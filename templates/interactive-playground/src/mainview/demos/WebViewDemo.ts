import type { WebviewTagElement } from "electrobun/view";

export class WebViewDemo {
  render() {
    return `
      <div class="demo-section">
        <div class="demo-header">
          <span class="demo-icon">🌐</span>
          <div>
            <h2 class="demo-title">WebView Browser</h2>
            <p class="demo-description">Embedded browser with navigation, transparency, masking, and advanced features</p>
          </div>
        </div>

        <div class="demo-controls" style="padding: 1rem;">
          <!-- Browser-like navigation bar -->
          <div style="display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem; background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 0.5rem; margin-bottom: 1rem;">
            <button class="btn btn-sm" id="webview-back" style="padding: 0.25rem 0.5rem;">←</button>
            <button class="btn btn-sm" id="webview-forward" style="padding: 0.25rem 0.5rem;">→</button>
            <button class="btn btn-sm" id="webview-reload" style="padding: 0.25rem 0.5rem;">🔄</button>
            <input type="text" id="url-bar" class="control-input" style="flex: 1; padding: 0.25rem 0.5rem; font-size: 0.875rem;" placeholder="Enter URL or click quick nav buttons" />
            <button class="btn btn-primary btn-sm" id="url-go" style="padding: 0.25rem 0.75rem;">Go</button>
          </div>

          <!-- Quick navigation buttons -->
          <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap;">
            <button class="btn btn-sm" id="nav-eggbun">eggbun.sh</button>
            <button class="btn btn-sm" id="nav-electrobun">electrobun.dev</button>
            <button class="btn btn-sm" id="nav-github">GitHub</button>
            <button class="btn btn-sm" id="nav-wikipedia">Wikipedia Random</button>
          </div>

          <!-- WebView control buttons -->
          <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap;">
            <button class="btn btn-secondary btn-sm" id="toggle-transparent">Toggle Transparent</button>
            <button class="btn btn-secondary btn-sm" id="toggle-passthrough">Toggle Passthrough</button>
            <button class="btn btn-secondary btn-sm" id="toggle-hidden">Toggle Hidden</button>
            <button class="btn btn-secondary btn-sm" id="add-mask">Add Mask</button>
            <button class="btn btn-secondary btn-sm" id="remove-mask">Remove Mask</button>
          </div>

          <!-- Draggable element for testing -->
          <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap;">
            <div id="draggable-test" draggable="true" style="padding: 10px; width: 120px; height: 80px; border: 3px dashed #4a5568; cursor: move; background: white; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 0.875rem; text-align: center;">
              <div>Drag me over the webview</div>
              <div id="drag-coords" style="font-size: 0.75rem; color: #4a5568; margin-top: 0.25rem;">x: 0, y: 0</div>
            </div>
          </div>

        </div>

        <div class="demo-results" style="position: relative;">
          <!-- Main webview container with mask overlay elements -->
          <div style="position: relative; width: 100%; height: 500px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.5rem;">
            
            <!-- Overlay squares for mask testing -->
            <div class="element-to-mask" style="position: absolute; z-index: 10; top: -30px; right: 50px; width: 120px; height: 110px; background: black; color: white; padding: 10px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 10px solid firebrick">
              Mask Layer 1
            </div>
            
            <div class="element-to-mask" style="position: absolute; z-index: 10; top: -20px; right: 160px; width: 120px; height: 130px; background: green; color: white; padding: 10px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 5px solid cadetblue;">
              Mask Layer 2
            </div>

            <!-- Main webview -->
            <electrobun-webview 
              id="main-webview"
              style="width: 100%; height: 100%;" 
              src="https://electrobun.dev" 
              preload="" 
              renderer="cef">
            </electrobun-webview>
          </div>

          

          <!-- Compact event log -->
          <div style="margin-top: 1rem;">
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.5rem; padding: 0.5rem;">
              <div style="font-weight: 500; padding: 0.25rem;">WebView Events Log</div>
              <div id="webview-events" style="max-height: 150px; overflow-y: auto; margin-top: 0.5rem;">
                <div class="no-events" style="text-align: center; color: #718096; font-size: 0.875rem;">
                  Events will appear here
                </div>
              </div>
            </div>
          </div>

          <!-- Additional webviews for testing partitions -->
          <div style="margin-top: 1rem;">
            <div style="font-weight: 500; padding: 0.5rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.5rem;">Session Partition Testing (Wikipedia)</div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem;">
              <div style="border: 1px solid #e2e8f0; border-radius: 0.25rem; overflow: hidden;">
                <div style="background: #f7fafc; padding: 0.25rem 0.5rem; font-size: 0.75rem;">
                  Shared (Default)
                </div>
                <electrobun-webview 
                  id="partition-default"
                  style="width: 100%; height: 200px;" 
                  src="https://en.wikipedia.org/wiki/Main_Page" 
                  renderer="cef" 
                  partition="">
                </electrobun-webview>
              </div>

              <div style="border: 1px solid #e2e8f0; border-radius: 0.25rem; overflow: hidden;">
                <div style="background: #f7fafc; padding: 0.25rem 0.5rem; font-size: 0.75rem;">
                  Shared (Also Default)
                </div>
                <electrobun-webview 
                  id="partition-default2"
                  style="width: 100%; height: 200px;" 
                  src="https://en.wikipedia.org/wiki/Main_Page" 
                  renderer="cef" 
                  partition="">
                </electrobun-webview>
              </div>

              <div style="border: 1px solid #e2e8f0; border-radius: 0.25rem; overflow: hidden;">
                <div style="background: #eff6ff; padding: 0.25rem 0.5rem; font-size: 0.75rem;">
                  Isolated (persist:user1)
                </div>
                <electrobun-webview 
                  id="partition-user1"
                  style="width: 100%; height: 200px;" 
                  src="https://en.wikipedia.org/wiki/Main_Page" 
                  renderer="cef" 
                  partition="persist:user1">
                </electrobun-webview>
              </div>

              <div style="border: 1px solid #e2e8f0; border-radius: 0.25rem; overflow: hidden;">
                <div style="background: #f0fdf4; padding: 0.25rem 0.5rem; font-size: 0.75rem;">
                  Isolated (persist:user2)
                </div>
                <electrobun-webview 
                  id="partition-user2"
                  style="width: 100%; height: 200px;" 
                  src="https://en.wikipedia.org/wiki/Main_Page" 
                  renderer="cef" 
                  partition="persist:user2">
                </electrobun-webview>
              </div>
            </div>
            
            <div style="margin-top: 0.5rem; padding: 0.5rem; background: #ebf8ff; border: 1px solid #90cdf4; border-radius: 0.25rem; font-size: 0.75rem; color: #2b6cb0;">
              <strong>How to test partitions:</strong> Click on any Wikipedia link in one webview. The two "Shared" webviews will both show visited links in purple, while the "Isolated" webviews maintain separate browsing history. Try logging in or changing settings - shared partitions share everything, isolated ones are independent.
            </div>
          </div>

          <!-- HTML content test -->
          <div style="margin-top: 1rem;">
            <div style="font-weight: 500; padding: 0.5rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.5rem;">Inline HTML WebView</div>
            <div style="margin-top: 0.5rem; border: 1px solid #e2e8f0; border-radius: 0.25rem; overflow: hidden;">
              <electrobun-webview 
                style="width: 100%; height: 150px;"
                preload="window.onload = () => {document.body.innerHTML += '<br>Hello from preload script!';}"  
                html="<html><body style='padding: 20px; font-family: system-ui;'><h2>WebView with inline HTML</h2><p>This webview is rendered from HTML string instead of URL.</p></body></html>">
              </electrobun-webview>
            </div>
          </div>

          <!-- CMD+Click Test WebView -->
          <div style="margin-top: 1rem;">
            <div style="font-weight: 500; padding: 0.5rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.5rem;">CMD+Click New Window Test</div>
            <div style="margin-top: 0.5rem; border: 1px solid #e2e8f0; border-radius: 0.25rem; overflow: hidden;">
              <electrobun-webview 
                id="cmd-click-test"
                style="width: 100%; height: 200px;"
                html="<html><head><style>body{font-family:system-ui;padding:20px;background:#f9f9f9;}a{display:block;margin:10px 0;padding:10px;background:white;border:1px solid #ddd;text-decoration:none;border-radius:5px;transition:background 0.2s;}a:hover{background:#e6f3ff;}</style></head><body><h3>Test CMD+Click to Open New Windows</h3><p>Hold <strong>CMD</strong> (macOS) and click these links to test new window events:</p><a href='https://electrobun.dev' target='_self'>Regular Link (same window)</a><a href='https://github.com/blackboardsh/electrobun' target='_blank'>Target _blank Link</a><a href='https://bun.sh'>CMD+Click Me!</a><a href='javascript:window.open(\"https://anthropic.com\", \"_blank\")'>JavaScript window.open()</a><p style='color:#666;font-size:14px;'>Watch the events log above to see how different link types are handled.</p></body></html>">
              </electrobun-webview>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  initialize(_rpc: any) {
    this.setupEventListeners();
    this.setupWebViewEvents();
  }

  private setupEventListeners() {
    const webview = document.getElementById('main-webview') as WebviewTagElement | null;
    const urlBar = document.getElementById('url-bar') as HTMLInputElement;

    // Safety check: If webview doesn't exist, don't set up listeners
    if (!webview) {
      console.warn('WebView element not found during event listener setup');
      return;
    }

    // Navigation controls
    document.getElementById('webview-back')?.addEventListener('click', () => {
      if (webview && typeof webview.goBack === 'function') {
        webview.goBack();
        this.addWebViewEvent('← Back');
      }
    });

    document.getElementById('webview-forward')?.addEventListener('click', () => {
      if (webview && typeof webview.goForward === 'function') {
        webview.goForward();
        this.addWebViewEvent('→ Forward');
      }
    });

    document.getElementById('webview-reload')?.addEventListener('click', () => {
      if (webview && typeof webview.reload === 'function') {
        webview.reload();
        this.addWebViewEvent('🔄 Reload');
      }
    });

    // URL bar navigation
    const navigateToUrl = () => {
      const url = urlBar?.value?.trim();
      if (url && webview && typeof webview.setAttribute === 'function') {
        // Add protocol if missing
        const finalUrl = url.startsWith('http://') || url.startsWith('https://') 
          ? url 
          : `https://${url}`;
        webview.setAttribute('src', finalUrl);
        this.addWebViewEvent(`Navigate: ${finalUrl}`);
      }
    };

    document.getElementById('url-go')?.addEventListener('click', navigateToUrl);
    urlBar?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        navigateToUrl();
      }
    });

    // Quick navigation
    document.getElementById('nav-eggbun')?.addEventListener('click', () => {
      if (webview && typeof webview.setAttribute === 'function' && urlBar) {
        webview.setAttribute('src', 'https://eggbun.sh');
        urlBar.value = 'https://eggbun.sh';
        this.addWebViewEvent('Nav: eggbun.sh');
      }
    });

    document.getElementById('nav-electrobun')?.addEventListener('click', () => {
      if (webview && typeof webview.setAttribute === 'function' && urlBar) {
        webview.setAttribute('src', 'https://electrobun.dev');
        urlBar.value = 'https://electrobun.dev';
        this.addWebViewEvent('Nav: electrobun.dev');
      }
    });

    document.getElementById('nav-github')?.addEventListener('click', () => {
      if (webview && typeof webview.setAttribute === 'function' && urlBar) {
        webview.setAttribute('src', 'https://github.com/blackboardsh/electrobun');
        urlBar.value = 'https://github.com/blackboardsh/electrobun';
        this.addWebViewEvent('Nav: GitHub');
      }
    });

    document.getElementById('nav-wikipedia')?.addEventListener('click', () => {
      if (webview && typeof webview.setAttribute === 'function' && urlBar) {
        webview.setAttribute('src', 'https://en.wikipedia.org/wiki/Special:Random');
        urlBar.value = 'https://en.wikipedia.org/wiki/Special:Random';
        this.addWebViewEvent('Nav: Wikipedia Random');
      }
    });

    // WebView effects
    let isTransparent = false;
    let isPassthrough = false;
    let isHidden = false;

    document.getElementById('toggle-transparent')?.addEventListener('click', () => {
      if (webview && typeof webview.toggleTransparent === 'function') {
        webview.toggleTransparent();
        isTransparent = !isTransparent;
        this.addWebViewEvent(`Transparent: ${isTransparent ? 'ON' : 'OFF'}`);
      }
    });

    document.getElementById('toggle-passthrough')?.addEventListener('click', () => {
      if (webview && typeof webview.togglePassthrough === 'function') {
        webview.togglePassthrough();
        isPassthrough = !isPassthrough;
        this.addWebViewEvent(`Passthrough: ${isPassthrough ? 'ON' : 'OFF'}`);
      }
    });

    document.getElementById('toggle-hidden')?.addEventListener('click', () => {
      if (webview && typeof webview.toggleHidden === 'function') {
        webview.toggleHidden();
        isHidden = !isHidden;
        this.addWebViewEvent(`Hidden: ${isHidden ? 'ON' : 'OFF'}`);
      }
    });

    // Element masking
    document.getElementById('add-mask')?.addEventListener('click', () => {
      if (webview && typeof webview.addMaskSelector === 'function') {
        webview.addMaskSelector('.element-to-mask');
        this.addWebViewEvent('Mask added: .element-to-mask');
      }
    });

    document.getElementById('remove-mask')?.addEventListener('click', () => {
      if (webview && typeof webview.removeMaskSelector === 'function') {
        webview.removeMaskSelector('.element-to-mask');
        this.addWebViewEvent('Mask removed: .element-to-mask');
      }
    });

    // Draggable element position tracking
    const draggable = document.getElementById('draggable-test');
    const dragCoords = document.getElementById('drag-coords');
    
    if (draggable && dragCoords) {
      draggable.addEventListener('dragstart', (e: DragEvent) => {
        (e.dataTransfer as any).effectAllowed = 'move';
      });

      // Update coordinates during drag
      document.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        if (dragCoords) {
          dragCoords.textContent = `x: ${e.clientX}, y: ${e.clientY}`;
        }
      });

      draggable.addEventListener('dragend', (e: DragEvent) => {
        if (dragCoords) {
          dragCoords.textContent = `x: ${e.clientX}, y: ${e.clientY}`;
        }
      });
    }

    // Add mask selectors to all webviews (with safety checks)
    document.querySelectorAll<WebviewTagElement>('electrobun-webview').forEach((w) => {
      if (w && typeof w.addMaskSelector === 'function') {
        w.addMaskSelector("header");
      }
    });

  }

  private setupWebViewEvents() {
    const webview = document.getElementById('main-webview') as WebviewTagElement | null;
    const cmdClickTestWebview = document.getElementById('cmd-click-test') as WebviewTagElement | null;
    const urlBar = document.getElementById('url-bar') as HTMLInputElement;
    
    // Setup events for main webview
    if (webview && typeof webview.on === 'function') {
      // Use the on() method as shown in the old playground
      webview.on('did-navigate', (e: any) => {
        const url = e.detail?.url || 'unknown';
        if (urlBar) {
          urlBar.value = url;
        }
        this.addWebViewEvent(`did-navigate: ${url}`);
      });

      webview.on('did-navigate-in-page', (e: any) => {
        this.addWebViewEvent(`in-page-nav: ${e.detail?.url || 'unknown'}`);
      });

      webview.on('did-commit-navigation', (e: any) => {
        this.addWebViewEvent(`commit-nav: ${e.detail?.url || 'unknown'}`);
      });

      webview.on('dom-ready', () => {
        this.addWebViewEvent(`DOM ready`);
      });

      webview.on('new-window-open', (e: any) => {
        const detail = e.detail;
        
        // Handle both legacy string format and new JSON format
        if (typeof detail === 'string') {
          this.addWebViewEvent(`new-window: ${detail}`);
        } else if (detail && typeof detail === 'object') {
          const { url, isCmdClick, modifierFlags, userGesture } = detail;
          const eventDesc = isCmdClick ? 'cmd+click' : 'popup';
          this.addWebViewEvent(`new-window (${eventDesc}): ${url || 'unknown'}`);
          
          // Log additional details for debugging
          console.log('New window event details:', { url, isCmdClick, modifierFlags, userGesture });
        } else {
          this.addWebViewEvent(`new-window: ${JSON.stringify(detail)}`);
        }
      });

      // Also try addEventListener for compatibility
      if (typeof webview.addEventListener === 'function') {
        webview.addEventListener('did-navigate', (e: any) => {
          const url = e.detail?.url || 'unknown';
          if (urlBar) {
            urlBar.value = url;
          }
          this.addWebViewEvent(`did-navigate: ${url}`);
        });
      }
    }

    // Setup events for cmd+click test webview
    if (cmdClickTestWebview && typeof cmdClickTestWebview.on === 'function') {
      cmdClickTestWebview.on('new-window-open', (e: any) => {
        const detail = e.detail;
        
        // Handle both legacy string format and new JSON format
        if (typeof detail === 'string') {
          this.addWebViewEvent(`[TEST] new-window: ${detail}`);
        } else if (detail && typeof detail === 'object') {
          const { url, isCmdClick, modifierFlags, userGesture } = detail;
          const eventDesc = isCmdClick ? 'cmd+click' : 'popup';
          this.addWebViewEvent(`[TEST] new-window (${eventDesc}): ${url || 'unknown'}`);
          
          // Log additional details for debugging
          console.log('CMD+Click test webview event:', { url, isCmdClick, modifierFlags, userGesture });
        } else {
          this.addWebViewEvent(`[TEST] new-window: ${JSON.stringify(detail)}`);
        }
      });

      cmdClickTestWebview.on('did-navigate', (e: any) => {
        const url = e.detail?.url || 'unknown';
        this.addWebViewEvent(`[TEST] did-navigate: ${url}`);
      });
    }
  }

  private addWebViewEvent(event: string) {
    const container = document.getElementById('webview-events');
    if (!container) return;

    const time = new Date().toLocaleTimeString();
    const eventHtml = `
      <div style="border-left: 2px solid #0ea5e9; padding: 0.25rem 0.5rem; margin-bottom: 0.25rem; font-size: 0.75rem;">
        <span style="color: #64748b;">${time}</span>
        <span style="color: #0369a1; margin-left: 0.5rem;">${event}</span>
      </div>
    `;

    // Remove "no events" message if it exists
    const noEvents = container.querySelector('.no-events');
    if (noEvents) {
      container.innerHTML = '';
    }

    // Add new event at the top
    container.insertAdjacentHTML('afterbegin', eventHtml);

    // Keep only last 10 events
    const events = container.children;
    while (events.length > 10) {
      container.removeChild(events[events.length - 1]);
    }
  }
}