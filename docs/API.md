# Browser Automation Service API Documentation

## Overview

The Browser Automation Service provides a REST API for managing browser automation sessions and executing commands through **two execution modes**:

1. **Extension-Based Mode**: Commands executed in user's browser via WebSocket-connected extension
2. **Server-Side Mode**: Commands executed in headless Chromium browser on the server

The service **automatically chooses** the appropriate execution mode based on connection availability.

**Base URL**: `http://localhost:3010`  
**WebSocket URL**: `ws://localhost:3010/ws`

## Execution Modes

### Extension-Based Execution
- **When**: Browser extension is connected via WebSocket
- **Benefits**: Real-time user interaction, access to user's actual browser state
- **Use Cases**: Interactive workflows, user-guided automation

### Server-Side Execution  
- **When**: No extension connection available (automatic fallback)
- **Benefits**: Fully programmatic, works without user interaction, perfect for CI/CD
- **Use Cases**: Automated testing, data scraping, headless workflows
- **Technology**: Puppeteer with headless Chromium

## Authentication

Currently, no authentication is required. In production, implement proper authentication mechanisms.

## Health Check

### GET /health

Returns the current status of the automation service.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:00:00Z",
  "uptime": 12345.67,
  "version": "1.0.0",
  "activeSessions": 5,
  "wsConnections": 3
}
```

## Session Management

### POST /api/sessions

Creates a new browser automation session.

**Request Body:**
```json
{
  "metadata": {
    "browser": "chrome",
    "version": "91.0",
    "userAgent": "Mozilla/5.0...",
    "custom_field": "value"
  }
}
```

**Response:**
```json
{
  "success": true,
  "session": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "createdAt": "2024-01-15T10:00:00Z",
    "status": "created",
    "metadata": {
      "userAgent": "curl/7.68.0",
      "ip": "::1",
      "browser": "chrome",
      "version": "91.0"
    }
  }
}
```

### GET /api/sessions/:sessionId

Retrieves information about a specific session.

**Response:**
```json
{
  "success": true,
  "session": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "createdAt": "2024-01-15T10:00:00Z",
    "lastActivity": "2024-01-15T10:05:00Z",
    "status": "connected",
    "isConnected": true,
    "commandCount": 3,
    "metadata": {
      "browser": "chrome",
      "version": "91.0"
    },
    "connectionInfo": {
      "connectedAt": "2024-01-15T10:01:00Z",
      "remoteAddress": "192.168.1.100"
    }
  }
}
```

### GET /api/sessions

Lists all active sessions.

**Response:**
```json
{
  "success": true,
  "sessions": [
    {
      "id": "session1",
      "createdAt": "2024-01-15T10:00:00Z",
      "lastActivity": "2024-01-15T10:05:00Z",
      "status": "connected",
      "isConnected": true,
      "commandCount": 3,
      "metadata": {}
    }
  ],
  "statistics": {
    "totalSessions": 1,
    "activeSessions": 1,
    "connectedSessions": 1,
    "expiredSessions": 0,
    "totalConnections": 1,
    "uptime": 300.5
  },
  "count": 1
}
```

### PATCH /api/sessions/:sessionId/status

Updates the status of a session.

**Request Body:**
```json
{
  "status": "active"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Session status updated",
  "status": "active"
}
```

### DELETE /api/sessions/:sessionId

Deletes a session and closes any associated connections.

**Response:**
```json
{
  "success": true,
  "message": "Session deleted successfully"
}
```

## Command Execution

### POST /api/sessions/:sessionId/commands

Executes a command in the browser for the specified session.

**Request Body:**
```json
{
  "type": "navigate",
  "payload": {
    "url": "https://example.com"
  },
  "timeout": 30000
}
```

**Response:**
```json
{
  "success": true,
  "command": {
    "id": "cmd_123",
    "type": "navigate",
    "status": "completed",
    "result": {
      "url": "https://example.com",
      "title": "Example Domain",
      "timestamp": "2024-01-15T10:00:00Z"
    },
    "completedAt": "2024-01-15T10:00:02Z"
  }
}
```

### GET /api/sessions/:sessionId/commands

Lists commands for a session.

**Query Parameters:**
- `status`: Filter by command status (pending, completed, failed, cancelled)
- `limit`: Limit number of results

**Response:**
```json
{
  "success": true,
  "commands": [
    {
      "id": "cmd_123",
      "type": "navigate",
      "payload": { "url": "https://example.com" },
      "createdAt": "2024-01-15T10:00:00Z",
      "addedAt": "2024-01-15T10:00:00Z",
      "status": {
        "id": "cmd_123",
        "status": "completed",
        "completedAt": "2024-01-15T10:00:02Z",
        "result": {}
      }
    }
  ],
  "count": 1
}
```

### GET /api/sessions/:sessionId/commands/:commandId

Gets the status and result of a specific command.

**Response:**
```json
{
  "success": true,
  "command": {
    "id": "cmd_123",
    "status": "completed",
    "completedAt": "2024-01-15T10:00:02Z",
    "result": {
      "url": "https://example.com",
      "title": "Example Domain"
    }
  }
}
```

### DELETE /api/sessions/:sessionId/commands/:commandId

Cancels a pending command.

**Response:**
```json
{
  "success": true,
  "message": "Command cancelled successfully"
}
```

## Natural Language Tasks

The service now supports natural language task execution powered by Google's Gemini AI. Users can describe tasks in plain English, and the AI will analyze the current page, determine necessary actions, execute them, and provide feedback.

### POST /api/sessions/:sessionId/nl-tasks

Executes a natural language task with AI analysis and feedback.

**Request Body:**
```json
{
  "task": "Go to tagesschau.de"
}
```

**Response (Observation Task):**
```json
{
  "success": true,
  "task": {
    "taskId": "task_123",
    "sessionId": "session_456",
    "taskDescription": "Go to tagesschau.de",
    "screenshot": {
      "screenshotId": "screenshot_789",
      "url": "/screenshots/screenshot_123.png",
      "base64": "iVBORw0KGgoAAAANSUhEUgAAA...",
      "timestamp": "2024-01-15T10:00:00Z"
    },
    "description": "I can see the Tagesschau website homepage with the main navigation, latest news articles, and the ARD logo at the top. The page displays current news headlines with preview images.",
    "requiresAction": false,
    "success": true,
    "timestamp": "2024-01-15T10:00:00Z"
  }
}
```

**Response (Action Task):**
```json
{
  "success": true,
  "task": {
    "taskId": "task_123",
    "sessionId": "session_456", 
    "taskDescription": "Open first news item",
    "beforeScreenshot": {
      "screenshotId": "screenshot_before",
      "url": "/screenshots/screenshot_before.png",
      "base64": "iVBORw0KGgoAAAANSUhEUgAAA...",
      "timestamp": "2024-01-15T10:00:00Z"
    },
    "afterScreenshot": {
      "screenshotId": "screenshot_after", 
      "url": "/screenshots/screenshot_after.png",
      "base64": "iVBORw0KGgoAAAANSUhEUgAAA...",
      "timestamp": "2024-01-15T10:00:05Z"
    },
    "initialAnalysis": "I can see the Tagesschau homepage with several news articles displayed. The first news item appears to be about current political developments.",
    "finalDescription": "Successfully navigated to the first news article. The page now shows the full article with headline, author, publication date, and the complete article text. The article discusses recent political developments with related images and additional context.",
    "actionsExecuted": [
      {
        "type": "click", 
        "description": "Click on the first news article",
        "payload": {
          "selector": ".teaser:first-child a"
        }
      }
    ],
    "executionResult": [
      {
        "action": {
          "type": "click",
          "payload": {
            "selector": ".teaser:first-child a"
          }
        },
        "result": {
          "success": true,
          "elementFound": true,
          "clicked": true
        },
        "success": true
      }
    ],
    "success": true,
    "timestamp": "2024-01-15T10:00:00Z"
  }
}
```

### GET /api/sessions/:sessionId/nl-tasks

Lists natural language tasks executed for a session.

**Response:**
```json
{
  "success": true,
  "tasks": [
    {
      "id": "task_123",
      "taskDescription": "Go to tagesschau.de",
      "type": "nl-task",
      "createdAt": "2024-01-15T10:00:00Z",
      "status": "completed"
    }
  ],
  "count": 1
}
```

### GET /screenshots/:filename

Downloads a screenshot file.

**Response:** Binary PNG image data

**Example URL:** `http://localhost:3010/screenshots/screenshot_123.png`

## Command Types

The service supports both **extension commands** (original) and **server-side commands** (new). All commands work in both execution modes.

### Navigate
Navigates the browser to a specified URL.

```json
{
  "type": "navigate",
  "payload": {
    "url": "https://example.com"
  }
}
```

**Result:**
```json
{
  "url": "https://example.com",
  "title": "Page Title",
  "timestamp": "2024-01-15T10:00:00Z"
}
```

### Screenshot
Captures a screenshot of the current page.

```json
{
  "type": "screenshot",
  "payload": {
    "fullPage": false  // optional: capture full page
  }
}
```

**Result:**
```json
{
  "screenshot": "data:image/png;base64,iVBORw0KGgoAAAANS...",
  "dimensions": {
    "width": 1280,
    "height": 720
  },
  "timestamp": "2024-01-15T10:00:00Z"
}
```

### Get Page Title
Gets the current page title.

```json
{
  "type": "getTitle"
}
```

**Result:**
```json
{
  "title": "Example Domain"
}
```

### Get Current URL
Gets the current page URL.

```json
{
  "type": "getUrl"
}
```

**Result:**
```json
{
  "url": "https://example.com"
}
```

### Click Element
Clicks on an element specified by CSS selector.

```json
{
  "type": "click",
  "payload": {
    "selector": "button#submit"
  }
}
```

**Result:**
```json
{
  "clicked": "button#submit"
}
```

### Type Text
Types text into an input element.

```json
{
  "type": "type",
  "payload": {
    "selector": "input[name='username']",
    "text": "john_doe"
  }
}
```

**Result:**
```json
{
  "typed": "john_doe",
  "target": "input[name='username']"
}
```

### Get Element Text
Extracts text content from an element.

```json
{
  "type": "getText",
  "payload": {
    "selector": "h1"
  }
}
```

**Result:**
```json
{
  "text": "Main Heading",
  "selector": "h1"
}
```

### Get Element Attribute
Gets an attribute value from an element.

```json
{
  "type": "getAttribute",
  "payload": {
    "selector": "a#link",
    "attribute": "href"
  }
}
```

**Result:**
```json
{
  "attribute": "href",
  "value": "https://example.com/page",
  "selector": "a#link"
}
```

### Wait for Element
Waits for an element to appear on the page.

```json
{
  "type": "waitForElement",
  "payload": {
    "selector": "#dynamic-content",
    "timeout": 10000  // optional: timeout in milliseconds
  }
}
```

**Result:**
```json
{
  "found": "#dynamic-content"
}
```

### Evaluate JavaScript
Executes JavaScript code on the page and returns the result.

```json
{
  "type": "evaluate",
  "payload": {
    "script": "document.querySelectorAll('p').length"
  }
}
```

**Result:**
```json
{
  "result": 5
}
```

### Scroll Page
Scrolls the page to specified coordinates.

```json
{
  "type": "scroll",
  "payload": {
    "x": 0,     // optional: horizontal position
    "y": 500    // optional: vertical position
  }
}
```

**Result:**
```json
{
  "scrolled": {
    "x": 0,
    "y": 500
  }
}
```

### Legacy Commands (Extension Mode Only)

These commands are supported for backward compatibility but only work in extension mode:

#### Extract (Legacy)
Extracts data from page elements using CSS selectors.

```json
{
  "type": "extract",
  "payload": {
    "selector": "h1",
    "attribute": "text",  // optional
    "multiple": false     // optional
  }
}
```

#### Execute (Legacy)  
Use `evaluate` command instead for new implementations.

```json
{
  "type": "execute",
  "payload": {
    "script": "return document.title;"
  }
}
```

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

Common HTTP status codes:
- `400`: Bad Request - Invalid input data
- `404`: Not Found - Session or command not found
- `500`: Internal Server Error - Server-side error

## Rate Limiting

The API implements rate limiting to prevent abuse:
- Default: 100 requests per minute per IP
- Configurable via `API_RATE_LIMIT` environment variable

## Configuration

Environment variables for configuration:

```env
PORT=3010
SESSION_TIMEOUT=1800000      # 30 minutes
COMMAND_TIMEOUT=30000        # 30 seconds
MAX_SESSIONS=100
WS_HEARTBEAT_INTERVAL=30000  # 30 seconds
ALLOWED_ORIGINS=http://localhost:3000,chrome-extension://
```
