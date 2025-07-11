// Background service worker for browser automation extension

class BackgroundService {
  constructor() {
    this.wsConnection = null;
    this.sessionId = null;
    this.connectionStatus = 'disconnected';
    this.serverUrl = 'wss://browserless.corrently.cloud/ws';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.workingTabId = null; // Track the tab used for automation
    this.autoConnectEnabled = true; // Enable auto-connect by default
    this.autoCreateSession = true; // Enable auto-session creation by default
    this.connectionHeartbeat = null; // For connection monitoring
    this.lastHeartbeat = null;
    
    // Version check properties
    this.currentVersion = '1.0.1'; // Current extension version
    this.latestVersion = null;
    this.versionCheckUrl = 'https://browserless.corrently.cloud/api/extension/version';
    this.versionCheckInterval = null;
    this.updateAvailable = false;
    
    this.setupEventListeners();
    this.loadStoredSession();
    this.checkForUpdates(); // Check for updates on startup
  }

  setupEventListeners() {
    // Handle extension startup
    chrome.runtime.onStartup.addListener(() => {
      console.log('Extension started');
      this.loadStoredSession();
    });

    // Handle extension installation
    chrome.runtime.onInstalled.addListener(() => {
      console.log('Extension installed');
    });

    // Handle messages from popup and content scripts
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // Keep message channel open for async responses
    });

    // Handle tab updates for navigation tracking
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.url) {
        this.notifyNavigationComplete(tab.url);
      }
    });
  }

  async loadStoredSession() {
    try {
      const result = await chrome.storage.local.get(['sessionId', 'serverUrl', 'autoConnectEnabled', 'autoCreateSession']);
      if (result.sessionId) {
        this.sessionId = result.sessionId;
        console.log('Loaded stored session:', this.sessionId);
      }
      if (result.serverUrl) {
        this.serverUrl = result.serverUrl;
      }
      if (result.autoConnectEnabled !== undefined) {
        this.autoConnectEnabled = result.autoConnectEnabled;
      }
      if (result.autoCreateSession !== undefined) {
        this.autoCreateSession = result.autoCreateSession;
      }

      // Auto-connect logic
      if (this.autoConnectEnabled) {
        if (this.sessionId) {
          console.log('Auto-connecting to stored session...');
          setTimeout(() => {
            this.connect(this.sessionId, this.serverUrl);
          }, 1000); // Delay to ensure extension is fully loaded
        } else if (this.autoCreateSession) {
          console.log('Auto-creating new session...');
          setTimeout(async () => {
            try {
              const sessionId = await this.createNewSession();
              if (sessionId) {
                await this.connect(sessionId, this.serverUrl);
              }
            } catch (error) {
              console.error('Auto-session creation failed:', error);
            }
          }, 1000);
        }
      }
    } catch (error) {
      console.error('Failed to load stored session:', error);
    }
  }

  async saveSession() {
    try {
      await chrome.storage.local.set({
        sessionId: this.sessionId,
        serverUrl: this.serverUrl,
        autoConnectEnabled: this.autoConnectEnabled,
        autoCreateSession: this.autoCreateSession
      });
    } catch (error) {
      console.error('Failed to save session:', error);
    }
  }

  async clearSession() {
    try {
      await chrome.storage.local.remove(['sessionId', 'serverUrl']);
      this.sessionId = null;
    } catch (error) {
      console.error('Failed to clear session:', error);
    }
  }

  handleMessage(message, sender, sendResponse) {
    console.log('Received message:', message.type);

    switch (message.type) {
      case 'connect':
        this.connect(message.sessionId, message.serverUrl)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ success: false, error: error.message }));
        break;

      case 'disconnect':
        this.disconnect()
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ success: false, error: error.message }));
        break;

      case 'get_status':
        sendResponse({
          success: true,
          status: this.connectionStatus,
          sessionId: this.sessionId,
          serverUrl: this.serverUrl,
          autoConnectEnabled: this.autoConnectEnabled,
          autoCreateSession: this.autoCreateSession,
          currentVersion: this.currentVersion,
          latestVersion: this.latestVersion,
          updateAvailable: this.updateAvailable
        });
        break;

      case 'check_updates':
        this.checkForUpdates()
          .then(() => sendResponse({
            success: true,
            currentVersion: this.currentVersion,
            latestVersion: this.latestVersion,
            updateAvailable: this.updateAvailable
          }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        break;

      case 'set_auto_connect':
        this.autoConnectEnabled = message.enabled;
        this.saveSession()
          .then(() => sendResponse({ success: true, autoConnectEnabled: this.autoConnectEnabled }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        break;

      case 'set_auto_create':
        this.autoCreateSession = message.enabled;
        this.saveSession()
          .then(() => sendResponse({ success: true, autoCreateSession: this.autoCreateSession }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        break;

      case 'create_session':
        this.createNewSession()
          .then(sessionId => sendResponse({ success: true, sessionId }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        break;

      case 'get_tabs':
        this.getAllTabs()
          .then(tabs => sendResponse({ success: true, tabs }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  }

  async connect(sessionId, serverUrl) {
    console.log('Background script: Starting connection process...', { sessionId, serverUrl });
    
    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    this.sessionId = sessionId;
    this.serverUrl = serverUrl || this.serverUrl;
    
    await this.saveSession();
    
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.serverUrl}?sessionId=${sessionId}`;
      console.log('Background script: Connecting to:', wsUrl);

      this.wsConnection = new WebSocket(wsUrl);

      this.wsConnection.onopen = () => {
        console.log('Background script: WebSocket connected successfully');
        this.connectionStatus = 'connected';
        this.reconnectAttempts = 0;
        this.startConnectionMonitoring(); // Start monitoring
        console.log('Background script: Sending connection status to popup...');
        this.notifyPopup({ type: 'connection_status', status: 'connected' });
        resolve({ success: true, status: 'connected' });
      };

      this.wsConnection.onmessage = (event) => {
        this.handleWebSocketMessage(event);
      };

      this.wsConnection.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        this.connectionStatus = 'disconnected';
        this.notifyPopup({ type: 'connection_status', status: 'disconnected' });
        
        if (event.code !== 1000) { // Not a normal close
          this.attemptReconnect();
        }
      };

      this.wsConnection.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.connectionStatus = 'error';
        this.notifyPopup({ type: 'connection_status', status: 'error' });
        reject(new Error('Failed to connect to automation service'));
      };

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.connectionStatus !== 'connected') {
          this.wsConnection.close();
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  async disconnect() {
    if (this.wsConnection) {
      this.wsConnection.close(1000, 'User disconnect');
      this.wsConnection = null;
    }
    
    this.connectionStatus = 'disconnected';
    this.stopConnectionMonitoring(); // Stop monitoring
    await this.clearSession();
    this.notifyPopup({ type: 'connection_status', status: 'disconnected' });
    
    return { success: true, status: 'disconnected' };
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts || !this.sessionId) {
      console.log('Max reconnect attempts reached or no session');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
    
    setTimeout(() => {
      this.connect(this.sessionId, this.serverUrl)
        .then(() => console.log('Reconnected successfully'))
        .catch(error => console.error('Reconnect failed:', error));
    }, delay);
  }

  handleWebSocketMessage(event) {
    try {
      const message = JSON.parse(event.data);
      console.log('Received WebSocket message:', message.type);

      switch (message.type) {
        case 'registered':
          console.log('Successfully registered with session:', message.sessionId);
          break;

        case 'command':
          this.executeCommand(message.id, message.command);
          break;

        case 'cancel_command':
          this.cancelCommand(message.commandId);
          break;

        case 'pong':
          // Heartbeat response
          break;

        default:
          console.warn('Unknown WebSocket message type:', message.type);
      }
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  }

  async executeCommand(commandId, command) {
    console.log('Executing command:', command.type, 'with ID:', commandId, 'payload:', command.payload);

    try {
      // Check if we have a working tab for non-navigate commands
      if (command.type !== 'navigate' && !this.workingTabId) {
        console.warn('No working tab established. Some commands may require navigation first.');
        // For certain commands, we can still try to use the active tab
        if (['get_page_elements', 'getTitle', 'screenshot'].includes(command.type)) {
          console.log('Attempting to use active tab for command:', command.type);
        } else {
          throw new Error('No active tab context. Please navigate to a page first.');
        }
      }

      let result;

      switch (command.type) {
        case 'navigate':
          result = await this.executeNavigate(command.payload);
          break;
        case 'screenshot':
          result = await this.executeScreenshot(command.payload);
          break;
        case 'extract':
          result = await this.executeExtract(command.payload);
          break;
        case 'execute':
          result = await this.executeScript(command.payload);
          break;
        case 'click':
          result = await this.executeClick(command.payload);
          break;
        case 'type':
          result = await this.executeType(command.payload);
          break;
        case 'scroll':
          result = await this.executeScroll(command.payload);
          break;
        case 'get_page_elements':
          result = await this.executeGetPageElements(command.payload);
          break;
        case 'getTitle':
          result = await this.executeGetTitle(command.payload);
          break;
        case 'getText':
          result = await this.executeGetText(command.payload);
          break;
        case 'evaluate':
          result = await this.executeEvaluate(command.payload);
          break;
        case 'waitForElement':
          result = await this.executeWaitForElement(command.payload);
          break;
        default:
          throw new Error(`Unknown command type: ${command.type}`);
      }

      console.log('Command executed successfully:', commandId, 'Result:', result);
      this.sendCommandResult(commandId, true, result);
    } catch (error) {
      console.error('Command execution failed:', commandId, error);
      this.sendCommandResult(commandId, false, null, error.message);
    }
  }

  async executeNavigate(payload) {
    const { url } = payload;
    
    console.log('Executing navigate command to:', url);
    
    // Create a new tab for navigation instead of using the current tab
    const newTab = await chrome.tabs.create({ url, active: true });
    this.workingTabId = newTab.id; // Store the working tab ID for future commands
    
    console.log('Created new tab:', newTab.id, 'for URL:', url);
    
    // Wait for navigation to complete with enhanced monitoring
    return new Promise((resolve) => {
      let resolved = false;
      
      const listener = (tabId, changeInfo, tab) => {
        if (tabId === newTab.id && changeInfo.status === 'complete' && !resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          
          console.log('Navigation completed for tab:', tabId, 'URL:', tab.url);
          
          // Additional delay to ensure page is fully interactive
          setTimeout(() => {
            resolve({
              url: tab.url,
              title: tab.title,
              tabId: tab.id,
              timestamp: new Date().toISOString(),
              navigationComplete: true
            });
          }, 1000); // Give the page time to fully load and become interactive
        }
      };
      
      chrome.tabs.onUpdated.addListener(listener);
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          console.log('Navigation timeout for tab:', newTab.id);
          resolve({
            url: url,
            title: 'Navigation timeout',
            tabId: newTab.id,
            timestamp: new Date().toISOString(),
            navigationComplete: false,
            error: 'Navigation timeout after 30 seconds'
          });
        }
      }, 30000);
    });
  }

  // Helper function to get the working tab
  async getWorkingTab() {
    // If we have a working tab ID, verify it still exists and is valid
    if (this.workingTabId) {
      try {
        const tab = await chrome.tabs.get(this.workingTabId);
        if (tab && !tab.discarded) {
          return tab;
        }
      } catch (error) {
        // Tab no longer exists, reset working tab ID
        this.workingTabId = null;
      }
    }
    
    // Fallback to active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) {
      throw new Error('No active tab found');
    }
    
    // Set this as the new working tab
    this.workingTabId = tabs[0].id;
    return tabs[0];
  }

  async executeScreenshot(payload) {
    const tab = await this.getWorkingTab();

    // Make sure the working tab is active/visible for screenshot
    await chrome.tabs.update(tab.id, { active: true });
    
    // Small delay to ensure tab is active
    await new Promise(resolve => setTimeout(resolve, 200));

    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 90
    });

    return {
      screenshot: dataUrl,
      timestamp: new Date().toISOString(),
      tabInfo: {
        id: tab.id,
        url: tab.url,
        title: tab.title
      }
    };
  }

  async executeExtract(payload) {
    const { selector, attribute, multiple } = payload;
    const tab = await this.getWorkingTab();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (selector, attribute, multiple) => {
        const elements = document.querySelectorAll(selector);
        const extractData = (element) => {
          if (attribute) {
            return element.getAttribute(attribute);
          } else {
            return {
              text: element.textContent?.trim(),
              html: element.innerHTML,
              tagName: element.tagName.toLowerCase(),
              attributes: Array.from(element.attributes).reduce((acc, attr) => {
                acc[attr.name] = attr.value;
                return acc;
              }, {})
            };
          }
        };

        if (multiple) {
          return Array.from(elements).map(extractData);
        } else {
          return elements.length > 0 ? extractData(elements[0]) : null;
        }
      },
      args: [selector, attribute, multiple]
    });

    return {
      data: results[0].result,
      selector,
      count: multiple ? (results[0].result?.length || 0) : (results[0].result ? 1 : 0),
      timestamp: new Date().toISOString()
    };
  }

  async executeScript(payload) {
    const { script } = payload;
    const tab = await this.getWorkingTab();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: new Function(script)
    });

    return {
      result: results[0].result,
      timestamp: new Date().toISOString()
    };
  }

  async executeClick(payload) {
    const { selector } = payload;
    return this.executeElementAction(selector, 'click');
  }

  async executeType(payload) {
    const { selector, text } = payload;
    return this.executeElementAction(selector, 'type', { text });
  }

  async executeScroll(payload) {
    const { x = 0, y = 0, selector } = payload;
    const tab = await this.getWorkingTab();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (x, y, selector) => {
        if (selector) {
          const element = document.querySelector(selector);
          if (element) {
            element.scrollTo(x, y);
          } else {
            throw new Error(`Element not found: ${selector}`);
          }
        } else {
          window.scrollTo(x, y);
        }
        return { x: window.scrollX, y: window.scrollY };
      },
      args: [x, y, selector]
    });

    return {
      scrollPosition: results[0].result,
      timestamp: new Date().toISOString()
    };
  }

  async executeElementAction(selector, action, params = {}) {
    const tab = await this.getWorkingTab();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (selector, action, params) => {
        const element = document.querySelector(selector);
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }

        switch (action) {
          case 'click':
            element.click();
            break;
          case 'type':
            element.focus();
            element.value = params.text;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          default:
            throw new Error(`Unknown action: ${action}`);
        }

        return {
          selector,
          action,
          element: {
            tagName: element.tagName.toLowerCase(),
            id: element.id,
            className: element.className
          }
        };
      },
      args: [selector, action, params]
    });

    return {
      ...results[0].result,
      timestamp: new Date().toISOString()
    };
  }

  // Additional command methods for better API compatibility
  async executeGetPageElements(payload) {
    const tab = await this.getWorkingTab();
    
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Get all interactive elements on the page
        const selectors = [
          'a[href]', 'button', 'input', 'select', 'textarea',
          '[onclick]', '[role="button"]', '[role="link"]',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          '.headline', '.title', '.news-item', '[data-testid*="headline"]',
          '.article-title', '.story-title', '.promo-heading'
        ];
        
        const elements = [];
        selectors.forEach(selector => {
          const found = document.querySelectorAll(selector);
          found.forEach(el => {
            if (el.textContent && el.textContent.trim()) {
              elements.push({
                tagName: el.tagName.toLowerCase(),
                text: el.textContent.trim(),
                href: el.href || null,
                id: el.id || null,
                className: el.className || null,
                selector: selector,
                position: {
                  x: el.offsetLeft,
                  y: el.offsetTop,
                  width: el.offsetWidth,
                  height: el.offsetHeight
                }
              });
            }
          });
        });
        
        return {
          elements: elements,
          totalCount: elements.length,
          url: window.location.href,
          title: document.title
        };
      },
      args: []
    });

    return {
      ...results[0].result,
      timestamp: new Date().toISOString()
    };
  }

  async executeGetTitle(payload) {
    const tab = await this.getWorkingTab();
    
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        return {
          title: document.title,
          url: window.location.href
        };
      },
      args: []
    });

    return {
      ...results[0].result,
      timestamp: new Date().toISOString()
    };
  }

  async executeGetText(payload) {
    const { selector } = payload;
    const tab = await this.getWorkingTab();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (selector) => {
        const element = document.querySelector(selector);
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }
        
        return {
          text: element.textContent?.trim(),
          innerHTML: element.innerHTML,
          selector: selector
        };
      },
      args: [selector]
    });

    return {
      ...results[0].result,
      timestamp: new Date().toISOString()
    };
  }

  async executeEvaluate(payload) {
    const { script } = payload;
    const tab = await this.getWorkingTab();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (scriptCode) => {
        // Safely evaluate the script
        try {
          return eval(scriptCode);
        } catch (error) {
          throw new Error(`Script evaluation failed: ${error.message}`);
        }
      },
      args: [script]
    });

    return {
      result: results[0].result,
      script: script,
      timestamp: new Date().toISOString()
    };
  }

  async executeWaitForElement(payload) {
    const { selector, timeout = 10000 } = payload;
    const tab = await this.getWorkingTab();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (selector, timeout) => {
        return new Promise((resolve, reject) => {
          const startTime = Date.now();
          
          const checkElement = () => {
            const element = document.querySelector(selector);
            if (element) {
              resolve({
                found: true,
                selector: selector,
                waitTime: Date.now() - startTime,
                element: {
                  tagName: element.tagName.toLowerCase(),
                  text: element.textContent?.trim(),
                  id: element.id || null,
                  className: element.className || null
                }
              });
            } else if (Date.now() - startTime >= timeout) {
              resolve({
                found: false,
                selector: selector,
                waitTime: timeout,
                error: 'Element not found within timeout'
              });
            } else {
              setTimeout(checkElement, 100);
            }
          };
          
          checkElement();
        });
      },
      args: [selector, timeout]
    });

    return {
      ...results[0].result,
      timestamp: new Date().toISOString()
    };
  }

  cancelCommand(commandId) {
    console.log('Command cancellation requested:', commandId);
    // For now, just log it. In a more complex implementation,
    // we could track running commands and actually cancel them
  }

  sendCommandResult(commandId, success, result, error) {
    if (this.wsConnection && this.wsConnection.readyState === WebSocket.OPEN) {
      const message = {
        type: 'command_result',
        commandId,
        success,
        result,
        error
      };
      
      this.wsConnection.send(JSON.stringify(message));
      console.log('Command result sent:', commandId, success);
    }
  }

  notifyNavigationComplete(url) {
    this.notifyPopup({
      type: 'navigation_complete',
      url,
      timestamp: new Date().toISOString()
    });
  }

  notifyPopup(message) {
    console.log('Background script: Sending message to popup:', message);
    // Try to send message to popup if it's open
    chrome.runtime.sendMessage(message).catch((error) => {
      console.log('Background script: Could not send message to popup (popup might not be open):', error);
    });
  }

  async getAllTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.active,
      windowId: tab.windowId
    }));
  }

  async createNewSession() {
    try {
      const serverBaseUrl = this.serverUrl.replace('ws://', 'http://').replace('wss://', 'https://').replace('/ws', '');
      
      // First, check if there are any existing sessions we can reuse
      console.log('Checking for existing sessions before creating new one...');
      try {
        const sessionsResponse = await fetch(`${serverBaseUrl}/api/sessions`);
        if (sessionsResponse.ok) {
          const sessionsData = await sessionsResponse.json();
          if (sessionsData.success && sessionsData.sessions) {
            // Look for any active session that the extension can use
            // Prefer extension sessions, but also consider web UI sessions if no extension session exists
            let existingSession = sessionsData.sessions.find(session => 
              session.isConnected && session.metadata?.browser === 'chrome-extension'
            );
            
            // If no extension session found, consider reusing an active web UI session
            if (!existingSession) {
              existingSession = sessionsData.sessions.find(session => 
                session.isConnected && 
                (session.metadata?.purpose === 'nl-control' || session.metadata?.user === 'dashboard-direct')
              );
            }
            
            if (existingSession) {
              console.log('Found existing session to reuse:', existingSession.id, existingSession.metadata);
              
              // Update the session metadata to indicate extension is now using it
              try {
                await fetch(`${serverBaseUrl}/api/sessions/${existingSession.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    metadata: {
                      ...existingSession.metadata,
                      browser: 'chrome-extension',
                      purpose: 'extension_reused',
                      extensionConnectedAt: new Date().toISOString()
                    }
                  })
                });
              } catch (updateError) {
                console.warn('Failed to update session metadata:', updateError);
              }
              
              this.sessionId = existingSession.id;
              await this.saveSession();
              console.log('Reusing existing session:', this.sessionId);
              return this.sessionId;
            }
          }
        }
      } catch (checkError) {
        console.warn('Failed to check existing sessions:', checkError);
      }
      
      // No existing session found, create a new one
      console.log('No reusable session found, creating new session...');
      const response = await fetch(`${serverBaseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          metadata: {
            browser: 'chrome-extension',
            purpose: 'extension_auto_connect',
            userAgent: navigator.userAgent,
            timestamp: new Date().toISOString()
          }
        })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      if (!data.success || !data.session || !data.session.id) {
        throw new Error('Invalid response from session creation API');
      }
      
      this.sessionId = data.session.id;
      await this.saveSession();
      
      console.log('Auto-created new session:', this.sessionId);
      return this.sessionId;
    } catch (error) {
      console.error('Failed to create new session:', error);
      throw error;
    }
  }

  startConnectionMonitoring() {
    // Clear existing heartbeat if any
    if (this.connectionHeartbeat) {
      clearInterval(this.connectionHeartbeat);
    }
    
    // Send ping every 30 seconds and monitor connection
    this.connectionHeartbeat = setInterval(() => {
      if (this.wsConnection && this.wsConnection.readyState === WebSocket.OPEN) {
        this.wsConnection.send(JSON.stringify({ type: 'ping' }));
        this.lastHeartbeat = Date.now();
      } else if (this.autoConnectEnabled && this.sessionId) {
        // Connection lost, attempt reconnect
        console.log('Connection lost, attempting auto-reconnect...');
        this.attemptReconnect();
      }
    }, 30000);
  }

  stopConnectionMonitoring() {
    if (this.connectionHeartbeat) {
      clearInterval(this.connectionHeartbeat);
      this.connectionHeartbeat = null;
    }
  }

  async checkForUpdates() {
    try {
      const response = await fetch(this.versionCheckUrl);
      if (!response.ok) {
        throw new Error(`Failed to check for updates: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      if (data.version && data.version !== this.currentVersion) {
        this.latestVersion = data.version;
        this.updateAvailable = true;
        console.log(`Update available: ${this.latestVersion}`);
        
        // Notify popup or take other actions as needed
        this.notifyPopup({
          type: 'update_available',
          version: this.latestVersion,
          currentVersion: this.currentVersion
        });
      } else {
        this.latestVersion = null;
        this.updateAvailable = false;
        console.log('No updates available');
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
    }
  }
}

// Initialize the background service
const backgroundService = new BackgroundService();
