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

class BrowserAutomationService {
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.sessionManager = new SessionManager();
    this.wsManager = new WebSocketManager(this.sessionManager);
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupGracefulShutdown();
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
    
    // Serve our enhanced task management interface as the default homepage
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'index.html'));
    });
    
    // Serve task management assets
    this.app.get('/script.js', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'script.js'));
    });
    
    this.app.get('/style.css', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'style.css'));
    });
    
    // Serve the original demo at /demo
    this.app.get('/demo', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });
    
    // Serve static files from public directory (except index.html which we handle above)
    this.app.use(express.static('public'));
    
    // Keep the task management interface also available at /tasks for backward compatibility
    this.app.get('/tasks', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'index.html'));
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

  setupRoutes() {
    // Health check endpoint
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
