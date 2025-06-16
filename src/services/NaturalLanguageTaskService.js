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
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
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

      // First, take a screenshot to see current state
      const screenshotResult = await this.takeScreenshot(sessionId);
      
      // Analyze the task and current page state
      const analysis = await this.analyzeTaskAndPage(taskDescription, screenshotResult.screenshot);
      
      // Execute the task if it requires action
      let executionResult = null;
      if (analysis.requiresAction) {
        executionResult = await this.executeTaskActions(sessionId, analysis.actions);
        
        // Take another screenshot after execution
        const afterScreenshot = await this.takeScreenshot(sessionId);
        
        // Get final AI description of the result
        const finalAnalysis = await this.analyzePageAfterAction(
          taskDescription, 
          analysis.description,
          afterScreenshot.screenshot
        );
        
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
      } else {
        // Just observation task
        return {
          taskId: uuidv4(),
          sessionId,
          taskDescription,
          screenshot: screenshotResult,
          description: analysis.description,
          requiresAction: false,
          success: true,
          timestamp: new Date().toISOString()
        };
      }
    } catch (error) {
      logger.error('Error processing natural language task:', error);
      throw error;
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
      throw error;
    }
  }

  /**
   * Analyze task and current page state using Gemini
   * @private
   */
  async analyzeTaskAndPage(taskDescription, screenshotBase64) {
    try {
      const prompt = `
You are an AI assistant that helps with browser automation tasks. Analyze the current webpage screenshot and the user's task request.

User's task: "${taskDescription}"

Based on the screenshot and the task description, provide:
1. A clear description of what you see on the current page
2. Whether the task requires any actions to be performed
3. If actions are needed, specify what actions should be taken

If actions are needed, format them as a JSON array with objects containing:
- type: The action type (navigate, click, type, scroll, etc.)
- description: Human-readable description of the action
- payload: The action parameters

Respond in this JSON format:
{
  "description": "Detailed description of what you see on the page",
  "requiresAction": true/false,
  "actions": [array of action objects if needed],
  "confidence": "high/medium/low"
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
        // If JSON parsing fails, return a fallback response
        logger.warn('Failed to parse Gemini response as JSON, using fallback');
        return {
          description: text,
          requiresAction: false,
          actions: [],
          confidence: 'low'
        };
      }
    } catch (error) {
      logger.error('Error analyzing task with Gemini:', error);
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
}

module.exports = NaturalLanguageTaskService;
