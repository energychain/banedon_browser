const SessionManager = require('../src/services/SessionManager');

describe('SessionManager', () => {
  let sessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
  });

  afterEach(async () => {
    await sessionManager.cleanup();
  });

  describe('Session Creation', () => {
    test('should create a new session with default metadata', () => {
      const session = sessionManager.createSession();
      
      expect(session).toHaveProperty('id');
      expect(session).toHaveProperty('createdAt');
      expect(session).toHaveProperty('lastActivity');
      expect(session).toHaveProperty('status', 'created');
      expect(session).toHaveProperty('metadata');
      expect(session).toHaveProperty('commands', []);
      expect(session).toHaveProperty('isConnected', false);
    });

    test('should create a session with custom metadata', () => {
      const metadata = {
        browser: 'chrome',
        version: '91.0',
        userAgent: 'test-agent'
      };
      
      const session = sessionManager.createSession(metadata);
      
      expect(session.metadata).toMatchObject(metadata);
    });

    test('should generate unique session IDs', () => {
      const session1 = sessionManager.createSession();
      const session2 = sessionManager.createSession();
      
      expect(session1.id).not.toBe(session2.id);
    });
  });

  describe('Session Retrieval', () => {
    test('should retrieve existing session', () => {
      const session = sessionManager.createSession();
      const retrieved = sessionManager.getSession(session.id);
      
      expect(retrieved).toBeTruthy();
      expect(retrieved.id).toBe(session.id);
    });

    test('should return null for non-existent session', () => {
      const retrieved = sessionManager.getSession('non-existent');
      
      expect(retrieved).toBeNull();
    });

    test('should update last activity when retrieving session', () => {
      const session = sessionManager.createSession();
      const originalActivity = session.lastActivity;
      
      // Wait a bit and retrieve
      setTimeout(() => {
        const retrieved = sessionManager.getSession(session.id);
        expect(new Date(retrieved.lastActivity)).toBeAfter(new Date(originalActivity));
      }, 10);
    });
  });

  describe('Session Listing', () => {
    test('should list active sessions', () => {
      const session1 = sessionManager.createSession();
      const session2 = sessionManager.createSession();
      
      const sessions = sessionManager.listActiveSessions();
      
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.id)).toContain(session1.id);
      expect(sessions.map(s => s.id)).toContain(session2.id);
    });

    test('should return empty list when no sessions', () => {
      const sessions = sessionManager.listActiveSessions();
      
      expect(sessions).toHaveLength(0);
    });
  });

  describe('Session Deletion', () => {
    test('should delete existing session', () => {
      const session = sessionManager.createSession();
      const deleted = sessionManager.deleteSession(session.id);
      
      expect(deleted).toBe(true);
      expect(sessionManager.getSession(session.id)).toBeNull();
    });

    test('should return false for non-existent session', () => {
      const deleted = sessionManager.deleteSession('non-existent');
      
      expect(deleted).toBe(false);
    });
  });

  describe('Session Status Updates', () => {
    test('should update session status', () => {
      const session = sessionManager.createSession();
      sessionManager.updateSessionStatus(session.id, 'connected');
      
      const updated = sessionManager.getSession(session.id);
      expect(updated.status).toBe('connected');
    });

    test('should ignore status update for non-existent session', () => {
      // Should not throw error
      expect(() => {
        sessionManager.updateSessionStatus('non-existent', 'connected');
      }).not.toThrow();
    });
  });

  describe('Command Management', () => {
    test('should add command to session', () => {
      const session = sessionManager.createSession();
      const command = {
        id: 'cmd-1',
        type: 'navigate',
        payload: { url: 'https://example.com' }
      };
      
      sessionManager.addCommand(session.id, command);
      
      const updated = sessionManager.getSession(session.id);
      expect(updated.commands).toHaveLength(1);
      expect(updated.commands[0]).toMatchObject(command);
      expect(updated.commands[0]).toHaveProperty('addedAt');
    });
  });

  describe('Statistics', () => {
    test('should return correct statistics', () => {
      sessionManager.createSession();
      sessionManager.createSession();
      
      const stats = sessionManager.getStatistics();
      
      expect(stats).toHaveProperty('totalSessions', 2);
      expect(stats).toHaveProperty('activeSessions', 2);
      expect(stats).toHaveProperty('connectedSessions', 0);
      expect(stats).toHaveProperty('expiredSessions', 0);
      expect(stats).toHaveProperty('totalConnections', 0);
      expect(stats).toHaveProperty('uptime');
    });

    test('should return correct active session count', () => {
      sessionManager.createSession();
      sessionManager.createSession();
      
      expect(sessionManager.getActiveSessionCount()).toBe(2);
    });
  });

  describe('Connection Management', () => {
    test('should register WebSocket connection', () => {
      const session = sessionManager.createSession();
      const mockWebSocket = { readyState: 1, close: jest.fn() };
      
      sessionManager.registerConnection(session.id, mockWebSocket);
      
      const updated = sessionManager.getSession(session.id);
      expect(updated.isConnected).toBe(true);
      expect(updated.connectionInfo).toBeTruthy();
    });

    test('should throw error for non-existent session', () => {
      const mockWebSocket = { readyState: 1, close: jest.fn() };
      
      expect(() => {
        sessionManager.registerConnection('non-existent', mockWebSocket);
      }).toThrow('Session not found: non-existent');
    });

    test('should handle disconnection', () => {
      const session = sessionManager.createSession();
      const mockWebSocket = { readyState: 1, close: jest.fn() };
      
      sessionManager.registerConnection(session.id, mockWebSocket);
      sessionManager.handleDisconnection(mockWebSocket);
      
      const updated = sessionManager.getSession(session.id);
      expect(updated.isConnected).toBe(false);
      expect(updated.connectionInfo).toBeNull();
    });
  });
});
