export class TrayDemo {
  private trays: Array<{ id: number; title: string }> = [];
  private rpc: any;

  render() {
    return `
      <div class="demo-section">
        <div class="demo-header">
          <span class="demo-icon">🔔</span>
          <div>
            <h2 class="demo-title">System Tray</h2>
            <p class="demo-description">Create and manage system tray icons with menus</p>
          </div>
        </div>

        <div class="demo-controls">
          <h3>Create System Tray</h3>
          <div class="control-group">
            <label class="control-label">Title:</label>
            <input type="text" id="tray-title" class="control-input" value="My Tray Item" style="width: 200px;">
            
            <button class="btn btn-primary" id="create-tray">Create Tray</button>
            <button class="btn btn-danger" id="remove-all-trays">Remove All Trays</button>
          </div>

          <div style="margin-top: 1rem; padding: 1rem; background: #f7fafc; border-radius: 0.5rem;">
            <p style="color: #4a5568; font-size: 0.875rem;">
              <strong>Note:</strong> System tray icons appear in your system's menu bar or notification area. 
              Click on the tray icon to see its menu. On macOS, look in the top-right menu bar.
            </p>
          </div>
        </div>

        <div class="demo-results">
          <div class="results-header">Active Trays (<span id="tray-count">0</span>):</div>
          <div id="tray-list" class="tray-list">
            <div class="no-trays" style="text-align: center; color: #718096; padding: 2rem;">
              No system tray items created yet.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  initialize(rpc: any) {
    this.rpc = rpc;
    
    const createTrayBtn = document.getElementById('create-tray');
    const removeAllTraysBtn = document.getElementById('remove-all-trays');

    createTrayBtn?.addEventListener('click', async () => {
      const title = (document.getElementById('tray-title') as HTMLInputElement).value;
      
      try {
        const result = await rpc.request.createTray({ title });
        this.trays.push({ id: result.id, title });
        this.updateTrayList();
        console.log('Created tray:', result);
      } catch (error) {
        console.error('Error creating tray:', error);
      }
    });

    removeAllTraysBtn?.addEventListener('click', async () => {
      for (const tray of this.trays) {
        try {
          await rpc.request.removeTray(tray.id);
          console.log('Removed tray:', tray.id);
        } catch (error) {
          console.error(`Error removing tray ${tray.id}:`, error);
        }
      }
      this.trays = [];
      this.updateTrayList();
    });
  }

  private updateTrayList() {
    const container = document.getElementById('tray-list');
    const count = document.getElementById('tray-count');
    
    if (!container || !count) return;

    count.textContent = this.trays.length.toString();

    if (this.trays.length === 0) {
      container.innerHTML = `
        <div class="no-trays" style="text-align: center; color: #718096; padding: 2rem;">
          No system tray items created yet.
        </div>
      `;
      return;
    }

    container.innerHTML = this.trays.map(tray => `
      <div class="tray-item" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.5rem; padding: 1rem; margin-bottom: 0.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong>Tray ${tray.id}</strong>
            <div style="color: #718096; font-size: 0.875rem;">${tray.title}</div>
            <div style="color: #4299e1; font-size: 0.75rem; margin-top: 0.25rem;">
              Click tray icon in menu bar to see menu
            </div>
          </div>
          <button class="btn btn-small btn-danger remove-tray" data-tray-id="${tray.id}">Remove</button>
        </div>
      </div>
    `).join('');

    // Add remove button listeners
    const removeButtons = document.querySelectorAll('.remove-tray');
    removeButtons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt((e.target as HTMLElement).getAttribute('data-tray-id') || '0');
        try {
          await this.rpc.request.removeTray(id);
          console.log('Removed tray:', id);
          this.trays = this.trays.filter(t => t.id !== id);
          this.updateTrayList();
        } catch (error) {
          console.error(`Error removing tray ${id}:`, error);
        }
      });
    });
  }

  // Handle events from the backend
  onTrayClicked(data: { id: number; action: string }) {
    console.log('Tray clicked:', data);
  }
}