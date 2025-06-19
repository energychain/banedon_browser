const express = require('express');
const logger = require('../utils/logger');
const CommandExecutor = require('../services/CommandExecutor');

/**
 * Create command routes
 * @param {SessionManager} sessionManager - Session manager instance
 * @returns {express.Router} Express router
 */
function createCommandRoutes(sessionManager) {
  const router = express.Router();
  const commandExecutor = new CommandExecutor(sessionManager);

  // Execute command
  router.post('/:sessionId/commands', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const commandData = req.body;

      const result = await commandExecutor.executeCommand(sessionId, commandData);
      
      res.json({
        success: true,
        command: {
          id: result.commandId,
          type: commandData.type,
          status: 'completed',
          result: result.result,
          completedAt: result.completedAt
        }
      });
    } catch (error) {
      logger.error(`Failed to execute command for session ${req.params.sessionId}:`, error);

      if (error.message.includes('No active browser connection')) {
        return res.status(400).json({
          success: false,
          message: 'No active browser connection for this session'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Internal Server Error',
        error: error.message
      });
    }
  });

  // Get commands for session
  router.get('/:sessionId/commands', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { status, limit } = req.query;
      
      const options = {};
      if (status) options.status = status;
      if (limit) options.limit = parseInt(limit);

      const commands = commandExecutor.getSessionCommands(sessionId, options);
      
      res.json({
        success: true,
        commands,
        count: commands.length
      });
    } catch (error) {
      logger.error('Failed to get commands:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get command status
  router.get('/:sessionId/commands/:commandId', async (req, res) => {
    try {
      const { commandId } = req.params;
      
      const status = commandExecutor.getCommandStatus(commandId);
      
      if (!status) {
        return res.status(404).json({
          success: false,
          error: 'Command not found'
        });
      }

      res.json({
        success: true,
        command: status
      });
    } catch (error) {
      logger.error('Failed to get command status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Cancel command
  router.delete('/:sessionId/commands/:commandId', async (req, res) => {
    try {
      const { commandId } = req.params;
      
      const cancelled = commandExecutor.cancelCommand(commandId);
      
      if (!cancelled) {
        return res.status(404).json({
          success: false,
          error: 'Command not found or already completed'
        });
      }

      res.json({
        success: true,
        message: 'Command cancelled successfully'
      });
    } catch (error) {
      logger.error('Failed to cancel command:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Store command executor for WebSocket manager
  router.commandExecutor = commandExecutor;

  return router;
}

module.exports = createCommandRoutes;
