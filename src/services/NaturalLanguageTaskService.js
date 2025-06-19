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
   * Process a natural language task with iterative execution
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
      let history = this.sessionManager.getHistory(sessionId);

      logger.info(`Processing natural language task for session ${sessionId}: ${taskDescription}`);

      // First check if we need to navigate somewhere before analyzing the page
      let analysis = await this.analyzeTaskForInitialNavigation(history, taskDescription);
      let screenshotResult;
      
      // If initial analysis suggests navigation, do that first
      if (analysis.requiresAction && analysis.actions && analysis.actions.length > 0 && 
          analysis.actions[0].type === 'navigate') {
        logger.info('Initial task requires navigation, performing navigation first');
        const navResult = await this.executeTaskActions(sessionId, [analysis.actions[0]]);
        
        // Wait for page to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Now take screenshot and analyze the loaded page
        screenshotResult = await this.takeScreenshot(sessionId);
        analysis = await this.analyzeTaskWithElements(history, screenshotResult.base64, sessionId);
      } else {
        // No navigation needed, analyze current page
        screenshotResult = await this.takeScreenshot(sessionId);
        analysis = await this.analyzeTaskWithElements(history, screenshotResult.base64, sessionId);
      }
      
      // Add AI's initial response to history
      const initialResponse = (analysis.thought ? `Thinking: ${analysis.thought}\n\n` : '') + (analysis.response || '');
      if (initialResponse) {
        this.sessionManager.addToHistory(sessionId, { role: 'assistant', content: initialResponse });
      }
      
      let executionResult = [];
      let afterScreenshot = null;
      let iterationCount = 0;
      const maxIterations = 10; // Prevent infinite loops
      
      // Iterative execution until task is complete or max iterations reached
      while (analysis.requiresAction && analysis.actions && analysis.actions.length > 0 && iterationCount < maxIterations) {
        iterationCount++;
        logger.info(`Iteration ${iterationCount}: Executing ${analysis.actions.length} actions`);
        
        try {
          const iterationResult = await this.executeTaskActions(sessionId, analysis.actions);
          executionResult.push(...iterationResult);
          
          // Take screenshot after actions
          afterScreenshot = await this.takeScreenshot(sessionId);
          
          if (afterScreenshot.base64 && !afterScreenshot.error) {
            history = this.sessionManager.getHistory(sessionId);
            
            // Check if task is complete or needs more actions
            const continueAnalysis = await this.analyzePageAfterActionForContinuationWithElements(
              history, 
              afterScreenshot.base64, 
              taskDescription,
              sessionId
            );
            
            if (continueAnalysis.description) {
              this.sessionManager.addToHistory(sessionId, { role: 'assistant', content: continueAnalysis.description });
            }
            
            // If task is complete or no more actions needed, break the loop
            if (continueAnalysis.taskCompleted || !continueAnalysis.requiresAction || !continueAnalysis.actions || continueAnalysis.actions.length === 0) {
              break;
            }
            
            // Update analysis for next iteration
            analysis = continueAnalysis;
            screenshotResult = afterScreenshot;
          } else {
            // If we can't take a screenshot, break to avoid infinite loop
            logger.warn('Cannot take screenshot for next iteration, stopping');
            break;
          }
        } catch (executeError) {
          logger.error('Failed to execute task actions:', executeError);
          
          // If the error is about a selector not being found, try to continue with a modified approach
          if (executeError.message.includes('Waiting for selector') && executeError.message.includes('failed')) {
            this.sessionManager.addToHistory(sessionId, { 
              role: 'assistant', 
              content: `I encountered an issue finding an element on the page. Let me try a different approach to continue with the task.` 
            });
            
            // Take a screenshot to analyze the current state
            try {
              const currentScreenshot = await this.takeScreenshot(sessionId);
              if (currentScreenshot.base64) {
                history = this.sessionManager.getHistory(sessionId);
                
                // Re-analyze with focus on finding alternative approaches
                const fallbackAnalysis = await this.analyzePageAfterActionForContinuationWithElements(
                  history, 
                  currentScreenshot.base64, 
                  taskDescription,
                  sessionId
                );
                
                if (fallbackAnalysis.description) {
                  this.sessionManager.addToHistory(sessionId, { role: 'assistant', content: fallbackAnalysis.description });
                }
                
                // Continue with fallback analysis if it provides new actions
                if (fallbackAnalysis.requiresAction && fallbackAnalysis.actions && fallbackAnalysis.actions.length > 0) {
                  analysis = fallbackAnalysis;
                  screenshotResult = currentScreenshot;
                  continue; // Try again with new approach
                }
              }
            } catch (fallbackError) {
              logger.warn('Fallback analysis failed:', fallbackError);
            }
          }
          
          this.sessionManager.addToHistory(sessionId, { 
            role: 'assistant', 
            content: `I encountered an error while trying to complete the task: ${executeError.message}` 
          });
          break;
        }
      }
      
      if (iterationCount >= maxIterations) {
        this.sessionManager.addToHistory(sessionId, { 
          role: 'assistant', 
          content: `I reached the maximum number of attempts (${maxIterations}) for this task. The task may be too complex or there might be an issue with the website.` 
        });
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
        iterations: iterationCount,
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
You are a conversational AI agent that controls a web browser like a human user would.

CONVERSATION HISTORY:
---
${historyString}
---

Your goal is to fulfill the user's latest request: "${lastUserTask}"

HUMAN-LIKE INTERACTION RULES:
- You see the page through screenshots, just like a human
- You interact using mouse clicks at specific coordinates (x, y positions)
- You can scroll the page to see more content
- You can type text using the keyboard
- You can press specific keys (Enter, Tab, Escape, etc.)
- Handle routine interactions automatically (cookie consent, popups) without asking the user
- Use visual cues to find elements rather than CSS selectors

AVAILABLE ACTIONS:
- navigate: Go to a URL
- click_coordinate: Click at specific x,y coordinates  
- scroll: Scroll the page (deltaY: positive=down, negative=up)
- type_text: Type text at the current cursor position
- key_press: Press a specific key (Enter, Tab, Escape, etc.)
- hover_coordinate: Hover mouse at x,y coordinates
- get_page_elements: Get list of clickable elements with their positions
- screenshot: Take a screenshot to see current page state

INTERACTION STRATEGY:
1. Look at the screenshot to see what's currently visible
2. If you need element positions, first use get_page_elements to get a list of clickable elements with coordinates
3. Use click_coordinate with the x,y position to click on buttons, links, etc.
4. Scroll down/up to see more content if needed
5. Type text and press keys as a human would
6. For routine tasks (cookie consent), just click the appropriate coordinates

Based on the screenshot and user request, decide what to do next. Think like a human user would.

Respond ONLY with valid JSON in this exact format:
{
  "thought": "I can see [describe what you see in the screenshot]. I need to [describe your plan step by step].",
  "response": "A conversational response to the user about what you're doing.",
  "requiresAction": true,
  "actions": [{"type": "get_page_elements", "description": "Get clickable elements to find cookie consent button", "payload": {}}],
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

IMPORTANT AUTOMATION RULES:
- Handle routine website interactions automatically without asking the user
- Cookie consent dialogs: Always accept/dismiss automatically
- Newsletter signups, promotional popups: Dismiss automatically  
- Age verification, country selection: Choose reasonable defaults automatically
- Only ask the user for input when truly necessary (login credentials, specific preferences, etc.)
- Your goal is to complete the user's task end-to-end, not stop at intermediate steps

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
   * Enhanced continuation analysis with element coordinates
   * @private
   */
  async analyzePageAfterActionForContinuationWithElements(history, screenshotBase64, originalTask, sessionId) {
    try {
      // Get page elements for coordinate-based interactions
      const elements = await this.getPageElementsForAnalysis(sessionId);
      
      const historyString = history.map(h => `${h.role}: ${h.content}`).join('\n');

      const elementsInfo = elements.length > 0 ? 
        `\n\nCLICKABLE ELEMENTS ON PAGE:\n${elements.map(el => 
          `- ${el.tagName} at (${el.x}, ${el.y}): "${el.text || el.ariaLabel || el.placeholder || 'no text'}" ${el.className ? `[class: ${el.className.slice(0, 50)}]` : ''}`
        ).join('\n')}` : '';

      const prompt = `
You are analyzing the result of a browser action, working like a human user.

ORIGINAL USER TASK: "${originalTask}"

CONVERSATION HISTORY:
---
${historyString}
---

${elementsInfo}

ANALYSIS APPROACH:
- Look at the screenshot to see what happened after the last action
- Use the element list to identify what can be clicked at specific coordinates
- For routine tasks (cookie consent), find and click appropriate buttons automatically
- Determine if the original task is complete or needs more actions

Key Questions:
1. Did the last action succeed?
2. Is the original task complete? (e.g., if user wanted flight info, do we see flight schedules?)
3. Are there routine dialogs that need handling?
4. What coordinates should be clicked next?

Respond ONLY with valid JSON in this exact format:
{
  "description": "Describe what you see and the current task status.",
  "taskCompleted": false,
  "requiresAction": true,
  "actions": [{"type": "click_coordinate", "description": "Click specific element", "payload": {"x": 150, "y": 200}}],
  "confidence": "high"
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
      
      const parsed = this._parseGeminiResponse(text);
      if (parsed.error) {
        logger.warn('Failed to parse enhanced continuation analysis, falling back');
        return this.analyzePageAfterActionForContinuation(history, screenshotBase64, originalTask);
      }
      return parsed;
    } catch (error) {
      logger.error('Error in enhanced continuation analysis:', error);
      return this.analyzePageAfterActionForContinuation(history, screenshotBase64, originalTask);
    }
  }

  /**
   * Simple continuation analysis without enhanced elements
   * @private
   */
  async analyzePageAfterActionForContinuation(history, screenshotBase64, originalTask) {
    // Fallback to the enhanced version with null sessionId
    return this.analyzePageAfterActionForContinuationWithElements(history, screenshotBase64, originalTask, null);
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
   * Get page elements and enhance analysis
   * @private
   */
  async getPageElementsForAnalysis(sessionId) {
    try {
      const elementsResult = await this.commandExecutor.executeCommand(sessionId, {
        type: 'get_page_elements',
        payload: {}
      });

      if (elementsResult.result && elementsResult.result.elements) {
        return elementsResult.result.elements;
      }
      return [];
    } catch (error) {
      logger.warn('Failed to get page elements:', error);
      return [];
    }
  }

  /**
   * Enhanced task processing that combines screenshots with element analysis
   * @private
   */
  async analyzeTaskWithElements(history, screenshotBase64, sessionId) {
    try {
      // Get page elements for coordinate-based interactions
      const elements = await this.getPageElementsForAnalysis(sessionId);
      
      const historyString = history.map(h => `${h.role}: ${h.content}`).join('\n');
      const lastUserTask = history.filter(h => h.role === 'user').pop()?.content || '';

      const elementsInfo = elements.length > 0 ? 
        `\n\nCLICKABLE ELEMENTS ON PAGE:\n${elements.map(el => 
          `- ${el.tagName} at (${el.x}, ${el.y}): "${el.text || el.ariaLabel || el.placeholder || 'no text'}" ${el.className ? `[class: ${el.className.slice(0, 50)}]` : ''}`
        ).join('\n')}` : '';

      const prompt = `
You are a conversational AI agent that controls a web browser like a human user.

CONVERSATION HISTORY:
---
${historyString}
---

Your goal is to fulfill the user's latest request: "${lastUserTask}"

HUMAN-LIKE INTERACTION APPROACH:
- You see the page through a screenshot and have a list of clickable elements with their coordinates
- Click directly on coordinates of elements you want to interact with
- Handle routine interactions (cookie consent, popups) automatically
- Think step by step like a human user would

${elementsInfo}

INTERACTION STRATEGY:
1. Look at the screenshot to understand the current page state
2. Use the element list above to find coordinates for clicking
3. For cookie consent: Find buttons with "accept", "allow", "agree" in their text and click their coordinates
4. For forms: Find input fields and buttons by their coordinates
5. Use scroll if you need to see more content

Based on the screenshot, element list, and user request, decide your next action.

Respond ONLY with valid JSON in this exact format:
{
  "thought": "I can see [describe the page]. Looking at the elements, I found [describe relevant elements]. I need to [describe plan].",
  "response": "A conversational response about what you're doing.",
  "requiresAction": true,
  "actions": [{"type": "click_coordinate", "description": "Click accept cookies button", "payload": {"x": 150, "y": 200}}],
  "confidence": "high"
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
      
      const parsed = this._parseGeminiResponse(text);
      if (parsed.error) {
        logger.warn('Failed to parse enhanced analysis response, falling back');
        return this.analyzeTaskAndPage(history, screenshotBase64);
      }
      return parsed;
    } catch (error) {
      logger.error('Error in enhanced task analysis:', error);
      return this.analyzeTaskAndPage(history, screenshotBase64);
    }
  }

  /**
   * Analyze task to determine if initial navigation is needed
   * @private
   */
  async analyzeTaskForInitialNavigation(history, taskDescription) {
    try {
      const historyString = history.map(h => `${h.role}: ${h.content}`).join('\n');

      const prompt = `
You are a conversational AI agent analyzing a user's request to determine if navigation to a website is needed first.

CONVERSATION HISTORY:
---
${historyString}
---

USER'S REQUEST: "${taskDescription}"

Determine if this request requires navigating to a specific website first. Common scenarios:
- Flight search → Navigate to Google Flights, Expedia, or airline websites
- Shopping → Navigate to Amazon, shopping sites
- News → Navigate to news websites  
- Maps/directions → Navigate to Google Maps
- General web search → Navigate to Google
- Hotel booking → Navigate to Booking.com, Hotels.com

If navigation is needed, provide the URL. If the user is already on the right page or this is a general question, no navigation is needed.

Respond ONLY with valid JSON in this exact format:
{
  "thought": "The user wants to [describe task]. This requires navigating to [site] because [reason], OR this doesn't require navigation because [reason].",
  "response": "I'll navigate to [site] to help you with [task]",
  "requiresAction": true,
  "actions": [{"type": "navigate", "description": "Navigate to Google Flights", "payload": {"url": "https://www.google.com/flights"}}],
  "confidence": "high"
}
`;

      const result = await this.model.generateContent([prompt]);
      const response = await result.response;
      const text = response.text().trim();
      
      const parsed = this._parseGeminiResponse(text);
      if (parsed.error) {
        // Fallback: detect common navigation patterns
        const taskLower = taskDescription.toLowerCase();
        if (taskLower.includes('flight') || taskLower.includes('airline')) {
          return {
            response: "I'll search for flights on Google Flights",
            requiresAction: true,
            actions: [{
              type: 'navigate',
              description: 'Navigate to Google Flights',
              payload: { url: 'https://www.google.com/flights' }
            }],
            confidence: 'medium'
          };
        } else if (taskLower.includes('hotel') || taskLower.includes('booking')) {
          return {
            response: "I'll search for hotels on Booking.com",
            requiresAction: true,
            actions: [{
              type: 'navigate', 
              description: 'Navigate to Booking.com',
              payload: { url: 'https://www.booking.com' }
            }],
            confidence: 'medium'
          };
        }
        
        return {
          response: "I'll analyze the current page",
          requiresAction: false,
          actions: [],
          confidence: 'low'
        };
      }
      return parsed;
    } catch (error) {
      logger.error('Error analyzing task for navigation:', error);
      // Simple fallback for flight searches
      if (taskDescription.toLowerCase().includes('flight')) {
        return {
          response: "I'll search for flights on Google Flights",
          requiresAction: true,
          actions: [{
            type: 'navigate',
            description: 'Navigate to Google Flights',
            payload: { url: 'https://www.google.com/flights' }
          }],
          confidence: 'medium'
        };
      }
      
      return {
        response: "I'll analyze the current page",
        requiresAction: false,
        actions: [],
        confidence: 'low'
      };
    }
  }
}

module.exports = NaturalLanguageTaskService;
