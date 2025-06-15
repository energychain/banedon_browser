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

// Import services
const SessionManager = require('./services/SessionManager');
const WebSocketManager = require('./services/WebSocketManager');

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
    // CORS configuration
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
      credentials: true
    }));

    // Parse JSON bodies
    this.app.use(express.json({ limit: '10mb' }));
    
    // Serve static files from public directory
    this.app.use(express.static('public'));
    
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
