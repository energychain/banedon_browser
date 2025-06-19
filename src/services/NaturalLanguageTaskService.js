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

      // Add user message to history and get the latest history
      this.sessionManager.addToHistory(sessionId, { role: 'user', content: taskDescription });
      const history = this.sessionManager.getHistory(sessionId);

      logger.info(`Processing natural language task for session ${sessionId}: ${taskDescription}`);

      const screenshotResult = await this.takeScreenshot(sessionId);
      
      const analysis = await this.analyzeTaskAndPage(history, screenshotResult.base64);
      
      // Add AI's thought process and response to history
      const assistantResponse = (analysis.thought ? `Thinking: ${analysis.thought}\n\n` : '') + (analysis.response || '');
      if (assistantResponse) {
        this.sessionManager.addToHistory(sessionId, { role: 'assistant', content: assistantResponse });
      }
      
      let executionResult = null;
      let afterScreenshot = null;
      let finalAnalysis = null;

      if (analysis.requiresAction && analysis.actions && analysis.actions.length > 0) {
        try {
          executionResult = await this.executeTaskActions(sessionId, analysis.actions);
          afterScreenshot = await this.takeScreenshot(sessionId);
          
          if (afterScreenshot.base64 && !afterScreenshot.error) {
            const updatedHistory = this.sessionManager.getHistory(sessionId);
            finalAnalysis = await this.analyzePageAfterAction(updatedHistory, afterScreenshot.base64);
            
            if (finalAnalysis.description) {
              this.sessionManager.addToHistory(sessionId, { role: 'assistant', content: finalAnalysis.description });
            }
          }
        } catch (executeError) {
          logger.error('Failed to execute task actions:', executeError);
          this.sessionManager.addToHistory(sessionId, { role: 'assistant', content: `I failed to execute the action. Error: ${executeError.message}` });
        }
      }
      
      const finalHistory = this.sessionManager.getHistory(sessionId);
      const lastMessage = finalHistory[finalHistory.length - 1];

      return {
        taskId: uuidv4(),
        sessionId,
        taskDescription,
        history: finalHistory,
        response: lastMessage.content, // The last thing the assistant said
        requiresAction: analysis.requiresAction,
        actions: analysis.actions,
        executionResult,
        beforeScreenshot: screenshotResult,
        afterScreenshot,
        success: true,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Error processing natural language task:', error);
      this.sessionManager.addToHistory(sessionId, { role: 'assistant', content: `I encountered an error: ${error.message}` });
      return {
        taskId: uuidv4(),
        sessionId,
        taskDescription,
        history: this.sessionManager.getHistory(sessionId),
        error: error.message,
        success: false,
        timestamp: new Date().toISOString(),
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
  async analyzeTaskAndPage(history, screenshotBase64) {
    try {
      // If no screenshot, use text-only analysis
      if (!screenshotBase64) {
        return await this.analyzeTextOnlyTask(history);
      }

      const historyString = history.map(h => `${h.role}: ${h.content}`).join('\n');
      const lastUserTask = history.filter(h => h.role === 'user').pop()?.content || '';

      const prompt = `
You are a conversational AI agent that helps users accomplish tasks in a web browser.

CONVERSATION HISTORY:
---
${historyString}
---

Your goal is to fulfill the user's latest request: "${lastUserTask}"

Based on the conversation history, the user's request, and the provided screenshot of the current page, create a plan.
- If the request is ambiguous, ask a clarifying question.
- If the request is complex, break it down into simple steps.
- If you have enough information, define the next action to take.
- Always think step-by-step and explain your reasoning.

Respond ONLY with valid JSON in this exact format:
{
  "thought": "Your step-by-step reasoning and plan. You are looking at the screenshot and deciding what to do next based on the user's request.",
  "response": "A conversational response to the user. This can be a status update ('Okay, I will now go to the website...') or a clarifying question.",
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
      
      const parsed = this._parseGeminiResponse(text);
      if (parsed.error) {
        logger.warn('Failed to parse Gemini response as JSON, using fallback');
        return this.createFallbackAnalysis(history, text);
      }
      return parsed;
    } catch (error) {
      logger.error('Error analyzing task with Gemini:', error);
      return this.createFallbackAnalysis(history, `Error: ${error.message}`);
    }
  }

  /**
   * Analyze task without screenshot (text-only)
   * @private
   */
  async analyzeTextOnlyTask(history) {
    try {
      const historyString = history.map(h => `${h.role}: ${h.content}`).join('\n');
      const lastUserTask = history.filter(h => h.role === 'user').pop()?.content || '';

      const prompt = `
You are a conversational AI agent that helps users accomplish tasks in a web browser. No screenshot is available.

CONVERSATION HISTORY:
---
${historyString}
---

Your goal is to fulfill the user's latest request: "${lastUserTask}"

Based on the conversation history and the user's request, create a plan.
- If the request is ambiguous, ask a clarifying question.
- If the request requires visiting a website, the first step is always a 'navigate' action.
- Always think step-by-step and explain your reasoning.

Respond ONLY with valid JSON in this exact format:
{
  "thought": "Your step-by-step reasoning and plan. I don't have a screenshot, so I'm relying on the text of the request.",
  "response": "A conversational response to the user. This can be a status update ('Okay, I will now go to the website...') or a clarifying question.",
  "requiresAction": true,
  "actions": [{"type": "navigate", "description": "Navigate to URL", "payload": {"url": "https://example.com"}}],
  "confidence": "medium"
}
`;

      const result = await this.model.generateContent([prompt]);
      const response = await result.response;
      const text = response.text();
      
      const parsed = this._parseGeminiResponse(text);
      if (parsed.error) {
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
      return parsed;
    } catch (error) {
      logger.error('Error analyzing task with text-only Gemini:', error);
      throw error;
    }
  }

  /**
   * Analyze page after action execution
   * @private
   */
  async analyzePageAfterAction(history, screenshotBase64) {
    try {
      const historyString = history.map(h => `${h.role}: ${h.content}`).join('\n');
      const lastUserTask = history.filter(h => h.role === 'user').pop()?.content || '';

      const prompt = `
You are a conversational AI agent analyzing the result of a browser action.

CONVERSATION HISTORY:
---
${historyString}
---

The last action was just executed. Look at the new screenshot and determine the next step.
- Did the last action succeed?
- Is the original task "${lastUserTask}" complete?
- If not complete, what is the next action?
- If complete, provide a final summary to the user.
- If something went wrong, describe the problem.

Respond ONLY with valid JSON in this exact format:
{
  "description": "Describe what you see on the page now and whether the task is complete. If the user wanted a summary, provide it here.",
  "taskCompleted": true,
  "requiresAction": false,
  "actions": [],
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
      
      const parsed = this._parseGeminiResponse(text);
      if (parsed.error) {
        return {
          description: text,
          taskCompleted: true,
          changes: "Analysis completed",
          nextSteps: "Continue with next task"
        };
      }
      return parsed;
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
   * Safely parse Gemini's JSON response
   * @private
   */
  _parseGeminiResponse(text) {
    try {
      let cleanText = text.trim();
      if (cleanText.startsWith('```json')) {
        cleanText = cleanText.replace(/```json\n?/, '').replace(/\n?```$/, '');
      }
       if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/```\n?/, '').replace(/\n?```$/, '');
      }
      return JSON.parse(cleanText);
    } catch (parseError) {
      logger.warn('Failed to parse Gemini response as JSON:', { text, error: parseError.message });
      // Return a structured error or a fallback object
      return { error: "Failed to parse AI response", details: text };
    }
  }

  /**
   * Summarize page content with screenshot
   * @private
   */
  async summarizePageWithScreenshot(sessionId, taskDescription, screenshotBase64) {
    try {
        const contentResult = await this.commandExecutor.executeCommand(sessionId, {
            type: 'get_text',
            payload: {}
        });

        if (!contentResult.result || !contentResult.result.text) {
            throw new Error('Could not get page content.');
        }

        const pageText = contentResult.result.text;

        const prompt = `
You are an AI assistant. The user wants a summary of the current page.
User's request: "${taskDescription}"

Here is a screenshot of the page and the extracted text content.
Page content:
---
${pageText.substring(0, 8000)}
---

Based on the user's request, the screenshot, and the page content, provide a concise summary of the main points.
If the user asks for headlines, list the main headlines.
The response should be in the same language as the user's request.

Respond with a JSON object in this format:
{
  "summary": "Your summary here.",
  "headlines": ["Headline 1", "Headline 2", ...]
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
        const text = response.text().trim();
        return this._parseGeminiResponse(text);
    } catch (error) {
        logger.error('Error summarizing page (with screenshot):', error);
        return this.summarizePageTextOnly(sessionId, taskDescription); // Fallback to text only
    }
  }

  /**
   * Summarize page content without screenshot
   * @private
   */
  async summarizePageTextOnly(sessionId, taskDescription) {
    try {
        const contentResult = await this.commandExecutor.executeCommand(sessionId, {
            type: 'get_text',
            payload: {}
        });

        if (!contentResult.result || !contentResult.result.text) {
            throw new Error('Could not get page content.');
        }

        const pageText = contentResult.result.text;

        const prompt = `
You are an AI assistant. The user wants a summary of the current page.
User's request: "${taskDescription}"
Page content:
---
${pageText.substring(0, 8000)}
---

Based on the user's request and the page content, provide a concise summary of the main points.
If the user asks for headlines, list the main headlines.
The response should be in the same language as the user's request.

Respond with a JSON object in this format:
{
  "summary": "Your summary here.",
  "headlines": ["Headline 1", "Headline 2", ...]
}
`;
        const result = await this.model.generateContent([prompt]);
        const response = await result.response;
        const text = response.text().trim();
        return this._parseGeminiResponse(text);
    } catch (error) {
        logger.error('Error summarizing page (text-only):', error);
        return { summary: 'Could not summarize the page.', headlines: [] };
    }
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
  createFallbackAnalysis(history, aiResponse = '') {
    // Determine if task requires action based on keywords
    const actionKeywords = ['go to', 'navigate', 'click', 'type', 'scroll', 'open', 'visit', 'find', 'search'];
    const lastUserTask = history.filter(h => h.role === 'user').pop()?.content || '';
    const requiresAction = actionKeywords.some(keyword => 
      lastUserTask.toLowerCase().includes(keyword)
    );

    let actions = [];
    if (requiresAction) {
      // Try to extract URL or action from task description
      const urlMatch = lastUserTask.match(/(?:go to|visit|open)\s+([^\s]+)/i);
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
      } else if (lastUserTask.toLowerCase().includes('click')) {
        actions = [{
          type: 'click',
          description: 'Click on element (requires manual identification)',
          payload: { selector: 'button, a, [onclick]' }
        }];
      } else if (lastUserTask.toLowerCase().includes('screenshot')) {
        actions = [{
          type: 'screenshot',
          description: 'Take a screenshot of the current page',
          payload: {}
        }];
      }
    }

    return {
      description: aiResponse || `Task: ${lastUserTask}. Unable to analyze page content due to technical limitations.`,
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
      
      const parsed = this._parseGeminiResponse(text);
      if (parsed.error) {
        logger.warn('Failed to parse Gemini text-only response as JSON, using fallback');
        return this.createFallbackAnalysis(taskDescription, text);
      }
      return parsed;
    } catch (error) {
      logger.error('Error with text-only Gemini analysis:', error);
      return this.createFallbackAnalysis(taskDescription, `Error: ${error.message}`);
    }
  }
}

module.exports = NaturalLanguageTaskService;
