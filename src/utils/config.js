require('dotenv').config();

const config = {
  // Server configuration
  PORT: process.env.PORT || 3010,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Session configuration
  SESSION_TIMEOUT: parseInt(process.env.SESSION_TIMEOUT) || 30 * 60 * 1000, // 30 minutes
  SESSION_CLEANUP_INTERVAL: parseInt(process.env.SESSION_CLEANUP_INTERVAL) || 5 * 60 * 1000, // 5 minutes
  MAX_SESSIONS: parseInt(process.env.MAX_SESSIONS) || 100,
  
  // Command configuration
  COMMAND_TIMEOUT: parseInt(process.env.COMMAND_TIMEOUT) || 30 * 1000, // 30 seconds
  MAX_COMMAND_QUEUE_SIZE: parseInt(process.env.MAX_COMMAND_QUEUE_SIZE) || 50,
  
  // WebSocket configuration
  WS_HEARTBEAT_INTERVAL: parseInt(process.env.WS_HEARTBEAT_INTERVAL) || 30 * 1000, // 30 seconds
  WS_CONNECTION_TIMEOUT: parseInt(process.env.WS_CONNECTION_TIMEOUT) || 60 * 1000, // 60 seconds
  
  // Security configuration
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:3000',
  API_RATE_LIMIT: parseInt(process.env.API_RATE_LIMIT) || 100, // requests per minute
  
  // AI configuration
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'AIzaSyAUV_utRoqQgumx1iGa9fdM5qGxDMbfm_k',
  
  // Logging configuration
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_FILE: process.env.LOG_FILE || 'automation-service.log'
};

module.exports = config;
