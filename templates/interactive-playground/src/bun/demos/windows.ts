import { BrowserWindow } from "electrobun/bun";

class WindowManager {
  private windows = new Map<number, BrowserWindow<any>>();
  private nextId = 1;

  async createWindow(options: {
    width: number;
    height: number;
    x: number;
    y: number;
    frameless?: boolean;
    transparent?: boolean;
    alwaysOnTop?: boolean;
  }) {
    const id = this.nextId++;
    
    const window = new BrowserWindow({
      title: `Demo Window ${id}`,
      url: "views://mainview/index.html",
      renderer: "cef",
      frame: {
        width: options.width,
        height: options.height,
        x: options.x,
        y: options.y,
      },
      titleBarStyle: options.frameless ? "hiddenInset" : "default",
      // For completely frameless, we need to set styleMask
      styleMask: options.frameless ? {
        Borderless: true,
        Titled: false,
        Closable: true,
        Miniaturizable: true,
        Resizable: true,
      } : undefined,
    });

    this.windows.set(id, window);

    // Listen for window events
    window.on("close", () => {
      this.windows.delete(id);
      this.onWindowClosed?.(id);
    });

    window.on("resize", (event: { data: unknown }) => {
      this.onWindowEvent?.({ type: 'resize', id, data: event.data });
    });

    window.on("move", (event: { data: unknown }) => {
      this.onWindowEvent?.({ type: 'move', id, data: event.data });
    });

    this.onWindowCreated?.(id, `Demo Window ${id}`);
    
    return { id };
  }

  async closeWindow(id: number) {
    const window = this.windows.get(id);
    if (window) {
      window.close();
      this.windows.delete(id);
    }
  }

  async focusWindow(id: number) {
    const window = this.windows.get(id);
    if (window) {
      window.focus();
      this.onWindowFocused?.(id);
    }
  }

  async getWindowList() {
    return Array.from(this.windows.entries()).map(([id, window]) => ({
      id,
      title: (window as any).getTitle?.() || `Window ${id}`,
    }));
  }

  // Event callbacks
  onWindowCreated?: (id: number, title: string) => void;
  onWindowClosed?: (id: number) => void;
  onWindowFocused?: (id: number) => void;
  onWindowEvent?: (event: { type: string; id: number; data: any }) => void;
}

export const windowManager = new WindowManager();