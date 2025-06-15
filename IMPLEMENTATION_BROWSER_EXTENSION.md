# Browser Extension MVP - Isolated Implementation

## 🎯 MVP Scope

**Goal**: Create a standalone browser automation service that can be integrated with any chat system via simple HTTP/WebSocket APIs.

**Team**: Extension Development Team (isolated from main chat application)

**Timeline**: 2-3 weeks for MVP

---

## 🏗️ MVP Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        MVP BOUNDARY                         │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │  Browser        │    │  WebSocket      │                │
│  │  Extension      │◄──►│  Bridge         │                │
│  │  (Chrome)       │    │  Service        │                │
│  └─────────────────┘    └─────────────────┘                │
│                                   │                         │
│                          ┌─────────────────┐                │
│                          │  REST API       │                │
│                          │  Gateway        │                │
│                          └─────────────────┘                │
│                                   │                         │
└─────────────────────────────────────────────────────────────┘
                                    │ HTTP/WebSocket APIs
                   ┌─────────────────┼─────────────────┐
                   │                 │                 │
            ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
            │   Chat      │   │   Testing   │   │   Future    │
            │   System    │   │   CLI       │   │   Systems   │
            │   (Later)   │   │   (MVP)     │   │             │
            └─────────────┘   └─────────────┘   └─────────────┘
```

---

## 📁 MVP File Structure

```
browser-automation-service/
├── extension/                          # Browser Extension
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.js
│   └── icons/
├── service/                           # Backend Service
│   ├── server.js                      # Main server
│   ├── websocket-bridge.js            # WebSocket handler
│   ├── session-manager.js             # Session management
│   ├── command-executor.js            # Command processing
│   └── api-routes.js                  # REST API
├── cli/                              # Testing CLI
│   ├── test-client.js                # Command line client
│   └── examples/                     # Usage examples
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── docs/
│   ├── API.md                        # API documentation
│   ├── INTEGRATION.md                # Integration guide
│   └── DEVELOPMENT.md                # Development setup
└── package.json
```

---

## 🔧 MVP Implementation

### 1. Backend Service (Node.js + Express + WebSocket)

**File**: `service/server.js`

```javascript
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const SessionManager = require('./session-manager');
const CommandExecutor = require('./command-executor');

class BrowserAutomationService {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this.sessionManager = new SessionManager();
        this.commandExecutor = new CommandExecutor(this.sessionManager);
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }
    
    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.static('extension'));
        
        // CORS for development
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
            next();
        });
    }
    
    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({ status: 'healthy', timestamp: new Date() });
        });
        
        // Create session
        this.app.post('/api/sessions', (req, res) => {
            const sessionId = this.sessionManager.createSession(req.body);
            res.json({ sessionId, connectUrl: `/extension?session=${sessionId}` });
        });
        
        // Execute command
        this.app.post('/api/sessions/:sessionId/commands', async (req, res) => {
            try {
                const result = await this.commandExecutor.execute(
                    req.params.sessionId, 
                    req.body
                );
                res.json({ success: true, result });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
        
        // Get session status
        this.app.get('/api/sessions/:sessionId', (req, res) => {
            const session = this.sessionManager.getSession(req.params.sessionId);
            res.json(session || { error: 'Session not found' });
        });
        
        // Extension download
        this.app.get('/extension/download', (req, res) => {
            // Serve extension as ZIP file
            res.download('./extension-package.zip');
        });
        
        // Installation page
        this.app.get('/install', (req, res) => {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head><title>Install Browser Extension</title></head>
                <body>
                    <h1>Browser Automation Extension</h1>
                    <a href="/extension/download">Download Extension</a>
                    <ol>
                        <li>Download the extension</li>
                        <li>Open Chrome extensions (chrome://extensions/)</li>
                        <li>Enable Developer mode</li>
                        <li>Click "Load unpacked" and select extension folder</li>
                    </ol>
                </body>
                </html>
            `);
        });
    }
    
    setupWebSocket() {
        this.wss.on('connection', (ws, req) => {
            console.log('Extension connected');
            
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleWebSocketMessage(ws, message);
                } catch (error) {
                    ws.send(JSON.stringify({ error: 'Invalid message format' }));
                }
            });
            
            ws.on('close', () => {
                console.log('Extension disconnected');
                this.sessionManager.handleDisconnection(ws);
            });
        });
    }
    
    handleWebSocketMessage(ws, message) {
        switch (message.type) {
            case 'register':
                this.sessionManager.registerConnection(message.sessionId, ws);
                ws.send(JSON.stringify({ type: 'registered', sessionId: message.sessionId }));
                break;
                
            case 'command_result':
                this.commandExecutor.handleResult(message);
                break;
                
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
        }
    }
    
    start(port = 3010) {
        this.server.listen(port, () => {
            console.log(`🚀 Browser Automation Service running on port ${port}`);
            console.log(`📦 Extension installation: http://localhost:${port}/install`);
            console.log(`🔧 API documentation: http://localhost:${port}/docs`);
        });
    }
}

module.exports = BrowserAutomationService;

// Start server if called directly
if (require.main === module) {
    const service = new BrowserAutomationService();
    service.start();
}
```

**File**: `service/session-manager.js`

```javascript
class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.connections = new Map(); // sessionId -> WebSocket
    }
    
    createSession(options = {}) {
        const sessionId = this.generateSessionId();
        const session = {
            id: sessionId,
            createdAt: new Date(),
            connected: false,
            commands: [],
            metadata: options.metadata || {}
        };
        
        this.sessions.set(sessionId, session);
        return sessionId;
    }
    
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    
    registerConnection(sessionId, ws) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.connected = true;
            session.connectedAt = new Date();
            this.connections.set(sessionId, ws);
            console.log(`Session ${sessionId} connected`);
        }
    }
    
    handleDisconnection(ws) {
        for (const [sessionId, connection] of this.connections) {
            if (connection === ws) {
                const session = this.sessions.get(sessionId);
                if (session) {
                    session.connected = false;
                    session.disconnectedAt = new Date();
                }
                this.connections.delete(sessionId);
                console.log(`Session ${sessionId} disconnected`);
                break;
            }
        }
    }
    
    getConnection(sessionId) {
        return this.connections.get(sessionId);
    }
    
    generateSessionId() {
        return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    listSessions() {
        return Array.from(this.sessions.values());
    }
}

module.exports = SessionManager;
```

**File**: `service/command-executor.js`

```javascript
class CommandExecutor {
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
        this.pendingCommands = new Map(); // commandId -> Promise resolve/reject
        this.commandTimeout = 30000; // 30 seconds
    }
    
    async execute(sessionId, command) {
        const connection = this.sessionManager.getConnection(sessionId);
        if (!connection) {
            throw new Error('Extension not connected');
        }
        
        const commandId = this.generateCommandId();
        const message = {
            type: 'command',
            id: commandId,
            command: command
        };
        
        return new Promise((resolve, reject) => {
            // Set timeout
            const timeout = setTimeout(() => {
                this.pendingCommands.delete(commandId);
                reject(new Error('Command timeout'));
            }, this.commandTimeout);
            
            // Store promise resolvers
            this.pendingCommands.set(commandId, { resolve, reject, timeout });
            
            // Send command
            connection.send(JSON.stringify(message));
        });
    }
    
    handleResult(message) {
        const { commandId, success, result, error } = message;
        const pendingCommand = this.pendingCommands.get(commandId);
        
        if (pendingCommand) {
            const { resolve, reject, timeout } = pendingCommand;
            clearTimeout(timeout);
            this.pendingCommands.delete(commandId);
            
            if (success) {
                resolve(result);
            } else {
                reject(new Error(error || 'Command failed'));
            }
        }
    }
    
    generateCommandId() {
        return `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

module.exports = CommandExecutor;
```

### 2. Browser Extension (Minimal)

**File**: `extension/manifest.json`

```json
{
    "manifest_version": 3,
    "name": "Browser Automation Extension",
    "version": "1.0.0",
    "description": "MVP Browser automation for external systems",
    
    "permissions": ["activeTab", "scripting", "desktopCapture", "tabs"],
    "host_permissions": ["<all_urls>"],
    
    "background": {
        "service_worker": "background.js"
    },
    
    "content_scripts": [{
        "matches": ["<all_urls>"],
        "js": ["content.js"]
    }],
    
    "action": {
        "default_popup": "popup.html"
    }
}
```

**File**: `extension/background.js`

```javascript
class ExtensionBridge {
    constructor() {
        this.ws = null;
        this.sessionId = null;
        this.serverUrl = 'ws://localhost:3010';
        this.setupListeners();
    }
    
    setupListeners() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sendResponse);
            return true; // Keep channel open
        });
    }
    
    connect(sessionId) {
        this.sessionId = sessionId;
        this.ws = new WebSocket(this.serverUrl);
        
        this.ws.onopen = () => {
            this.ws.send(JSON.stringify({
                type: 'register',
                sessionId: sessionId
            }));
            chrome.action.setBadgeText({ text: '✓' });
            chrome.action.setBadgeBackgroundColor({ color: 'green' });
        };
        
        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'command') {
                this.executeCommand(message);
            }
        };
        
        this.ws.onclose = () => {
            chrome.action.setBadgeText({ text: '✗' });
            chrome.action.setBadgeBackgroundColor({ color: 'red' });
        };
    }
    
    async executeCommand(message) {
        try {
            let result;
            
            switch (message.command.type) {
                case 'navigate':
                    result = await this.navigate(message.command.url);
                    break;
                case 'screenshot':
                    result = await this.takeScreenshot();
                    break;
                case 'extract':
                    result = await this.extractContent(message.command.selector);
                    break;
                default:
                    throw new Error(`Unknown command: ${message.command.type}`);
            }
            
            this.ws.send(JSON.stringify({
                type: 'command_result',
                commandId: message.id,
                success: true,
                result: result
            }));
            
        } catch (error) {
            this.ws.send(JSON.stringify({
                type: 'command_result',
                commandId: message.id,
                success: false,
                error: error.message
            }));
        }
    }
    
    async navigate(url) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        await chrome.tabs.update(tabs[0].id, { url });
        
        return new Promise((resolve) => {
            const listener = (tabId, changeInfo) => {
                if (tabId === tabs[0].id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve({ success: true, url });
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });
    }
    
    async takeScreenshot() {
        const dataUrl = await chrome.tabs.captureVisibleTab();
        return {
            success: true,
            image: dataUrl.split(',')[1], // Base64 data
            timestamp: new Date().toISOString()
        };
    }
    
    async extractContent(selector) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: (sel) => {
                const element = sel ? document.querySelector(sel) : document.body;
                return element ? element.textContent : null;
            },
            args: [selector]
        });
        
        return {
            success: true,
            content: results[0].result,
            selector: selector
        };
    }
    
    handleMessage(message, sendResponse) {
        switch (message.type) {
            case 'connect':
                this.connect(message.sessionId);
                sendResponse({ success: true });
                break;
            case 'status':
                sendResponse({ 
                    connected: this.ws && this.ws.readyState === WebSocket.OPEN,
                    sessionId: this.sessionId 
                });
                break;
        }
    }
}

const bridge = new ExtensionBridge();
```

**File**: `extension/popup.html`

```html
<!DOCTYPE html>
<html>
<head>
    <style>
        body { width: 300px; padding: 16px; font-family: Arial, sans-serif; }
        input { width: 100%; padding: 8px; margin: 8px 0; }
        button { width: 100%; padding: 10px; background: #4CAF50; color: white; border: none; cursor: pointer; }
        .status { padding: 8px; margin: 8px 0; border-radius: 4px; }
        .connected { background: #d4edda; color: #155724; }
        .disconnected { background: #f8d7da; color: #721c24; }
    </style>
</head>
<body>
    <h3>Browser Automation</h3>
    
    <div id="status" class="status disconnected">Disconnected</div>
    
    <input type="text" id="sessionId" placeholder="Enter Session ID">
    <button id="connect">Connect</button>
    
    <script src="popup.js"></script>
</body>
</html>
```

### 3. Testing CLI

**File**: `cli/test-client.js`

```javascript
#!/usr/bin/env node

const axios = require('axios');
const readline = require('readline');

class TestClient {
    constructor(baseUrl = 'http://localhost:3010') {
        this.baseUrl = baseUrl;
        this.sessionId = null;
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }
    
    async start() {
        console.log('🚀 Browser Automation Test Client');
        console.log('Commands: create, navigate <url>, screenshot, extract <selector>, status, quit');
        
        this.prompt();
    }
    
    prompt() {
        this.rl.question('> ', async (input) => {
            await this.handleCommand(input.trim());
            this.prompt();
        });
    }
    
    async handleCommand(input) {
        const [command, ...args] = input.split(' ');
        
        try {
            switch (command) {
                case 'create':
                    await this.createSession();
                    break;
                case 'navigate':
                    await this.navigate(args[0]);
                    break;
                case 'screenshot':
                    await this.screenshot();
                    break;
                case 'extract':
                    await this.extract(args[0]);
                    break;
                case 'status':
                    await this.status();
                    break;
                case 'quit':
                    process.exit(0);
                    break;
                default:
                    console.log('Unknown command');
            }
        } catch (error) {
            console.error('Error:', error.message);
        }
    }
    
    async createSession() {
        const response = await axios.post(`${this.baseUrl}/api/sessions`, {
            metadata: { source: 'test-cli' }
        });
        
        this.sessionId = response.data.sessionId;
        console.log(`✅ Session created: ${this.sessionId}`);
        console.log(`🔗 Connect extension: ${this.baseUrl}${response.data.connectUrl}`);
    }
    
    async navigate(url) {
        if (!this.sessionId) {
            console.log('❌ No session. Run "create" first.');
            return;
        }
        
        const response = await axios.post(
            `${this.baseUrl}/api/sessions/${this.sessionId}/commands`,
            { type: 'navigate', url }
        );
        
        console.log('✅ Navigation result:', response.data.result);
    }
    
    async screenshot() {
        if (!this.sessionId) {
            console.log('❌ No session. Run "create" first.');
            return;
        }
        
        const response = await axios.post(
            `${this.baseUrl}/api/sessions/${this.sessionId}/commands`,
            { type: 'screenshot' }
        );
        
        console.log('✅ Screenshot taken:', response.data.result.timestamp);
    }
    
    async extract(selector = 'body') {
        if (!this.sessionId) {
            console.log('❌ No session. Run "create" first.');
            return;
        }
        
        const response = await axios.post(
            `${this.baseUrl}/api/sessions/${this.sessionId}/commands`,
            { type: 'extract', selector }
        );
        
        console.log('✅ Content extracted:', response.data.result.content.substring(0, 200) + '...');
    }
    
    async status() {
        if (!this.sessionId) {
            console.log('❌ No session. Run "create" first.');
            return;
        }
        
        const response = await axios.get(`${this.baseUrl}/api/sessions/${this.sessionId}`);
        console.log('📊 Session status:', response.data);
    }
}

if (require.main === module) {
    const client = new TestClient();
    client.start().catch(console.error);
}
```

---

## 🚀 MVP Development Timeline

### **Week 1: Core Service**
- [ ] Backend WebSocket service
- [ ] Session management
- [ ] Basic command execution
- [ ] REST API endpoints

### **Week 2: Browser Extension**
- [ ] Extension manifest and structure
- [ ] WebSocket communication
- [ ] Basic commands (navigate, screenshot, extract)
- [ ] Connection management

### **Week 3: Testing & Documentation**
- [ ] CLI testing client
- [ ] API documentation
- [ ] Integration guide
- [ ] Docker packaging

---

## 🔗 Integration Points

**For Main Chat Team (Later):**

```javascript
// Simple integration - just HTTP calls
const browserService = 'http://browser-automation:3010';

// 1. Create session
const session = await fetch(`${browserService}/api/sessions`, {
    method: 'POST',
    body: JSON.stringify({ metadata: { chatUuid } })
});

// 2. Execute commands
const result = await fetch(`${browserService}/api/sessions/${sessionId}/commands`, {
    method: 'POST', 
    body: JSON.stringify({ type: 'screenshot' })
});
```

---

## ✅ MVP Success Criteria

1. **Extension connects** to service via WebSocket
2. **Commands execute** (navigate, screenshot, extract content)
3. **CLI client** can control browser remotely  
4. **Documented APIs** for easy integration
5. **Docker package** for deployment

This MVP can be developed completely independently and then integrated into your main chat system with minimal changes!