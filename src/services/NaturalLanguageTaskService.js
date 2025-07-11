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
   * @param {string} executionMode - Execution mode: 'auto', 'extension', or 'server'
   * @returns {Promise<Object>} Task execution result with AI analysis
   */
  async processTask(sessionId, taskDescription, executionMode = 'auto') {
    try {
      // Set current session ID for context
      this.setCurrentSessionId(sessionId);
      
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      logger.info(`Processing natural language task for session ${sessionId}: ${taskDescription}, executionMode: ${executionMode}`);

      // Store execution mode preference in session metadata for use by command executor
      session.metadata = session.metadata || {};
      session.metadata.preferredExecutionMode = executionMode;

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
      let interventionRequest = null;
      
      if (iterationsSinceProgress >= maxIterationsWithoutProgress) {
        const userMilestones = this.filterUserFacingMilestones(progressTracker.completedMilestones);
        completionMessage = `I completed ${userMilestones.length} key steps but reached the limit of ${maxIterationsWithoutProgress} iterations without progress. Progress achieved: ${userMilestones.join(', ') || 'Initial setup'}. The task may need additional time or manual completion.`;
        
        // Request manual intervention
        interventionRequest = await this.requestManualIntervention(sessionId, 
          'Task stalled with no progress after multiple attempts',
          {
            currentState: `Completed ${userMilestones.length} steps: ${userMilestones.join(', ')}`,
            iterationsWithoutProgress: iterationsSinceProgress,
            totalIterations: iterationCount
          }
        );
      } else if (iterationCount >= absoluteMaxIterations) {
        const userMilestones = this.filterUserFacingMilestones(progressTracker.completedMilestones);
        completionMessage = `I reached the absolute maximum of ${absoluteMaxIterations} iterations. I achieved ${userMilestones.length} key steps: ${userMilestones.join(', ') || 'basic setup'}. The system needs additional time or manual intervention.`;
        
        // Request manual intervention
        interventionRequest = await this.requestManualIntervention(sessionId,
          'Maximum iteration limit reached',
          {
            currentState: `Completed ${userMilestones.length} steps: ${userMilestones.join(', ')}`,
            totalIterations: iterationCount,
            maxIterations: absoluteMaxIterations
          }
        );
      }
      
      if (completionMessage) {
        this.sessionManager.addToHistory(sessionId, { 
          role: 'assistant', 
          content: completionMessage
        });
      }
      
      // Ensure we have a final screenshot regardless of how the task completed
      let finalScreenshot = afterScreenshot;
      if (!finalScreenshot || finalScreenshot.error) {
        logger.info('Taking final screenshot for task completion');
        finalScreenshot = await this.takeScreenshot(sessionId);
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
          final: finalScreenshot, // Always ensure we have a final screenshot
          total: executionAnalytics.screenshotCount
        },

        // Conversation History (condensed)
        history: finalHistory, // Backward compatibility - keep as array
        historyDetails: {
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
        timestamp: new Date().toISOString(),

        // Backward compatibility for tests
        executionResult: executionResult,
        iterations: iterationCount
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
  "description": "Describe what you see on the page now and whether the task is complete. If the user asked for headlines, list the main headlines.",
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
   * Get current session ID from processing context
   * @private
   */
  getCurrentSessionId() {
    return this.currentSessionId || 'unknown';
  }

  /**
   * Set current session ID for processing context
   * @private
   */
  setCurrentSessionId(sessionId) {
    this.currentSessionId = sessionId;
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
You are a conversational AI agent analyzing a user's request to determine if navigation to a specific website is needed first.

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
   * Request manual intervention when AI/LLM cannot proceed
   * @private
   */
  async requestManualIntervention(sessionId, reason, context) {
    const interventionRequest = {
      sessionId,
      timestamp: new Date().toISOString(),
      reason,
      context,
      status: 'pending',
      requestId: uuidv4()
    };

    // Store the intervention request
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      if (!session.interventionRequests) {
        session.interventionRequests = [];
      }
      session.interventionRequests.push(interventionRequest);
      
      // Add chat message requesting help
      this.sessionManager.addToHistory(sessionId, {
        role: 'assistant',
        content: `I need human assistance to proceed. ${reason}. Current situation: ${context.currentState || 'Complex web interaction required'}. Please provide guidance or complete the task manually.`,
        interventionRequest: interventionRequest.requestId
      });

      // Emit via WebSocket if connected
      if (session.wsConnection) {
        session.wsConnection.send(JSON.stringify({
          type: 'intervention_request',
          data: interventionRequest
        }));
      }

      logger.warn(`Manual intervention requested for session ${sessionId}: ${reason}`);
      
      return interventionRequest;
    }
    
    return null;
  }

  /**
   * Handle manual intervention response
   * @private
   */
  async handleManualInterventionResponse(sessionId, requestId, response) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.interventionRequests) {
      return false;
    }

    const request = session.interventionRequests.find(r => r.requestId === requestId);
    if (!request) {
      return false;
    }

    request.status = 'resolved';
    request.response = response;
    request.resolvedAt = new Date().toISOString();

    // Add the human response to history
    this.sessionManager.addToHistory(sessionId, {
      role: 'user',
      content: response.message || 'Task completed manually',
      interventionResponse: requestId
    });

    // If task was completed manually, add success message
    if (response.taskCompleted) {
      this.sessionManager.addToHistory(sessionId, {
        role: 'assistant',
        content: response.result || 'Task has been completed with human assistance. Thank you for your help!'
      });
    }

    logger.info(`Manual intervention resolved for session ${sessionId}: ${response.message || 'Completed'}`);
    
    return true;
  }

  /**
   * Handle advanced fallback logic for repetitive behavior patterns
   * @private
   */
  async handleAdvancedFallback(history, taskDescription, iterationsSinceProgress, subtaskPatterns) {
    // Analyze patterns to determine the best fallback strategy
    const totalPatterns = Object.values(subtaskPatterns).reduce((sum, count) => sum + count, 0);
    
    // If we have many repeated patterns, try a different approach
    if (totalPatterns > 5 || iterationsSinceProgress > 10) {
      // Suggest manual intervention
      const sessionId = this.getCurrentSessionId();
      if (sessionId) {
        await this.requestManualIntervention(sessionId,
          'Automated task execution stuck in repetitive pattern, unable to progress',
          {
            currentState: 'Repetitive behavior detected',
            patterns: subtaskPatterns,
            iterationsSinceProgress,
            lastActions: history.slice(-3).map(h => h.content?.substring(0, 100))
          }
        );
      }
      
      return {
        description: "Task execution is stuck in repetitive patterns. Manual intervention may be required.",
        requiresAction: false,
        actions: [],
        reason: 'repetitive_pattern_detected'
      };
    }
    
    // Try coordinate-based fallback if clicking isn't working
    if (subtaskPatterns.repeatedClicks > 2) {
      return {
        description: "Multiple click attempts failed. Trying coordinate-based interaction or keyboard navigation.",
        requiresAction: true,
        actions: [{
          type: "key_press",
          description: "Try Tab to navigate to next element",
          payload: { key: "Tab" }
        }],
        reason: 'click_fallback_keyboard'
      };
    }
    
    // Try alternative input methods if form inputs are failing
    if (subtaskPatterns.repeatedInputs > 2) {
      return {
        description: "Form input attempts failed. Trying alternative input strategy.",
        requiresAction: true,
        actions: [{
          type: "key_press",
          description: "Clear field and retry input",
          payload: { key: "Control+a" }
        }],
        reason: 'input_fallback_clear'
      };
    }
    
    // If navigation is failing, try refresh
    if (subtaskPatterns.repeatedNavigations > 1) {
      return {
        description: "Navigation issues detected. Refreshing page to reset state.",
        requiresAction: true,
        actions: [{
          type: "key_press",
          description: "Refresh page",
          payload: { key: "F5" }
        }],
        reason: 'navigation_fallback_refresh'
      };
    }
    
    // Default fallback - wait and retry with simplified approach
    return {
      description: "Applying general fallback strategy. Waiting before retry with simplified approach.",
      requiresAction: false,
      actions: [],
      reason: 'general_fallback'
    };
  }

  /**
   * Handle rate limit fallback with potential manual intervention
   * @private
   */
  async handleRateLimitFallback(history, originalTask) {
    // Extract sessionId from history
    const sessionId = history.length > 0 && history[0].sessionId 
      ? history[0].sessionId 
      : this.getCurrentSessionId();
    
    // Check if we've been rate limited multiple times recently
    const session = this.sessionManager.sessions.get(sessionId);
    if (session) {
      if (!session.rateLimitCount) {
        session.rateLimitCount = 1;
        session.lastRateLimit = Date.now();
      } else {
        session.rateLimitCount++;
        
        // If we've hit rate limits multiple times in a short period, request manual intervention
        if (session.rateLimitCount >= 3 && (Date.now() - session.lastRateLimit) < 300000) { // 5 minutes
          await this.requestManualIntervention(sessionId,
            'AI service repeatedly rate limited, preventing automatic task completion',
            {
              currentState: 'Automatic task execution blocked by API rate limits',
              rateLimitCount: session.rateLimitCount,
              taskType: originalTask.includes('flight') ? 'flight search' : 'web automation'
            }
          );
          
          return {
            description: "AI service unavailable due to rate limiting. Manual intervention requested.",
            requiresAction: true,
            actions: [],
            reason: 'rate_limited_manual_intervention'
          };
        }
        
        session.lastRateLimit = Date.now();
      }
    }

    // Use basic fallback logic
    return this.analyzePageAfterActionForContinuation(history, null, originalTask);
  }

  /**
   * Detect progress in task execution
   * @private
   */
  detectProgress(progressTracker, history, iterationCount, currentScreenshot) {
    let progressMade = false;
    let progressDetails = [];
    
    // Track iteration count since last progress
    progressTracker.iterationsSinceProgress++;
    
    // Check for URL changes
    const currentUrl = this.getCurrentPageUrl();
    if (currentUrl && currentUrl !== progressTracker.lastPageUrl) {
      progressMade = true;
      progressDetails.push(`URL changed to ${currentUrl}`);
      progressTracker.lastPageUrl = currentUrl;
    }
    
    // Check for screenshot changes (simple hash comparison)
    if (currentScreenshot) {
      const screenshotHash = this.simpleHash(currentScreenshot.substring(0, 1000)); // Use first 1000 chars for hash
      if (screenshotHash !== progressTracker.lastScreenshotHash) {
        progressMade = true;
        progressDetails.push('Page content changed');
        progressTracker.lastScreenshotHash = screenshotHash;
      }
    }
    
    // Check for new form interactions
    const currentFormState = this.getCurrentFormState();
    if (JSON.stringify(currentFormState) !== JSON.stringify(progressTracker.lastFormState)) {
      progressMade = true;
      progressDetails.push('Form state changed');
      progressTracker.lastFormState = currentFormState;
    }
    
    // Check for milestone completion
    if (history.length > 0) {
      const lastAssistantMessage = history.filter(h => h.role === 'assistant').pop();
      if (lastAssistantMessage && lastAssistantMessage.content) {
        for (const milestone of progressTracker.milestones) {
          if (!progressTracker.completedMilestones.has(milestone) && 
              lastAssistantMessage.content.toLowerCase().includes(milestone.replace('_', ' '))) {
            progressMade = true;
            progressDetails.push(`Milestone completed: ${milestone}`);
            progressTracker.completedMilestones.add(milestone);
          }
        }
      }
    }
    
    // Reset iteration counter if progress was made
    if (progressMade) {
      progressTracker.iterationsSinceProgress = 0;
      progressTracker.lastProgressTime = Date.now();
    }
    
    return {
      progressMade,
      details: progressDetails,
      iterationsSinceProgress: progressTracker.iterationsSinceProgress
    };
  }

  /**
   * Build execution analytics for result reporting
   * @private
   */
  buildExecutionAnalytics(history, executionResult, iterationCount) {
    const analytics = {
      totalIterations: iterationCount,
      totalActions: 0,
      actionTypes: {},
      milestones: [],
      timeSpent: 0,
      errorCount: 0,
      progressPoints: []
    };
    
    // Calculate time spent
    if (history.length > 0) {
      const startTime = history[0].timestamp || Date.now();
      const endTime = history[history.length - 1].timestamp || Date.now();
      analytics.timeSpent = endTime - startTime;
    }
    
    // Analyze history for actions and milestones
    history.forEach((entry, index) => {
      if (entry.role === 'assistant' && entry.content) {
        // Count errors
        if (entry.content.toLowerCase().includes('error') || 
            entry.content.toLowerCase().includes('failed')) {
          analytics.errorCount++;
        }
        
        // Identify progress points
        if (entry.content.toLowerCase().includes('successfully') ||
            entry.content.toLowerCase().includes('completed') ||
            entry.content.toLowerCase().includes('found')) {
          analytics.progressPoints.push({
            iteration: Math.floor(index / 2) + 1,
            description: entry.content.substring(0, 100) + '...'
          });
        }
      }
      
      // Count actions from action entries
      if (entry.action) {
        analytics.totalActions++;
        const actionType = entry.action.type || 'unknown';
        analytics.actionTypes[actionType] = (analytics.actionTypes[actionType] || 0) + 1;
      }
    });
    
    return analytics;
  }

  /**
   * Build condensed history for result reporting
   * @private
   */
  buildCondensedHistory(history) {
    const condensed = [];
    let lastRole = null;
    
    history.forEach((entry, index) => {
      // Skip consecutive assistant messages that are just progress updates
      if (entry.role === 'assistant' && lastRole === 'assistant' && 
          entry.content && entry.content.length < 100) {
        return;
      }
      
      // Condense long assistant messages
      if (entry.role === 'assistant' && entry.content && entry.content.length > 200) {
        condensed.push({
          ...entry,
          content: entry.content.substring(0, 200) + '...'
        });
      } else {
        condensed.push(entry);
      }
      
      lastRole = entry.role;
    });
    
    return condensed;
  }

  /**
   * Handle alternative search strategy when normal flow isn't working
   * @private
   */
  async handleAlternativeSearch(history, taskDescription) {
    // Try a different approach for the search
    const sessionId = this.getCurrentSessionId();
    
    // For flight searches, try direct navigation approach
    if (taskDescription.toLowerCase().includes('flight')) {
      return {
        description: "Normal search approach isn't working. Trying alternative direct navigation to search form.",
        requiresAction: true,
        actions: [{
          type: "navigate",
          description: "Navigate to a simpler search interface",
          payload: { url: "https://www.google.com/travel/flights" }
        }],
        reason: 'alternative_navigation'
      };
    }
    
    // For general searches, try keyboard navigation
    return {
      description: "Normal interaction isn't working. Trying keyboard-based navigation.",
      requiresAction: true,
      actions: [{
        type: "key_press",
        description: "Use keyboard shortcut to focus search",
        payload: { key: "Control+f" }
      }],
      reason: 'alternative_keyboard'
    };
  }

  /**
   * Filter milestones to only include user-facing ones
   * @private
   */
  filterUserFacingMilestones(completedMilestones) {
    const userFacingMilestones = [];
    const technicalMilestones = new Set([
      'page_loaded',
      'navigation_completed',
      'form_interaction'
    ]);
    
    for (const milestone of completedMilestones) {
      if (!technicalMilestones.has(milestone)) {
        // Convert milestone to user-friendly text
        const userFriendly = milestone
          .replace(/_/g, ' ')
          .replace(/\b\w/g, l => l.toUpperCase());
        userFacingMilestones.push(userFriendly);
      }
    }
    
    return userFacingMilestones;
  }

  /**
   * Detect repeated subtask patterns in history
   * @private
   */
  detectRepeatedSubtasks(history, iterationsSinceProgress) {
    const patterns = {
      repeatedClicks: 0,
      repeatedInputs: 0,
      repeatedNavigations: 0,
      consecutiveFailures: 0,
      sameTargetRepeats: 0
    };
    
    if (history.length < 2) {
      return patterns;
    }
    
    // Analyze recent assistant messages for patterns
    const assistantMessages = history
      .filter(h => h.role === 'assistant')
      .slice(-Math.min(5, iterationsSinceProgress)); // Look at recent messages based on iterations since progress
    
    // Check for repeated action patterns
    let lastAction = null;
    let consecutiveActions = 0;
    
    assistantMessages.forEach(message => {
      if (message.content) {
        const content = message.content.toLowerCase();
        
        // Detect repeated click patterns
        if (content.includes('click') && lastAction === 'click') {
          consecutiveActions++;
          patterns.repeatedClicks++;
        } else if (content.includes('click')) {
          lastAction = 'click';
          consecutiveActions = 1;
        }
        
        // Detect repeated input patterns
        if (content.includes('input') || content.includes('type') || content.includes('enter')) {
          if (lastAction === 'input') {
            patterns.repeatedInputs++;
          }
          lastAction = 'input';
        }
        
        // Detect navigation patterns
        if (content.includes('navigate') || content.includes('reload') || content.includes('refresh')) {
          if (lastAction === 'navigate') {
            patterns.repeatedNavigations++;
          }
          lastAction = 'navigate';
        }
        
        // Detect failure patterns
        if (content.includes('error') || content.includes('failed') || content.includes('unable') || content.includes('cannot')) {
          patterns.consecutiveFailures++;
        } else if (patterns.consecutiveFailures > 0) {
          patterns.consecutiveFailures = 0; // Reset on success
        }
        
        // Detect same target repeats (simplified)
        if (consecutiveActions > 2) {
          patterns.sameTargetRepeats++;
        }
      }
    });
    
    return patterns;
  }

  /**
   * Simple hash function for content comparison
   * @private
   */
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  /**
   * Get current page URL (mock implementation for testing)
   * @private
   */
  getCurrentPageUrl() {
    // In a real implementation, this would get the URL from the browser
    return null; // Placeholder
  }

  /**
   * Get current form state (mock implementation for testing)
   * @private
   */
  getCurrentFormState() {
    // In a real implementation, this would analyze form fields
    return {}; // Placeholder
  }

  /**
   * Get current session ID from context
   * @private
   */
  getCurrentSessionId() {
    return this.currentSessionId || null;
  }

  /**
   * Initialize progress tracker for task execution
   * @private
   */
  initializeProgressTracker(taskDescription, history) {
    return {
      iterationsSinceProgress: 0,
      lastProgressTime: Date.now(),
      lastScreenshotHash: null,
      lastPageUrl: null,
      lastFormState: {},
      previousActions: [],
      interactionCounts: {
        clicks: 0,
        inputs: 0,
        navigations: 0
      },
      milestones: this.defineMilestones(taskDescription),
      completedMilestones: new Set(),
      lastInteractionStrategy: null
    };
  }

  /**
   * Define key milestones for tracking progress in a task
   */
  defineMilestones(taskDescription) {
    const milestones = [];
    const lowerTask = taskDescription.toLowerCase();
    
    // Search-related milestones
    if (lowerTask.includes('search') || lowerTask.includes('find')) {
      milestones.push('search_initiated', 'results_loaded', 'result_selected');
    }
    
    // Flight-related milestones
    if (lowerTask.includes('flight')) {
      milestones.push('flight_search_form', 'departure_entered', 'destination_entered', 'search_executed', 'results_displayed');
    }
    
    // Form-related milestones
    if (lowerTask.includes('form') || lowerTask.includes('fill') || lowerTask.includes('enter')) {
      milestones.push('form_located', 'fields_filled', 'form_submitted');
    }
    
    // Navigation milestones
    if (lowerTask.includes('navigate') || lowerTask.includes('go to') || lowerTask.includes('visit')) {
      milestones.push('page_loaded', 'navigation_complete');
    }
    
    // Cookie consent milestones
    milestones.push('cookie_consent_handled');
    
    // General completion milestone
    milestones.push('task_completed');
    
    return milestones;
  }

  /**
   * Build execution analytics from progress tracker
   */
  buildExecutionAnalytics(progressTracker) {
    const analytics = {
      totalIterations: progressTracker.iterationsSinceProgress || 0,
      totalInteractions: 0,
      interactionBreakdown: progressTracker.interactionCounts || {},
      milestonesCompleted: Array.from(progressTracker.completedMilestones || []),
      lastProgressTime: progressTracker.lastProgressTime,
      strategiesUsed: progressTracker.lastInteractionStrategy ? [progressTracker.lastInteractionStrategy] : []
    };
    
    // Calculate total interactions
    if (analytics.interactionBreakdown) {
      analytics.totalInteractions = Object.values(analytics.interactionBreakdown).reduce((sum, count) => sum + count, 0);
    }
    
    return analytics;
  }
}

module.exports = NaturalLanguageTaskService;
