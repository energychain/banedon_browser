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
      
      // Create writable tmp directories for Chrome (solution from puppeteer/puppeteer#11023)
      const fs = require('fs');
      const path = require('path');
      const tmpDir = path.join('/tmp', 'chrome-session', sessionId);
      const userDataDir = path.join(tmpDir, 'user-data');
      const crashDir = path.join(tmpDir, 'crash-dumps');
      
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(userDataDir, { recursive: true });
        fs.mkdirSync(crashDir, { recursive: true });
        fs.mkdirSync(path.join(userDataDir, 'crashpad-db'), { recursive: true });
        
        // Ensure directories are writable
        fs.chmodSync(tmpDir, 0o777);
        fs.chmodSync(userDataDir, 0o777);
        fs.chmodSync(crashDir, 0o777);
      } catch (e) {
        logger.warn(`Could not create chrome directories ${tmpDir}: ${e.message}`);
      }

      const crashpadDb = '/tmp/crashpad-db';
      try {
        fs.mkdirSync(crashpadDb, { recursive: true });
        fs.chmodSync(crashpadDb, 0o777);
      } catch (e) {
        logger.warn(`Could not create crashpad db dir ${crashpadDb}: ${e.message}`);
      }

      // Configuration with proper tmp directories for Docker
      const launchOptions = {
        headless: 'new',
        userDataDir: userDataDir,
        args: [
          '--headless=new',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          // \'--disable-plugins\', // Might be needed for some sites, let's test without it first
          '--disable-default-apps',
          '--disable-translate',
          '--disable-sync',
          '--no-first-run',
          '--no-zygote',
          // \'--single-process\', // Removed for stability
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--window-size=1920,1080',
          '--disable-web-security', // Consider if this is truly needed long-term
          //'--disable-features=VizDisplayCompositor', // This can cause issues with screenshots
          '--mute-audio',
          `--user-data-dir=${userDataDir}`,
          '--disable-crash-reporter', // Disable Chrome\'s own crash reporting
          '--disable-breakpad',
          '--no-crash-upload',
          // \'--disable-crashpad\', // Let Chrome manage its crashpad
          // Removed hardcoded crashpad handler and database paths
          // \'--crashpad-handler=/usr/lib/chromium/chrome_crashpad_handler\',
          // `--database=${crashpadDb}`
        ],
        timeout: 15000, // Increased timeout to 15 seconds
        env: {
          ...process.env,
          NO_SANDBOX: '1',
          CHROME_CRASH_REPORTER_DISABLE: '1',
          BREAKPAD_DISABLE: '1',
          CHROME_CRASHPAD_HANDLER_DISABLE: '1',
          TMPDIR: '/tmp'
        }
      };

      // Try to find a working browser executable
      const executablePaths = [
        '/opt/google/chrome/chrome', // Priority for Google Chrome stable
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

      // Launch with aggressive timeout
      const browser = await Promise.race([
        puppeteer.launch(launchOptions),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Browser launch timeout')), 15000); // Increased timeout
        })
      ]);

      logger.info(`Browser launched for session: ${sessionId}, path: ${browser.process() ? browser.process().spawnfile : 'N/A'}`);
      
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
          
          // Try to click the element with fallback strategies
          let clicked = false;
          let clickedSelector = '';
          
          try {
            // First try the exact selector
            await page.waitForSelector(selector, { timeout: 5000 });
            await page.click(selector);
            clicked = true;
            clickedSelector = selector;
          } catch (error) {
            // If exact selector fails, try fallback strategies for common cases
            logger.warn(`Primary selector failed: ${selector}, trying fallbacks`);
            
            // Common fallback selectors for cookie consent
            const fallbackSelectors = [
              'button[id*="accept"]',
              'button[class*="accept"]', 
              'button[data-testid*="accept"]',
              '[role="button"][aria-label*="accept"]',
              '.cookie-consent button',
              '#cookie-consent button',
              '[class*="cookie"] button',
              '[id*="cookie"] button',
              'button' // Last resort: any button
            ];
            
            for (const fallback of fallbackSelectors) {
              try {
                const elements = await page.$$(fallback);
                if (elements.length > 0) {
                  // Check if any button has consent-related text
                  for (const element of elements) {
                    const text = await page.evaluate(el => el.textContent, element);
                    if (text && (
                      text.toLowerCase().includes('accept') ||
                      text.toLowerCase().includes('agree') ||
                      text.toLowerCase().includes('allow') ||
                      text.toLowerCase().includes('ok') ||
                      text.toLowerCase().includes('continue')
                    )) {
                      await element.click();
                      clicked = true;
                      clickedSelector = `${fallback} (fallback: "${text.trim()}")`;
                      break;
                    }
                  }
                  if (clicked) break;
                }
              } catch (fallbackError) {
                // Continue to next fallback
                logger.debug(`Fallback selector failed: ${fallback}`);
              }
            }
            
            // If still not clicked, try evaluating xpath for text-based selection
            if (!clicked) {
              try {
                const result = await page.evaluate(() => {
                  // Look for buttons with accept-related text
                  const buttons = Array.from(document.querySelectorAll('button, [role="button"], div[onclick], a[onclick]'));
                  for (const button of buttons) {
                    const text = button.textContent.toLowerCase();
                    if (text.includes('accept') || text.includes('agree') || text.includes('allow') || text.includes('ok')) {
                      button.click();
                      return { success: true, text: button.textContent.trim() };
                    }
                  }
                  return { success: false };
                });
                
                if (result.success) {
                  clicked = true;
                  clickedSelector = `JavaScript fallback (clicked: "${result.text}")`;
                }
              } catch (jsError) {
                logger.debug('JavaScript fallback also failed');
              }
            }
          }
          
          if (!clicked) {
            throw new Error(`Could not find clickable element with selector: ${selector}`);
          }
          
          return {
            success: true,
            result: {
              clicked: clickedSelector,
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

        case 'get_text':
          const bodyText = await page.evaluate(() => document.body.innerText);
          return {
              success: true,
              result: {
                  text: bodyText,
                  timestamp: new Date().toISOString()
              }
          };

        case 'click_coordinate':
          const x = command.payload.x;
          const y = command.payload.y;
          await page.mouse.click(x, y);
          return {
            success: true,
            result: {
              clicked: `coordinates (${x}, ${y})`,
              timestamp: new Date().toISOString()
            }
          };

        case 'scroll':
          const deltaY = command.payload.deltaY || 300;
          const deltaX = command.payload.deltaX || 0;
          await page.mouse.wheel({ deltaX, deltaY });
          return {
            success: true,
            result: {
              scrolled: `deltaX: ${deltaX}, deltaY: ${deltaY}`,
              timestamp: new Date().toISOString()
            }
          };

        case 'key_press':
          const key = command.payload.key;
          
          // Handle key combinations like "Control+a", "Ctrl+a", etc.
          if (key.includes('+')) {
            const parts = key.split('+');
            const modifiers = parts.slice(0, -1).map(mod => {
              // Normalize modifier names
              switch (mod.toLowerCase()) {
                case 'ctrl':
                case 'control': return 'Control';
                case 'shift': return 'Shift';
                case 'alt': return 'Alt';
                case 'meta':
                case 'cmd': return 'Meta';
                default: return mod;
              }
            });
            const mainKey = parts[parts.length - 1];
            
            // Press modifiers down
            for (const modifier of modifiers) {
              await page.keyboard.down(modifier);
            }
            
            // Press main key
            await page.keyboard.press(mainKey);
            
            // Release modifiers
            for (const modifier of modifiers.reverse()) {
              await page.keyboard.up(modifier);
            }
          } else {
            // Single key press
            await page.keyboard.press(key);
          }
          
          return {
            success: true,
            result: {
              pressed: key,
              timestamp: new Date().toISOString()
            }
          };

        case 'type_text':
          const textToType = command.payload.text;
          await page.keyboard.type(textToType);
          return {
            success: true,
            result: {
              typed: textToType,
              timestamp: new Date().toISOString()
            }
          };

        case 'keyboard_input':
          const inputText = command.payload.input;
          await page.keyboard.type(inputText);
          return {
            success: true,
            result: {
              typed: inputText,
              timestamp: new Date().toISOString()
            }
          };

        case 'get_page_elements':
          // Get interactive elements with their positions for AI analysis
          const elements = await page.evaluate(() => {
            const clickableElements = Array.from(document.querySelectorAll(
              'button, input, a, [role="button"], [onclick], select, textarea, [tabindex]'
            ));
            
            return clickableElements.map((el, index) => {
              const rect = el.getBoundingClientRect();
              const isVisible = rect.width > 0 && rect.height > 0 && 
                               getComputedStyle(el).visibility !== 'hidden' &&
                               getComputedStyle(el).display !== 'none';
              
              return {
                id: index,
                tagName: el.tagName.toLowerCase(),
                text: el.textContent?.trim().substring(0, 100) || '',
                type: el.type || '',
                placeholder: el.placeholder || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                className: el.className || '',
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                visible: isVisible
              };
            }).filter(el => el.visible && el.x > 0 && el.y > 0);
          });

          return {
            success: true,
            result: {
              elements,
              timestamp: new Date().toISOString()
            }
          };

        case 'hover_coordinate':
          const hoverX = command.payload.x;
          const hoverY = command.payload.y;
          await page.mouse.move(hoverX, hoverY);
          return {
            success: true,
            result: {
              hovered: `coordinates (${hoverX}, ${hoverY})`,
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
