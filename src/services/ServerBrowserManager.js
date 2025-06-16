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

      const browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || '/usr/bin/google-chrome-stable',
        headless: 'new', // Use new headless mode
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--disable-extensions',
          '--disable-plugins',
          '--disable-sync',
          '--metrics-recording-only',
          '--no-crash-upload'
        ]
      });

      const page = await browser.newPage();
      
      // Set viewport
      await page.setViewport({ width: 1280, height: 720 });

      // Store references
      this.browsers.set(sessionId, browser);
      this.pages.set(sessionId, page);

      logger.info(`Browser launched for session: ${sessionId}`);
      
      return { browser, page };
    } catch (error) {
      logger.error(`Failed to launch browser for session ${sessionId}:`, error);
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
