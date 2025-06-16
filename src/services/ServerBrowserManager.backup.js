const puppeteer = require('puppeteer');
const logger = require('../utils/logger');

class ServerBrowserManager {
  constructor() {
    this.browsers = new Map(); // sessionId -> browser instance
    this.pages = new Map(); // sessionId -> page instance
  }

  /**
   * Launch a new browser instance for a session
   * @param {string} sessionId - Session ID
   * @returns {Promise<Object>} Browser and page objects
   */
  async launchBrowser(sessionId) {
    try {
      // Close existing browser if any
      await this.closeBrowser(sessionId);

      logger.info(`Launching browser for session: ${sessionId}`);

      // Docker-optimized Puppeteer configuration
      const launchOptions = {
        headless: true,
        args: [
          // Essential for Docker
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          
          // Performance and stability
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI',
          '--disable-features=VizDisplayCompositor',
          
          // Memory optimization
          '--memory-pressure-off',
          '--max_old_space_size=4096',
          
          // Security (relaxed for automation)
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--allow-running-insecure-content',
          '--disable-features=VizDisplayCompositor',
          
          // UI elements
          '--hide-scrollbars',
          '--mute-audio',
          '--disable-extensions',
          '--disable-plugins',
          '--disable-default-apps',
          
          // Network
          '--aggressive-cache-discard',
          '--disable-background-networking',
          
          // Window size
          '--window-size=1920,1080',
          
          // Language
          '--lang=en-US',
          
          // User data directory (temporary)
          `--user-data-dir=/tmp/puppeteer-${sessionId}`,
          
          // Crash handling - provide what crashpad needs
          '--crash-dumps-dir=/tmp/crash-dumps',
          '--breakpad-dump-location=/tmp/crash-dumps',
          '--enable-crashpad',
          
          // Additional stability fixes
          '--disable-ipc-flooding-protection',
          '--disable-extensions-file-access-check',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-features=MediaRouter',
          '--disable-hang-monitor',
          '--disable-popup-blocking',
          '--disable-prompt-on-repost',
          '--disable-sync',
          '--no-first-run',
          '--no-default-browser-check',
          '--no-zygote',
          '--single-process',
          '--disable-logging',
          '--disable-permissions-api'
        ],
        
        // Environment variables (remove DISPLAY requirement)
        env: {
          ...process.env,
          NO_SANDBOX: '1',
          PUPPETEER_DISABLE_HEADLESS_WARNING: 'true',
          CRASHPAD_DATABASE_PATH: '/tmp/crashpad_database'
        },
        
        // Timeouts
        timeout: 30000,
        
        // Don't wait for initial load
        waitForInitialPage: false
      };

      // Try to find Chromium/Chrome executable
      const chromiumPaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser', 
        '/snap/bin/chromium',
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_BIN
      ].filter(Boolean);

      // Check if any executable exists
      const fs = require('fs');
      
      // Create necessary directories for crash handling and user data
      const userDataDir = `/tmp/puppeteer-${sessionId}`;
      const crashDir = '/tmp/crash-dumps';
      const crashpadDb = '/tmp/crashpad_database';
      
      try {
        // Create all required directories
        [userDataDir, crashDir, crashpadDb].forEach(dir => {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.chmodSync(dir, 0o755);
        });
      } catch (dirError) {
        logger.warn(`Failed to create directories: ${dirError.message}`);
      }
      
      let executablePath = null;
      
      for (const path of chromiumPaths) {
        try {
          if (fs.existsSync(path)) {
            executablePath = path;
            logger.debug(`Found Chromium at: ${path}`);
            break;
          }
        } catch (e) {
          // Continue to next path
        }
      }

      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }

      logger.debug(`Launching browser with options:`, {
        executablePath: executablePath || 'default',
        argsCount: launchOptions.args.length,
        sessionId
      });

      let browser;
      try {
        // Add a timeout wrapper around the browser launch
        const launchPromise = puppeteer.launch(launchOptions);
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Browser launch timeout after 20 seconds'));
          }, 20000);
        });
        
        browser = await Promise.race([launchPromise, timeoutPromise]);
        
        logger.info(`Browser launched successfully for session: ${sessionId}`);
      } catch (launchError) {
        logger.error(`Puppeteer launch failed:`, {
          error: launchError.message,
          stack: launchError.stack,
          executablePath: executablePath || 'default',
          sessionId
        });
        throw new Error(`Browser launch failed: ${launchError.message}`);
      }
      
      // Create new page with enhanced configuration
      const page = await browser.newPage();
      
      // Set enhanced viewport
      await page.setViewport({ 
        width: 1920, 
        height: 1080,
        deviceScaleFactor: 1
      });
      
      // Set realistic user agent
      await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Set extra HTTP headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9'
      });
      
      // Enable request interception for debugging if needed
      // await page.setRequestInterception(true);
      
      // Set default navigation timeout
      page.setDefaultNavigationTimeout(30000);
      page.setDefaultTimeout(30000);

      // Store references
      this.browsers.set(sessionId, browser);
      this.pages.set(sessionId, page);

      logger.info(`Browser successfully launched for session: ${sessionId}`);
      
      return { browser, page };
    } catch (error) {
      logger.error(`Failed to launch browser for session ${sessionId}:`, {
        message: error.message,
        stack: error.stack,
        sessionId
      });
      
      // Clean up any partial state
      this.browsers.delete(sessionId);
      this.pages.delete(sessionId);
      
      throw error;
    }
  }

  /**
   * Get browser page for a session
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Page instance or null
   */
  getPage(sessionId) {
    return this.pages.get(sessionId) || null;
  }

  /**
   * Get browser instance for a session
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Browser instance or null
   */
  getBrowser(sessionId) {
    return this.browsers.get(sessionId) || null;
  }

  /**
   * Close browser for a session
   * @param {string} sessionId - Session ID
   */
  async closeBrowser(sessionId) {
    try {
      const browser = this.browsers.get(sessionId);
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
   * Execute a command using server-side browser
   * @param {string} sessionId - Session ID
   * @param {Object} command - Command to execute
   * @returns {Promise<Object>} Command result
   */
  async executeCommand(sessionId, command) {
    try {
      let page = this.getPage(sessionId);
      
      // Launch browser if not exists
      if (!page) {
        const { page: newPage } = await this.launchBrowser(sessionId);
        page = newPage;
      }

      const result = await this._executeCommandOnPage(page, command);
      
      return {
        success: true,
        result: result,
        timestamp: new Date().toISOString(),
        executedBy: 'server'
      };
    } catch (error) {
      logger.error(`Server browser command failed for session ${sessionId}:`, error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        executedBy: 'server'
      };
    }
  }

  /**
   * Execute command on a specific page
   * @private
   */
  async _executeCommandOnPage(page, command) {
    const { type, payload = {} } = command;

    switch (type) {
      case 'navigate':
        await page.goto(payload.url, { waitUntil: 'networkidle2' });
        return { url: page.url(), title: await page.title() };

      case 'click':
        await page.click(payload.selector);
        return { clicked: payload.selector };

      case 'type':
        await page.type(payload.selector, payload.text);
        return { typed: payload.text, target: payload.selector };

      case 'screenshot':
        const screenshot = await page.screenshot({ 
          encoding: 'base64',
          fullPage: payload.fullPage || false 
        });
        return { 
          screenshot: `data:image/png;base64,${screenshot}`,
          dimensions: page.viewport()
        };

      case 'evaluate':
        const result = await page.evaluate(new Function('return ' + payload.script)());
        return { result };

      case 'getTitle':
        return { title: await page.title() };

      case 'getUrl':
        return { url: page.url() };

      case 'getText':
        const element = await page.$(payload.selector);
        if (!element) throw new Error(`Element not found: ${payload.selector}`);
        const text = await page.evaluate(el => el.textContent, element);
        return { text, selector: payload.selector };

      case 'getAttribute':
        const el = await page.$(payload.selector);
        if (!el) throw new Error(`Element not found: ${payload.selector}`);
        const attr = await page.evaluate(
          (element, attrName) => element.getAttribute(attrName),
          el, 
          payload.attribute
        );
        return { attribute: payload.attribute, value: attr, selector: payload.selector };

      case 'waitForElement':
        await page.waitForSelector(payload.selector, { 
          timeout: payload.timeout || 30000 
        });
        return { found: payload.selector };

      case 'scroll':
        await page.evaluate((x, y) => {
          window.scrollTo(x || 0, y || 0);
        }, payload.x, payload.y);
        return { scrolled: { x: payload.x || 0, y: payload.y || 0 } };

      default:
        throw new Error(`Unknown command type: ${type}`);
    }
  }

  /**
   * Close all browsers
   */
  async closeAll() {
    const promises = Array.from(this.browsers.keys()).map(sessionId => 
      this.closeBrowser(sessionId)
    );
    await Promise.all(promises);
    logger.info('All server browsers closed');
  }
}

module.exports = ServerBrowserManager;
