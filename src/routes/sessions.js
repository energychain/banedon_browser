const express = require('express');
const logger = require('../utils/logger');

/**
 * Create session routes
 * @param {SessionManager} sessionManager - Session manager instance
 * @returns {express.Router} Express router
 */
function createSessionRoutes(sessionManager) {
  const router = express.Router();

  // Create new session
  router.post('/', async (req, res) => {
    try {
      const metadata = {
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        ...req.body.metadata
      };

      const session = sessionManager.createSession(metadata);
      
      res.status(201).json({
        success: true,
        session: {
          id: session.id,
          createdAt: session.createdAt,
          status: session.status,
          metadata: session.metadata
        }
      });
    } catch (error) {
      logger.error('Failed to create session:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get session by ID
  router.get('/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = sessionManager.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      res.json({
        success: true,
        session: {
          id: session.id,
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
          status: session.status,
          isConnected: session.isConnected,
          commandCount: session.commands.length,
          metadata: session.metadata,
          connectionInfo: session.connectionInfo
        }
      });
    } catch (error) {
      logger.error('Failed to get session:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // List all active sessions
  router.get('/', async (req, res) => {
    try {
      const sessions = sessionManager.listActiveSessions();
      const statistics = sessionManager.getStatistics();
      
      res.json({
        success: true,
        sessions,
        statistics,
        count: sessions.length
      });
    } catch (error) {
      logger.error('Failed to list sessions:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Delete session
  router.delete('/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const deleted = sessionManager.deleteSession(sessionId);
      
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      res.json({
        success: true,
        message: 'Session deleted successfully'
      });
    } catch (error) {
      logger.error('Failed to delete session:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Update session status
  router.patch('/:sessionId/status', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { status } = req.body;
      
      if (!status) {
        return res.status(400).json({
          success: false,
          error: 'Status is required'
        });
      }

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      sessionManager.updateSessionStatus(sessionId, status);
      
      res.json({
        success: true,
        message: 'Session status updated',
        status
      });
    } catch (error) {
      logger.error('Failed to update session status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get session statistics
  router.get('/_stats', async (req, res) => {
    try {
      const statistics = sessionManager.getStatistics();
      
      res.json({
        success: true,
        statistics
      });
    } catch (error) {
      logger.error('Failed to get statistics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createSessionRoutes;
