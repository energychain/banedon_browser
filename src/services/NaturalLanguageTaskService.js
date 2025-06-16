const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const config = require('../utils/config');

class NaturalLanguageTaskService {
  constructor(sessionManager, commandExecutor) {
    this.sessionManager = sessionManager;
    this.commandExecutor = commandExecutor;
    this.genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    this.screenshotStorage = new Map(); // Store screenshots temporarily
    this.setupScreenshotDirectory();
  }

  setupScreenshotDirectory() {
    this.screenshotDir = path.join(process.cwd(), 'public', 'screenshots');
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  /**
   * Process a natural language task
   * @param {string} sessionId - Session ID
   * @param {string} taskDescription - Natural language description of the task
   * @returns {Promise<Object>} Task execution result with AI analysis
   */
  async processTask(sessionId, taskDescription) {
    try {
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      logger.info(`Processing natural language task for session ${sessionId}: ${taskDescription}`);

      // First, try to take a screenshot to see current state
      const screenshotResult = await this.takeScreenshot(sessionId);
      
      // If screenshot failed, proceed with text-only analysis
      if (screenshotResult.error) {
        logger.warn(`Screenshot failed for session ${sessionId}, proceeding with text-only analysis`);
        
        // Analyze the task without screenshot
        const textOnlyAnalysis = await this.analyzeTextOnlyTask(taskDescription);
        
        // Execute the task if it requires action
        let executionResult = null;
        if (textOnlyAnalysis.requiresAction && textOnlyAnalysis.actions && textOnlyAnalysis.actions.length > 0) {
          try {
            executionResult = await this.executeTaskActions(sessionId, textOnlyAnalysis.actions);
          } catch (executeError) {
            logger.error('Failed to execute actions:', executeError);
            executionResult = [{
              action: textOnlyAnalysis.actions[0],
              error: executeError.message,
              success: false
            }];
          }
        }
        
        return {
          taskId: uuidv4(),
          sessionId,
          taskDescription,
          screenshot: screenshotResult,
          analysis: textOnlyAnalysis,
          executionResult,
          success: true,
          timestamp: new Date().toISOString(),
          note: "Processed without screenshot due to browser limitations"
        };
      }
      
      // Analyze the task and current page state with screenshot
      const analysis = await this.analyzeTaskAndPage(taskDescription, screenshotResult.base64);
      
      // Execute the task if it requires action
      let executionResult = null;
      if (analysis.requiresAction && analysis.actions && analysis.actions.length > 0) {
        try {
          executionResult = await this.executeTaskActions(sessionId, analysis.actions);
          
          // Take another screenshot after execution
          const afterScreenshot = await this.takeScreenshot(sessionId);
          
          // Get final AI description of the result
          let finalAnalysis;
          if (afterScreenshot.base64 && !afterScreenshot.error) {
            try {
              finalAnalysis = await this.analyzePageAfterAction(
                taskDescription, 
                analysis.description,
                afterScreenshot.base64
              );
            } catch (finalAnalysisError) {
              logger.warn('Failed final analysis, using fallback');
              finalAnalysis = {
                description: "Task executed successfully",
                taskCompleted: true,
                changes: "Actions were executed",
                nextSteps: "Continue with next task"
              };
            }
          } else {
            finalAnalysis = {
              description: "Task executed but unable to capture final screenshot",
              taskCompleted: true,
              changes: "Actions were executed",
              nextSteps: "Continue with next task"
            };
          }
          
          return {
            taskId: uuidv4(),
            sessionId,
            taskDescription,
            beforeScreenshot: screenshotResult,
            afterScreenshot,
            initialAnalysis: analysis.description,
            finalDescription: finalAnalysis.description,
            actionsExecuted: analysis.actions,
            executionResult,
            success: true,
            timestamp: new Date().toISOString()
          };
        } catch (executeError) {
          logger.error('Failed to execute task actions:', executeError);
          return {
            taskId: uuidv4(),
            sessionId,
            taskDescription,
            screenshot: screenshotResult,
            analysis,
            executionResult: null,
            error: executeError.message,
            success: false,
            timestamp: new Date().toISOString()
          };
        }
      } else {
        // Just observation task
        return {
          taskId: uuidv4(),
          sessionId,
          taskDescription,
          screenshot: screenshotResult,
          description: analysis.description,
          analysis,
          requiresAction: false,
          success: true,
          timestamp: new Date().toISOString()
        };
      }
    } catch (error) {
      logger.error('Error processing natural language task:', error);
      
      // Return a graceful error response instead of throwing
      return {
        taskId: uuidv4(),
        sessionId,
        taskDescription,
        error: error.message,
        success: false,
        timestamp: new Date().toISOString(),
        fallbackResponse: true
      };
    }
  }

  /**
   * Take a screenshot and store it
   * @private
   */
  async takeScreenshot(sessionId) {
    try {
      const commandResult = await this.commandExecutor.executeCommand(sessionId, {
        type: 'screenshot',
        payload: {}
      });

      if (!commandResult.result || !commandResult.result.screenshot) {
        throw new Error('Failed to capture screenshot');
      }

      const screenshotId = uuidv4();
      const filename = `screenshot_${screenshotId}.png`;
      const filepath = path.join(this.screenshotDir, filename);
      
      // Convert base64 to file if needed
      let screenshotData = commandResult.result.screenshot;
      if (screenshotData.startsWith('data:image')) {
        // Remove data URL prefix
        screenshotData = screenshotData.split(',')[1];
      }

      // Save to file
      fs.writeFileSync(filepath, screenshotData, 'base64');
      
      // Store reference
      this.screenshotStorage.set(screenshotId, {
        filename,
        filepath,
        base64: screenshotData,
        createdAt: new Date()
      });

      return {
        screenshotId,
        url: `/screenshots/${filename}`,
        base64: screenshotData,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to take screenshot:', error);
      
      // Return a fallback response for when screenshots fail
      const screenshotId = uuidv4();
      return {
        screenshotId,
        url: null,
        base64: null,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Analyze task and current page state using Gemini
   * @private
   */
  async analyzeTaskAndPage(taskDescription, screenshotBase64) {
    try {
      // If no screenshot, use text-only analysis
      if (!screenshotBase64) {
        return await this.analyzeTextOnlyTask(taskDescription);
      }

      const prompt = `
You are an AI assistant that helps with browser automation tasks. Analyze the current webpage screenshot and the user's task request.

User's task: "${taskDescription}"

Based on the screenshot and the task description, provide a JSON response with:
1. A clear description of what you see on the current page
2. Whether the task requires any actions to be performed
3. If actions are needed, specify what actions should be taken

Respond ONLY with valid JSON in this exact format:
{
  "description": "Detailed description of what you see on the page",
  "requiresAction": true,
  "actions": [{"type": "navigate", "description": "Navigate to URL", "payload": {"url": "https://example.com"}}],
  "confidence": "high"
}
`;

      const imagePart = {
        inlineData: {
          data: screenshotBase64,
          mimeType: 'image/png'
        }
      };

      // Add timeout to Gemini API call
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Gemini API timeout')), 15000);
      });

      const apiCallPromise = this.model.generateContent([prompt, imagePart]);
      
      const result = await Promise.race([apiCallPromise, timeoutPromise]);
      const response = await result.response;
      const text = response.text().trim();
      
      try {
        // Clean up the response text
        let cleanText = text;
        if (cleanText.startsWith('```json')) {
          cleanText = cleanText.replace(/```json\n?/, '').replace(/\n?```$/, '');
        }
        if (cleanText.startsWith('```')) {
          cleanText = cleanText.replace(/```\n?/, '').replace(/\n?```$/, '');
        }
        
        const parsed = JSON.parse(cleanText);
        return parsed;
      } catch (parseError) {
        logger.warn('Failed to parse Gemini response as JSON, using fallback');
        return this.createFallbackAnalysis(taskDescription, text);
      }
    } catch (error) {
      logger.error('Error analyzing task with Gemini:', error);
      return this.createFallbackAnalysis(taskDescription, `Error: ${error.message}`);
    }
  }

  /**
   * Analyze task without screenshot (text-only)
   * @private
   */
  async analyzeTaskTextOnly(taskDescription) {
    try {
      const prompt = `
You are an AI assistant that helps with browser automation tasks. 

User's task: "${taskDescription}"

Since no screenshot is available, analyze the task description and determine what actions are needed.

Based on the task description, provide:
1. A description of what the task involves
2. Whether the task requires any actions to be performed
3. If actions are needed, specify what actions should be taken

If actions are needed, format them as a JSON array with objects containing:
- type: The action type (navigate, click, type, scroll, etc.)
- description: Human-readable description of the action
- payload: The action parameters

For common navigation tasks like "Go to [website]", suggest a navigate action.

Respond in this JSON format:
{
  "description": "Description of what the task involves",
  "requiresAction": true/false,
  "actions": [array of action objects if needed],
  "confidence": "high/medium/low"
}
`;

      const result = await this.model.generateContent([prompt]);
      const response = await result.response;
      const text = response.text();
      
      try {
        return JSON.parse(text);
      } catch (parseError) {
        // If JSON parsing fails, return a fallback response
        logger.warn('Failed to parse Gemini text-only response as JSON, using fallback');
        
        // Try to extract a simple navigation task
        const lowerTask = taskDescription.toLowerCase();
        if (lowerTask.includes('go to') || lowerTask.includes('navigate to') || lowerTask.includes('visit')) {
          // Extract URL or website name
          const urlMatch = taskDescription.match(/(?:go to|navigate to|visit)\s+([^\s]+)/i);
          if (urlMatch) {
            let url = urlMatch[1];
            if (!url.startsWith('http')) {
              url = `https://${url}`;
            }
            
            return {
              description: `Navigate to ${url}`,
              requiresAction: true,
              actions: [{
                type: 'navigate',
                description: `Navigate to ${url}`,
                payload: { url }
              }],
              confidence: 'medium'
            };
          }
        }
        
        return {
          description: text,
          requiresAction: false,
          actions: [],
          confidence: 'low'
        };
      }
    } catch (error) {
      logger.error('Error analyzing task with text-only Gemini:', error);
      throw error;
    }
  }

  /**
   * Analyze page after action execution
   * @private
   */
  async analyzePageAfterAction(originalTask, previousDescription, screenshotBase64) {
    try {
      const prompt = `
You are an AI assistant analyzing the result of a browser automation task.

Original task: "${originalTask}"
Previous page description: "${previousDescription}"

Look at the new screenshot and describe:
1. What has changed from the previous state
2. Whether the original task appears to have been completed successfully
3. What the user should know about the current page state

Provide a clear, concise description of the current state and whether the task was successful.

Respond in this JSON format:
{
  "description": "Description of current page state",
  "taskCompleted": true/false,
  "changes": "What changed from the previous state",
  "nextSteps": "Suggested next steps if any"
}
`;

      const imagePart = {
        inlineData: {
          data: screenshotBase64,
          mimeType: 'image/png'
        }
      };

      const result = await this.model.generateContent([prompt, imagePart]);
      const response = await result.response;
      const text = response.text();
      
      try {
        return JSON.parse(text);
      } catch (parseError) {
        return {
          description: text,
          taskCompleted: true,
          changes: "Analysis completed",
          nextSteps: "Continue with next task"
        };
      }
    } catch (error) {
      logger.error('Error analyzing result with Gemini:', error);
      throw error;
    }
  }

  /**
   * Execute the actions determined by AI analysis
   * @private
   */
  async executeTaskActions(sessionId, actions) {
    const results = [];
    
    for (const action of actions) {
      try {
        logger.info(`Executing action: ${action.type}`, { sessionId, action });
        
        const result = await this.commandExecutor.executeCommand(sessionId, {
          type: action.type,
          payload: action.payload || {}
        });
        
        results.push({
          action,
          result,
          success: true
        });
        
        // Small delay between actions
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error(`Failed to execute action ${action.type}:`, error);
        results.push({
          action,
          error: error.message,
          success: false
        });
      }
    }
    
    return results;
  }

  /**
   * Get screenshot by ID
   */
  getScreenshot(screenshotId) {
    return this.screenshotStorage.get(screenshotId);
  }

  /**
   * Clean up old screenshots
   */
  cleanupOldScreenshots() {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = new Date();
    
    for (const [id, screenshot] of this.screenshotStorage.entries()) {
      if (now - screenshot.createdAt > maxAge) {
        try {
          fs.unlinkSync(screenshot.filepath);
          this.screenshotStorage.delete(id);
          logger.debug(`Cleaned up old screenshot: ${id}`);
        } catch (error) {
          logger.warn(`Failed to cleanup screenshot ${id}:`, error);
        }
      }
    }
  }

  /**
   * Create fallback analysis when Gemini fails
   * @private
   */
  createFallbackAnalysis(taskDescription, aiResponse = '') {
    // Determine if task requires action based on keywords
    const actionKeywords = ['go to', 'navigate', 'click', 'type', 'scroll', 'open', 'visit', 'find', 'search'];
    const requiresAction = actionKeywords.some(keyword => 
      taskDescription.toLowerCase().includes(keyword)
    );

    let actions = [];
    if (requiresAction) {
      // Try to extract URL or action from task description
      const urlMatch = taskDescription.match(/(?:go to|visit|open)\s+([^\s]+)/i);
      if (urlMatch) {
        let url = urlMatch[1];
        if (!url.startsWith('http')) {
          url = `https://${url}`;
        }
        actions = [{
          type: 'navigate',
          description: `Navigate to ${url}`,
          payload: { url }
        }];
      } else if (taskDescription.toLowerCase().includes('click')) {
        actions = [{
          type: 'click',
          description: 'Click on element (requires manual identification)',
          payload: { selector: 'button, a, [onclick]' }
        }];
      } else if (taskDescription.toLowerCase().includes('screenshot')) {
        actions = [{
          type: 'screenshot',
          description: 'Take a screenshot of the current page',
          payload: {}
        }];
      }
    }

    return {
      description: aiResponse || `Task: ${taskDescription}. Unable to analyze page content due to technical limitations.`,
      requiresAction,
      actions,
      confidence: 'low',
      fallback: true
    };
  }

  /**
   * Analyze text-only task (no screenshot)
   * @private
   */
  async analyzeTextOnlyTask(taskDescription) {
    try {
      const prompt = `
Analyze this browser automation task: "${taskDescription}"

Provide a JSON response with the likely actions needed:

{
  "description": "Description of what this task involves",
  "requiresAction": true/false,
  "actions": [{"type": "action_type", "description": "what to do", "payload": {}}],
  "confidence": "medium"
}

Common action types: navigate, click, type, scroll, screenshot
`;

      // Add timeout to Gemini API call
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Gemini API timeout')), 10000);
      });

      const apiCallPromise = this.model.generateContent([prompt]);
      
      const result = await Promise.race([apiCallPromise, timeoutPromise]);
      const response = await result.response;
      const text = response.text().trim();
      
      try {
        // Clean up the response text
        let cleanText = text;
        if (cleanText.startsWith('```json')) {
          cleanText = cleanText.replace(/```json\n?/, '').replace(/\n?```$/, '');
        }
        
        const parsed = JSON.parse(cleanText);
        return parsed;
      } catch (parseError) {
        logger.warn('Failed to parse Gemini text-only response as JSON, using fallback');
        return this.createFallbackAnalysis(taskDescription, text);
      }
    } catch (error) {
      logger.error('Error with text-only Gemini analysis:', error);
      return this.createFallbackAnalysis(taskDescription, `Error: ${error.message}`);
    }
  }
}

module.exports = NaturalLanguageTaskService;
