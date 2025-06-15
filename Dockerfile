# Multi-stage Docker build for Browser Automation Service
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code and extension files
COPY src/ ./src/
COPY docs/ ./docs/
COPY extension/ ./extension/
COPY public/ ./public/
COPY build.sh ./build.sh

# Install zip utility for building extension package
RUN apk add --no-cache zip

# Build extension package
RUN chmod +x build.sh && ./build.sh

# Production stage
FROM node:18-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S appuser -u 1001

# Set working directory
WORKDIR /app

# Copy built application from builder stage
COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/src ./src
COPY --from=builder --chown=appuser:nodejs /app/docs ./docs
COPY --from=builder --chown=appuser:nodejs /app/extension ./extension
COPY --from=builder --chown=appuser:nodejs /app/public ./public
COPY --from=builder --chown=appuser:nodejs /app/build ./build
COPY --chown=appuser:nodejs package*.json ./

# Create logs directory
RUN mkdir -p logs && chown appuser:nodejs logs

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3010

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); \
    const options = { hostname: 'localhost', port: 3010, path: '/health' }; \
    const req = http.request(options, (res) => { \
      process.exit(res.statusCode === 200 ? 0 : 1); \
    }); \
    req.on('error', () => process.exit(1)); \
    req.end();"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "src/server.js"]
