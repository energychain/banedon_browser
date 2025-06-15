# Browser Automation Service API Documentation

## Overview

The Browser Automation Service provides a REST API for managing browser automation sessions and executing commands through a connected browser extension.

**Base URL**: `http://localhost:3010`  
**WebSocket URL**: `ws://localhost:3010/ws`

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

## Command Types

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
  "payload": {}
}
```

**Result:**
```json
{
  "screenshot": "data:image/png;base64,iVBORw0KGgoAAAANS...",
  "timestamp": "2024-01-15T10:00:00Z",
  "tabInfo": {
    "id": 123,
    "url": "https://example.com",
    "title": "Page Title"
  }
}
```

### Extract
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

**Result:**
```json
{
  "data": {
    "text": "Main Heading",
    "html": "<h1>Main Heading</h1>",
    "tagName": "h1",
    "attributes": {}
  },
  "selector": "h1",
  "count": 1,
  "timestamp": "2024-01-15T10:00:00Z"
}
```

### Click
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
  "selector": "button#submit",
  "action": "click",
  "element": {
    "tagName": "button",
    "id": "submit",
    "className": "btn primary"
  },
  "timestamp": "2024-01-15T10:00:00Z"
}
```

### Type
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
  "selector": "input[name='username']",
  "action": "type",
  "element": {
    "tagName": "input",
    "id": "",
    "className": ""
  },
  "timestamp": "2024-01-15T10:00:00Z"
}
```

### Execute
Executes custom JavaScript code on the page.

```json
{
  "type": "execute",
  "payload": {
    "script": "return document.title;"
  }
}
```

**Result:**
```json
{
  "result": "Page Title",
  "timestamp": "2024-01-15T10:00:00Z"
}
```

### Scroll
Scrolls the page to specified coordinates.

```json
{
  "type": "scroll",
  "payload": {
    "x": 0,
    "y": 500,
    "selector": null  // optional: scroll specific element
  }
}
```

**Result:**
```json
{
  "scrollPosition": {
    "x": 0,
    "y": 500
  },
  "timestamp": "2024-01-15T10:00:00Z"
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
