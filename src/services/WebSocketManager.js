const WebSocket = require('ws');
const url = require('url');
const logger = require('../utils/logger');
const config = require('../utils/config');

class WebSocketManager {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.connections = new Map(); // websocket -> connection info
    this.heartbeatInterval = null;
    this.commandExecutor = null; // Will be set by server
    
    this.startHeartbeat();
  }

  /**
   * Set command executor instance
   * @param {CommandExecutor} commandExecutor - Command executor instance
   */
  setCommandExecutor(commandExecutor) {
    this.commandExecutor = commandExecutor;
  }

  /**
   * Verify client connection
   * @param {Object} info - Connection info
   * @returns {boolean} True if connection is allowed
   */
  verifyClient(info) {
    const { origin, secure, req } = info;
    
    // Check origin in production
    if (config.NODE_ENV === 'production') {
      const allowedOrigins = config.ALLOWED_ORIGINS.split(',');
      
      if (origin) {
        // Check for exact matches first
        let isAllowed = allowedOrigins.includes(origin);
        
        // If not exact match, check for pattern matches (like chrome-extension://)
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
        
        if (!isAllowed) {
          logger.warn(`Connection rejected from unauthorized origin: ${origin}`);
          return false;
        }
      }
    }

    // Extract session ID from query parameters
    const queryParams = url.parse(req.url, true).query;
    if (!queryParams.sessionId) {
      logger.warn('Connection rejected: missing sessionId parameter');
      return false;
    }

    // Verify session exists
    const session = this.sessionManager.getSession(queryParams.sessionId);
    if (!session) {
      logger.warn(`Connection rejected: invalid sessionId ${queryParams.sessionId}`);
      return false;
    }

    return true;
  }

  /**
   * Handle new WebSocket connection
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} req - HTTP request object
   */
  handleConnection(ws, req) {
    const queryParams = url.parse(req.url, true).query;
    const sessionId = queryParams.sessionId;
    const remoteAddress = req.socket.remoteAddress;

    logger.info(`WebSocket connection established for session: ${sessionId}`, { remoteAddress });

    // Store connection info
    const connectionInfo = {
      sessionId,
      remoteAddress,
      connectedAt: new Date(),
      lastPing: new Date(),
      isAlive: true
    };
    
    this.connections.set(ws, connectionInfo);

    // Register connection with session manager
    try {
      this.sessionManager.registerConnection(sessionId, ws);
    } catch (error) {
      logger.error('Failed to register connection:', error);
      ws.close(1000, 'Registration failed');
      return;
    }

    // Send registration confirmation
    this.sendMessage(ws, {
      type: 'registered',
      sessionId,
      timestamp: new Date().toISOString()
    });

    // Set up event handlers
    ws.on('message', (data) => this.handleMessage(ws, data));
    ws.on('close', (code, reason) => this.handleDisconnection(ws, code, reason));
    ws.on('error', (error) => this.handleError(ws, error));
    ws.on('pong', () => this.handlePong(ws));
  }

  /**
   * Handle incoming WebSocket message
   * @param {WebSocket} ws - WebSocket connection
   * @param {Buffer} data - Message data
   */
  handleMessage(ws, data) {
    const connectionInfo = this.connections.get(ws);
    if (!connectionInfo) {
      logger.warn('Received message from untracked connection');
      return;
    }

    try {
      const message = JSON.parse(data.toString());
      logger.debug(`Received message from session ${connectionInfo.sessionId}:`, message.type);

      switch (message.type) {
        case 'ping':
          this.handlePing(ws);
          break;
        
        case 'command_result':
          this.handleCommandResult(ws, message);
          break;
        
        case 'error':
          this.handleClientError(ws, message);
          break;
        
        case 'status_update':
          this.handleStatusUpdate(ws, message);
          break;
        
        default:
          logger.warn(`Unknown message type: ${message.type}`, { sessionId: connectionInfo.sessionId });
      }
    } catch (error) {
      logger.error('Failed to parse WebSocket message:', error);
      this.sendMessage(ws, {
        type: 'error',
        error: 'Invalid message format'
      });
    }
  }

  /**
   * Handle ping message
   * @param {WebSocket} ws - WebSocket connection
   */
  handlePing(ws) {
    const connectionInfo = this.connections.get(ws);
    if (connectionInfo) {
      connectionInfo.lastPing = new Date();
      connectionInfo.isAlive = true;
    }
    
    this.sendMessage(ws, { type: 'pong' });
  }

  /**
   * Handle pong response
   * @param {WebSocket} ws - WebSocket connection
   */
  handlePong(ws) {
    const connectionInfo = this.connections.get(ws);
    if (connectionInfo) {
      connectionInfo.isAlive = true;
      connectionInfo.lastPing = new Date();
    }
  }

  /**
   * Handle command result from extension
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Command result message
   */
  handleCommandResult(ws, message) {
    const connectionInfo = this.connections.get(ws);
    if (!connectionInfo) {
      return;
    }

    if (!this.commandExecutor) {
      logger.error('Command executor not set');
      return;
    }

    const { commandId, success, result, error } = message;
    
    if (!commandId) {
      logger.warn('Command result missing commandId', { sessionId: connectionInfo.sessionId });
      return;
    }

    this.commandExecutor.handleCommandResult(commandId, {
      success,
      result,
      error
    });

    logger.debug(`Command result processed: ${commandId}`, { 
      success, 
      sessionId: connectionInfo.sessionId 
    });
  }

  /**
   * Handle client error
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Error message
   */
  handleClientError(ws, message) {
    const connectionInfo = this.connections.get(ws);
    if (!connectionInfo) {
      return;
    }

    logger.error(`Client error from session ${connectionInfo.sessionId}:`, message.error);
  }

  /**
   * Handle status update from client
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Status update message
   */
  handleStatusUpdate(ws, message) {
    const connectionInfo = this.connections.get(ws);
    if (!connectionInfo) {
      return;
    }

    const { status } = message;
    if (status) {
      this.sessionManager.updateSessionStatus(connectionInfo.sessionId, status);
      logger.debug(`Session status updated: ${connectionInfo.sessionId} -> ${status}`);
    }
  }

  /**
   * Handle WebSocket disconnection
   * @param {WebSocket} ws - WebSocket connection
   * @param {number} code - Close code
   * @param {string} reason - Close reason
   */
  handleDisconnection(ws, code, reason) {
    const connectionInfo = this.connections.get(ws);
    if (connectionInfo) {
      logger.info(`WebSocket disconnected for session: ${connectionInfo.sessionId}`, { 
        code, 
        reason: reason.toString() 
      });
      
      // Notify session manager
      this.sessionManager.handleDisconnection(ws);
      
      // Clean up commands if command executor is available
      if (this.commandExecutor) {
        this.commandExecutor.cleanupSession(connectionInfo.sessionId);
      }
    }
    
    this.connections.delete(ws);
  }

  /**
   * Handle WebSocket error
   * @param {WebSocket} ws - WebSocket connection
   * @param {Error} error - Error object
   */
  handleError(ws, error) {
    const connectionInfo = this.connections.get(ws);
    const sessionId = connectionInfo ? connectionInfo.sessionId : 'unknown';
    
    logger.error(`WebSocket error for session ${sessionId}:`, error);
  }

  /**
   * Send message to WebSocket
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Message object
   */
  sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        logger.error('Failed to send WebSocket message:', error);
      }
    }
  }

  /**
   * Send message to session
   * @param {string} sessionId - Session ID
   * @param {Object} message - Message object
   * @returns {boolean} True if message was sent
   */
  sendToSession(sessionId, message) {
    const connection = this.sessionManager.getConnection(sessionId);
    if (connection && connection.readyState === WebSocket.OPEN) {
      this.sendMessage(connection, message);
      return true;
    }
    return false;
  }

  /**
   * Broadcast message to all connections
   * @param {Object} message - Message object
   * @param {Array} excludeSessions - Session IDs to exclude
   */
  broadcast(message, excludeSessions = []) {
    for (const [ws, connectionInfo] of this.connections.entries()) {
      if (!excludeSessions.includes(connectionInfo.sessionId)) {
        this.sendMessage(ws, message);
      }
    }
  }

  /**
   * Start heartbeat mechanism
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, connectionInfo] of this.connections.entries()) {
        if (!connectionInfo.isAlive) {
          logger.info(`Terminating inactive connection for session: ${connectionInfo.sessionId}`);
          ws.terminate();
          continue;
        }
        
        connectionInfo.isAlive = false;
        ws.ping();
      }
    }, config.WS_HEARTBEAT_INTERVAL);
    
    logger.info(`WebSocket heartbeat started: ${config.WS_HEARTBEAT_INTERVAL}ms`);
  }

  /**
   * Get connection count
   * @returns {number} Number of active connections
   */
  getConnectionCount() {
    return this.connections.size;
  }

  /**
   * Get connection info for session
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Connection info or null
   */
  getConnectionInfo(sessionId) {
    for (const [ws, connectionInfo] of this.connections.entries()) {
      if (connectionInfo.sessionId === sessionId) {
        return {
          sessionId: connectionInfo.sessionId,
          remoteAddress: connectionInfo.remoteAddress,
          connectedAt: connectionInfo.connectedAt,
          lastPing: connectionInfo.lastPing,
          isAlive: connectionInfo.isAlive
        };
      }
    }
    return null;
  }

  /**
   * Close all connections
   */
  async closeAllConnections() {
    logger.info('Closing all WebSocket connections...');
    
    const closePromises = [];
    for (const ws of this.connections.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        closePromises.push(new Promise((resolve) => {
          ws.close(1000, 'Service shutdown');
          ws.on('close', resolve);
          setTimeout(resolve, 1000); // Force resolve after 1 second
        }));
      }
    }
    
    await Promise.all(closePromises);
    this.connections.clear();
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    logger.info('All WebSocket connections closed');
  }
}

module.exports = WebSocketManager;
