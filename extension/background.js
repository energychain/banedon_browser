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
    
    this.setupEventListeners();
    this.loadStoredSession();
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
      const result = await chrome.storage.local.get(['sessionId', 'serverUrl', 'autoConnectEnabled']);
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

      // Auto-connect if enabled and we have a session ID
      if (this.autoConnectEnabled && this.sessionId) {
        console.log('Auto-connecting to stored session...');
        setTimeout(() => {
          this.connect(this.sessionId, this.serverUrl);
        }, 1000); // Delay to ensure extension is fully loaded
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
        autoConnectEnabled: this.autoConnectEnabled
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
          autoConnectEnabled: this.autoConnectEnabled
        });
        break;

      case 'set_auto_connect':
        this.autoConnectEnabled = message.enabled;
        this.saveSession()
          .then(() => sendResponse({ success: true, autoConnectEnabled: this.autoConnectEnabled }))
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
    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    this.sessionId = sessionId;
    this.serverUrl = serverUrl || this.serverUrl;
    
    await this.saveSession();
    
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.serverUrl}?sessionId=${sessionId}`;
      console.log('Connecting to:', wsUrl);

      this.wsConnection = new WebSocket(wsUrl);

      this.wsConnection.onopen = () => {
        console.log('WebSocket connected');
        this.connectionStatus = 'connected';
        this.reconnectAttempts = 0;
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
    console.log('Executing command:', command.type, commandId);

    try {
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
        default:
          throw new Error(`Unknown command type: ${command.type}`);
      }

      this.sendCommandResult(commandId, true, result);
    } catch (error) {
      console.error('Command execution failed:', error);
      this.sendCommandResult(commandId, false, null, error.message);
    }
  }

  async executeNavigate(payload) {
    const { url } = payload;
    
    // Create a new tab for navigation instead of using the current tab
    const newTab = await chrome.tabs.create({ url, active: true });
    this.workingTabId = newTab.id; // Store the working tab ID for future commands
    
    // Wait for navigation to complete
    return new Promise((resolve) => {
      const listener = (tabId, changeInfo, tab) => {
        if (tabId === newTab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve({
            url: tab.url,
            title: tab.title,
            timestamp: new Date().toISOString()
          });
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      
      // Timeout after 30 seconds
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({
          url: url,
          title: 'Navigation timeout',
          timestamp: new Date().toISOString()
        });
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
    // Try to send message to popup if it's open
    chrome.runtime.sendMessage(message).catch(() => {
      // Popup might not be open, that's fine
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
}

// Initialize the background service
const backgroundService = new BackgroundService();
