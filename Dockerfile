# Multi-stage Docker build for Browser Automation Service
FROM node:18-alpine AS # Create startup script with improved browser support
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
# Create and set permissions for tmp directories\n\
mkdir -p /tmp/puppeteer /tmp/.X99-lock\n\
chown -R appuser:nodejs /tmp/puppeteer /tmp/.X99-lock || true\n\
\n\
# Start Xvfb display server in background\n\
echo "Starting Xvfb..."\n\
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset > /dev/null 2>&1 &\n\
\n\
# Wait for Xvfb to start\n\
sleep 3\n\
\n\
# Export display variable\n\
export DISPLAY=:99\n\
\n\
# Test if display is working\n\
if ! xdpyinfo -display :99 >/dev/null 2>&1; then\n\
  echo "Warning: Xvfb display not ready, continuing anyway..."\n\
fi\n\
\n\
# Start the Node.js application\n\
echo "Starting Browser Automation Service..."\n\
exec node src/server.js\n\
' > /app/start.sh && \
chmod +x /app/start.sh && \
chown appuser:nodejs /app/start.sh

# Create logs directory and set proper permissions  
RUN mkdir -p logs /tmp/puppeteer && \
    chown -R appuser:nodejs logs /tmp/puppeteer && \
    chmod 755 /tmporking directory
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
    x11-utils \
    # Font support
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-dejavu-core \
    # Audio support
    libasound2 \
    # Accessibility
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    # Graphics and rendering
    libdrm2 \
    libxkbcommon0 \
    libxss1 \
    libgconf-2-4 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libatk1.0-0 \
    libcairo-gobject2 \
    libgtk-3-0 \
    libgdk-pixbuf2.0-0 \
    # Security
    libu2f-udev \
    # Vulkan support
    libvulkan1 \
    # Additional dependencies
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libnss3 \
    libcups2 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libgcc1 \
    # Process management
    dumb-init \
    # Debugging tools (optional)
    procps \
    # Cleanup
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for browser automation
ENV CHROME_BIN=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium \
    CHROMIUM_PATH=/usr/bin/chromium \
    DISPLAY=:99 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    NO_SANDBOX=1 \
    DEBIAN_FRONTEND=noninteractive

# Create app user (Debian syntax)
RUN groupadd -r -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs appuser

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

# Create logs directory and tmp directories for Puppeteer
RUN mkdir -p logs /tmp/puppeteer && \
    chown -R appuser:nodejs logs /tmp/puppeteer && \
    chmod 755 /tmp

# Create enhanced startup script for Xvfb and application
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
# Create and set permissions for tmp directories\n\
mkdir -p /tmp/puppeteer /tmp/.X99-lock\n\
\n\
# Start Xvfb display server in background\n\
echo "Starting Xvfb virtual display..."\n\
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset > /dev/null 2>&1 &\n\
XVFB_PID=$!\n\
\n\
# Wait for Xvfb to start\n\
sleep 3\n\
\n\
# Export display variable\n\
export DISPLAY=:99\n\
\n\
# Verify Xvfb is running\n\
if ! kill -0 $XVFB_PID 2>/dev/null; then\n\
  echo "Warning: Xvfb failed to start, continuing without virtual display..."\n\
fi\n\
\n\
# Start the Node.js application\n\
echo "Starting Browser Automation Service..."\n\
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
