const express = require('express');
const logger = require('../utils/logger');

/**
 * Create natural language task routes
 * @param {SessionManager} sessionManager - Session manager instance
 * @param {NaturalLanguageTaskService} nlTaskService - Natural language task service
 * @returns {express.Router} Express router
 */
function createNLTaskRoutes(sessionManager, nlTaskService) {
  const router = express.Router();

  // Execute natural language task
  router.post('/:sessionId/nl-tasks', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { task, description } = req.body;

      if (!task && !description) {
        return res.status(400).json({
          success: false,
          error: 'Task description is required'
        });
      }

      const taskDescription = task || description;
      
      logger.info(`Natural language task requested for session ${sessionId}: ${taskDescription}`);

      // Always return a result, even if there are errors
      const result = await nlTaskService.processTask(sessionId, taskDescription);
      
      // If the result indicates failure but we have some response, still return success
      if (!result.success && result.fallbackResponse) {
        res.status(500).json({
          success: false,
          error: result.error,
          task: result
        });
      } else {
        res.json({
          success: true,
          task: result
        });
      }
    } catch (error) {
      logger.error('Failed to execute natural language task:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        task: {
          taskId: require('uuid').v4(),
          sessionId: req.params.sessionId,
          taskDescription: req.body.task || req.body.description || 'Unknown task',
          error: error.message,
          success: false,
          timestamp: new Date().toISOString(),
          fallbackResponse: true
        }
      });
    }
  });

  // Get task history for session
  router.get('/:sessionId/nl-tasks', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = sessionManager.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      // Get natural language tasks from session commands
      const nlTasks = session.commands.filter(cmd => 
        cmd.type === 'nl-task' || cmd.type === 'natural-language-task'
      );
      
      res.json({
        success: true,
        tasks: nlTasks,
        count: nlTasks.length
      });
    } catch (error) {
      logger.error('Failed to get natural language tasks:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createNLTaskRoutes;
