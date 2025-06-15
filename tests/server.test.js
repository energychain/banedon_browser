const request = require('supertest');
const BrowserAutomationService = require('../src/server');

describe('Browser Automation Service', () => {
  let app;
  let server;

  beforeAll(async () => {
    const service = new BrowserAutomationService();
    app = service.app;
    server = service.server;
  });

  afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  describe('Health Check', () => {
    test('GET /health should return service status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('activeSessions');
      expect(response.body).toHaveProperty('wsConnections');
    });
  });

  describe('Session Management', () => {
    let sessionId;

    test('POST /api/sessions should create a new session', async () => {
      const response = await request(app)
        .post('/api/sessions')
        .send({
          metadata: {
            browser: 'test',
            version: '1.0'
          }
        })
        .expect(201);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('session');
      expect(response.body.session).toHaveProperty('id');
      expect(response.body.session).toHaveProperty('status', 'created');
      
      sessionId = response.body.session.id;
    });

    test('GET /api/sessions/:id should return session details', async () => {
      const response = await request(app)
        .get(`/api/sessions/${sessionId}`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('session');
      expect(response.body.session).toHaveProperty('id', sessionId);
      expect(response.body.session).toHaveProperty('status');
      expect(response.body.session).toHaveProperty('isConnected', false);
    });

    test('GET /api/sessions should list all sessions', async () => {
      const response = await request(app)
        .get('/api/sessions')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('sessions');
      expect(response.body).toHaveProperty('count');
      expect(Array.isArray(response.body.sessions)).toBe(true);
      expect(response.body.sessions.length).toBeGreaterThan(0);
    });

    test('PATCH /api/sessions/:id/status should update session status', async () => {
      const response = await request(app)
        .patch(`/api/sessions/${sessionId}/status`)
        .send({ status: 'active' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('status', 'active');
    });

    test('DELETE /api/sessions/:id should delete session', async () => {
      const response = await request(app)
        .delete(`/api/sessions/${sessionId}`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message');
    });

    test('GET /api/sessions/:id should return 404 for deleted session', async () => {
      await request(app)
        .get(`/api/sessions/${sessionId}`)
        .expect(404);
    });
  });

  describe('Command Execution', () => {
    let sessionId;

    beforeEach(async () => {
      const response = await request(app)
        .post('/api/sessions')
        .send({});
      sessionId = response.body.session.id;
    });

    test('POST /api/sessions/:id/commands should fail for disconnected session', async () => {
      const response = await request(app)
        .post(`/api/sessions/${sessionId}/commands`)
        .send({
          type: 'navigate',
          payload: { url: 'https://example.com' }
        })
        .expect(500);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
    });

    test('GET /api/sessions/:id/commands should return empty command list', async () => {
      const response = await request(app)
        .get(`/api/sessions/${sessionId}/commands`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('commands');
      expect(Array.isArray(response.body.commands)).toBe(true);
      expect(response.body.commands.length).toBe(0);
    });

    test('GET /api/sessions/:id/commands/:cmdId should return 404 for non-existent command', async () => {
      await request(app)
        .get(`/api/sessions/${sessionId}/commands/non-existent`)
        .expect(404);
    });
  });

  describe('Error Handling', () => {
    test('GET /non-existent-endpoint should return 404', async () => {
      const response = await request(app)
        .get('/non-existent-endpoint')
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Endpoint not found');
    });

    test('POST /api/sessions/:id/commands with invalid session should return 500', async () => {
      await request(app)
        .post('/api/sessions/invalid-session/commands')
        .send({
          type: 'navigate',
          payload: { url: 'https://example.com' }
        })
        .expect(500);
    });
  });
});
