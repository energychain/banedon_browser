# Browser Automation Service

A standalone browser automation service that provides HTTP/WebSocket APIs for remote browser control via a Chrome extension.

## � Documentation

- **[🚀 Production Installation Guide](INSTALLATION.md)** - Complete deployment guide for server 10.0.0.2
- **[📖 API Documentation](docs/API.md)** - HTTP API reference
- **[🔌 WebSocket Documentation](docs/WEBSOCKET.md)** - WebSocket API reference
- **[✅ Phase 1 Completion Summary](PHASE1_COMPLETE.md)** - Implementation details and deliverables

## �🚀 Quick Start (Development)

### Prerequisites
- Node.js 16+ 
- Chrome/Chromium browser
- npm or yarn

### 1. Install and Start Service

```bash
# Clone and install
git clone <repository-url>
cd browser-automation-service
npm install

# Start the service
npm start
```

The service will start on `http://localhost:3010`

### 2. Install Browser Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/` folder
4. The extension icon should appear in your toolbar

### 3. Create a Session and Connect

```bash
# Create a new session
curl -X POST http://localhost:3010/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"metadata":{"browser":"chrome"}}'

# Copy the session ID from the response
# Click the extension icon and enter the session ID
# Click "Connect"
```

### 4. Execute Commands

```bash
# Navigate to a webpage
curl -X POST http://localhost:3010/api/sessions/{SESSION_ID}/commands \
  -H "Content-Type: application/json" \
  -d '{"type":"navigate","payload":{"url":"https://example.com"}}'

# Take a screenshot
curl -X POST http://localhost:3010/api/sessions/{SESSION_ID}/commands \
  -H "Content-Type: application/json" \
  -d '{"type":"screenshot","payload":{}}'
```

## 📁 Project Structure

```
browser-automation-service/
├── src/
│   ├── server.js              # Main server file
│   ├── services/
│   │   ├── SessionManager.js  # Session management
│   │   ├── CommandExecutor.js # Command execution
│   │   └── WebSocketManager.js # WebSocket handling
│   ├── routes/
│   │   ├── sessions.js        # Session API routes
│   │   └── commands.js        # Command API routes
│   ├── utils/
│   │   ├── config.js          # Configuration
│   │   └── logger.js          # Logging utility
│   └── cli.js                 # CLI testing tool
├── extension/
│   ├── manifest.json          # Extension manifest
│   ├── background.js          # Service worker
│   ├── popup.html            # Extension popup
│   ├── popup.js              # Popup logic
│   ├── content.js            # Content script
│   └── styles.css            # Popup styles
├── tests/                     # Test files
├── docs/                      # Documentation
└── docker-compose.yml         # Docker setup
```

## 🔧 CLI Tool

The service includes a powerful CLI for testing and automation:

```bash
# Start the CLI
npm run cli

# CLI Commands
automation> create                    # Create new session
automation> connect <sessionId>       # Connect to session  
automation> navigate https://google.com
automation> screenshot
automation> extract h1
automation> test google               # Run test scenario
automation> help                     # Show all commands
```

## 📖 API Documentation

### REST API

**Base URL**: `http://localhost:3010`

#### Sessions
- `POST /api/sessions` - Create session
- `GET /api/sessions` - List sessions  
- `GET /api/sessions/:id` - Get session
- `DELETE /api/sessions/:id` - Delete session

#### Commands
- `POST /api/sessions/:id/commands` - Execute command
- `GET /api/sessions/:id/commands` - List commands
- `GET /api/sessions/:id/commands/:cmdId` - Get command status

#### Health
- `GET /health` - Service health check

### WebSocket API

**URL**: `ws://localhost:3010/ws?sessionId={SESSION_ID}`

Real-time bidirectional communication between service and extension.

### Command Types

| Command | Description | Payload |
|---------|-------------|---------|
| `navigate` | Navigate to URL | `{"url": "https://example.com"}` |
| `screenshot` | Take screenshot | `{}` |
| `extract` | Extract page data | `{"selector": "h1", "multiple": false}` |
| `click` | Click element | `{"selector": "button#submit"}` |
| `type` | Type text | `{"selector": "input", "text": "hello"}` |
| `execute` | Run JavaScript | `{"script": "return document.title;"}` |
| `scroll` | Scroll page | `{"x": 0, "y": 500}` |

## 🐳 Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# Or build manually
docker build -t browser-automation-service .
docker run -p 3010:3010 browser-automation-service
```

## ⚙️ Configuration

Create a `.env` file or set environment variables:

```env
# Server
PORT=3010
NODE_ENV=production

# Sessions  
SESSION_TIMEOUT=1800000      # 30 minutes
MAX_SESSIONS=100

# Commands
COMMAND_TIMEOUT=30000        # 30 seconds
MAX_COMMAND_QUEUE_SIZE=50

# WebSocket
WS_HEARTBEAT_INTERVAL=30000  # 30 seconds

# Security
ALLOWED_ORIGINS=http://localhost:3000,chrome-extension://
API_RATE_LIMIT=100

# Logging
LOG_LEVEL=info
```

## 🧪 Testing

```bash
# Run tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test
npm test -- --testNamePattern="SessionManager"
```

## 📚 Documentation

- [API Documentation](docs/API.md) - Complete REST API reference
- [WebSocket Protocol](docs/WEBSOCKET.md) - WebSocket message specification  
- [Integration Guide](docs/INTEGRATION.md) - How to integrate with other systems
- [Architecture](docs/ARCHITECTURE.md) - System design and components

## 🔒 Security

### Production Considerations

1. **Authentication**: Implement API authentication
2. **HTTPS**: Use TLS for production deployments
3. **Origin Validation**: Restrict WebSocket origins
4. **Rate Limiting**: Configure appropriate rate limits
5. **Input Validation**: Sanitize all command payloads
6. **Logging**: Monitor for suspicious activity

### Extension Security

- Commands are validated before execution
- Script execution has security checks
- Permission-based access control
- Origin verification for messages

## 🔍 Troubleshooting

### Common Issues

**Service Won't Start**
- Check if port 3010 is available
- Verify Node.js version (16+ required)
- Check for missing dependencies

**Extension Won't Connect**
- Ensure service is running
- Check session ID is valid
- Verify WebSocket URL is correct
- Check browser console for errors

**Commands Fail**
- Verify extension is connected
- Check command payload format
- Ensure target elements exist
- Review timeout settings

### Debug Logging

Enable debug mode:
```bash
LOG_LEVEL=debug npm start
```

## 🚧 Development

### Setup Development Environment

```bash
# Install dependencies
npm install

# Start in development mode with auto-reload
npm run dev

# Run linting
npm run lint
npm run lint:fix

# Run tests in watch mode
npm run test:watch
```

### Project Standards

- **Code Style**: ESLint + Prettier
- **Testing**: Jest with >80% coverage
- **Documentation**: Keep docs updated
- **Git**: Conventional commit messages
- **Security**: Regular dependency updates

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests and documentation
5. Submit a pull request

## 📄 License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

## 🎯 Roadmap

### Phase 1 (Current)
- ✅ Basic service and extension
- ✅ Core command types
- ✅ WebSocket communication
- ✅ CLI tool

### Phase 2 (Planned)
- [ ] Authentication system
- [ ] Multi-browser support
- [ ] Advanced selectors
- [ ] Plugin system

### Phase 3 (Future)
- [ ] Visual testing
- [ ] AI-powered automation
- [ ] Cloud deployment
- [ ] Performance monitoring

## 💬 Support

- Create an issue for bug reports
- Join discussions for questions
- Check documentation for guides
- Use CLI tool for quick testing

---

**Ready to automate? Start with `npm start` and explore the possibilities!** 🎉