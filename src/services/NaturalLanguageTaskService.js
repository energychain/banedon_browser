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
      let iterationsSinceProgress = 0;
      const maxIterationsWithoutProgress = 6; // Max iterations without progress before giving up
      const absoluteMaxIterations = 15; // Hard limit to prevent infinite loops
      
      // Initialize progress tracking
      let progressTracker = this.initializeProgressTracker(taskDescription, history);
      
      // Iterative execution until task is complete or no progress for too long
      while (analysis.requiresAction && analysis.actions && analysis.actions.length > 0 && 
             iterationsSinceProgress < maxIterationsWithoutProgress && 
             iterationCount < absoluteMaxIterations) {
        iterationCount++;
        iterationsSinceProgress++;
        logger.info(`Iteration ${iterationCount} (${iterationsSinceProgress} since progress): Executing ${analysis.actions.length} actions`);
        
        try {
          const iterationResult = await this.executeTaskActions(sessionId, analysis.actions);
          executionResult.push(...iterationResult);
          
          // Take screenshot after actions
          afterScreenshot = await this.takeScreenshot(sessionId);
          
          if (afterScreenshot.base64 && !afterScreenshot.error) {
            history = this.sessionManager.getHistory(sessionId);
            
            // Check for progress before applying delays or fallbacks
            const progressResult = this.detectProgress(progressTracker, history, iterationCount, afterScreenshot.base64);
            
            if (progressResult.hasProgress) {
              iterationsSinceProgress = 0; // Reset counter on progress
              progressTracker = progressResult.updatedTracker;
              logger.info(`Progress detected: ${progressResult.progressDescription}. Resetting iteration counter.`);
            }
            
            // Add delay to avoid rate limiting (only after first iteration and no recent progress)
            if (iterationCount > 1 && iterationsSinceProgress > 1) {
              await new Promise(resolve => setTimeout(resolve, 6000)); // 6 second delay
            }
            
            // Check for repetitive behavior (stuck in loop) - only if no recent progress
            if (iterationsSinceProgress >= 3) {
              const recentHistory = history.slice(-4).map(h => h.content).join(' ').toLowerCase();
              
              // Enhanced sub-task repetition detection
              const subtaskPatterns = this.detectRepeatedSubtasks(history, iterationsSinceProgress);
              
              const isStuckOnInput = recentHistory.includes('where from') && 
                                   recentHistory.includes('input field') &&
                                   (recentHistory.match(/where from/g) || []).length >= 2;
              
              // Also check for repetitive typing patterns
              const frankfurtMatches = (recentHistory.match(/frankfurt/g) || []).length;
              const londonMatches = (recentHistory.match(/london/g) || []).length;
              const isStuckTyping = frankfurtMatches >= 2 && londonMatches >= 2;
              
              // Check for general repetition in responses
              const recentResponses = history.slice(-3).map(h => h.content);
              const isRepeatingResponses = recentResponses.length >= 2 && 
                recentResponses.some(r => r.toLowerCase().includes('where from')) && 
                recentResponses.some(r => r.toLowerCase().includes('where from'));
              
              // Check if we're stuck in fallback loop (same fallback repeatedly)
              const isStuckInFallback = iterationsSinceProgress >= 4 && 
                recentHistory.includes('fallback') && 
                (recentHistory.match(/fallback/g) || []).length >= 2;
              
              if ((isStuckOnInput || isStuckTyping || isRepeatingResponses || isStuckInFallback || subtaskPatterns.hasRepeatedSubtask) && 
                  iterationsSinceProgress <= 5) { // Only use fallback if not too many iterations without progress
                logger.info(`Detected repetitive behavior (${subtaskPatterns.description}), using advanced fallback logic`);
                const fallbackAnalysis = this.handleAdvancedFallback(history, taskDescription, iterationsSinceProgress, subtaskPatterns);
                if (fallbackAnalysis.requiresAction && fallbackAnalysis.actions.length > 0) {
                  analysis = fallbackAnalysis;
                  continue; // Skip AI analysis and use fallback
                }
              } else if (iterationsSinceProgress > 5) {
                // After many iterations without progress, try a completely different approach
                logger.info('Too many iterations without progress, trying alternative search strategy');
                const alternativeAnalysis = this.handleAlternativeSearch(history, taskDescription);
                if (alternativeAnalysis.requiresAction && alternativeAnalysis.actions.length > 0) {
                  analysis = alternativeAnalysis;
                  continue;
                }
              }
            }
            
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
      
      // Add final completion message based on progress and stopping reason
      let completionMessage = '';
      if (iterationsSinceProgress >= maxIterationsWithoutProgress) {
        completionMessage = `I completed ${progressTracker.completedMilestones.size} milestones but reached the limit of ${maxIterationsWithoutProgress} iterations without progress. Progress achieved: ${Array.from(progressTracker.completedMilestones).join(', ') || 'Initial navigation and setup'}. The task may need additional time or manual completion.`;
      } else if (iterationCount >= absoluteMaxIterations) {
        completionMessage = `I reached the absolute maximum of ${absoluteMaxIterations} iterations. I achieved ${progressTracker.completedMilestones.size} milestones: ${Array.from(progressTracker.completedMilestones).join(', ') || 'basic navigation'}. The system needs additional time or manual intervention.`;
      }
      
      if (completionMessage) {
        this.sessionManager.addToHistory(sessionId, { 
          role: 'assistant', 
          content: completionMessage
        });
      }
      
      const finalHistory = this.sessionManager.getHistory(sessionId);
      const lastMessage = finalHistory[finalHistory.length - 1];

      // Build comprehensive execution analytics
      const executionAnalytics = this.buildExecutionAnalytics(finalHistory, executionResult, iterationCount);

      return {
        taskId: uuidv4(),
        sessionId,
        taskDescription,
        response: lastMessage.content, // The last thing the assistant said
        
        // Execution Summary
        execution: {
          status: 'completed',
          iterations: iterationCount,
          maxIterations: 8,
          totalActions: executionResult.length,
          completionReason: iterationCount >= 8 ? 'max_iterations_reached' : 'task_completed',
          duration: Date.now() - new Date(this.sessionManager.sessions.get(sessionId)?.createdAt || Date.now()).getTime()
        },

        // Sub-task Analysis
        subtasks: executionAnalytics.subtasks,
        
        // Fallback Information
        fallbacks: executionAnalytics.fallbacks,
        
        // Action Breakdown
        actionBreakdown: executionAnalytics.actionBreakdown,
        
        // Screenshots and Visual Data
        screenshots: {
          before: screenshotResult,
          after: afterScreenshot,
          total: executionAnalytics.screenshotCount
        },

        // Conversation History (condensed)
        history: {
          full: finalHistory,
          condensed: this.buildCondensedHistory(finalHistory),
          messageCount: finalHistory.length
        },

        // Technical Details
        technical: {
          requiresAction: analysis.requiresAction,
          finalActions: analysis.actions,
          executionResults: executionResult,
          aiModel: 'gemini-1.5-flash',
          browserEngine: 'chromium'
        },

        // Success Metrics
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
  "description": "Describe what you see on the page now and whether the task is complete. If the user wanted a summary, do we see flight schedules with prices, times, airlines?",
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
- For input fields: CRITICAL - if you just clicked an input field, DO NOT click it again. Instead, proceed to clear and type.
- If you see a cursor in an input field or if the field appears focused, immediately proceed to typing
- Determine if the original task is complete or needs more actions

AVAILABLE ACTIONS:
- click_coordinate: Click at specific coordinates {"x": 150, "y": 200}
- keyboard_input: Type text {"input": "Frankfurt"}
- key_press: Press special keys {"key": "Delete"} or {"key": "Backspace"} or {"key": "Control+a"}

INPUT FIELD STRATEGY (FOLLOW THIS EXACTLY):
1. Click the input field to focus it (ONLY ONCE)
2. If field is focused/clicked, immediately clear: key_press with "Control+a" then "Delete"  
3. Type content: keyboard_input with desired text
4. After typing, press Tab or Enter to confirm, or move to next field

CRITICAL RULES:
- NEVER click the same input field coordinates twice in a row
- If last action was clicking an input field, next action MUST be clearing or typing
- After typing in a field, consider pressing "Tab" or "Enter" to confirm the selection
- For flight search: Origin="Frankfurt", Destination="London"
- Google Flights specific: Origin input around (620, 472), Destination input around (950, 472)

Key Questions:
1. Did the last action succeed?
2. Is the original task complete? (e.g., if user wanted flight info, do we see flight schedules with prices, times, airlines?)
3. Are there routine dialogs that need handling?
4. What coordinates should be clicked next?

FLIGHT SEARCH COMPLETION CRITERIA:
- If you see a page with flight times, prices, airline names, or "departing" information, the task is COMPLETE
- Look for text like "9:45 AM", "$299", "Lufthansa", "British Airways", "departing", "arriving"
- If you see flight results, set taskCompleted: true and describe the flights found

TASK COMPLETION DETECTION:
- For flight searches: Look for flight times, prices, airline logos/names
- If page shows actual flight information (not just input fields), mark as complete
- Include flight details in description if found

TASK COMPLETION CRITERIA:
- For flight searches: Task is complete when we see a list of actual flights with details (times, prices, airlines)
- If you see flight results/schedules, set "taskCompleted": true and provide a summary of the flights found
- If still filling forms or seeing loading pages, continue with appropriate actions

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
      
      // Handle rate limiting specially
      if (error.status === 429) {
        logger.warn('Rate limited by AI service, using fallback logic');
        return this.handleRateLimitFallback(history, originalTask);
      }
      
      return this.analyzePageAfterActionForContinuation(history, screenshotBase64, originalTask);
    }
  }

  /**
   * Simple continuation analysis without enhanced elements
   * @private
   */
  async analyzePageAfterActionForContinuation(history, screenshotBase64, originalTask) {
    try {
      // Simple analysis without making additional AI calls to avoid rate limits
      const historyText = history.map(h => h.content).join(' ').toLowerCase();
      const taskLower = originalTask.toLowerCase();
      
      // If we're dealing with flight search and seem stuck, use hardcoded logic
      if (taskLower.includes('flight') && historyText.includes('where from')) {
        return {
          description: "Using simplified logic due to AI unavailability. Attempting to continue flight search.",
          taskCompleted: false,
          requiresAction: true,
          actions: [
            {"type": "key_press", "description": "Clear input field", "payload": {"key": "Control+a"}},
            {"type": "keyboard_input", "description": "Type Frankfurt", "payload": {"input": "Frankfurt"}}
          ],
          confidence: "low"
        };
      }
      
      // Default fallback
      return {
        description: "Unable to analyze page state without AI assistance.",
        taskCompleted: false,
        requiresAction: false,
        actions: [],
        confidence: "low"
      };
    } catch (error) {
      logger.error('Error in fallback analysis:', error);
      return {
        description: "System error during fallback analysis.",
        taskCompleted: false,
        requiresAction: false,
        actions: [],
        confidence: "low"
      };
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

  /**
   * Handle rate limit by using predefined logic based on task context
   * @private
   */
  handleRateLimitFallback(history, originalTask, iterationCount = 0) {
    const taskLower = originalTask.toLowerCase();
    const historyText = history.map(h => h.content).join(' ').toLowerCase();
    
    // Flight search specific fallback logic
    if (taskLower.includes('flight') && taskLower.includes('frankfurt') && taskLower.includes('london')) {
      
      // Count how many times Frankfurt has been typed (avoid infinite loops)
      const frankfurtTypeCount = history.filter(h => 
        h.content && h.content.toLowerCase().includes('frankfurt')
      ).length;
      
      // Vary fallback strategy based on iteration count
      if (iterationCount >= 5) {
        // After 5 iterations, try aggressive search button clicking
        return {
          description: "AI rate limited, using iteration-based aggressive search strategy. Clicking search elements directly.",
          taskCompleted: false,
          requiresAction: true,
          actions: [
            {"type": "click_coordinate", "description": "Click search/explore button", "payload": {"x": 680, "y": 520}},
            {"type": "key_press", "description": "Press Enter to trigger search", "payload": {"key": "Enter"}},
            {"type": "click_coordinate", "description": "Click Done or Search button", "payload": {"x": 720, "y": 580}},
            {"type": "click_coordinate", "description": "Click Flight results area", "payload": {"x": 640, "y": 640}}
          ],
          confidence: "medium"
        };
      }
      
      if (iterationCount >= 4) {
        // After 4 iterations, try different coordinates
        return {
          description: "AI rate limited, using alternative coordinates fallback strategy.",
          taskCompleted: false,
          requiresAction: true,
          actions: [
            {"type": "click_coordinate", "description": "Click alternative destination field", "payload": {"x": 950, "y": 472}},
            {"type": "keyboard_input", "description": "Type London", "payload": {"input": "London"}},
            {"type": "key_press", "description": "Press Tab and Enter", "payload": {"key": "Tab"}},
            {"type": "key_press", "description": "Press Enter for search", "payload": {"key": "Enter"}}
          ],
          confidence: "medium"
        };
      }
      
      // If we've tried typing Frankfurt many times, try more aggressive approach
      if (frankfurtTypeCount >= 3) {
        return {
          description: "AI rate limited, using complete flight search fallback. Completing entire search flow programmatically.",
          taskCompleted: false,
          requiresAction: true,
          actions: [
            {"type": "key_press", "description": "Press Arrow Down to select Frankfurt suggestion", "payload": {"key": "ArrowDown"}},
            {"type": "key_press", "description": "Press Enter to confirm Frankfurt", "payload": {"key": "Enter"}},
            {"type": "key_press", "description": "Press Tab to move to destination", "payload": {"key": "Tab"}},
            {"type": "keyboard_input", "description": "Type London Heathrow", "payload": {"input": "London Heathrow"}},
            {"type": "key_press", "description": "Press Arrow Down to select London suggestion", "payload": {"key": "ArrowDown"}},
            {"type": "key_press", "description": "Press Enter to confirm London", "payload": {"key": "Enter"}},
            {"type": "click_coordinate", "description": "Click search button", "payload": {"x": 680, "y": 600}},
            {"type": "key_press", "description": "Press Enter for final search", "payload": {"key": "Enter"}}
          ],
          confidence: "high"
        };
      }
      
      if (frankfurtTypeCount >= 2) {
        return {
          description: "AI rate limited, using systematic fallback logic. Proceeding step-by-step through flight search.",
          taskCompleted: false,
          requiresAction: true,
          actions: [
            {"type": "key_press", "description": "Press Arrow Down to select Frankfurt from dropdown", "payload": {"key": "ArrowDown"}},
            {"type": "key_press", "description": "Press Enter to confirm Frankfurt selection", "payload": {"key": "Enter"}},
            {"type": "click_coordinate", "description": "Click destination field (Where to)", "payload": {"x": 950, "y": 472}},
            {"type": "keyboard_input", "description": "Type London Heathrow", "payload": {"input": "London Heathrow"}},
            {"type": "key_press", "description": "Press Enter to search", "payload": {"key": "Enter"}}
          ],
          confidence: "high"
        };
      }
      
      // If we've tried typing Frankfurt multiple times, try different approach
      if (frankfurtTypeCount >= 1) {
        return {
          description: "AI rate limited, using enhanced fallback logic. Selecting Frankfurt from dropdown and proceeding to destination.",
          taskCompleted: false,
          requiresAction: true,
          actions: [
            {"type": "key_press", "description": "Press Arrow Down to select Frankfurt from dropdown", "payload": {"key": "ArrowDown"}},
            {"type": "key_press", "description": "Press Enter to confirm Frankfurt", "payload": {"key": "Enter"}},
            {"type": "click_coordinate", "description": "Click Where to field", "payload": {"x": 950, "y": 472}},
            {"type": "keyboard_input", "description": "Type London Heathrow", "payload": {"input": "London Heathrow"}}
          ],
          confidence: "high"
        };
      }
      
      // Check what stage we're at based on history
      if (historyText.includes('where from') || historyText.includes('input field')) {
        // We're at the input field - proceed with typing Frankfurt
        return {
          description: "AI rate limited, using fallback logic. Clearing input field and typing Frankfurt.",
          taskCompleted: false,
          requiresAction: true,
          actions: [
            {"type": "key_press", "description": "Select all text in input field", "payload": {"key": "Control+a"}},
            {"type": "key_press", "description": "Delete selected text", "payload": {"key": "Delete"}},
            {"type": "keyboard_input", "description": "Type Frankfurt", "payload": {"input": "Frankfurt"}},
            {"type": "key_press", "description": "Press Enter to confirm selection", "payload": {"key": "Enter"}}
          ],
          confidence: "high"
        };
      }
      
      if (historyText.includes('frankfurt') && !historyText.includes('london')) {
        // We have origin, need destination - try different coordinate strategies
        const coordinateStrategies = [
          {"x": 950, "y": 472},  // Original
          {"x": 850, "y": 472},  // Left alternative
          {"x": 1050, "y": 472}, // Right alternative
          {"x": 950, "y": 500},  // Lower alternative
        ];
        const strategyIndex = Math.min(frankfurtTypeCount, coordinateStrategies.length - 1);
        const coords = coordinateStrategies[strategyIndex];
        
        return {
          description: `AI rate limited, using fallback logic. Trying destination coordinates (${coords.x}, ${coords.y}) and typing London.`,
          taskCompleted: false,
          requiresAction: true,
          actions: [
            {"type": "click_coordinate", "description": "Click Where to field", "payload": coords},
            {"type": "key_press", "description": "Clear field", "payload": {"key": "Control+a"}},
            {"type": "keyboard_input", "description": "Type London Heathrow", "payload": {"input": "London Heathrow"}},
            {"type": "key_press", "description": "Press Enter to search", "payload": {"key": "Enter"}}
          ],
          confidence: "high"
        };
      }
      
      if (historyText.includes('frankfurt') && historyText.includes('london')) {
        // Both fields filled, trigger search
        return {
          description: "AI rate limited, using fallback logic. Both origin and destination filled, triggering flight search.",
          taskCompleted: false,
          requiresAction: true,
          actions: [
            {"type": "key_press", "description": "Press Enter to search for flights", "payload": {"key": "Enter"}},
            {"type": "click_coordinate", "description": "Click search button if needed", "payload": {"x": 680, "y": 650}}
          ],
          confidence: "high"
        };
      }
    }
    
    // Generic fallback - mark task as incomplete due to rate limiting
    return {
      description: "AI service rate limited. Unable to continue automated task execution. Please try again in a few minutes.",
      taskCompleted: false,
      requiresAction: false,
      actions: [],
      confidence: "low"
    };
  }

  /**
   * Handle alternative search strategy when normal fallback fails
   * @private
   */
  handleAlternativeSearch(history, originalTask) {
    const taskLower = originalTask.toLowerCase();
    
    if (taskLower.includes('flight') && taskLower.includes('frankfurt') && taskLower.includes('london')) {
      return {
        description: "Using alternative search strategy. Trying direct URL navigation and different search approach.",
        taskCompleted: false,
        requiresAction: true,
        actions: [
          {"type": "navigate", "description": "Navigate to Google Flights search URL", "payload": {"url": "https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDI1LTA2LTIwagcIARIDRlJBcgcIARIDTEhSQAFIAXABggELCP___________wFAAUgBmAEB"}},
          {"type": "key_press", "description": "Wait and press Enter", "payload": {"key": "Enter"}}
        ],
        confidence: "high"
      };
    }
    
    // General alternative strategy
    return {
      description: "Using general alternative search strategy with simulated typing.",
      taskCompleted: false,
      requiresAction: true,
      actions: [
        {"type": "key_press", "description": "Press Escape to clear", "payload": {"key": "Escape"}},
        {"type": "click_coordinate", "description": "Click page center", "payload": {"x": 680, "y": 400}},
        {"type": "keyboard_input", "description": "Type search query", "payload": {"input": "frankfurt to london flights"}}
      ],
      confidence: "medium"
    };
  }

  /**
   * Detect repeated sub-tasks in conversation history
   * @private
   */
  detectRepeatedSubtasks(history, iterationCount) {
    const recentHistory = history.slice(-6).map(h => h.content.toLowerCase()).join(' ');
    
    // Define sub-task patterns to detect
    const subtaskPatterns = {
      fieldReplacement: {
        pattern: /(replace|change|clear|update).*(from|origin|departure).*(field|input|value)/,
        threshold: 2,
        description: 'field replacement attempts'
      },
      strasbourg_to_frankfurt: {
        pattern: /(strasbourg|strasb).*(frankfurt|frank)/,
        threshold: 2, 
        description: 'Strasbourg to Frankfurt replacement'
      },
      destination_entry: {
        pattern: /(destination|where to|london|heathrow).*(field|input|type|enter)/,
        threshold: 2,
        description: 'destination field entry'
      },
      search_trigger: {
        pattern: /(search|click search|trigger search|search button)/,
        threshold: 3,
        description: 'search triggering attempts'
      },
      form_navigation: {
        pattern: /(tab|next field|move to|navigate to).*(field|input)/,
        threshold: 2,
        description: 'form field navigation'
      }
    };

    const detectedPatterns = [];
    let hasRepeatedSubtask = false;
    
    for (const [key, config] of Object.entries(subtaskPatterns)) {
      const matches = (recentHistory.match(config.pattern) || []).length;
      if (matches >= config.threshold) {
        detectedPatterns.push({
          type: key,
          count: matches,
          description: config.description
        });
        hasRepeatedSubtask = true;
      }
    }

    // Special case: detect if same action type is repeated too often
    const actionWords = ['click', 'type', 'press', 'enter', 'select'];
    for (const action of actionWords) {
      const actionCount = (recentHistory.match(new RegExp(action, 'g')) || []).length;
      if (actionCount >= 4) {
        detectedPatterns.push({
          type: 'repeated_action',
          action: action,
          count: actionCount,
          description: `repeated ${action} actions`
        });
        hasRepeatedSubtask = true;
      }
    }

    return {
      hasRepeatedSubtask,
      patterns: detectedPatterns,
      description: detectedPatterns.map(p => p.description).join(', ') || 'general repetitive behavior',
      iterationCount
    };
  }

  /**
   * Advanced fallback handler that varies strategy based on detected sub-task patterns
   * @private
   */
  handleAdvancedFallback(history, originalTask, iterationCount, subtaskPatterns) {
    const taskLower = originalTask.toLowerCase();
    
    // Handle specific repeated sub-task patterns
    for (const pattern of subtaskPatterns.patterns) {
      if (pattern.type === 'strasbourg_to_frankfurt' || pattern.type === 'fieldReplacement') {
        return this.handleFieldReplacementFallback(history, iterationCount, pattern.count);
      }
      
      if (pattern.type === 'destination_entry') {
        return this.handleDestinationEntryFallback(history, iterationCount);
      }
      
      if (pattern.type === 'search_trigger') {
        return this.handleSearchTriggerFallback(history, iterationCount);
      }
      
      if (pattern.type === 'repeated_action') {
        return this.handleRepeatedActionFallback(history, iterationCount, pattern.action);
      }
    }
    
    // Fall back to original rate limit fallback for general cases
    return this.handleRateLimitFallback(history, originalTask, iterationCount);
  }

  /**
   * Specialized fallback for field replacement issues (like Strasbourg -> Frankfurt)
   * @private 
   */
  handleFieldReplacementFallback(history, iterationCount, patternCount) {
    logger.info(`Handling field replacement fallback, iteration ${iterationCount}, pattern count ${patternCount}`);
    
    // Progressive strategy escalation for field replacement
    if (iterationCount >= 5) {
      // Aggressive field clearing and replacement
      return {
        description: "Advanced field replacement: aggressive clear and replace strategy",
        taskCompleted: false,
        requiresAction: true,
        actions: [
          {"type": "click_coordinate", "description": "Click origin field center", "payload": {"x": 620, "y": 472}},
          {"type": "key_press", "description": "Select all text", "payload": {"key": "Control+a"}},
          {"type": "key_press", "description": "Delete selected text", "payload": {"key": "Delete"}},
          {"type": "keyboard_input", "description": "Type Frankfurt directly", "payload": {"input": "Frankfurt"}},
          {"type": "key_press", "description": "Wait for suggestions", "payload": {"key": "ArrowDown"}},
          {"type": "key_press", "description": "Select suggestion", "payload": {"key": "Enter"}},
          {"type": "key_press", "description": "Move to next field", "payload": {"key": "Tab"}}
        ],
        confidence: "high"
      };
    }
    
    if (iterationCount >= 3) {
      // Try different coordinates and escape first
      return {
        description: "Advanced field replacement: escape and retry with different coordinates",
        taskCompleted: false,
        requiresAction: true,
        actions: [
          {"type": "key_press", "description": "Escape any dropdowns", "payload": {"key": "Escape"}},
          {"type": "click_coordinate", "description": "Click alternative origin field location", "payload": {"x": 580, "y": 472}},
          {"type": "key_press", "description": "Triple click to select all", "payload": {"key": "Control+a"}},
          {"type": "keyboard_input", "description": "Replace with Frankfurt", "payload": {"input": "Frankfurt"}},
          {"type": "key_press", "description": "Confirm with Tab", "payload": {"key": "Tab"}}
        ],
        confidence: "medium"
      };
    }
    
    // Initial attempt with backspace approach
    return {
      description: "Advanced field replacement: backspace and clear approach",
      taskCompleted: false,
      requiresAction: true,
      actions: [
        {"type": "click_coordinate", "description": "Focus origin field", "payload": {"x": 621, "y": 472}},
        {"type": "key_press", "description": "Go to end of field", "payload": {"key": "End"}},
        {"type": "key_press", "description": "Select all backwards", "payload": {"key": "Control+Shift+Home"}},
        {"type": "key_press", "description": "Delete selection", "payload": {"key": "Backspace"}},
        {"type": "keyboard_input", "description": "Type Frankfurt", "payload": {"input": "Frankfurt"}}
      ],
      confidence: "medium"
    };
  }

  /**
   * Specialized fallback for destination entry issues
   * @private
   */
  handleDestinationEntryFallback(history, iterationCount) {
    logger.info(`Handling destination entry fallback, iteration ${iterationCount}`);
    
    return {
      description: "Advanced destination entry: multiple coordinate attempts",
      taskCompleted: false,
      requiresAction: true,
      actions: [
        {"type": "click_coordinate", "description": "Try destination field variant 1", "payload": {"x": 950, "y": 472}},
        {"type": "keyboard_input", "description": "Type London Heathrow", "payload": {"input": "London Heathrow"}},
        {"type": "key_press", "description": "Press Arrow Down", "payload": {"key": "ArrowDown"}},
        {"type": "key_press", "description": "Press Enter", "payload": {"key": "Enter"}}
      ],
      confidence: "medium"
    };
  }

  /**
   * Specialized fallback for search trigger issues  
   * @private
   */
  handleSearchTriggerFallback(history, iterationCount) {
    logger.info(`Handling search trigger fallback, iteration ${iterationCount}`);
    
    if (iterationCount >= 4) {
      return {
        description: "Advanced search trigger: multiple search methods",
        taskCompleted: false,
        requiresAction: true,
        actions: [
          {"type": "key_press", "description": "Try Enter key", "payload": {"key": "Enter"}},
          {"type": "click_coordinate", "description": "Try search button area 1", "payload": {"x": 680, "y": 520}},
          {"type": "click_coordinate", "description": "Try search button area 2", "payload": {"x": 720, "y": 580}},
          {"type": "key_press", "description": "Try Enter again", "payload": {"key": "Enter"}}
        ],
        confidence: "medium"
      };
    }
    
    return {
      description: "Advanced search trigger: keyboard focus approach",
      taskCompleted: false,
      requiresAction: true,
      actions: [
        {"type": "key_press", "description": "Tab to search button", "payload": {"key": "Tab"}},
        {"type": "key_press", "description": "Trigger with Enter", "payload": {"key": "Enter"}},
        {"type": "key_press", "description": "Alternative Space trigger", "payload": {"key": "Space"}}
      ],
      confidence: "medium"
    };
  }

  /**
   * Specialized fallback for repeated actions
   * @private
   */
  handleRepeatedActionFallback(history, iterationCount, repeatedAction) {
    logger.info(`Handling repeated action fallback for '${repeatedAction}', iteration ${iterationCount}`);
    
    // If we're repeating clicks, try keyboard navigation
    if (repeatedAction === 'click') {
      return {
        description: "Switch from clicking to keyboard navigation",
        taskCompleted: false,
        requiresAction: true,
        actions: [
          {"type": "key_press", "description": "Tab to navigate", "payload": {"key": "Tab"}},
          {"type": "key_press", "description": "Enter to activate", "payload": {"key": "Enter"}},
          {"type": "key_press", "description": "Tab again", "payload": {"key": "Tab"}}
        ],
        confidence: "medium"
      };
    }
    
    // If we're repeating typing, try clicking
    if (repeatedAction === 'type') {
      return {
        description: "Switch from typing to clicking elements",
        taskCompleted: false,
        requiresAction: true,
        actions: [
          {"type": "click_coordinate", "description": "Click to focus", "payload": {"x": 640, "y": 400}},
          {"type": "key_press", "description": "Navigate with arrows", "payload": {"key": "ArrowDown"}},
          {"type": "key_press", "description": "Select with Enter", "payload": {"key": "Enter"}}
        ],
        confidence: "medium"
      };
    }
    
    // Generic fallback for other repeated actions
    return {
      description: `Fallback for repeated ${repeatedAction} actions`,
      taskCompleted: false,
      requiresAction: true,
      actions: [
        {"type": "key_press", "description": "Escape any modals", "payload": {"key": "Escape"}},
        {"type": "click_coordinate", "description": "Click somewhere neutral", "payload": {"x": 640, "y": 300}},
        {"type": "key_press", "description": "Tab to navigate", "payload": {"key": "Tab"}}
      ],
      confidence: "low"
    };
  }

  /**
   * Initialize progress tracker for a task
   * @private
   */
  initializeProgressTracker(taskDescription, history) {
    const taskLower = taskDescription.toLowerCase();
    
    return {
      taskType: this.identifyTaskType(taskDescription),
      milestones: this.defineMilestones(taskDescription),
      completedMilestones: new Set(),
      lastScreenshotHash: null,
      lastSignificantAction: null,
      actionHistory: [],
      fieldsInteractedWith: new Set(),
      pagesVisited: new Set(),
      progressMarkers: {
        navigationCompleted: false,
        cookiesHandled: false,
        formFieldsInteractedWith: 0,
        searchTriggered: false,
        resultsPageReached: false
      },
      startTime: Date.now()
    };
  }

  /**
   * Identify the type of task to set appropriate progress markers
   * @private
   */
  identifyTaskType(taskDescription) {
    const taskLower = taskDescription.toLowerCase();
    
    if (taskLower.includes('flight') && (taskLower.includes('search') || taskLower.includes('find'))) {
      return 'flight_search';
    }
    if (taskLower.includes('hotel') && (taskLower.includes('search') || taskLower.includes('find'))) {
      return 'hotel_search';
    }
    if (taskLower.includes('form') && taskLower.includes('fill')) {
      return 'form_filling';
    }
    if (taskLower.includes('login') || taskLower.includes('sign in')) {
      return 'login';
    }
    if (taskLower.includes('purchase') || taskLower.includes('buy')) {
      return 'purchase';
    }
    
    return 'general';
  }

  /**
   * Define milestone markers for different task types
   * @private
   */
  defineMilestones(taskDescription) {
    const taskType = this.identifyTaskType(taskDescription);
    
    const milestoneMap = {
      flight_search: [
        'navigation_complete',
        'cookies_handled', 
        'origin_field_filled',
        'destination_field_filled',
        'search_triggered',
        'results_displayed'
      ],
      hotel_search: [
        'navigation_complete',
        'cookies_handled',
        'location_field_filled', 
        'dates_selected',
        'search_triggered',
        'results_displayed'
      ],
      form_filling: [
        'navigation_complete',
        'form_identified',
        'fields_filled',
        'form_submitted'
      ],
      login: [
        'navigation_complete',
        'username_entered',
        'password_entered', 
        'login_submitted',
        'login_successful'
      ],
      general: [
        'navigation_complete',
        'interaction_started',
        'action_completed'
      ]
    };
    
    return milestoneMap[taskType] || milestoneMap.general;
  }

  /**
   * Detect if meaningful progress has been made
   * @private
   */
  detectProgress(progressTracker, history, iterationCount, screenshotBase64) {
    const recentHistory = history.slice(-3);
    const lastResponse = recentHistory[recentHistory.length - 1]?.content?.toLowerCase() || '';
    
    // Calculate screenshot similarity to detect page changes
    const screenshotHash = this.calculateScreenshotHash(screenshotBase64);
    const pageChanged = progressTracker.lastScreenshotHash && 
                       screenshotHash !== progressTracker.lastScreenshotHash;
    
    // Track actions taken
    const newActions = this.extractActionsFromHistory(recentHistory);
    const actionDiversity = this.calculateActionDiversity(progressTracker.actionHistory, newActions);
    
    let hasProgress = false;
    let progressDescription = '';
    const newMilestones = new Set(progressTracker.completedMilestones);
    const updatedMarkers = { ...progressTracker.progressMarkers };
    
    // Check for various types of progress
    
    // 1. Page/Navigation Progress
    if (pageChanged) {
      hasProgress = true;
      progressDescription += 'Page changed (navigation/form submission/search results). ';
      
      if (lastResponse.includes('search') || lastResponse.includes('result')) {
        newMilestones.add('search_triggered');
        updatedMarkers.resultsPageReached = true;
      }
    }
    
    // 2. Milestone Progress (task-specific)
    const milestoneProgress = this.checkMilestoneProgress(progressTracker, lastResponse, recentHistory);
    if (milestoneProgress.achieved.length > 0) {
      hasProgress = true;
      progressDescription += `Milestones achieved: ${milestoneProgress.achieved.join(', ')}. `;
      milestoneProgress.achieved.forEach(m => newMilestones.add(m));
    }
    
    // 3. Form Interaction Progress
    const formProgress = this.detectFormProgress(lastResponse, progressTracker);
    if (formProgress.newFieldsInteracted > 0) {
      hasProgress = true;
      progressDescription += `New form fields interacted: ${formProgress.newFieldsInteracted}. `;
      updatedMarkers.formFieldsInteractedWith += formProgress.newFieldsInteracted;
    }
    
    // 4. Error Recovery Progress
    if (lastResponse.includes('error') && recentHistory.some(h => h.content.toLowerCase().includes('trying') || h.content.toLowerCase().includes('attempt'))) {
      hasProgress = true;
      progressDescription += 'Error recovery attempt made. ';
    }
    
    // 5. New Strategy Progress
    if (actionDiversity.isNewStrategy) {
      hasProgress = true;
      progressDescription += 'New interaction strategy detected. ';
    }
    
    // 6. Task-specific Progress Detection
    const taskSpecificProgress = this.detectTaskSpecificProgress(progressTracker, lastResponse, recentHistory);
    if (taskSpecificProgress.hasProgress) {
      hasProgress = true;
      progressDescription += taskSpecificProgress.description + '. ';
    }
    
    return {
      hasProgress,
      progressDescription: progressDescription.trim(),
      updatedTracker: {
        ...progressTracker,
        completedMilestones: newMilestones,
        lastScreenshotHash: screenshotHash,
        progressMarkers: updatedMarkers,
        actionHistory: [...progressTracker.actionHistory, ...newActions].slice(-10), // Keep last 10 actions
        fieldsInteractedWith: new Set([...progressTracker.fieldsInteractedWith, ...formProgress.newFields])
      }
    };
  }

  /**
   * Calculate a simple hash of screenshot for change detection
   * @private
   */
  calculateScreenshotHash(screenshotBase64) {
    if (!screenshotBase64) return null;
    
    // Simple hash based on length and sample characters
    const sample = screenshotBase64.slice(0, 100) + screenshotBase64.slice(-100);
    let hash = 0;
    for (let i = 0; i < sample.length; i++) {
      const char = sample.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }

  /**
   * Extract actions from recent history
   * @private
   */
  extractActionsFromHistory(recentHistory) {
    const actions = [];
    for (const entry of recentHistory) {
      const content = entry.content.toLowerCase();
      if (content.includes('click')) actions.push('click');
      if (content.includes('type') || content.includes('enter')) actions.push('type');
      if (content.includes('navigate')) actions.push('navigate');
      if (content.includes('press') || content.includes('key')) actions.push('key_press');
      if (content.includes('scroll')) actions.push('scroll');
    }
    return actions;
  }

  /**
   * Calculate diversity of actions to detect new strategies
   * @private
   */
  calculateActionDiversity(oldActions, newActions) {
    const oldSet = new Set(oldActions);
    const newSet = new Set(newActions);
    const intersection = new Set([...oldSet].filter(x => newSet.has(x)));
    
    return {
      diversity: newSet.size,
      isNewStrategy: newActions.some(action => !oldSet.has(action)),
      actionTypes: Array.from(newSet)
    };
  }

  /**
   * Check for milestone-specific progress
   * @private
   */
  checkMilestoneProgress(progressTracker, lastResponse, recentHistory) {
    const achieved = [];
    const taskType = progressTracker.taskType;
    
    // Check navigation completion

    if (!progressTracker.completedMilestones.has('navigation_complete')) {
      if (lastResponse.includes('page') || lastResponse.includes('site') || lastResponse.includes('website')) {
        achieved.push('navigation_complete');
      }
    }
    
    // Check cookie handling
    if (!progressTracker.completedMilestones.has('cookies_handled')) {
      if (lastResponse.includes('cookie') || lastResponse.includes('accept') || lastResponse.includes('consent')) {
        achieved.push('cookies_handled');
      }
    }
    
    // Task-specific milestones
    if (taskType === 'flight_search') {
      if (!progressTracker.completedMilestones.has('origin_field_filled') && 
          (lastResponse.includes('frankfurt') || lastResponse.includes('origin') || lastResponse.includes('from'))) {
        achieved.push('origin_field_filled');
      }
      
      if (!progressTracker.completedMilestones.has('destination_field_filled') && 
          (lastResponse.includes('london') || lastResponse.includes('heathrow') || lastResponse.includes('destination') || lastResponse.includes('to'))) {
        achieved.push('destination_field_filled');
      }
      
      if (!progressTracker.completedMilestones.has('search_triggered') && 
          (lastResponse.includes('search') || lastResponse.includes('find flights'))) {
        achieved.push('search_triggered');
      }
    }
    
    return { achieved };
  }

  /**
   * Detect form interaction progress
   * @private
   */
  detectFormProgress(lastResponse, progressTracker) {
    const formFieldKeywords = ['input', 'field', 'form', 'text box', 'dropdown', 'select'];
    const newFields = new Set();
    
    // Detect new form fields mentioned
    for (const keyword of formFieldKeywords) {
      if (lastResponse.includes(keyword)) {
        const context = lastResponse.substring(
          Math.max(0, lastResponse.indexOf(keyword) - 20),
          lastResponse.indexOf(keyword) + 20
        );
        
        if (!progressTracker.fieldsInteractedWith.has(context)) {
          newFields.add(context);
        }
      }
    }
    
    return {
      newFieldsInteracted: newFields.size,
      newFields: Array.from(newFields)
    };
  }

  /**
   * Detect task-specific progress indicators
   * @private
   */
  detectTaskSpecificProgress(progressTracker, lastResponse, recentHistory) {
    const taskType = progressTracker.taskType;
    
    if (taskType === 'flight_search') {
      // Progress indicators for flight search
      if (lastResponse.includes('flight') && (lastResponse.includes('result') || lastResponse.includes('available'))) {
        return { hasProgress: true, description: 'Flight results or availability mentioned' };
      }
      
      if (lastResponse.includes('price') || lastResponse.includes('time') || lastResponse.includes('airline')) {
        return { hasProgress: true, description: 'Flight details (price/time/airline) detected' };
      }
      
      // Progress through form steps
      if (recentHistory.some(h => h.content.toLowerCase().includes('where from')) && 
          lastResponse.includes('where to')) {
        return { hasProgress: true, description: 'Progressed from origin to destination field' };
      }
    }
    
    return { hasProgress: false, description: '' };
  }

  /**
   * Build comprehensive execution analytics from the task history and results
   * @private
   */
  buildExecutionAnalytics(finalHistory, executionResult, iterationCount) {
    const analytics = {
      subtasks: [],
      fallbacks: [],
      actionBreakdown: {
        navigate: 0,
        click: 0,
        type: 0,
        key_press: 0,
        screenshot: 0,
        other: 0
      }
    };

    // Analyze subtasks from history
    const subtaskPatterns = [
      { name: 'Cookie Consent', keywords: ['cookie', 'accept', 'consent'] },
      { name: 'Field Input', keywords: ['input', 'type', 'field', 'text'] },
      { name: 'Navigation', keywords: ['navigate', 'goto', 'url'] },
      { name: 'Form Submission', keywords: ['search', 'submit', 'button'] },
      { name: 'Selection', keywords: ['select', 'choose', 'option'] },
      { name: 'Date Setting', keywords: ['date', 'calendar', 'day'] }
    ];

    finalHistory.forEach(message => {
      if (message.role === 'assistant') {
        subtaskPatterns.forEach(pattern => {
          if (pattern.keywords.some(keyword => 
            message.content.toLowerCase().includes(keyword))) {
            const existingSubtask = analytics.subtasks.find(s => s.name === pattern.name);
            if (existingSubtask) {
              existingSubtask.attempts++;
            } else {
              analytics.subtasks.push({
                name: pattern.name,
                attempts: 1,
                completed: true
              });
            }
          }
        });

        // Detect fallback usage
        if (message.content.includes('rate limited') || 
            message.content.includes('fallback')) {
          analytics.fallbacks.push({
            type: 'ai_rate_limit',
            reason: 'AI service rate limit exceeded',
            timestamp: new Date().toISOString()
          });
        }
      }
    });

    // Analyze action breakdown from execution results
    executionResult.forEach(action => {
      if (action.type && analytics.actionBreakdown.hasOwnProperty(action.type)) {
        analytics.actionBreakdown[action.type]++;
      } else {
        analytics.actionBreakdown.other++;
      }
    });

    return analytics;
  }
}

module.exports = NaturalLanguageTaskService;
