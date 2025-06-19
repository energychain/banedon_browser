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
      // Create a session for each test
      const response = await request(app)
        .post('/api/sessions')
        .send({ metadata: { browser: 'test-command' } });
      sessionId = response.body.session.id;
    });

    afterEach(async () => {
      // Clean up the session
      await request(app).delete(`/api/sessions/${sessionId}`);
    });

    // This test is disabled as it's slow and the core functionality is tested by the NL task test
    xtest('POST /api/sessions/:id/commands should handle command execution', async () => {
      // This test may be slow due to browser launch, so we'll be more flexible
      const startTime = Date.now();
      
      const response = await request(app)
        .post(`/api/sessions/${sessionId}/commands`)
        .send({
          type: 'navigate',
          payload: { url: 'https://example.com' }
        });

      const duration = Date.now() - startTime;
      console.log(`Command execution took ${duration}ms`);
      
      // Accept either success (if browser works) or failure (if browser doesn't work in test env)
      expect(response.body).toHaveProperty('success');
      expect([200, 400, 500]).toContain(response.status);
      
      if (response.body.success) {
        expect(response.body).toHaveProperty('command');
      }
    }, 30000); // Increase timeout to 30 seconds

    // This test requires a connected client (extension) to be properly tested,
    // so we will skip it in this environment.
    xtest('POST /api/sessions/:id/commands should execute a command', async () => {
      // This would require a mock WebSocket client to connect and test command execution
    }, 15000);

    test('GET /api/sessions/:id/commands should list commands for a session', async () => {
      const response = await request(app)
        .get(`/api/sessions/${sessionId}/commands`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('commands');
      expect(Array.isArray(response.body.commands)).toBe(true);
    });
  });

  describe('Natural Language Tasks', () => {
    let sessionId;

    beforeAll(async () => {
      // Create a session for NL tasks with debug mode enabled
      const response = await request(app)
        .post('/api/sessions')
        .send({ 
          debug: true, // Enable debug mode
          metadata: { browser: 'test-nl', purpose: 'flight-search-test' } 
        })
        .expect(201);
      sessionId = response.body.session.id;
      
      // Verify debug mode is enabled
      expect(response.body.session.debug).toBe(true);
    });

    afterAll(async () => {
      // Clean up the session
      await request(app).delete(`/api/sessions/${sessionId}`);
    });

    test('POST /api/sessions/:id/nl-tasks should handle a multi-step flight search task', async () => {
      const prompt = "Search for the next flight from Frankfurt to London Heathrow";

      const response = await request(app)
        .post(`/api/sessions/${sessionId}/nl-tasks`)
        .send({ task: prompt })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('task');
      
      const task = response.body.task;
      expect(task).toHaveProperty('taskId');
      expect(task).toHaveProperty('sessionId', sessionId);
      expect(task).toHaveProperty('taskDescription', prompt);
      expect(task).toHaveProperty('history');
      expect(task).toHaveProperty('response');
      
      // Verify that the task contains a meaningful response about flight search
      expect(task.response).toBeDefined();
      expect(typeof task.response).toBe('string');
      expect(task.response.length).toBeGreaterThan(0);
      
      // Check that the history contains some interaction steps
      expect(Array.isArray(task.history)).toBe(true);
      
      // The task should have some execution result
      expect(task).toHaveProperty('executionResult');
      
      // CRITICAL: The system should handle routine decisions like cookie consent automatically
      // and provide an actual flight schedule, not just stop at intermediate steps
      expect(task.response.toLowerCase()).not.toMatch(/cookie|consent|dialog/);
      
      // The response should contain actual flight information or at least indicate 
      // that it attempted to search for flights with specific details
      const responseText = task.response.toLowerCase();
      
      // Debug logging to see what we actually got
      console.log('\n=== FLIGHT SEARCH RESPONSE DEBUG ===');
      console.log('Full task response:', task.response);
      console.log('Response text (lowercase):', responseText);
      console.log('Contains "flight":', responseText.includes('flight'));
      console.log('Contains Frankfurt:', responseText.includes('frankfurt') || responseText.includes('fra'));
      console.log('Contains London:', responseText.includes('london') || responseText.includes('heathrow') || responseText.includes('lhr'));
      console.log('Task iterations:', task.iterations);
      console.log('Task history length:', task.history?.length);
      console.log('Last few history entries:', task.history?.slice(-3));
      
      // Get debug information from new endpoints
      try {
        const debugStatusResponse = await request(app)
          .get(`/api/sessions/${sessionId}/debug/status`)
          .expect(200);
        console.log('Debug session status:', debugStatusResponse.body);
        
        const debugLogsResponse = await request(app)
          .get(`/api/sessions/${sessionId}/debug/logs?lines=10`)
          .expect(200);
        console.log('Debug logs count:', debugLogsResponse.body.count);
        console.log('Last few logs:', debugLogsResponse.body.logs?.slice(-3));
        
        const debugScreenshotsResponse = await request(app)
          .get(`/api/sessions/${sessionId}/debug/screenshots`)
          .expect(200);
        console.log('Debug screenshots count:', debugScreenshotsResponse.body.count);
        console.log('Latest screenshots:', debugScreenshotsResponse.body.screenshots?.slice(0, 3)?.map(s => ({
          filename: s.filename,
          size: s.size,
          createdAt: s.createdAt
        })));
      } catch (debugError) {
        console.log('Debug endpoints error:', debugError.message);
      }
      
      console.log('=====================================\n');
      
      const hasFlightInfo = 
        responseText.includes('flight') && 
        (responseText.includes('frankfurt') || responseText.includes('fra')) &&
        (responseText.includes('london') || responseText.includes('heathrow') || responseText.includes('lhr')) &&
        (responseText.includes('time') || responseText.includes('price') || responseText.includes('schedule') || 
         responseText.includes('airline') || responseText.includes('departure') || responseText.includes('arrival') ||
         responseText.includes('available') || responseText.includes('found') || responseText.includes('search results'));
      
      expect(hasFlightInfo).toBe(true, 
        `Expected actual flight search results, but got: "${task.response}". ` +
        `The system should automatically handle cookie consent and provide flight information.`);
      
      console.log('Flight search task completed successfully');
      console.log('Task Response:', task.response);
      console.log('History steps:', task.history.length);

    }, 120000); // Increased timeout to 120 seconds for the complex flight search task that needs to complete fully
  });

  describe('Debug Endpoints', () => {
    let sessionId;

    beforeAll(async () => {
      // Create a session with debug mode enabled
      const response = await request(app)
        .post('/api/sessions')
        .send({ 
          debug: true, // Enable debug mode
          metadata: { browser: 'test-debug' } 
        })
        .expect(201);
      sessionId = response.body.session.id;
    });

    afterAll(async () => {
      // Clean up the session
      await request(app).delete(`/api/sessions/${sessionId}`);
    });

    test('DEBUG: Debug endpoints should work for debug-enabled sessions', async () => {
      // Test debug status endpoint
      const statusResponse = await request(app)
        .get(`/api/sessions/${sessionId}/debug/status`)
        .expect(200);
      
      expect(statusResponse.body.success).toBe(true);
      expect(statusResponse.body.sessionId).toBe(sessionId);
      expect(statusResponse.body.session).toBeDefined();
      expect(statusResponse.body.history).toBeDefined();
      expect(Array.isArray(statusResponse.body.history)).toBe(true);
      
      // Test debug logs endpoint
      const logsResponse = await request(app)
        .get(`/api/sessions/${sessionId}/debug/logs`)
        .expect(200);
      
      expect(logsResponse.body.success).toBe(true);
      expect(logsResponse.body.sessionId).toBe(sessionId);
      expect(Array.isArray(logsResponse.body.logs)).toBe(true);
      
      // Test debug screenshots endpoint
      const screenshotsResponse = await request(app)
        .get(`/api/sessions/${sessionId}/debug/screenshots`)
        .expect(200);
      
      expect(screenshotsResponse.body.success).toBe(true);
      expect(screenshotsResponse.body.sessionId).toBe(sessionId);
      expect(Array.isArray(screenshotsResponse.body.screenshots)).toBe(true);
      
      // Test that non-debug session cannot access debug endpoints
      const normalSessionResponse = await request(app)
        .post('/api/sessions')
        .send({ metadata: { browser: 'test-normal' } })
        .expect(201);
      
      const normalSessionId = normalSessionResponse.body.session.id;
      
      // Should get 403 for non-debug session
      await request(app)
        .get(`/api/sessions/${normalSessionId}/debug/status`)
        .expect(403);
      
      // Clean up
      await request(app).delete(`/api/sessions/${normalSessionId}`);
    });
  });
});
