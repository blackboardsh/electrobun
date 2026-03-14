type CarrotMode = "window" | "background";

type CarrotWindowOptions = {
  id?: string;
  title?: string;
  url?: string | null;
  frame?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  titleBarStyle?: "hidden" | "hiddenInset" | "default";
  transparent?: boolean;
  passthrough?: boolean;
  hidden?: boolean;
};

type CarrotTrayOptions = {
  title?: string;
};

type CarrotMenuItem =
  | {
      type?: "normal" | "checkbox" | "radio";
      label: string;
      action?: string;
      enabled?: boolean;
      checked?: boolean;
      hidden?: boolean;
      tooltip?: string;
      submenu?: CarrotMenuItem[];
    }
  | { type: "divider" | "separator" };

type CarrotApplicationMenuItem =
  | {
      type?: "normal";
      label?: string;
      tooltip?: string;
      action?: string;
      role?: string;
      data?: unknown;
      submenu?: CarrotApplicationMenuItem[];
      enabled?: boolean;
      checked?: boolean;
      hidden?: boolean;
      accelerator?: string;
    }
  | { type: "divider" | "separator" };

type CarrotContextMenuItem = CarrotApplicationMenuItem;

type InitMessage = {
  type: "init";
  manifest?: {
    id: string;
    name: string;
    mode: CarrotMode;
    view?: {
      relativePath: string;
      title: string;
      width: number;
      height: number;
      titleBarStyle?: "hidden" | "hiddenInset" | "default";
      transparent?: boolean;
    };
  };
  context?: {
    statePath?: string;
    logsPath?: string;
    permissions?: string[];
    grantedPermissions?: Record<string, unknown>;
  };
};

type HostResponseMessage = {
  type: "host-response";
  requestId: number;
  success: boolean;
  payload?: unknown;
  error?: string;
};

type EventMessage = {
  type: "event";
  name: string;
  payload?: unknown;
};

type RuntimeMessage = InitMessage | HostResponseMessage | EventMessage;

type EventHandler = (payload: unknown) => void;

function postRuntimeMessage(message: unknown) {
  self.postMessage(message);
}

function readBootstrapState() {
  const bootstrap = (globalThis as Record<string, unknown>).__bunnyCarrotBootstrap as
    | {
        manifest?: InitMessage["manifest"];
        context?: InitMessage["context"];
      }
    | undefined;

  if (!bootstrap) {
    return {
      manifest: null,
      context: null,
    };
  }

  return {
    manifest: bootstrap.manifest ?? null,
    context: bootstrap.context ?? null,
  };
}

function normalizeViewUrl(url: string | null | undefined, fallbackRelativePath?: string) {
  if (typeof url === "string" && url.length > 0) {
    if (url.includes("://")) {
      return url;
    }
    return `views://${url.replace(/^\/+/, "")}`;
  }

  if (fallbackRelativePath) {
    return `views://${fallbackRelativePath.replace(/^\/+/, "")}`;
  }

  return null;
}

class CarrotRuntimeBridge {
  private requestId = 1;
  private nextWindowId = 1;
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private pendingHostRequests = new Map<
    number,
    {
      resolve: (payload: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  manifest: InitMessage["manifest"] | null;
  context: InitMessage["context"] | null;

  constructor() {
    const bootstrap = readBootstrapState();
    this.manifest = bootstrap.manifest;
    this.context = bootstrap.context;
    if (this.manifest || this.context) {
      queueMicrotask(() => {
        this.emit("boot", {
          manifest: this.manifest,
          context: this.context,
        });
      });
    }
    self.addEventListener("message", (event) => {
      this.handleMessage(event.data as RuntimeMessage);
    });
  }

  on(name: string, handler: EventHandler) {
    const handlers = this.eventHandlers.get(name) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.eventHandlers.set(name, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(name);
      }
    };
  }

  emit(name: string, payload: unknown) {
    this.eventHandlers.get(name)?.forEach((handler) => {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[carrot-runtime] event handler failed: ${name}`, error);
      }
    });
  }

  createWindowId() {
    const windowId = `window-${this.nextWindowId}`;
    this.nextWindowId += 1;
    return windowId;
  }

  sendAction(action: string, payload?: unknown) {
    postRuntimeMessage({
      type: "action",
      action,
      payload,
    });
  }

  requestHost<T = unknown>(method: string, params?: unknown): Promise<T> {
    const requestId = this.requestId++;
    postRuntimeMessage({
      type: "host-request",
      requestId,
      method,
      params,
    });

    return new Promise<T>((resolve, reject) => {
      this.pendingHostRequests.set(requestId, {
        resolve: (payload) => resolve(payload as T),
        reject,
      });
    });
  }

  private handleMessage(message: RuntimeMessage) {
    if (!message || typeof message !== "object" || !("type" in message)) {
      return;
    }

    if (message.type === "host-response") {
      const pending = this.pendingHostRequests.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pendingHostRequests.delete(message.requestId);
      if (message.success) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new Error(message.error || "Unknown host error"));
      }
      return;
    }

    if (message.type === "init") {
      this.manifest = message.manifest ?? null;
      this.context = message.context ?? null;
      this.emit("boot", {
        manifest: this.manifest,
        context: this.context,
      });
      return;
    }

    if (message.type === "event") {
      this.emit(message.name, message.payload);
    }
  }
}

export const carrotRuntime = new CarrotRuntimeBridge();

class RuntimeWindow {
  static instances = new Map<string, RuntimeWindow>();

  id: string;
  title: string;
  url: string | null;
  frame: { x: number; y: number; width: number; height: number };
  titleBarStyle: "hidden" | "hiddenInset" | "default";
  transparent: boolean;
  passthrough: boolean;
  hidden: boolean;
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  constructor(options: CarrotWindowOptions = {}) {
    const defaultView = carrotRuntime.manifest?.view;
    this.id = options.id || carrotRuntime.createWindowId();
    this.title = options.title || defaultView?.title || carrotRuntime.manifest?.name || "Carrot";
    this.url = normalizeViewUrl(options.url, defaultView?.relativePath);
    this.frame = {
      x: options.frame?.x ?? 120,
      y: options.frame?.y ?? 120,
      width: options.frame?.width ?? defaultView?.width ?? 1100,
      height: options.frame?.height ?? defaultView?.height ?? 760,
    };
    this.titleBarStyle = options.titleBarStyle ?? defaultView?.titleBarStyle ?? "default";
    this.transparent = options.transparent ?? defaultView?.transparent ?? false;
    this.passthrough = options.passthrough ?? false;
    this.hidden = options.hidden ?? (carrotRuntime.manifest?.mode === "background");

    RuntimeWindow.instances.set(this.id, this);
    carrotRuntime.sendAction("window-create", {
      windowId: this.id,
      options: {
        title: this.title,
        url: this.url,
        frame: this.frame,
        titleBarStyle: this.titleBarStyle,
        transparent: this.transparent,
        passthrough: this.passthrough,
        hidden: this.hidden,
      },
    });
  }

  static getById(id: string) {
    return RuntimeWindow.instances.get(id);
  }

  static getAll() {
    return Array.from(RuntimeWindow.instances.values());
  }

  static dispatch(name: string, payload: { windowId?: string } & Record<string, unknown>) {
    const windowId = String(payload?.windowId || "");
    if (!windowId) {
      return;
    }

    const instance = RuntimeWindow.instances.get(windowId);
    if (!instance) {
      return;
    }

    if (name === "window-move" || name === "window-resize") {
      instance.frame = {
        ...instance.frame,
        ...(typeof payload.x === "number" ? { x: payload.x } : {}),
        ...(typeof payload.y === "number" ? { y: payload.y } : {}),
        ...(typeof payload.width === "number" ? { width: payload.width } : {}),
        ...(typeof payload.height === "number" ? { height: payload.height } : {}),
      };
    }

    if (name === "window-closed") {
      RuntimeWindow.instances.delete(windowId);
    }

    instance.handlers.get(name)?.forEach((handler) => handler(payload));
  }

  on(
    name:
      | "focus"
      | "close"
      | "move"
      | "resize"
      | "window-focus"
      | "window-closed"
      | "window-move"
      | "window-resize",
    handler: (payload: unknown) => void,
  ) {
    const eventName =
      name === "focus"
        ? "window-focus"
        : name === "close"
          ? "window-closed"
          : name === "move"
            ? "window-move"
            : name === "resize"
              ? "window-resize"
              : name;
    const handlers = this.handlers.get(eventName) ?? new Set<(payload: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(eventName, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(eventName);
      }
    };
  }

  focus() {
    carrotRuntime.sendAction("focus-window", {
      windowId: this.id,
      title: this.title,
    });
  }

  show() {
    this.focus();
  }

  close() {
    carrotRuntime.sendAction("close-window", {
      windowId: this.id,
    });
  }

  setTitle(title: string) {
    this.title = title;
    carrotRuntime.sendAction("window-set-title", {
      windowId: this.id,
      title,
    });
  }

  setFrame(x: number, y: number, width: number, height: number) {
    this.frame = { x, y, width, height };
    carrotRuntime.sendAction("window-set-frame", {
      windowId: this.id,
      frame: this.frame,
    });
  }

  getFrame() {
    return { ...this.frame };
  }

  setAlwaysOnTop(alwaysOnTop: boolean) {
    carrotRuntime.sendAction("window-set-always-on-top", {
      windowId: this.id,
      alwaysOnTop,
    });
  }

  send(name: string, payload?: unknown, options?: { raw?: boolean }) {
    carrotRuntime.sendAction("emit-view", {
      name,
      payload,
      raw: options?.raw === true,
      windowId: this.id,
    });
  }
}

carrotRuntime.on("window-focus", (payload) => {
  RuntimeWindow.dispatch("window-focus", payload as { windowId?: string });
});

carrotRuntime.on("window-closed", (payload) => {
  RuntimeWindow.dispatch("window-closed", payload as { windowId?: string });
});

carrotRuntime.on("window-move", (payload) => {
  RuntimeWindow.dispatch("window-move", payload as { windowId?: string });
});

carrotRuntime.on("window-resize", (payload) => {
  RuntimeWindow.dispatch("window-resize", payload as { windowId?: string });
});

class RuntimeTray {
  title: string;
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  private static current: RuntimeTray | null = null;

  constructor(options: CarrotTrayOptions = {}) {
    this.title = options.title || carrotRuntime.manifest?.name || "Carrot";
    RuntimeTray.current = this;
    carrotRuntime.sendAction("set-tray", {
      title: this.title,
    });
  }

  static dispatch(payload: unknown) {
    RuntimeTray.current?.handlers.get("click")?.forEach((handler) => handler(payload));
  }

  on(name: "click", handler: (payload: unknown) => void) {
    const handlers = this.handlers.get(name) ?? new Set<(payload: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(name);
      }
    };
  }

  setTitle(title: string) {
    this.title = title;
    carrotRuntime.sendAction("set-tray", {
      title,
    });
  }

  setMenu(menu: CarrotMenuItem[]) {
    carrotRuntime.sendAction("set-tray-menu", menu);
  }

  remove() {
    if (RuntimeTray.current === this) {
      RuntimeTray.current = null;
    }
    carrotRuntime.sendAction("remove-tray");
  }
}

carrotRuntime.on("tray", (payload) => {
  RuntimeTray.dispatch(payload);
});

export class BrowserWindow extends RuntimeWindow {}
export class Tray extends RuntimeTray {}

export const Utils = {
  async openFileDialog(options: {
    startingFolder?: string;
    allowedFileTypes?: string;
    canChooseFiles?: boolean;
    canChooseDirectory?: boolean;
    allowsMultipleSelection?: boolean;
  }) {
    return carrotRuntime.requestHost<string[]>("open-file-dialog", options);
  },
  async openPath(path: string) {
    return carrotRuntime.requestHost("open-path", { path });
  },
  async showItemInFolder(path: string) {
    return carrotRuntime.requestHost("show-item-in-folder", { path });
  },
  async clipboardWriteText(text: string) {
    return carrotRuntime.requestHost("clipboard-write-text", { text });
  },
  showNotification(options: { title: string; body?: string }) {
    carrotRuntime.sendAction("notify", options);
  },
  quit() {
    carrotRuntime.sendAction("stop-carrot");
  },
};

export const Screen = {
  async getPrimaryDisplay() {
    return carrotRuntime.requestHost("screen-get-primary-display");
  },
  async getCursorScreenPoint() {
    return carrotRuntime.requestHost("screen-get-cursor-screen-point");
  },
};

export const ApplicationMenu = {
  setApplicationMenu(menu: CarrotApplicationMenuItem[]) {
    if (!Array.isArray(menu) || menu.length === 0) {
      carrotRuntime.sendAction("clear-application-menu");
      return;
    }
    carrotRuntime.sendAction("set-application-menu", {
      menu,
    });
  },
  on(name: "application-menu-clicked", handler: EventHandler) {
    return carrotRuntime.on(name, handler);
  },
};

export const ContextMenu = {
  showContextMenu(menu: CarrotContextMenuItem[]) {
    if (!Array.isArray(menu) || menu.length === 0) {
      return;
    }
    carrotRuntime.sendAction("show-context-menu", {
      menu,
    });
  },
  on(name: "context-menu-clicked", handler: EventHandler) {
    return carrotRuntime.on(name, handler);
  },
};

export const Updater = {
  checkForUpdate() {
    throw new Error("Updater is not implemented for carrots yet");
  },
  downloadUpdate() {
    throw new Error("Updater is not implemented for carrots yet");
  },
  applyUpdate() {
    throw new Error("Updater is not implemented for carrots yet");
  },
};

export const app = {
  on(name: string, handler: EventHandler) {
    return carrotRuntime.on(name, handler);
  },
  openManager() {
    carrotRuntime.sendAction("open-manager");
  },
  openBunnyWindow(payload?: { screenX?: number; screenY?: number }) {
    carrotRuntime.sendAction("open-bunny-window", payload);
  },
  quit() {
    Utils.quit();
  },
  get manifest() {
    return carrotRuntime.manifest;
  },
  get permissions() {
    return carrotRuntime.context?.permissions ?? [];
  },
  get grantedPermissions() {
    return carrotRuntime.context?.grantedPermissions ?? {};
  },
  get statePath() {
    return carrotRuntime.context?.statePath ?? "";
  },
  get logsPath() {
    return carrotRuntime.context?.logsPath ?? "";
  },
  async getWindowFrame(windowId?: string) {
    return carrotRuntime.requestHost<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>("window-get-frame", {
      windowId,
    });
  },
};

const Electrobun = {
  BrowserWindow,
  Tray,
  Utils,
  Screen,
  ApplicationMenu,
  ContextMenu,
  Updater,
  app,
};

export type WindowOptionsType = CarrotWindowOptions;
export type TrayOptions = CarrotTrayOptions;
export type MenuItemConfig = CarrotMenuItem;
export type ApplicationMenuItemConfig = CarrotApplicationMenuItem;
export type ContextMenuItemConfig = CarrotContextMenuItem;

export default Electrobun;
