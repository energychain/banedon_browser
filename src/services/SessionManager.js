const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const config = require('../utils/config');

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.connections = new Map(); // sessionId -> WebSocket connection
    this.cleanupIntervalId = null;
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
   * Update last activity timestamp for a session
   * @param {string} sessionId - Session ID
   */
  updateLastActivity(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  /**
   * Check if a session is expired
   * @param {Object} session - Session object
   * @returns {boolean} True if session is expired
   */
  isExpired(session) {
    const timeout = (session.isConnected ? config.ACTIVE_SESSION_TIMEOUT : config.INACTIVE_SESSION_TIMEOUT) * 1000;
    return (new Date() - session.lastActivity) > timeout;
  }

  /**
   * Start periodic cleanup of expired sessions
   */
  startCleanupInterval() {
    this.cleanupIntervalId = setInterval(() => {
      logger.info('Starting SessionManager cleanup...');
      let cleanedCount = 0;
      for (const session of this.sessions.values()) {
        if (this.isExpired(session)) {
          logger.info(`Session expired: ${session.id}, cleaning up.`);
          this.deleteSession(session.id);
          cleanedCount++;
        }
      }
      if (cleanedCount > 0) {
        logger.info(`SessionManager cleanup completed. Removed ${cleanedCount} expired sessions.`);
      } else {
        logger.info('SessionManager cleanup completed. No expired sessions found.');
      }
    }, config.SESSION_CLEANUP_INTERVAL * 1000);
    logger.info(`Session cleanup interval started: ${config.SESSION_CLEANUP_INTERVAL}s`);
  }

  /**
   * Stop periodic cleanup of expired sessions
   */
  stopCleanupInterval() {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
      logger.info('Session cleanup interval stopped.');
    }
  }

  /**
   * Cleanup all sessions and intervals
   */
  async cleanup() {
    this.stopCleanupInterval();
    for (const sessionId of this.sessions.keys()) {
      await this.deleteSession(sessionId);
    }
    this.sessions.clear();
    this.connections.clear();
    logger.info('SessionManager fully cleaned up.');
  }

  /**
   * Get the count of active sessions
   * @returns {number} Number of active sessions
   */
  getActiveSessionCount() {
    return this.sessions.size;
  }

  /**
   * Add a command to a session
   * @param {string} sessionId - Session ID
   * @param {Object} command - Command object
   */
  addCommand(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (!session.commands) {
        session.commands = [];
      }
      session.commands.push(command);
      this.updateLastActivity(sessionId);
    }
  }

  /**
   * Check and process expired sessions
   */
  checkExpiredSessions() {
    for (const session of this.sessions.values()) {
      if (this.isExpired(session)) {
        session.status = 'expired';
        logger.info(`Session expired: ${session.id}`);
      }
    }
  }

  /**
   * Get session statistics
   * @returns {Object} Session statistics
   */
  getStatistics() {
    const sessions = Array.from(this.sessions.values());
    return {
      total: sessions.length,
      connected: sessions.filter(s => s.isConnected).length,
      active: sessions.filter(s => s.status === 'active' || s.status === 'connected').length,
      created: sessions.filter(s => s.status === 'created').length,
      expired: sessions.filter(s => s.status === 'expired').length
    };
  }
}

module.exports = SessionManager;
