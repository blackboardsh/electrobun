interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: any;
}

export class EventLog {
  private entries: LogEntry[] = [];
  private isOpen: boolean = false;
  private filters: Set<string> = new Set(['info', 'warn', 'error']);

  constructor() {
    this.initializeEventListeners();
  }

  private initializeEventListeners() {
    const toggle = document.getElementById('event-log-toggle');
    const clearBtn = document.getElementById('clear-log');
    const filterCheckboxes = document.querySelectorAll('.event-log-filters input[type="checkbox"]');

    toggle?.addEventListener('click', () => {
      this.toggle();
    });

    clearBtn?.addEventListener('click', () => {
      this.clear();
    });

    filterCheckboxes.forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const level = target.getAttribute('data-level');
        if (level) {
          if (target.checked) {
            this.filters.add(level);
          } else {
            this.filters.delete(level);
          }
          this.render();
        }
      });
    });
  }

  toggle() {
    this.isOpen = !this.isOpen;
    const eventLog = document.getElementById('event-log');
    eventLog?.classList.toggle('open', this.isOpen);
  }

  addEntry(level: 'info' | 'warn' | 'error', message: string, data?: any) {
    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      data
    };

    this.entries.unshift(entry); // Add to beginning

    // Keep only last 100 entries
    if (this.entries.length > 100) {
      this.entries = this.entries.slice(0, 100);
    }

    this.render();
  }

  clear() {
    this.entries = [];
    this.render();
  }

  private render() {
    const container = document.getElementById('event-log-list');
    if (!container) return;

    const filteredEntries = this.entries.filter(entry => this.filters.has(entry.level));

    container.innerHTML = filteredEntries.map(entry => `
      <div class="event-entry ${entry.level}">
        <div class="event-time">${this.formatTime(entry.timestamp)}</div>
        <div class="event-message">${this.escapeHtml(entry.message)}</div>
        ${entry.data ? `<pre class="event-data">${this.escapeHtml(JSON.stringify(entry.data, null, 2))}</pre>` : ''}
      </div>
    `).join('');

    // Auto-scroll to top for new entries
    container.scrollTop = 0;
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}