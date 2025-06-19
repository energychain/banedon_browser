const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const config = require('../utils/config');

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.connections = new Map(); // sessionId -> WebSocket connection
    this.startCleanupInterval();
  }

  /**
   * Create a new browser session
   * @param {Object} metadata - Session metadata (user, browser info, etc.)
   * @returns {Object} Session object
   */
  createSession(metadata = {}) {
    if (this.sessions.size >= config.MAX_SESSIONS) {
      throw new Error(`Maximum sessions limit reached (${config.MAX_SESSIONS})`);
    }

    const sessionId = uuidv4();
    const session = {
      id: sessionId,
      createdAt: new Date(),
      lastActivity: new Date(),
      status: 'created',
      metadata: {
        userAgent: metadata.userAgent || 'Unknown',
        ip: metadata.ip || 'Unknown',
        ...metadata
      },
      commands: [],
      history: [], // Add history array
      isConnected: false,
      connectionInfo: null
    };

    this.sessions.set(sessionId, session);
    logger.info(`Session created: ${sessionId}`, { metadata });
    
    return session;
  }

  /**
   * Get session by ID
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Session object or null if not found
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.updateLastActivity(sessionId);
    }
    return session || null;
  }

  /**
   * List all active sessions
   * @returns {Array} Array of session objects
   */
  listActiveSessions() {
    return Array.from(this.sessions.values())
      .filter(session => !this.isExpired(session))
      .map(session => ({
        id: session.id,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        status: session.status,
        isConnected: session.isConnected,
        commandCount: session.commands.length,
        metadata: session.metadata
      }));
  }

  /**
   * Update session status
   * @param {string} sessionId - Session ID
   * @param {string} status - New status
   */
  updateSessionStatus(sessionId, status) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      this.updateLastActivity(sessionId);
      logger.debug(`Session ${sessionId} status updated to: ${status}`);
    }
  }

  /**
   * Register WebSocket connection for session
   * @param {string} sessionId - Session ID
   * @param {WebSocket} websocket - WebSocket connection
   */
  registerConnection(sessionId, websocket) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Close existing connection if any
    if (this.connections.has(sessionId)) {
      const existingConnection = this.connections.get(sessionId);
      if (existingConnection.readyState === 1) { // OPEN
        existingConnection.close(1000, 'New connection established');
      }
    }

    this.connections.set(sessionId, websocket);
    session.isConnected = true;
    session.connectionInfo = {
      connectedAt: new Date(),
      remoteAddress: websocket._socket?.remoteAddress || 'Unknown'
    };
    
    this.updateSessionStatus(sessionId, 'connected');
    logger.info(`WebSocket registered for session: ${sessionId}`);
  }

  /**
   * Handle WebSocket disconnection
   * @param {WebSocket} websocket - WebSocket connection
   */
  handleDisconnection(websocket) {
    // Find session by WebSocket connection
    for (const [sessionId, connection] of this.connections.entries()) {
      if (connection === websocket) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.isConnected = false;
          session.connectionInfo = null;
          this.updateSessionStatus(sessionId, 'disconnected');
        }
        
        this.connections.delete(sessionId);
        logger.info(`WebSocket disconnected for session: ${sessionId}`);
        break;
      }
    }
  }

  /**
   * Get WebSocket connection for session
   * @param {string} sessionId - Session ID
   * @returns {WebSocket|null} WebSocket connection or null
   */
  getConnection(sessionId) {
    return this.connections.get(sessionId) || null;
  }

  /**
   * Delete session
   * @param {string} sessionId - Session ID
   * @returns {Promise<boolean>} True if session was deleted
   */
  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // Close WebSocket connection if exists
    const connection = this.connections.get(sessionId);
    if (connection && connection.readyState === 1) {
      connection.close(1000, 'Session deleted');
    }
    
    this.connections.delete(sessionId);
    this.sessions.delete(sessionId);

    logger.info(`Session deleted: ${sessionId}`);
    return true;
  }

  /**
   * Add a message to the session's history
   * @param {string} sessionId - Session ID
   * @param {Object} message - Message to add to history
   */
  addToHistory(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (!session.history) {
        session.history = [];
      }
      session.history.push(message);
      this.updateLastActivity(sessionId);
    }
  }

  /**
   * Get the session's history
   * @param {string} sessionId - Session ID
   * @returns {Array} History array
   */
  getHistory(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? session.history || [] : [];
  }

  /**
   * Add command to session
   * @param {string} sessionId - Session ID
   * @param {Object} command - Command object
   */
  addCommand(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.commands.push({
        ...command,
        addedAt: new Date()
      });
      this.updateLastActivity(sessionId);
    }
  }

  /**
   * Get session statistics
   * @returns {Object} Statistics object
   */
  getStatistics() {
    const totalSessions = this.sessions.size;
    const activeSessions = this.listActiveSessions().length;
    const connectedSessions = Array.from(this.sessions.values())
      .filter(session => session.isConnected).length;
    
    return {
      totalSessions,
      activeSessions,
      connectedSessions,
      expiredSessions: totalSessions - activeSessions,
      totalConnections: this.connections.size,
      uptime: process.uptime()
    };
  }

  /**
   * Get active session count
   * @returns {number} Number of active sessions
   */
  getActiveSessionCount() {
    return this.listActiveSessions().length;
  }

  /**
   * Update last activity timestamp
   * @param {string} sessionId - Session ID
   */
  updateLastActivity(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  /**
   * Check if session is expired
   * @param {Object} session - Session object
   * @returns {boolean} True if session is expired
   */
  isExpired(session) {
    const now = Date.now();
    const lastActivity = new Date(session.lastActivity).getTime();
    return (now - lastActivity) > config.SESSION_TIMEOUT;
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions() {
    const expiredSessions = [];
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (this.isExpired(session)) {
        expiredSessions.push(sessionId);
      }
    }

    expiredSessions.forEach(sessionId => {
      this.deleteSession(sessionId);
    });

    if (expiredSessions.length > 0) {
      logger.info(`Cleaned up ${expiredSessions.length} expired sessions`);
    }
  }

  /**
   * Start automatic cleanup interval
   */
  startCleanupInterval() {
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, config.SESSION_CLEANUP_INTERVAL);
    
    logger.info(`Session cleanup interval started: ${config.SESSION_CLEANUP_INTERVAL}ms`);
  }

  /**
   * Cleanup all sessions and connections
   */
  async cleanup() {
    logger.info('Starting SessionManager cleanup...');
    
    // Close all WebSocket connections
    for (const connection of this.connections.values()) {
      if (connection.readyState === 1) {
        connection.close(1000, 'Service shutdown');
      }
    }
    
    this.connections.clear();
    this.sessions.clear();
    
    logger.info('SessionManager cleanup completed');
  }
}

module.exports = SessionManager;
