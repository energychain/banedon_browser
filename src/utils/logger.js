const config = require('./config');

class Logger {
  constructor() {
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };
    this.currentLevel = this.levels[config.LOG_LEVEL] || this.levels.info;
  }

  formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
  }

  log(level, message, meta = {}) {
    if (this.levels[level] <= this.currentLevel) {
      const formattedMessage = this.formatMessage(level, message, meta);
      console.log(formattedMessage);
      
      // In production, you might want to write to files or external logging services
      if (config.NODE_ENV === 'production' && level === 'error') {
        // Write to error log file or send to monitoring service
        this.writeToFile(formattedMessage);
      }
    }
  }

  writeToFile(message) {
    // Simple file logging - in production, consider using winston or similar
    const fs = require('fs');
    const path = require('path');
    
    try {
      const logFile = path.join(process.cwd(), 'logs', config.LOG_FILE);
      fs.appendFileSync(logFile, message + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', error.message);
    }
  }

  error(message, meta = {}) {
    this.log('error', message, meta);
  }

  warn(message, meta = {}) {
    this.log('warn', message, meta);
  }

  info(message, meta = {}) {
    this.log('info', message, meta);
  }

  debug(message, meta = {}) {
    this.log('debug', message, meta);
  }
}

module.exports = new Logger();
