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
        debug: req.body.debug || false, // Enable debug mode for this session
        ...req.body.metadata
      };

      const session = sessionManager.createSession(metadata);
      
      res.status(201).json({
        success: true,
        session: {
          id: session.id,
          createdAt: session.createdAt,
          status: session.status,
          metadata: session.metadata,
          debug: session.metadata.debug
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

  // Update session metadata
  router.put('/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { metadata } = req.body;
      
      if (!metadata) {
        return res.status(400).json({
          success: false,
          error: 'Metadata is required'
        });
      }

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      // Update session metadata
      session.metadata = { ...session.metadata, ...metadata };
      session.lastActivity = new Date();
      
      logger.info(`Updated session ${sessionId} metadata:`, metadata);
      
      res.json({
        success: true,
        message: 'Session metadata updated',
        session: {
          id: session.id,
          metadata: session.metadata,
          lastActivity: session.lastActivity
        }
      });
    } catch (error) {
      logger.error('Failed to update session metadata:', error);
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

  // Debug endpoint: Get screenshots for session (only if debug enabled)
  router.get('/:sessionId/debug/screenshots', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = sessionManager.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      if (!session.metadata.debug) {
        return res.status(403).json({
          success: false,
          error: 'Debug mode not enabled for this session'
        });
      }

      // Get screenshots from NaturalLanguageTaskService if available
      const screenshots = [];
      const screenshotDir = './public/screenshots';
      const fs = require('fs');
      const path = require('path');
      
      if (fs.existsSync(screenshotDir)) {
        const files = fs.readdirSync(screenshotDir);
        const sessionScreenshots = files
          .filter(file => file.endsWith('.png'))
          .map(file => {
            const filepath = path.join(screenshotDir, file);
            const stats = fs.statSync(filepath);
            return {
              filename: file,
              url: `/screenshots/${file}`,
              size: stats.size,
              createdAt: stats.mtime,
              sessionId: sessionId // For now, return all screenshots
            };
          })
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, 20); // Return last 20 screenshots
        
        screenshots.push(...sessionScreenshots);
      }
      
      res.json({
        success: true,
        sessionId,
        screenshots,
        count: screenshots.length
      });
    } catch (error) {
      logger.error('Failed to get session screenshots:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Debug endpoint: Get logs for session (only if debug enabled)
  router.get('/:sessionId/debug/logs', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { lines = 100 } = req.query;
      const session = sessionManager.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      if (!session.metadata.debug) {
        return res.status(403).json({
          success: false,
          error: 'Debug mode not enabled for this session'
        });
      }

      // Get session history and logs
      const history = sessionManager.getHistory(sessionId);
      const sessionLogs = [];
      
      // For now, return the session history as logs
      // In a real implementation, you'd want to capture actual log entries
      history.forEach(entry => {
        sessionLogs.push({
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `${entry.role}: ${entry.content}`,
          sessionId: sessionId
        });
      });
      
      res.json({
        success: true,
        sessionId,
        logs: sessionLogs.slice(-parseInt(lines)),
        count: sessionLogs.length
      });
    } catch (error) {
      logger.error('Failed to get session logs:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Debug endpoint: Get session task status (only if debug enabled)
  router.get('/:sessionId/debug/status', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = sessionManager.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      if (!session.metadata.debug) {
        return res.status(403).json({
          success: false,
          error: 'Debug mode not enabled for this session'
        });
      }

      const history = sessionManager.getHistory(sessionId);
      
      res.json({
        success: true,
        sessionId,
        session: {
          id: session.id,
          status: session.status,
          createdAt: session.createdAt,
          metadata: session.metadata,
          isConnected: session.isConnected
        },
        history: history,
        historyCount: history.length
      });
    } catch (error) {
      logger.error('Failed to get session debug status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get intervention requests for a session
  router.get('/:sessionId/interventions', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = sessionManager.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      const interventions = session.interventionRequests || [];
      
      res.json({
        success: true,
        sessionId,
        interventions,
        count: interventions.length
      });
    } catch (error) {
      logger.error('Failed to get intervention requests:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Respond to an intervention request
  router.post('/:sessionId/interventions/:requestId/respond', async (req, res) => {
    try {
      const { sessionId, requestId } = req.params;
      const { message, taskCompleted, result } = req.body;
      
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      const nlTaskService = req.app.get('nlTaskService');
      if (!nlTaskService) {
        return res.status(500).json({
          success: false,
          error: 'Natural language task service not available'
        });
      }

      const success = await nlTaskService.handleManualInterventionResponse(sessionId, requestId, {
        message,
        taskCompleted: taskCompleted || false,
        result
      });

      if (!success) {
        return res.status(404).json({
          success: false,
          error: 'Intervention request not found'
        });
      }

      res.json({
        success: true,
        message: 'Intervention response recorded'
      });
    } catch (error) {
      logger.error('Failed to handle intervention response:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createSessionRoutes;
