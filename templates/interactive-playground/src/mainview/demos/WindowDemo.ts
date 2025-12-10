export class WindowDemo {
  private windows: Array<{ id: number; title: string }> = [];
  private rpc: any;

  render() {
    return `
      <div class="demo-section">
        <div class="demo-header">
          <span class="demo-icon">🪟</span>
          <div>
            <h2 class="demo-title">Window Management</h2>
            <p class="demo-description">Create and manage multiple application windows with different properties</p>
          </div>
        </div>

        <div class="demo-controls">
          <div class="control-group">
            <label class="control-label">Width:</label>
            <input type="number" id="window-width" class="control-input" value="800" min="200" max="2000">
            
            <label class="control-label">Height:</label>
            <input type="number" id="window-height" class="control-input" value="600" min="200" max="1200">
            
            <label class="control-label">X:</label>
            <input type="number" id="window-x" class="control-input" value="100" min="0" max="2000">
            
            <label class="control-label">Y:</label>
            <input type="number" id="window-y" class="control-input" value="100" min="0" max="1200">
          </div>
          
          <div class="control-group">
            <label class="control-checkbox">
              <input type="checkbox" id="window-frameless"> Frameless
            </label>
            <label class="control-checkbox" title="Transparency is for webviews, not windows">
              <input type="checkbox" id="window-transparent" disabled> Transparent (WebView only)
            </label>
            <label class="control-checkbox">
              <input type="checkbox" id="window-always-on-top"> Always on Top
            </label>
          </div>
          
          <div class="control-group">
            <button class="btn btn-primary" id="create-window">Create Window</button>
            <button class="btn btn-secondary" id="get-window-list">Refresh List</button>
            <button class="btn btn-danger" id="close-all-windows">Close All</button>
          </div>
        </div>

        <div class="demo-results">
          <div class="results-header">Active Windows (<span id="window-count">0</span>):</div>
          <div class="window-grid" id="window-grid">
            <div class="no-windows" style="grid-column: 1 / -1; text-align: center; color: #718096; padding: 2rem;">
              No windows created yet. Use the controls above to create your first window.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  initialize(rpc: any) {
    this.rpc = rpc; // Store RPC reference
    
    // Get DOM elements
    const createBtn = document.getElementById('create-window');
    const refreshBtn = document.getElementById('get-window-list');
    const closeAllBtn = document.getElementById('close-all-windows');

    // Event listeners
    createBtn?.addEventListener('click', async () => {
      const width = parseInt((document.getElementById('window-width') as HTMLInputElement).value);
      const height = parseInt((document.getElementById('window-height') as HTMLInputElement).value);
      const x = parseInt((document.getElementById('window-x') as HTMLInputElement).value);
      const y = parseInt((document.getElementById('window-y') as HTMLInputElement).value);
      const frameless = (document.getElementById('window-frameless') as HTMLInputElement).checked;
      // Transparent and alwaysOnTop are disabled for now
      // const transparent = (document.getElementById('window-transparent') as HTMLInputElement).checked;
      const alwaysOnTop = (document.getElementById('window-always-on-top') as HTMLInputElement).checked;

      try {
        const result = await rpc.request.createWindow({
          width, height, x, y, frameless, alwaysOnTop
        });
        console.log('Window created:', result);
      } catch (error) {
        console.error('Error creating window:', error);
      }
    });

    refreshBtn?.addEventListener('click', async () => {
      try {
        const windows = await rpc.request.getWindowList();
        this.updateWindowList(windows);
      } catch (error) {
        console.error('Error getting window list:', error);
      }
    });

    closeAllBtn?.addEventListener('click', async () => {
      for (const window of this.windows) {
        try {
          await rpc.request.closeWindow(window.id);
        } catch (error) {
          console.error(`Error closing window ${window.id}:`, error);
        }
      }
    });

    // Load initial window list
    this.loadWindowList(rpc);
  }

  private async loadWindowList(rpc: any) {
    try {
      const windows = await rpc.request.getWindowList();
      this.updateWindowList(windows);
    } catch (error) {
      console.error('Error loading window list:', error);
    }
  }

  updateWindowList(windows: Array<{ id: number; title: string }>) {
    this.windows = windows;
    const grid = document.getElementById('window-grid');
    const count = document.getElementById('window-count');
    
    if (!grid || !count) return;

    count.textContent = windows.length.toString();

    if (windows.length === 0) {
      grid.innerHTML = `
        <div class="no-windows" style="grid-column: 1 / -1; text-align: center; color: #718096; padding: 2rem;">
          No windows created yet. Use the controls above to create your first window.
        </div>
      `;
      return;
    }

    grid.innerHTML = windows.map(window => `
      <div class="window-card" data-window-id="${window.id}">
        <div class="window-preview">Window Preview</div>
        <div class="window-title">${window.title}</div>
        <div class="window-actions">
          <button class="btn btn-small btn-secondary focus-window" data-window-id="${window.id}">Focus</button>
          <button class="btn btn-small btn-danger close-window" data-window-id="${window.id}">×</button>
        </div>
      </div>
    `).join('');

    // Add event listeners for window actions
    this.attachWindowActionListeners();
  }

  private attachWindowActionListeners() {
    const focusButtons = document.querySelectorAll('.focus-window');
    const closeButtons = document.querySelectorAll('.close-window');

    focusButtons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt((e.target as HTMLElement).getAttribute('data-window-id') || '0');
        try {
          await this.rpc.request.focusWindow(id);
          console.log(`Focused window ${id}`);
        } catch (error) {
          console.error(`Error focusing window ${id}:`, error);
        }
      });
    });

    closeButtons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt((e.target as HTMLElement).getAttribute('data-window-id') || '0');
        try {
          await this.rpc.request.closeWindow(id);
          console.log(`Closed window ${id}`);
          // Remove from local list
          this.windows = this.windows.filter(w => w.id !== id);
          this.updateWindowList(this.windows);
        } catch (error) {
          console.error(`Error closing window ${id}:`, error);
        }
      });
    });
  }

  // Handle events from the backend
  onWindowCreated(data: { id: number; title: string }) {
    this.windows.push(data);
    this.updateWindowList(this.windows);
  }

  onWindowClosed(data: { id: number }) {
    this.windows = this.windows.filter(w => w.id !== data.id);
    this.updateWindowList(this.windows);
  }

  onWindowFocused(data: { id: number }) {
    // Visual feedback for focused window
    const windowCard = document.querySelector(`[data-window-id="${data.id}"]`);
    if (windowCard) {
      windowCard.classList.add('focused');
      setTimeout(() => windowCard.classList.remove('focused'), 1000);
    }
  }
}