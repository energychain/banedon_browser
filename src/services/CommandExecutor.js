const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const config = require('../utils/config');

class CommandExecutor {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.commandQueue = new Map(); // sessionId -> command queue
    this.pendingCommands = new Map(); // commandId -> command info
    this.commandResults = new Map(); // commandId -> result
  }

  /**
   * Execute a command for a session
   * @param {string} sessionId - Session ID
   * @param {Object} commandData - Command data
   * @returns {Promise<Object>} Command execution result
   */
  async executeCommand(sessionId, commandData) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session.isConnected) {
      throw new Error(`Session not connected: ${sessionId}`);
    }

    // Validate command
    this.validateCommand(commandData);

    // Create command object
    const command = {
      id: uuidv4(),
      sessionId,
      type: commandData.type,
      payload: commandData.payload || {},
      timeout: commandData.timeout || config.COMMAND_TIMEOUT,
      createdAt: new Date(),
      status: 'pending',
      retryCount: 0
    };

    // Check queue size
    const queue = this.getCommandQueue(sessionId);
    if (queue.length >= config.MAX_COMMAND_QUEUE_SIZE) {
      throw new Error(`Command queue full for session: ${sessionId}`);
    }

    // Add to session commands
    this.sessionManager.addCommand(sessionId, command);

    // Add to pending commands
    this.pendingCommands.set(command.id, command);

    // Send command to extension via WebSocket
    const connection = this.sessionManager.getConnection(sessionId);
    if (!connection || connection.readyState !== 1) {
      this.pendingCommands.delete(command.id);
      throw new Error(`WebSocket connection not available for session: ${sessionId}`);
    }

    try {
      // Send command to extension
      const message = {
        type: 'command',
        id: command.id,
        command: {
          type: command.type,
          payload: command.payload,
          timeout: command.timeout
        }
      };

      connection.send(JSON.stringify(message));
      command.status = 'sent';
      logger.debug(`Command sent to extension: ${command.id}`, { sessionId, type: command.type });

      // Set timeout for command
      const timeoutPromise = this.createCommandTimeout(command.id, command.timeout);

      // Wait for result or timeout
      const result = await Promise.race([
        this.waitForCommandResult(command.id),
        timeoutPromise
      ]);

      return result;
    } catch (error) {
      this.pendingCommands.delete(command.id);
      command.status = 'failed';
      command.error = error.message;
      throw error;
    }
  }

  /**
   * Handle command result from extension
   * @param {string} commandId - Command ID
   * @param {Object} result - Command result
   */
  handleCommandResult(commandId, result) {
    const command = this.pendingCommands.get(commandId);
    if (!command) {
      logger.warn(`Received result for unknown command: ${commandId}`);
      return;
    }

    command.status = result.success ? 'completed' : 'failed';
    command.completedAt = new Date();
    command.result = result.result;
    command.error = result.error;

    // Store result for retrieval
    this.commandResults.set(commandId, {
      commandId,
      success: result.success,
      result: result.result,
      error: result.error,
      completedAt: command.completedAt
    });

    // Remove from pending
    this.pendingCommands.delete(commandId);

    logger.debug(`Command result received: ${commandId}`, { 
      success: result.success, 
      sessionId: command.sessionId 
    });
  }

  /**
   * Cancel a pending command
   * @param {string} commandId - Command ID
   * @returns {boolean} True if command was cancelled
   */
  cancelCommand(commandId) {
    const command = this.pendingCommands.get(commandId);
    if (!command) {
      return false;
    }

    command.status = 'cancelled';
    command.completedAt = new Date();

    // Send cancellation to extension
    const connection = this.sessionManager.getConnection(command.sessionId);
    if (connection && connection.readyState === 1) {
      const message = {
        type: 'cancel_command',
        commandId
      };
      connection.send(JSON.stringify(message));
    }

    this.pendingCommands.delete(commandId);
    logger.debug(`Command cancelled: ${commandId}`);
    
    return true;
  }

  /**
   * Get command status
   * @param {string} commandId - Command ID
   * @returns {Object|null} Command status or null if not found
   */
  getCommandStatus(commandId) {
    // Check pending commands first
    const pendingCommand = this.pendingCommands.get(commandId);
    if (pendingCommand) {
      return {
        id: pendingCommand.id,
        status: pendingCommand.status,
        type: pendingCommand.type,
        createdAt: pendingCommand.createdAt,
        sessionId: pendingCommand.sessionId
      };
    }

    // Check completed commands
    const result = this.commandResults.get(commandId);
    if (result) {
      return {
        id: commandId,
        status: result.success ? 'completed' : 'failed',
        completedAt: result.completedAt,
        result: result.result,
        error: result.error
      };
    }

    return null;
  }

  /**
   * Get commands for a session
   * @param {string} sessionId - Session ID
   * @param {Object} options - Query options
   * @returns {Array} Array of commands
   */
  getSessionCommands(sessionId, options = {}) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return [];
    }

    let commands = [...session.commands];

    // Filter by status if specified
    if (options.status) {
      commands = commands.filter(cmd => {
        const status = this.getCommandStatus(cmd.id);
        return status && status.status === options.status;
      });
    }

    // Sort by creation time (newest first)
    commands.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));

    // Limit results
    if (options.limit) {
      commands = commands.slice(0, options.limit);
    }

    return commands.map(cmd => ({
      ...cmd,
      status: this.getCommandStatus(cmd.id)
    }));
  }

  /**
   * Validate command data
   * @param {Object} commandData - Command data to validate
   */
  validateCommand(commandData) {
    if (!commandData.type) {
      throw new Error('Command type is required');
    }

    const validTypes = ['navigate', 'screenshot', 'extract', 'execute', 'click', 'type', 'scroll'];
    if (!validTypes.includes(commandData.type)) {
      throw new Error(`Invalid command type: ${commandData.type}`);
    }

    // Type-specific validation
    switch (commandData.type) {
      case 'navigate':
        if (!commandData.payload?.url) {
          throw new Error('URL is required for navigate command');
        }
        break;
      case 'extract':
        if (!commandData.payload?.selector) {
          throw new Error('Selector is required for extract command');
        }
        break;
      case 'execute':
        if (!commandData.payload?.script) {
          throw new Error('Script is required for execute command');
        }
        break;
      case 'click':
        if (!commandData.payload?.selector) {
          throw new Error('Selector is required for click command');
        }
        break;
      case 'type':
        if (!commandData.payload?.selector || !commandData.payload?.text) {
          throw new Error('Selector and text are required for type command');
        }
        break;
    }
  }

  /**
   * Get command queue for session
   * @param {string} sessionId - Session ID
   * @returns {Array} Command queue
   */
  getCommandQueue(sessionId) {
    if (!this.commandQueue.has(sessionId)) {
      this.commandQueue.set(sessionId, []);
    }
    return this.commandQueue.get(sessionId);
  }

  /**
   * Wait for command result
   * @param {string} commandId - Command ID
   * @returns {Promise<Object>} Command result
   */
  waitForCommandResult(commandId) {
    return new Promise((resolve, reject) => {
      const checkResult = () => {
        const result = this.commandResults.get(commandId);
        if (result) {
          this.commandResults.delete(commandId); // Clean up
          if (result.success) {
            resolve(result);
          } else {
            reject(new Error(result.error || 'Command failed'));
          }
        } else {
          // Check if command still pending
          if (this.pendingCommands.has(commandId)) {
            setTimeout(checkResult, 100); // Check again in 100ms
          } else {
            reject(new Error('Command was cancelled or lost'));
          }
        }
      };
      
      setTimeout(checkResult, 100);
    });
  }

  /**
   * Create command timeout promise
   * @param {string} commandId - Command ID
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise} Timeout promise
   */
  createCommandTimeout(commandId, timeout) {
    return new Promise((_, reject) => {
      setTimeout(() => {
        if (this.pendingCommands.has(commandId)) {
          this.pendingCommands.delete(commandId);
          reject(new Error(`Command timeout after ${timeout}ms`));
        }
      }, timeout);
    });
  }

  /**
   * Cleanup commands for session
   * @param {string} sessionId - Session ID
   */
  cleanupSession(sessionId) {
    // Cancel all pending commands for this session
    for (const [commandId, command] of this.pendingCommands.entries()) {
      if (command.sessionId === sessionId) {
        this.cancelCommand(commandId);
      }
    }

    // Clear command queue
    this.commandQueue.delete(sessionId);
    
    logger.debug(`Cleaned up commands for session: ${sessionId}`);
  }
}

module.exports = CommandExecutor;
