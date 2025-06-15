// Popup script for browser automation extension

class PopupController {
  constructor() {
    this.isConnected = false;
    this.currentSessionId = null;
    this.currentServerUrl = 'ws://localhost:3010/ws';
    
    this.initializeElements();
    this.setupEventListeners();
    this.loadCurrentStatus();
  }

  initializeElements() {
    // Connection elements
    this.serverUrlInput = document.getElementById('serverUrl');
    this.sessionIdInput = document.getElementById('sessionId');
    this.createSessionBtn = document.getElementById('createSessionBtn');
    this.connectBtn = document.getElementById('connectBtn');
    this.disconnectBtn = document.getElementById('disconnectBtn');
    
    // Status elements
    this.statusIndicator = document.getElementById('statusIndicator');
    this.statusDot = document.getElementById('statusDot');
    this.statusText = document.getElementById('statusText');
    
    // Info elements
    this.connectionSection = document.getElementById('connectionSection');
    this.sessionInfoSection = document.getElementById('sessionInfoSection');
    this.testingSection = document.getElementById('testingSection');
    this.currentSessionId = document.getElementById('currentSessionId');
    this.currentStatus = document.getElementById('currentStatus');
    this.currentServer = document.getElementById('currentServer');
    
    // Testing elements
    this.testUrlInput = document.getElementById('testUrl');
    this.testNavigateBtn = document.getElementById('testNavigateBtn');
    this.testScreenshotBtn = document.getElementById('testScreenshotBtn');
    this.testSelectorInput = document.getElementById('testSelector');
    this.testExtractBtn = document.getElementById('testExtractBtn');
    this.screenshotResult = document.getElementById('screenshotResult');
    this.extractResult = document.getElementById('extractResult');
    
    // Log elements
    this.logContainer = document.getElementById('logContainer');
    this.clearLogsBtn = document.getElementById('clearLogsBtn');
  }

  setupEventListeners() {
    // Connection buttons
    this.createSessionBtn.addEventListener('click', () => this.createNewSession());
    this.connectBtn.addEventListener('click', () => this.connect());
    this.disconnectBtn.addEventListener('click', () => this.disconnect());
    
    // Testing buttons
    this.testNavigateBtn.addEventListener('click', () => this.testNavigate());
    this.testScreenshotBtn.addEventListener('click', () => this.testScreenshot());
    this.testExtractBtn.addEventListener('click', () => this.testExtract());
    
    // Other buttons
    this.clearLogsBtn.addEventListener('click', () => this.clearLogs());
    
    // Listen for background script messages
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleBackgroundMessage(message);
    });
    
    // Auto-resize popup
    this.resizePopup();
  }

  async loadCurrentStatus() {
    try {
      const response = await this.sendMessageToBackground({ type: 'get_status' });
      if (response.success) {
        this.updateStatus(response.status, response.sessionId, response.serverUrl);
      }
    } catch (error) {
      this.log('Failed to load current status', 'error');
    }
  }

  async createNewSession() {
    this.setButtonLoading(this.createSessionBtn, true);
    
    try {
      const serverUrl = this.serverUrlInput.value.replace('ws://', 'http://').replace('wss://', 'https://');
      const apiUrl = serverUrl.replace('/ws', '') + '/api/sessions';
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          metadata: {
            browser: 'chrome-extension',
            userAgent: navigator.userAgent,
            timestamp: new Date().toISOString()
          }
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.sessionIdInput.value = data.session.id;
        this.log(`Created new session: ${data.session.id}`, 'success');
      } else {
        throw new Error(data.error || 'Failed to create session');
      }
    } catch (error) {
      this.log(`Failed to create session: ${error.message}`, 'error');
    } finally {
      this.setButtonLoading(this.createSessionBtn, false);
    }
  }

  async connect() {
    const sessionId = this.sessionIdInput.value.trim();
    const serverUrl = this.serverUrlInput.value.trim();
    
    if (!sessionId) {
      this.log('Please enter a session ID', 'error');
      return;
    }
    
    if (!serverUrl) {
      this.log('Please enter a server URL', 'error');
      return;
    }
    
    this.setButtonLoading(this.connectBtn, true);
    this.updateConnectionStatus('connecting');
    
    try {
      const response = await this.sendMessageToBackground({
        type: 'connect',
        sessionId,
        serverUrl
      });
      
      if (response.success) {
        this.log(`Connected to session: ${sessionId}`, 'success');
        this.updateStatus('connected', sessionId, serverUrl);
      } else {
        throw new Error(response.error || 'Connection failed');
      }
    } catch (error) {
      this.log(`Connection failed: ${error.message}`, 'error');
      this.updateConnectionStatus('disconnected');
    } finally {
      this.setButtonLoading(this.connectBtn, false);
    }
  }

  async disconnect() {
    this.setButtonLoading(this.disconnectBtn, true);
    
    try {
      const response = await this.sendMessageToBackground({ type: 'disconnect' });
      
      if (response.success) {
        this.log('Disconnected from automation service', 'info');
        this.updateStatus('disconnected');
      } else {
        throw new Error(response.error || 'Disconnect failed');
      }
    } catch (error) {
      this.log(`Disconnect failed: ${error.message}`, 'error');
    } finally {
      this.setButtonLoading(this.disconnectBtn, false);
    }
  }

  async testNavigate() {
    const url = this.testUrlInput.value.trim();
    
    if (!url) {
      this.log('Please enter a URL to navigate to', 'error');
      return;
    }
    
    if (!this.isConnected) {
      this.log('Please connect to automation service first', 'error');
      return;
    }
    
    this.setButtonLoading(this.testNavigateBtn, true);
    
    try {
      const apiUrl = this.currentServerUrl.replace('ws://', 'http://').replace('wss://', 'https://').replace('/ws', '');
      const response = await fetch(`${apiUrl}/api/sessions/${this.currentSessionId}/commands`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'navigate',
          payload: { url }
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.log(`Navigation completed: ${url}`, 'success');
      } else {
        throw new Error(data.error || 'Navigation failed');
      }
    } catch (error) {
      this.log(`Navigation failed: ${error.message}`, 'error');
    } finally {
      this.setButtonLoading(this.testNavigateBtn, false);
    }
  }

  async testScreenshot() {
    if (!this.isConnected) {
      this.log('Please connect to automation service first', 'error');
      return;
    }
    
    this.setButtonLoading(this.testScreenshotBtn, true);
    this.screenshotResult.classList.remove('show');
    
    try {
      const apiUrl = this.currentServerUrl.replace('ws://', 'http://').replace('wss://', 'https://').replace('/ws', '');
      const response = await fetch(`${apiUrl}/api/sessions/${this.currentSessionId}/commands`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'screenshot',
          payload: {}
        })
      });
      
      const data = await response.json();
      
      if (data.success && data.command.result.screenshot) {
        this.screenshotResult.innerHTML = `
          <div>Screenshot captured at ${data.command.result.timestamp}</div>
          <img src="${data.command.result.screenshot}" alt="Screenshot" />
        `;
        this.screenshotResult.classList.add('show');
        this.log('Screenshot captured successfully', 'success');
      } else {
        throw new Error(data.error || 'Screenshot failed');
      }
    } catch (error) {
      this.log(`Screenshot failed: ${error.message}`, 'error');
    } finally {
      this.setButtonLoading(this.testScreenshotBtn, false);
    }
  }

  async testExtract() {
    const selector = this.testSelectorInput.value.trim();
    
    if (!selector) {
      this.log('Please enter a CSS selector', 'error');
      return;
    }
    
    if (!this.isConnected) {
      this.log('Please connect to automation service first', 'error');
      return;
    }
    
    this.setButtonLoading(this.testExtractBtn, true);
    this.extractResult.classList.remove('show');
    
    try {
      const apiUrl = this.currentServerUrl.replace('ws://', 'http://').replace('wss://', 'https://').replace('/ws', '');
      const response = await fetch(`${apiUrl}/api/sessions/${this.currentSessionId}/commands`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'extract',
          payload: { selector, multiple: false }
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.extractResult.innerHTML = `
          <div>Extracted data from "${selector}":</div>
          <pre>${JSON.stringify(data.command.result.data, null, 2)}</pre>
        `;
        this.extractResult.classList.add('show');
        this.log(`Data extracted from ${selector}`, 'success');
      } else {
        throw new Error(data.error || 'Extraction failed');
      }
    } catch (error) {
      this.log(`Extraction failed: ${error.message}`, 'error');
    } finally {
      this.setButtonLoading(this.testExtractBtn, false);
    }
  }

  updateStatus(status, sessionId = null, serverUrl = null) {
    this.isConnected = status === 'connected';
    this.currentSessionId = sessionId;
    if (serverUrl) this.currentServerUrl = serverUrl;
    
    this.updateConnectionStatus(status);
    this.updateUI();
    
    if (sessionId) {
      this.currentSessionId.textContent = sessionId;
      this.currentStatus.textContent = status;
      this.currentServer.textContent = serverUrl || this.currentServerUrl;
    }
  }

  updateConnectionStatus(status) {
    this.statusDot.className = 'status-dot';
    
    switch (status) {
      case 'connected':
        this.statusDot.classList.add('connected');
        this.statusText.textContent = 'Connected';
        break;
      case 'connecting':
        this.statusDot.classList.add('connecting');
        this.statusText.textContent = 'Connecting...';
        break;
      case 'disconnected':
      default:
        this.statusText.textContent = 'Disconnected';
        break;
    }
  }

  updateUI() {
    // Update button states
    this.connectBtn.disabled = this.isConnected;
    this.disconnectBtn.disabled = !this.isConnected;
    
    // Update input states
    this.serverUrlInput.disabled = this.isConnected;
    this.sessionIdInput.disabled = this.isConnected;
    this.createSessionBtn.disabled = this.isConnected;
    
    // Update testing button states
    this.testNavigateBtn.disabled = !this.isConnected;
    this.testScreenshotBtn.disabled = !this.isConnected;
    this.testExtractBtn.disabled = !this.isConnected;
    
    // Show/hide sections
    if (this.isConnected) {
      this.sessionInfoSection.style.display = 'block';
      this.testingSection.style.display = 'block';
    } else {
      this.sessionInfoSection.style.display = 'none';
      this.testingSection.style.display = 'none';
    }
    
    this.resizePopup();
  }

  handleBackgroundMessage(message) {
    switch (message.type) {
      case 'connection_status':
        this.updateStatus(message.status, this.currentSessionId, this.currentServerUrl);
        break;
      case 'navigation_complete':
        this.log(`Navigation completed: ${message.url}`, 'success');
        break;
      default:
        console.log('Unknown message from background:', message);
    }
  }

  sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  setButtonLoading(button, loading) {
    if (loading) {
      button.classList.add('loading');
      button.disabled = true;
    } else {
      button.classList.remove('loading');
      button.disabled = false;
      this.updateUI(); // Restore proper disabled state
    }
  }

  log(message, level = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${level}`;
    logEntry.innerHTML = `<span class="timestamp">${timestamp}</span>${message}`;
    
    this.logContainer.appendChild(logEntry);
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
    
    // Keep only last 100 log entries
    const entries = this.logContainer.children;
    if (entries.length > 100) {
      this.logContainer.removeChild(entries[0]);
    }
  }

  clearLogs() {
    this.logContainer.innerHTML = '<div class="log-entry info">Logs cleared</div>';
  }

  resizePopup() {
    // Auto-resize popup based on content
    setTimeout(() => {
      const height = document.body.scrollHeight;
      document.body.style.height = `${Math.min(height, 600)}px`;
    }, 100);
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
