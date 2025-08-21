export type ToastType = 'info' | 'success' | 'warning' | 'error';

export class Toast {
  static show(message: string, type: ToastType = 'info', duration: number = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <div class="toast-content">
        <div class="toast-message">${this.escapeHtml(message)}</div>
      </div>
    `;

    container.appendChild(toast);

    // Auto-remove after duration
    setTimeout(() => {
      this.remove(toast);
    }, duration);

    // Allow manual dismissal
    toast.addEventListener('click', () => {
      this.remove(toast);
    });
  }

  private static remove(toast: HTMLElement) {
    toast.style.animation = 'slideOut 0.3s ease forwards';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }

  private static escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  static success(message: string, duration?: number) {
    this.show(message, 'success', duration);
  }

  static error(message: string, duration?: number) {
    this.show(message, 'error', duration);
  }

  static warning(message: string, duration?: number) {
    this.show(message, 'warning', duration);
  }

  static info(message: string, duration?: number) {
    this.show(message, 'info', duration);
  }
}