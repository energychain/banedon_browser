const puppeteer = require('puppeteer');
const logger = require('../utils/logger');

class ServerBrowserManager {
  constructor() {
    this.browsers = new Map(); // sessionId -> browser instance
    this.pages = new Map(); // sessionId -> page instance
  }

  /**
   * Launch a browser for a session with minimal configuration
   */
  async launchBrowser(sessionId) {
    try {
      logger.info(`Launching browser for session: ${sessionId}`);
      
      // Ultra-minimal configuration to avoid hanging
      const launchOptions = {
        headless: 'new',
        args: [
          '--headless=new',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-crash-reporter',
          '--disable-extensions',
          '--disable-plugins',
          '--disable-default-apps',
          '--disable-translate',
          '--disable-sync',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--window-size=1920,1080',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--mute-audio',
          // Fix for crashpad database requirement
          `--crash-dumps-dir=/tmp/crashes-${sessionId}`,
          '--enable-crash-reporter'
        ],
        timeout: 10000, // 10 second timeout
        env: {
          ...process.env,
          NO_SANDBOX: '1'
        }
      };

      // Try to find a working browser executable
      const fs = require('fs');
      const executablePaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome', 
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
      ];

      let executablePath = null;
      for (const path of executablePaths) {
        if (fs.existsSync(path)) {
          executablePath = path;
          logger.info(`Using browser: ${path}`);
          break;
        }
      }

      if (executablePath) {
        launchOptions.executablePath = executablePath;
      } else {
        logger.info('Using Puppeteer bundled browser');
      }

      // Create crashes directory
      const fs = require('fs');
      const crashesDir = `/tmp/crashes-${sessionId}`;
      try {
        fs.mkdirSync(crashesDir, { recursive: true });
      } catch (e) {
        // Directory might already exist, ignore
      }

      // Launch with aggressive timeout
      const browser = await Promise.race([
        puppeteer.launch(launchOptions),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Browser launch timeout')), 10000);
        })
      ]);

      logger.info(`Browser launched for session: ${sessionId}`);
      
      // Create page
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(30000);

      // Store references
      this.browsers.set(sessionId, browser);
      this.pages.set(sessionId, page);

      return { browser, page };
    } catch (error) {
      logger.error(`Browser launch failed for session ${sessionId}:`, error.message);
      
      // Cleanup
      this.browsers.delete(sessionId);
      this.pages.delete(sessionId);
      
      throw error;
    }
  }

  /**
   * Get browser page for a session
   */
  getPage(sessionId) {
    return this.pages.get(sessionId) || null;
  }

  /**
   * Get browser instance for a session
   */
  getBrowser(sessionId) {
    return this.browsers.get(sessionId) || null;
  }

  /**
   * Execute a command for a session
   */
  async executeCommand(sessionId, command) {
    try {
      logger.debug(`Executing command ${command.type} for session ${sessionId}`);
      
      // Get or create browser/page
      let page = this.getPage(sessionId);
      if (!page) {
        const { page: newPage } = await this.launchBrowser(sessionId);
        page = newPage;
      }

      // Execute command based on type
      switch (command.type) {
        case 'navigate':
          const url = command.payload.url;
          const fullUrl = url.startsWith('http') ? url : `https://${url}`;
          await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          return {
            success: true,
            result: {
              url: page.url(),
              title: await page.title(),
              timestamp: new Date().toISOString()
            }
          };

        case 'screenshot':
          const screenshot = await page.screenshot({ 
            encoding: 'base64',
            fullPage: false,
            type: 'png'
          });
          return {
            success: true,
            result: {
              screenshot: `data:image/png;base64,${screenshot}`,
              timestamp: new Date().toISOString()
            }
          };

        case 'click':
          const selector = command.payload.selector || command.payload.element;
          await page.waitForSelector(selector, { timeout: 10000 });
          await page.click(selector);
          return {
            success: true,
            result: {
              clicked: selector,
              timestamp: new Date().toISOString()
            }
          };

        case 'type':
          const typeSelector = command.payload.selector || command.payload.element;
          const text = command.payload.text || command.payload.value;
          await page.waitForSelector(typeSelector, { timeout: 10000 });
          await page.type(typeSelector, text);
          return {
            success: true,
            result: {
              typed: text,
              into: typeSelector,
              timestamp: new Date().toISOString()
            }
          };

        default:
          throw new Error(`Unknown command type: ${command.type}`);
      }
    } catch (error) {
      logger.error(`Server browser command failed for session ${sessionId}:`, error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Close browser for a session
   */
  async closeBrowser(sessionId) {
    try {
      const browser = this.getBrowser(sessionId);
      if (browser) {
        await browser.close();
        this.browsers.delete(sessionId);
        this.pages.delete(sessionId);
        logger.info(`Browser closed for session: ${sessionId}`);
      }
    } catch (error) {
      logger.error(`Error closing browser for session ${sessionId}:`, error);
    }
  }

  /**
   * Cleanup all browsers
   */
  async cleanup() {
    logger.info('Cleaning up all browsers...');
    const sessionIds = Array.from(this.browsers.keys());
    
    await Promise.all(
      sessionIds.map(sessionId => this.closeBrowser(sessionId))
    );
    
    this.browsers.clear();
    this.pages.clear();
    logger.info('Browser cleanup completed');
  }
}

module.exports = ServerBrowserManager;
