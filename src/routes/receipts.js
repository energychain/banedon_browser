const express = require('express');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const CommandExecutor = require('../services/CommandExecutor');

/**
 * Create receipt routes
 * @param {SessionManager} sessionManager - Session manager instance
 * @returns {express.Router} Express router
 */
function createReceiptRoutes(sessionManager) {
  const router = express.Router();
  const commandExecutor = new CommandExecutor(sessionManager);

  // Run a receipt
  router.post('/run', async (req, res) => {
    try {
      const receipt = req.body;
      
      // Validate receipt format
      if (!receipt || typeof receipt !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'Invalid receipt format: must be a JSON object'
        });
      }
      
      if (!receipt.version) {
        return res.status(400).json({
          success: false,
          error: 'Invalid receipt: missing version field'
        });
      }
      
      if (!Array.isArray(receipt.tasks)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid receipt: tasks must be an array'
        });
      }
      
      // Validate each task
      for (let i = 0; i < receipt.tasks.length; i++) {
        const task = receipt.tasks[i];
        if (!task.id) {
          return res.status(400).json({
            success: false,
            error: `Invalid task at index ${i}: missing id`
          });
        }
        if (!task.type) {
          return res.status(400).json({
            success: false,
            error: `Invalid task at index ${i}: missing type`
          });
        }
        if (!task.params || !task.params.query) {
          return res.status(400).json({
            success: false,
            error: `Invalid task at index ${i}: missing params.query`
          });
        }
      }
      
      // Create a new session for the receipt execution
      const metadata = {
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        source: 'receipt',
        receiptInfo: {
          version: receipt.version,
          createdAt: receipt.createdAt,
          taskCount: receipt.tasks.length
        }
      };
      
      const session = sessionManager.createSession(metadata);
      logger.info(`Created session ${session.id} for receipt execution with ${receipt.tasks.length} tasks`);
      
      // Execute tasks sequentially
      const results = [];
      let hasErrors = false;
      
      for (let i = 0; i < receipt.tasks.length; i++) {
        const task = receipt.tasks[i];
        
        try {
          logger.info(`Executing task ${i + 1}/${receipt.tasks.length}: ${task.params.query}`);
          
          // Convert receipt task to command format
          const commandData = {
            type: task.type || 'natural_language_task',
            payload: {
              query: task.params.query,
              taskId: task.id
            },
            timeout: 30000 // 30 second timeout per task
          };
          
          const result = await commandExecutor.executeCommand(session.id, commandData);
          
          results.push({
            taskId: task.id,
            taskIndex: i,
            query: task.params.query,
            status: 'completed',
            result: result.result,
            commandId: result.commandId,
            completedAt: result.completedAt
          });
          
          logger.info(`Task ${i + 1} completed successfully`);
          
        } catch (error) {
          logger.error(`Task ${i + 1} failed:`, error);
          hasErrors = true;
          
          results.push({
            taskId: task.id,
            taskIndex: i,
            query: task.params.query,
            status: 'failed',
            error: error.message,
            failedAt: new Date().toISOString()
          });
          
          // Continue with next task even if this one failed
        }
      }
      
      const executionSummary = {
        totalTasks: receipt.tasks.length,
        completedTasks: results.filter(r => r.status === 'completed').length,
        failedTasks: results.filter(r => r.status === 'failed').length,
        hasErrors
      };
      
      logger.info(`Receipt execution completed for session ${session.id}:`, executionSummary);
      
      res.json({
        success: true,
        sessionId: session.id,
        executionId: uuidv4(),
        receipt: {
          version: receipt.version,
          createdAt: receipt.createdAt,
          executedAt: new Date().toISOString()
        },
        summary: executionSummary,
        results: results
      });
      
    } catch (error) {
      logger.error('Failed to execute receipt:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get receipt execution status
  router.get('/execution/:executionId', async (req, res) => {
    try {
      const { executionId } = req.params;
      
      // This is a placeholder for now - you could store execution results
      // in a database or cache to retrieve them later
      res.status(404).json({
        success: false,
        error: 'Execution tracking not implemented yet'
      });
      
    } catch (error) {
      logger.error('Failed to get execution status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createReceiptRoutes;
