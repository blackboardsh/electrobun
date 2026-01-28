export class MenuDemo {
  render() {
    return `
      <div class="demo-section">
        <div class="demo-header">
          <span class="demo-icon">🎛️</span>
          <div>
            <h2 class="demo-title">Menu Systems</h2>
            <p class="demo-description">Test application menus and context menus</p>
          </div>
        </div>

        <div class="demo-controls">
          <h3>Application Menu</h3>
          <div class="control-group">
            <div style="padding: 1rem; background: #f7fafc; border-radius: 0.5rem;">
              <p style="color: #4a5568; margin-bottom: 0.5rem;">
                The application menu is automatically set up. Look at the menu bar at the top of your screen.
              </p>
              <p style="color: #718096; font-size: 0.875rem;">
                Try: Edit → Custom Menu Item 🚀
              </p>
            </div>
          </div>

          <h3>Context Menu</h3>
          <div class="control-group">
            <button class="btn btn-primary" id="show-context-menu">Show Context Menu</button>
            <span style="color: #718096; font-size: 0.875rem;">Click to show a context menu at cursor position</span>
          </div>

          <div class="control-group">
            <div style="padding: 1rem; background: #ebf8ff; border: 1px solid #90cdf4; border-radius: 0.5rem;">
              <p style="color: #2b6cb0; font-size: 0.875rem;">
                <strong>Tip:</strong> You can also trigger context menus from your app by right-clicking in your UI and preventing the default action.
              </p>
            </div>
          </div>
        </div>

        <div class="demo-results">
          <div class="results-header">Menu Events:</div>
          <div id="menu-events" class="menu-events">
            <div class="no-events" style="text-align: center; color: #718096; padding: 2rem;">
              Click menu items to see events here
            </div>
          </div>
        </div>
      </div>
    `;
  }

  initialize(rpc: any) {
    const showContextBtn = document.getElementById('show-context-menu');

    showContextBtn?.addEventListener('click', async () => {
      try {
        // Show context menu at a default position
        await rpc.request.showContextMenu({ x: 100, y: 100 });
        this.addMenuEvent('Context menu shown');
      } catch (error) {
        console.error('Error showing context menu:', error);
      }
    });
  }

  private addMenuEvent(event: string) {
    const container = document.getElementById('menu-events');
    if (!container) return;

    const time = new Date().toLocaleTimeString();
    const eventHtml = `
      <div style="background: #f8fafc; border-left: 3px solid #4299e1; padding: 0.75rem; margin-bottom: 0.5rem; border-radius: 0 0.25rem 0.25rem 0;">
        <div style="color: #718096; font-size: 0.75rem;">${time}</div>
        <div style="color: #2d3748;">${event}</div>
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

  // Handle events from the backend
  onMenuClicked(data: { action: string }) {
    this.addMenuEvent(`Menu clicked: ${data.action}`);
  }
}