// Content script for browser automation extension
// This script runs on all web pages and can interact with the page content

class ContentScript {
  constructor() {
    this.setupMessageListener();
    this.injectHelpers();
  }

  setupMessageListener() {
    // Listen for messages from background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.target === 'content-script') {
        this.handleMessage(message, sendResponse);
        return true; // Keep message channel open
      }
    });
  }

  handleMessage(message, sendResponse) {
    try {
      switch (message.action) {
        case 'get_page_info':
          sendResponse(this.getPageInfo());
          break;
        case 'highlight_element':
          this.highlightElement(message.selector);
          sendResponse({ success: true });
          break;
        case 'remove_highlights':
          this.removeHighlights();
          sendResponse({ success: true });
          break;
        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  }

  getPageInfo() {
    return {
      url: window.location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scroll: {
        x: window.scrollX,
        y: window.scrollY
      },
      elements: {
        links: document.querySelectorAll('a').length,
        images: document.querySelectorAll('img').length,
        forms: document.querySelectorAll('form').length,
        inputs: document.querySelectorAll('input').length,
        buttons: document.querySelectorAll('button').length
      }
    };
  }

  highlightElement(selector) {
    // Remove existing highlights
    this.removeHighlights();
    
    const elements = document.querySelectorAll(selector);
    elements.forEach((element, index) => {
      const highlight = document.createElement('div');
      highlight.className = 'automation-highlight';
      highlight.style.cssText = `
        position: absolute;
        border: 2px solid #ff4757;
        background: rgba(255, 71, 87, 0.1);
        pointer-events: none;
        z-index: 999999;
        box-sizing: border-box;
      `;
      
      const rect = element.getBoundingClientRect();
      highlight.style.left = (rect.left + window.scrollX) + 'px';
      highlight.style.top = (rect.top + window.scrollY) + 'px';
      highlight.style.width = rect.width + 'px';
      highlight.style.height = rect.height + 'px';
      
      // Add element counter
      if (elements.length > 1) {
        const counter = document.createElement('div');
        counter.textContent = index + 1;
        counter.style.cssText = `
          position: absolute;
          top: -20px;
          left: 0;
          background: #ff4757;
          color: white;
          padding: 2px 6px;
          font-size: 12px;
          font-weight: bold;
          border-radius: 3px;
        `;
        highlight.appendChild(counter);
      }
      
      document.body.appendChild(highlight);
    });
  }

  removeHighlights() {
    const highlights = document.querySelectorAll('.automation-highlight');
    highlights.forEach(highlight => highlight.remove());
  }

  injectHelpers() {
    // Inject helper functions into page context if needed
    // This allows the automation service to access page-specific functionality
    
    window.automationHelper = {
      // Helper function to wait for element
      waitForElement: (selector, timeout = 5000) => {
        return new Promise((resolve, reject) => {
          const element = document.querySelector(selector);
          if (element) {
            resolve(element);
            return;
          }
          
          const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element) {
              observer.disconnect();
              resolve(element);
            }
          });
          
          observer.observe(document.body, {
            childList: true,
            subtree: true
          });
          
          setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Element not found: ${selector}`));
          }, timeout);
        });
      },
      
      // Helper function to simulate user-like typing
      simulateTyping: (element, text, delay = 100) => {
        return new Promise((resolve) => {
          element.focus();
          element.value = '';
          
          let index = 0;
          const type = () => {
            if (index < text.length) {
              element.value += text[index];
              element.dispatchEvent(new Event('input', { bubbles: true }));
              index++;
              setTimeout(type, delay);
            } else {
              element.dispatchEvent(new Event('change', { bubbles: true }));
              resolve();
            }
          };
          
          type();
        });
      },
      
      // Helper function to get element path
      getElementPath: (element) => {
        const path = [];
        while (element && element.nodeType === 1) {
          let selector = element.tagName.toLowerCase();
          if (element.id) {
            selector += '#' + element.id;
            path.unshift(selector);
            break;
          } else {
            let sibling = element;
            let nth = 1;
            while (sibling.previousElementSibling) {
              sibling = sibling.previousElementSibling;
              if (sibling.tagName === element.tagName) {
                nth++;
              }
            }
            if (nth > 1) {
              selector += `:nth-of-type(${nth})`;
            }
          }
          path.unshift(selector);
          element = element.parentElement;
        }
        return path.join(' > ');
      }
    };
  }
}

// Initialize content script when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new ContentScript());
} else {
  new ContentScript();
}
