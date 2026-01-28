import { ApplicationMenu, ContextMenu, Tray } from "electrobun/bun";

class MenuManager {
  private trays = new Map<number, Tray>();
  private nextTrayId = 1;

  constructor() {
    this.setupApplicationMenu();
  }

  private setupApplicationMenu() {
    ApplicationMenu.setApplicationMenu([
      {
        submenu: [
          { label: "About", role: "about" },
          { type: "separator" },
          { label: "Quit", role: "quit", accelerator: "q" }
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          {
            label: "Custom Demo Action",
            action: "demo-action",
            tooltip: "This is a demo menu item",
          },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" }
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "close" }
        ],
      }
    ]);
  }

  async createTray(options: { title: string; image?: string }) {
    const id = this.nextTrayId++;
    
    const tray = new Tray({
      title: options.title,
      image: options.image || "views://assets/tray-icon.png",
      template: true,
      width: 32,
      height: 32,
    });

    // Set up tray menu
    tray.setMenu([
      {
        type: "normal",
        label: "Show Playground",
        action: "show-playground",
      },
      {
        type: "separator",
      },
      {
        type: "normal",
        label: "Demo Action",
        action: "demo-tray-action",
        tooltip: "This is a demo tray action",
      },
      {
        type: "normal",
        label: "Quit",
        action: "quit-app",
      },
    ]);

    tray.on("tray-clicked", (e: { data: { action: string } }) => {
      this.onTrayClicked?.(id, e.data.action);
    });

    this.trays.set(id, tray);
    return { id };
  }

  async removeTray(id: number) {
    const tray = this.trays.get(id);
    if (tray) {
      tray.remove();
      this.trays.delete(id);
    }
  }

  async showContextMenu(_params: { x: number; y: number }) {
    ContextMenu.showContextMenu([
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      {
        label: "Demo Context Action",
        action: "demo-context-action",
        tooltip: "This is a demo context menu item",
      },
      {
        label: "Disabled Action",
        action: "disabled-action",
        enabled: false,
      },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
    ]);
  }

  // Event callbacks
  onTrayClicked?: (id: number, action: string) => void;
  onMenuClicked?: (action: string) => void;
}

export const menuManager = new MenuManager();