#!/usr/bin/env node

const readline = require('readline');
const axios = require('axios');
const WebSocket = require('ws');

class AutomationCLI {
  constructor() {
    this.baseUrl = 'http://localhost:3010';
    this.wsUrl = 'ws://localhost:3010/ws';
    this.currentSession = null;
    this.wsConnection = null;
    this.isConnected = false;
    
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'automation> '
    });
    
    this.setupEventHandlers();
    this.showWelcome();
  }

  setupEventHandlers() {
    this.rl.on('line', (input) => {
      this.handleCommand(input.trim());
    });

    this.rl.on('close', () => {
      this.cleanup();
    });

    process.on('SIGINT', () => {
      this.cleanup();
    });
  }

  showWelcome() {
    console.log('\\n🔧 Browser Automation Service CLI');
    console.log('=====================================');
    console.log('Type "help" for available commands');
    console.log('Type "quit" or "exit" to close\\n');
    this.rl.prompt();
  }

  async handleCommand(input) {
    if (!input) {
      this.rl.prompt();
      return;
    }

    const [command, ...args] = input.split(' ');

    try {
      switch (command.toLowerCase()) {
        case 'help':
          this.showHelp();
          break;
        case 'create':
          await this.createSession();
          break;
        case 'connect':
          await this.connectToSession(args[0]);
          break;
        case 'disconnect':
          await this.disconnect();
          break;
        case 'status':
          await this.showStatus();
          break;
        case 'sessions':
          await this.listSessions();
          break;
        case 'navigate':
          await this.navigate(args[0]);
          break;
        case 'screenshot':
          await this.takeScreenshot();
          break;
        case 'extract':
          await this.extractData(args[0], args[1]);
          break;
        case 'click':
          await this.clickElement(args[0]);
          break;
        case 'type':
          await this.typeText(args[0], args.slice(1).join(' '));
          break;
        case 'execute':
          await this.executeScript(args.join(' '));
          break;
        case 'scroll':
          await this.scroll(args[0], args[1]);
          break;
        case 'test':
          await this.runTestScenario(args[0]);
          break;
        case 'clear':
          console.clear();
          break;
        case 'quit':
        case 'exit':
          await this.cleanup();
          process.exit(0);
          break;
        default:
          console.log(`Unknown command: ${command}. Type "help" for available commands.`);
      }
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
    }

    this.rl.prompt();
  }

  showHelp() {
    console.log('\\n📖 Available Commands:');
    console.log('=======================');
    console.log('Connection:');
    console.log('  create                    - Create a new session');
    console.log('  connect <sessionId>       - Connect to existing session');
    console.log('  disconnect                - Disconnect from current session');
    console.log('  status                    - Show connection status');
    console.log('  sessions                  - List all active sessions');
    console.log('');
    console.log('Browser Control:');
    console.log('  navigate <url>            - Navigate to URL');
    console.log('  screenshot                - Take screenshot');
    console.log('  extract <selector> [attr] - Extract data from elements');
    console.log('  click <selector>          - Click element');
    console.log('  type <selector> <text>    - Type text into element');
    console.log('  execute <script>          - Execute JavaScript');
    console.log('  scroll <x> <y>            - Scroll to position');
    console.log('');
    console.log('Testing:');
    console.log('  test <scenario>           - Run test scenario (basic, google, form)');
    console.log('');
    console.log('Utility:');
    console.log('  help                      - Show this help');
    console.log('  clear                     - Clear screen');
    console.log('  quit/exit                 - Exit CLI\\n');
  }

  async createSession() {
    console.log('🔄 Creating new session...');
    
    try {
      const response = await axios.post(`${this.baseUrl}/api/sessions`, {
        metadata: {
          source: 'cli',
          timestamp: new Date().toISOString()
        }
      });

      if (response.data.success) {
        const session = response.data.session;
        console.log(`✅ Session created: ${session.id}`);
        console.log(`   Status: ${session.status}`);
        console.log(`   Created: ${new Date(session.createdAt).toLocaleString()}`);
        
        // Auto-connect to the new session
        await this.connectToSession(session.id);
      } else {
        throw new Error(response.data.error || 'Failed to create session');
      }
    } catch (error) {
      if (error.response) {
        throw new Error(`Server error: ${error.response.data.error || error.response.statusText}`);
      } else if (error.request) {
        throw new Error('Cannot connect to automation service. Is it running?');
      } else {
        throw error;
      }
    }
  }

  async connectToSession(sessionId) {
    if (!sessionId) {
      console.log('❌ Please provide a session ID');
      return;
    }

    console.log(`🔄 Connecting to session: ${sessionId}...`);

    try {
      // First verify session exists
      const response = await axios.get(`${this.baseUrl}/api/sessions/${sessionId}`);
      
      if (!response.data.success) {
        throw new Error('Session not found');
      }

      this.currentSession = response.data.session;
      console.log(`✅ Connected to session: ${sessionId}`);
      console.log(`   Status: ${this.currentSession.status}`);
      console.log(`   Connected: ${this.currentSession.isConnected ? 'Yes' : 'No'}`);

      if (!this.currentSession.isConnected) {
        console.log('⚠️  Note: Extension not connected to this session');
        console.log('   Install and connect the browser extension to execute commands');
      }

      this.isConnected = true;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        throw new Error('Session not found');
      } else if (error.response) {
        throw new Error(`Server error: ${error.response.data.error || error.response.statusText}`);
      } else if (error.request) {
        throw new Error('Cannot connect to automation service');
      } else {
        throw error;
      }
    }
  }

  async disconnect() {
    if (!this.isConnected) {
      console.log('❌ Not connected to any session');
      return;
    }

    console.log('🔄 Disconnecting...');
    this.currentSession = null;
    this.isConnected = false;
    console.log('✅ Disconnected');
  }

  async showStatus() {
    try {
      const healthResponse = await axios.get(`${this.baseUrl}/health`);
      const health = healthResponse.data;

      console.log('\\n📊 Service Status:');
      console.log('==================');
      console.log(`Service: ${health.status}`);
      console.log(`Uptime: ${Math.floor(health.uptime)}s`);
      console.log(`Active Sessions: ${health.activeSessions}`);
      console.log(`WebSocket Connections: ${health.wsConnections}`);

      if (this.currentSession) {
        console.log('\\n📱 Current Session:');
        console.log('===================');
        console.log(`ID: ${this.currentSession.id}`);
        console.log(`Status: ${this.currentSession.status}`);
        console.log(`Extension Connected: ${this.currentSession.isConnected ? 'Yes' : 'No'}`);
        console.log(`Commands: ${this.currentSession.commandCount || 0}`);
      } else {
        console.log('\\n📱 Current Session: None');
      }
    } catch (error) {
      throw new Error('Failed to get service status');
    }
  }

  async listSessions() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/sessions`);
      const data = response.data;

      console.log('\\n📋 Active Sessions:');
      console.log('===================');
      
      if (data.sessions.length === 0) {
        console.log('No active sessions');
      } else {
        data.sessions.forEach(session => {
          const current = this.currentSession && session.id === this.currentSession.id ? ' (current)' : '';
          console.log(`${session.id}${current}`);
          console.log(`  Status: ${session.status}`);
          console.log(`  Connected: ${session.isConnected ? 'Yes' : 'No'}`);
          console.log(`  Commands: ${session.commandCount}`);
          console.log(`  Created: ${new Date(session.createdAt).toLocaleString()}`);
          console.log('');
        });
      }

      console.log(`Total: ${data.count} sessions`);
    } catch (error) {
      throw new Error('Failed to list sessions');
    }
  }

  async executeCommand(type, payload) {
    if (!this.isConnected) {
      throw new Error('Not connected to any session. Use "create" or "connect <sessionId>" first.');
    }

    if (!this.currentSession.isConnected) {
      throw new Error('Browser extension not connected. Please connect the extension first.');
    }

    console.log(`🔄 Executing ${type} command...`);

    try {
      const response = await axios.post(
        `${this.baseUrl}/api/sessions/${this.currentSession.id}/commands`,
        { type, payload }
      );

      if (response.data.success) {
        const command = response.data.command;
        console.log(`✅ Command completed: ${command.type}`);
        
        if (command.result) {
          this.displayResult(command.type, command.result);
        }
        
        return command.result;
      } else {
        throw new Error(response.data.error || 'Command failed');
      }
    } catch (error) {
      if (error.response) {
        throw new Error(`Command failed: ${error.response.data.error || error.response.statusText}`);
      } else {
        throw error;
      }
    }
  }

  async navigate(url) {
    if (!url) {
      console.log('❌ Please provide a URL');
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    await this.executeCommand('navigate', { url });
  }

  async takeScreenshot() {
    const result = await this.executeCommand('screenshot', {});
    
    if (result && result.screenshot) {
      console.log(`📸 Screenshot saved (${result.screenshot.length} bytes)`);
      console.log(`   Page: ${result.tabInfo.title}`);
      console.log(`   URL: ${result.tabInfo.url}`);
    }
  }

  async extractData(selector, attribute) {
    if (!selector) {
      console.log('❌ Please provide a CSS selector');
      return;
    }

    const payload = { selector };
    if (attribute) {
      payload.attribute = attribute;
    }

    await this.executeCommand('extract', payload);
  }

  async clickElement(selector) {
    if (!selector) {
      console.log('❌ Please provide a CSS selector');
      return;
    }

    await this.executeCommand('click', { selector });
  }

  async typeText(selector, text) {
    if (!selector || !text) {
      console.log('❌ Please provide both selector and text');
      return;
    }

    await this.executeCommand('type', { selector, text });
  }

  async executeScript(script) {
    if (!script) {
      console.log('❌ Please provide JavaScript code to execute');
      return;
    }

    await this.executeCommand('execute', { script });
  }

  async scroll(x = 0, y = 0) {
    await this.executeCommand('scroll', { 
      x: parseInt(x) || 0, 
      y: parseInt(y) || 0 
    });
  }

  displayResult(commandType, result) {
    switch (commandType) {
      case 'navigate':
        console.log(`   🌐 Navigated to: ${result.url}`);
        console.log(`   📄 Title: ${result.title}`);
        break;
      case 'extract':
        console.log(`   📊 Found ${result.count} element(s)`);
        if (result.data) {
          console.log(`   📋 Data: ${JSON.stringify(result.data, null, 2)}`);
        }
        break;
      case 'click':
        console.log(`   🖱️  Clicked: ${result.selector}`);
        console.log(`   🏷️  Element: ${result.element.tagName}`);
        break;
      case 'type':
        console.log(`   ⌨️  Typed into: ${result.selector}`);
        break;
      case 'execute':
        console.log(`   💻 Script result: ${JSON.stringify(result.result)}`);
        break;
      case 'scroll':
        console.log(`   📜 Scrolled to: (${result.scrollPosition.x}, ${result.scrollPosition.y})`);
        break;
    }
  }

  async runTestScenario(scenario) {
    if (!scenario) {
      console.log('❌ Available test scenarios: basic, google, form');
      return;
    }

    console.log(`🧪 Running test scenario: ${scenario}`);

    try {
      switch (scenario.toLowerCase()) {
        case 'basic':
          await this.runBasicTest();
          break;
        case 'google':
          await this.runGoogleTest();
          break;
        case 'form':
          await this.runFormTest();
          break;
        default:
          console.log('❌ Unknown test scenario. Available: basic, google, form');
      }
    } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
    }
  }

  async runBasicTest() {
    console.log('1. Navigating to httpbin.org...');
    await this.navigate('httpbin.org/html');
    
    await this.sleep(2000);
    
    console.log('2. Taking screenshot...');
    await this.takeScreenshot();
    
    console.log('3. Extracting page title...');
    await this.extractData('h1');
    
    console.log('✅ Basic test completed');
  }

  async runGoogleTest() {
    console.log('1. Navigating to Google...');
    await this.navigate('google.com');
    
    await this.sleep(2000);
    
    console.log('2. Typing search query...');
    await this.typeText('input[name="q"]', 'browser automation');
    
    await this.sleep(1000);
    
    console.log('3. Taking screenshot...');
    await this.takeScreenshot();
    
    console.log('✅ Google test completed');
  }

  async runFormTest() {
    console.log('1. Navigating to form test page...');
    await this.navigate('httpbin.org/forms/post');
    
    await this.sleep(2000);
    
    console.log('2. Filling form fields...');
    await this.typeText('input[name="custname"]', 'Test User');
    await this.typeText('input[name="custtel"]', '123-456-7890');
    await this.typeText('input[name="custemail"]', 'test@example.com');
    
    console.log('3. Taking screenshot...');
    await this.takeScreenshot();
    
    console.log('✅ Form test completed');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup() {
    if (this.wsConnection) {
      this.wsConnection.close();
    }
    console.log('\\n👋 Goodbye!');
    this.rl.close();
  }
}

// Start CLI if this file is run directly
if (require.main === module) {
  new AutomationCLI();
}

module.exports = AutomationCLI;
