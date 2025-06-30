const express = require('express');
const logger = require('../utils/logger');

/**
 * Create interactive command routes for manual browser control
 * @param {SessionManager} sessionManager - Session manager instance
 * @param {CommandExecutor} commandExecutor - Command executor instance
 * @returns {express.Router} Express router
 */
function createInteractiveRoutes(sessionManager, commandExecutor) {
  const router = express.Router();

  // Execute interactive command (click, type, etc.)
  router.post('/:sessionId/interactive', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { command } = req.body;

      if (!command || !command.type) {
        return res.status(400).json({
          success: false,
          error: 'Command type is required'
        });
      }

      logger.info(`Interactive command requested for session ${sessionId}: ${command.type}`);

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      let result;
      
      switch (command.type) {
        case 'click':
          if (!command.x || !command.y) {
            return res.status(400).json({
              success: false,
              error: 'Click coordinates (x, y) are required'
            });
          }
          
          result = await commandExecutor.executeCommand(sessionId, {
            type: 'click',
            payload: {
              x: command.x,
              y: command.y,
              timeout: 5000
            }
          });
          break;

        case 'type':
          if (!command.text) {
            return res.status(400).json({
              success: false,
              error: 'Text to type is required'
            });
          }
          
          result = await commandExecutor.executeCommand(sessionId, {
            type: 'type',
            payload: {
              text: command.text,
              timeout: 5000
            }
          });
          break;

        case 'key':
          if (!command.key) {
            return res.status(400).json({
              success: false,
              error: 'Key to press is required'
            });
          }
          
          result = await commandExecutor.executeCommand(sessionId, {
            type: 'keypress',
            payload: {
              key: command.key,
              timeout: 5000
            }
          });
          break;

        case 'pause':
          session.isPaused = true;
          session.pauseReason = command.reason || 'manual_pause';
          result = { success: true, message: 'Session paused' };
          break;

        case 'resume':
          session.isPaused = false;
          session.pauseReason = null;
          result = { success: true, message: 'Session resumed' };
          break;

        default:
          return res.status(400).json({
            success: false,
            error: `Unknown command type: ${command.type}`
          });
      }

      // Take screenshot after interactive command
      let screenshot = null;
      try {
        const screenshotResult = await commandExecutor.executeCommand(sessionId, {
          type: 'screenshot',
          payload: {}
        });
        screenshot = screenshotResult.result.screenshot;
      } catch (screenshotError) {
        logger.warn('Failed to take screenshot after interactive command:', screenshotError);
      }

      res.json({
        success: true,
        result: result,
        screenshot: screenshot ? {
          base64: screenshot,
          timestamp: new Date().toISOString()
        } : null,
        sessionState: {
          isPaused: session.isPaused,
          pauseReason: session.pauseReason
        }
      });

    } catch (error) {
      logger.error('Failed to execute interactive command:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get current screenshot for live view
  router.get('/:sessionId/screenshot', async (req, res) => {
    try {
      const { sessionId } = req.params;
      
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      const screenshotResult = await commandExecutor.executeCommand(sessionId, {
        type: 'screenshot',
        payload: {}
      });

      res.json({
        success: true,
        screenshot: {
          base64: screenshotResult.result.screenshot,
          timestamp: new Date().toISOString()
        },
        sessionState: {
          isPaused: session.isPaused,
          pauseReason: session.pauseReason
        }
      });

    } catch (error) {
      logger.error('Failed to get screenshot:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get session state
  router.get('/:sessionId/state', async (req, res) => {
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
        sessionState: {
          id: session.id,
          isPaused: session.isPaused || false,
          pauseReason: session.pauseReason || null,
          createdAt: session.createdAt,
          status: session.status,
          commandCount: session.commands.length
        }
      });

    } catch (error) {
      logger.error('Failed to get session state:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createInteractiveRoutes;
