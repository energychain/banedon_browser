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

# Production stage - Use Debian for better browser support
FROM node:18-slim AS production

# Install system dependencies for headless browser automation
RUN apt-get update && apt-get install -y \
    # Browser dependencies
    chromium \
    # Display server for headless mode
    xvfb \
    # Font support
    fonts-liberation \
    fonts-noto-color-emoji \
    # Audio support
    libasound2 \
    # Accessibility
    libatk-bridge2.0-0 \
    # Graphics
    libdrm2 \
    libxkbcommon0 \
    libxss1 \
    # Security
    libu2f-udev \
    # Vulkan support
    libvulkan1 \
    # Process management
    dumb-init \
    # Cleanup
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for browser automation
ENV CHROME_BIN=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium \
    CHROMIUM_PATH=/usr/bin/chromium \
    DISPLAY=:99 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

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

# Create startup script for Xvfb and application
RUN echo '#!/bin/bash\n\
# Start Xvfb (virtual display) in background\n\
Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &\n\
\n\
# Wait a moment for Xvfb to start\n\
sleep 2\n\
\n\
# Start the Node.js application\n\
exec node src/server.js\n\
' > /app/start.sh && \
chmod +x /app/start.sh && \
chown appuser:nodejs /app/start.sh

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

# Start the application with Xvfb
CMD ["./start.sh"]
