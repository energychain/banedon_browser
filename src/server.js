const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');
const config = require('./utils/config');

// Import route handlers
const sessionRoutes = require('./routes/sessions');
const commandRoutes = require('./routes/commands');
const nlTaskRoutes = require('./routes/nlTasks');
const interactiveRoutes = require('./routes/interactive');
const receiptRoutes = require('./routes/receipts');

// Import services
const SessionManager = require('./services/SessionManager');
const WebSocketManager = require('./services/WebSocketManager');
const NaturalLanguageTaskService = require('./services/NaturalLanguageTaskService');

// Simple user store (in production, this would be a database)
const users = new Map();
const sessions = new Map(); // Store user sessions and receipts
const userReceipts = new Map(); // Store receipts per user

// Initialize default users (optional, can be disabled)
if (process.env.ENABLE_AUTH === 'true') {
  users.set('demo', { password: 'demo123', name: 'Demo User' });
  users.set('admin', { password: 'admin123', name: 'Administrator' });
}

class BrowserAutomationService {
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.sessionManager = new SessionManager();
    this.wsManager = new WebSocketManager(this.sessionManager);
    
    this.setupMiddleware();
    this.setupAuthRoutes();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupGracefulShutdown();
  }

  // Authentication middleware
  authenticateUser(req, res, next) {
    // Skip auth if not enabled
    if (process.env.ENABLE_AUTH !== 'true') {
      req.user = { username: 'guest', name: 'Guest User' };
      return next();
    }

    const sessionToken = req.headers['x-session-token'] || req.cookies?.sessionToken;
    
    if (sessionToken && sessions.has(sessionToken)) {
      req.user = sessions.get(sessionToken);
      return next();
    }

    // For API endpoints, return 401
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required' 
      });
    }

    // For web pages, continue as guest
    req.user = { username: 'guest', name: 'Guest User' };
    next();
  }

  setupMiddleware() {
    // CORS configuration with pattern matching
    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
        
        // Check for exact matches first
        let isAllowed = allowedOrigins.includes(origin);
        
        // If not exact match, check for pattern matches
        if (!isAllowed) {
          isAllowed = allowedOrigins.some(allowedOrigin => {
            // Handle chrome-extension:// pattern
            if (allowedOrigin === 'chrome-extension://' && origin.startsWith('chrome-extension://')) {
              return true;
            }
            // Handle moz-extension:// pattern
            if (allowedOrigin === 'moz-extension://' && origin.startsWith('moz-extension://')) {
              return true;
            }
            // Handle wildcard patterns
            if (allowedOrigin.includes('*')) {
              const pattern = allowedOrigin.replace(/\*/g, '.*');
              const regex = new RegExp(`^${pattern}$`);
              return regex.test(origin);
            }
            return false;
          });
        }
        
        callback(null, isAllowed);
      },
      credentials: true
    }));

    // Parse JSON bodies
    this.app.use(express.json({ limit: '10mb' }));
    
    // Serve the modern advanced web UI as the default homepage
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });
    
    // Serve static files from public directory first (includes modern UI assets)
    this.app.use(express.static('public'));
    
    // Serve the legacy task management interface at /tasks
    this.app.get('/tasks', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'index.html'));
    });
    
    // Serve task management assets for /tasks
    this.app.get('/tasks/script.js', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'script.js'));
    });
    
    this.app.get('/tasks/style.css', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'style.css'));
    });
    
    // Keep /demo for backward compatibility (redirect to root)
    this.app.get('/demo', (req, res) => {
      res.redirect('/');
    });

    // Request logging
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, { 
        ip: req.ip, 
        userAgent: req.get('User-Agent') 
      });
      next();
    });
  }

  setupAuthRoutes() {
    // Login endpoint
    this.app.post('/api/auth/login', express.json(), (req, res) => {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: 'Username and password required'
        });
      }

      const user = users.get(username);
      if (!user || user.password !== password) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      // Create session token
      const sessionToken = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const userSession = {
        username: user.username || username,
        name: user.name,
        loginTime: new Date().toISOString()
      };

      sessions.set(sessionToken, userSession);

      res.json({
        success: true,
        user: userSession,
        sessionToken
      });
    });

    // Logout endpoint
    this.app.post('/api/auth/logout', (req, res) => {
      const sessionToken = req.headers['x-session-token'] || req.cookies?.sessionToken;
      
      if (sessionToken) {
        sessions.delete(sessionToken);
      }

      res.json({ success: true, message: 'Logged out successfully' });
    });

    // Get current user
    this.app.get('/api/auth/me', this.authenticateUser.bind(this), (req, res) => {
      res.json({
        success: true,
        user: req.user
      });
    });

    // Session and receipt management
    this.app.get('/api/user/sessions', this.authenticateUser.bind(this), (req, res) => {
      const userSessions = userReceipts.get(req.user.username) || [];
      res.json({
        success: true,
        sessions: userSessions
      });
    });

    this.app.post('/api/user/sessions', this.authenticateUser.bind(this), express.json(), (req, res) => {
      const { sessionId, receipt } = req.body;
      
      if (!sessionId || !receipt) {
        return res.status(400).json({
          success: false,
          message: 'Session ID and receipt required'
        });
      }

      if (!userReceipts.has(req.user.username)) {
        userReceipts.set(req.user.username, []);
      }

      const userSessions = userReceipts.get(req.user.username);
      const sessionData = {
        sessionId,
        receipt,
        savedAt: new Date().toISOString(),
        name: receipt.metadata?.name || `Session ${sessionId.slice(0, 8)}`
      };

      userSessions.push(sessionData);
      userReceipts.set(req.user.username, userSessions);

      res.json({
        success: true,
        message: 'Session saved successfully',
        session: sessionData
      });
    });

    this.app.get('/api/user/sessions/:sessionId', this.authenticateUser.bind(this), (req, res) => {
      const { sessionId } = req.params;
      const userSessions = userReceipts.get(req.user.username) || [];
      const session = userSessions.find(s => s.sessionId === sessionId);

      if (!session) {
        return res.status(404).json({
          success: false,
          message: 'Session not found'
        });
      }

      res.json({
        success: true,
        session
      });
    });
  }

  setupRoutes() {
    // Health check endpoint (no auth required)
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: require('../package.json').version,
        activeSessions: this.sessionManager.getActiveSessionCount(),
        wsConnections: this.wsManager.getConnectionCount()
      });
    });

    // Apply authentication middleware to API routes
    this.app.use('/api/sessions', this.authenticateUser.bind(this));
    this.app.use('/api/nl-tasks', this.authenticateUser.bind(this));
    this.app.use('/api/commands', this.authenticateUser.bind(this));

    // API routes
    this.app.use('/api/sessions', sessionRoutes(this.sessionManager));
    const commandRouter = commandRoutes(this.sessionManager);
    this.app.use('/api/sessions', commandRouter);
    
    // Store reference to command executor for cleanup
    this.commandExecutor = commandRouter.commandExecutor;
    
    // Initialize natural language task service
    this.nlTaskService = new NaturalLanguageTaskService(this.sessionManager, this.commandExecutor);
    
    // Make nlTaskService available to routes
    this.app.set('nlTaskService', this.nlTaskService);
    
    // Natural language task routes
    this.app.use('/api/sessions', nlTaskRoutes(this.sessionManager, this.nlTaskService));
    
    // Interactive control routes
    this.app.use('/api/sessions', interactiveRoutes(this.sessionManager, this.commandExecutor));
    
    // Receipt execution routes
    this.app.use('/api/receipts', receiptRoutes(this.sessionManager));
    
    // Serve screenshots
    this.app.use('/screenshots', express.static(path.join(__dirname, '..', 'public', 'screenshots')));
    
    // Set command executor in WebSocket manager
    this.wsManager.setCommandExecutor(commandRouter.commandExecutor);

    // Extension routes
    this.setupExtensionRoutes();

    // Documentation routes
    this.app.get('/api/docs', (req, res) => {
      res.sendFile('api-docs.html', { root: 'public' });
    });

    this.app.get('/openapi.json', (req, res) => {
      res.sendFile('openapi.json', { root: 'public' });
    });

    this.app.get('/extension/install-guide', (req, res) => {
      res.sendFile('install-guide.html', { root: 'public' });
    });

    // Natural Language Demo page
    this.app.get('/nl-demo', (req, res) => {
      res.sendFile('nl-demo.html', { root: 'public' });
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });

    // Error handler
    this.app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    });
  }

  setupExtensionRoutes() {
    // Extension version check endpoint
    this.app.get('/api/extension/version', (req, res) => {
      try {
        // Read the current extension version from manifest or package.json
        const manifestPath = path.join(__dirname, '..', 'extension', 'manifest.json');
        let currentVersion = '1.0.1'; // default version
        
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          currentVersion = manifest.version || currentVersion;
        }
        
        // For demonstration purposes, always return a newer version to show update functionality
        // In production, you would check against GitHub releases or another version source
        const latestVersion = '1.0.2'; // Simulate a newer version available
        
        res.json({
          version: latestVersion,
          releaseDate: new Date().toISOString(),
          downloadUrl: '/extension/download',
          releaseNotes: 'Latest version with new features: global status indicator, enhanced connection monitoring, and version notifications.'
        });
      } catch (error) {
        logger.error('Error checking extension version:', error);
        res.status(500).json({
          error: 'Version check failed',
          message: error.message
        });
      }
    });
    
    // Extension download route
    this.app.get('/extension/download', (req, res) => {
      const zipPath = path.join(__dirname, '..', 'build', 'browser-automation-extension.zip');
      
      if (fs.existsSync(zipPath)) {
        // Serve the pre-built extension ZIP file
        res.download(zipPath, 'browser-automation-extension.zip', (err) => {
          if (err) {
            logger.error('Error downloading extension:', err);
            res.status(500).json({ 
              error: 'Download failed',
              message: 'Unable to download extension package'
            });
          }
        });
      } else {
        // If no built package exists, provide instructions
        res.status(404).json({
          error: 'Extension package not found',
          message: 'Extension package not built yet',
          instructions: [
            'Run "./build.sh" to build the extension package',
            'Or access extension files directly at /extension/',
            'Follow the installation guide for manual installation'
          ],
          extensionFiles: '/extension/',
          installGuide: '/extension/install-guide',
          buildCommand: './build.sh'
        });
      }
    });

    // Serve extension files directly for development
    this.app.use('/extension/files', express.static(path.join(__dirname, '..', 'extension')));
  }

  setupWebSocket() {
    const wss = new WebSocket.Server({ 
      server: this.server,
      path: '/ws',
      verifyClient: this.wsManager.verifyClient.bind(this.wsManager)
    });

    wss.on('connection', (ws, req) => {
      this.wsManager.handleConnection(ws, req);
    });

    logger.info('WebSocket server initialized on /ws');
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      logger.info(`Received ${signal}. Starting graceful shutdown...`);
      
      // Stop accepting new connections
      this.server.close(() => {
        logger.info('HTTP server closed');
      });

      // Close WebSocket connections
      await this.wsManager.closeAllConnections();
      
      // Cleanup command executor (closes all server browsers)
      if (this.commandExecutor) {
        await this.commandExecutor.cleanup();
      }
      
      // Cleanup natural language task service
      if (this.nlTaskService) {
        this.nlTaskService.cleanupOldScreenshots();
      }
      
      // Cleanup sessions
      await this.sessionManager.cleanup();
      
      logger.info('Graceful shutdown completed');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  start() {
    const port = config.PORT;
    this.server.listen(port, () => {
      logger.info(`Browser Automation Service started on port ${port}`);
      logger.info(`Health check: http://localhost:${port}/health`);
      logger.info(`WebSocket endpoint: ws://localhost:${port}/ws`);
    });
  }
}

// Start the service if this file is run directly
if (require.main === module) {
  const service = new BrowserAutomationService();
  service.start();
}

module.exports = BrowserAutomationService;
