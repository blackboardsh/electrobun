import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  ContextMenu as HostContextMenu,
  Screen,
  Tray,
  Utils,
  type RPCSchema,
  Updater,
} from "electrobun/bun";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  CarrotPermissionConsentRequest,
  CarrotPermissionGrant,
  CarrotPermissionTag,
  CarrotViewRPC,
  CarrotWorkerMessage,
} from "../carrot-runtime/types";
import {
  flattenCarrotPermissions,
  hasHostPermission,
} from "../carrot-runtime/types";
import {
  getInstalledCarrotsRoot,
  getInstalledCarrot,
  loadInstalledCarrots,
  prepareArtifactCarrotInstall,
  prepareDevCarrotInstallFromSource,
  pruneLegacyPrototypeCarrots,
  refreshTrackedDevCarrots,
  uninstallInstalledCarrot,
  type InstalledCarrot,
  type PreparedCarrotInstall,
} from "./carrotStore";
import {
  buildCarrotPermissionConsentRequest,
  requestCarrotUninstallConsent,
} from "./carrotConsent";
import { toBunWorkerPermissions } from "./workerPermissions";

const DEBUG_BUNNY_EARS_BOOT = process.env.BUNNY_EARS_BOOT_DEBUG === "1";

function bootLog(message: string, details?: unknown) {
  if (!DEBUG_BUNNY_EARS_BOOT) {
    return;
  }
  if (details === undefined) {
    console.log(`[bunny-ears:boot] ${message}`);
    return;
  }
  console.log(`[bunny-ears:boot] ${message}`, details);
}

type CarrotStatus = "stopped" | "starting" | "running";

type CarrotRemoteUIInfo = {
  id: string;
  name: string;
  path: string;
};

type CarrotInfo = {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: "window" | "background";
  permissions: CarrotPermissionTag[];
  status: CarrotStatus;
  installStatus: "installed" | "broken";
  devMode: boolean;
  sourceKind: "prototype" | "local" | "artifact";
  sourceLabel: string | null;
  lastBuildError: string | null;
  logTail: string[];
  // Remote UIs declared in the carrot manifest. Used by Farm to render
  // "Open in browser" links pointing through Hop. Empty array for background
  // carrots or carrots that don't expose remote UIs.
  remoteUIs: CarrotRemoteUIInfo[];
};

type DashboardState = {
  installRoot: string;
  carrots: CarrotInfo[];
  pendingConsent: CarrotPermissionConsentRequest | null;
};

type DashboardRPC = {
  bun: RPCSchema<{
    requests: {
      getDashboard: {
        params: {};
        response: DashboardState;
      };
      installCarrotSourceFromDisk: {
        params: {};
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      installCarrotArtifactFromDisk: {
        params: {};
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      reinstallCarrot: {
        params: { id: string };
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      respondToConsent: {
        params: { requestId: string; approved: boolean };
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      uninstallCarrot: {
        params: { id: string };
        response: { ok: boolean; error?: string; reason?: string };
      };
      revealCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
      launchCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
      stopCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
      openCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      dashboardChanged: DashboardState;
    };
  }>;
};

class CarrotInstance {
  carrot: InstalledCarrot;
  status: CarrotStatus = "stopped";
  logs: string[] = [];
  tray: Tray | null = null;
  applicationMenu: any[] | null = null;
  controllerWindows = new Map<string, BrowserWindow>();
  controllerWindow: BrowserWindow | null = null;
  webClients = new Map<string, { send: (data: string) => void }>();
  hopBrowserIds = new Set<string>();
  bunnyWindow: BrowserWindow | null = null;
  bunnyPollTimeout: ReturnType<typeof setTimeout> | null = null;
  worker: Worker | null = null;
  requestId = 1;
  pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(carrot: InstalledCarrot) {
    this.carrot = carrot;
  }

  get stateDir() {
    return this.carrot.stateDir;
  }

  get statePath() {
    return join(this.stateDir, "state.json");
  }

  get logsPath() {
    return join(this.stateDir, "logs.txt");
  }

  get summary(): CarrotInfo {
    const sourceLabel =
      this.carrot.install.source.kind === "local"
        ? this.carrot.install.source.path
        : this.carrot.install.source.kind === "artifact"
          ? this.carrot.install.source.location
          : this.carrot.install.source.prototypeId;

    const manifestRemoteUIs = this.carrot.manifest.remoteUIs || {};
    const remoteUIs: CarrotRemoteUIInfo[] = Object.entries(manifestRemoteUIs).map(
      ([id, ui]) => ({ id, name: ui.name, path: ui.path }),
    );

    return {
      id: this.carrot.manifest.id,
      name: this.carrot.manifest.name,
      description: this.carrot.manifest.description,
      version: this.carrot.manifest.version,
      mode: this.carrot.manifest.mode,
      permissions: flattenCarrotPermissions(this.carrot.install.permissionsGranted),
      status: this.status,
      installStatus: this.carrot.install.status,
      devMode: this.carrot.install.devMode === true,
      sourceKind: this.carrot.install.source.kind,
      sourceLabel,
      lastBuildError: this.carrot.install.lastBuildError ?? null,
      logTail: this.logs.slice(-4),
      remoteUIs,
    };
  }

  activateApplicationMenu() {
    (runtime as any).activateCarrotApplicationMenu(this);
  }

  restoreApplicationMenuIfActive() {
    (runtime as any).restoreApplicationMenuIfOwner(this);
  }

  sendApplicationMenuClicked(payload: unknown) {
    this.sendEvent("application-menu-clicked", payload);
  }

  sendContextMenuClicked(payload: unknown) {
    this.sendEvent("context-menu-clicked", payload);
  }

  private syncPrimaryControllerWindow() {
    this.controllerWindow = this.controllerWindows.values().next().value ?? null;
  }

  private setControllerWindow(windowId: string, win: BrowserWindow) {
    this.controllerWindows.set(windowId, win);
    this.syncPrimaryControllerWindow();
  }

  private removeControllerWindow(windowId: string, win?: BrowserWindow) {
    const existing = this.controllerWindows.get(windowId);
    if (!existing) {
      return;
    }
    if (win && existing !== win) {
      return;
    }
    this.controllerWindows.delete(windowId);
    this.syncPrimaryControllerWindow();
  }

  private getPrimaryControllerWindowId() {
    return this.controllerWindows.keys().next().value ?? "main";
  }

  async start() {
    if (this.status === "running" || this.status === "starting") {
      if (this.carrot.manifest.mode === "window") {
        this.openWindow().catch(() => {});
      }
      return;
    }

    mkdirSync(this.stateDir, { recursive: true });
    this.status = "starting";
    bootLog("carrot starting", {
      id: this.carrot.manifest.id,
      mode: this.carrot.manifest.mode,
      workerPath: this.carrot.workerPath,
      permissions: flattenCarrotPermissions(this.carrot.install.permissionsGranted),
    });
    runtime.notifyDashboardChanged();

    if (
      this.carrot.manifest.mode === "window" &&
      !hasHostPermission(this.carrot.install.permissionsGranted, "windows")
    ) {
      throw new Error(`${this.carrot.manifest.name} is missing the host.windows permission`);
    }

    bootLog("creating carrot worker", { id: this.carrot.manifest.id });
    this.worker = new Worker(this.carrot.workerPath, {
      type: "module",
      permissions: toBunWorkerPermissions(this.carrot.install.permissionsGranted),
    });
    this.worker.onmessage = (event: MessageEvent<CarrotWorkerMessage>) => {
      void this.handleWorkerMessage(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.pushLog(`worker error: ${event.message}`);
      bootLog("carrot worker error", {
        id: this.carrot.manifest.id,
        message: event.message,
      });
      void this.stop();
    };

    // Send init context to the worker so it has statePath, permissions, etc.
    const channel = await Updater.localInfo.channel().catch(() => "dev");
    this.worker!.postMessage({
      type: "init",
      manifest: this.carrot.manifest,
      context: {
        statePath: this.statePath,
        logsPath: this.logsPath,
        permissions: flattenCarrotPermissions(this.carrot.install.permissionsGranted),
        grantedPermissions: this.carrot.install.permissionsGranted,
        authToken: runtime.authToken || null,
        channel: channel || "dev",
      },
    });

    this.status = "running";
    bootLog("carrot running", { id: this.carrot.manifest.id });
    runtime.notifyDashboardChanged();

  }

  async stop() {
    if (this.status === "stopped") return;

    this.status = "stopped";

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    for (const [, pending] of this.pending) {
      pending.reject(new Error(`${this.carrot.manifest.name} stopped`));
    }
    this.pending.clear();

    if (this.tray) {
      this.tray.remove();
      this.tray = null;
    }

    for (const [windowId, win] of this.controllerWindows) {
      this.removeControllerWindow(windowId, win);
      try {
        win.close();
      } catch {
        // Best effort; window may already be gone.
      }
    }

    this.closeBunnyWindow();
    this.restoreApplicationMenuIfActive();

    this.pushLog("carrot stopped");
    runtime.notifyDashboardChanged();
  }

  async openWindow(windowId = this.getPrimaryControllerWindowId(), options?: { title?: string }) {
    if (!hasHostPermission(this.carrot.install.permissionsGranted, "windows")) {
      return;
    }

    if (this.status !== "running") {
      await this.start();
    }

    const existing = this.controllerWindows.get(windowId);
    if (existing) {
      existing.focus();
      return;
    }

    bootLog("opening carrot window", {
      id: this.carrot.manifest.id,
      windowId,
    });
    this.createControllerWindow(windowId, {
      hidden: false,
      title: options?.title,
    });
    this.controllerWindows.get(windowId)?.focus();
  }

  async closeWindow(windowId = this.getPrimaryControllerWindowId()) {
    const win = this.controllerWindows.get(windowId);
    if (!win) {
      return;
    }
    this.removeControllerWindow(windowId, win);
    try {
      win.close();
    } catch {
      // Window may already be gone.
    }
  }

  async invoke(method: string, params?: unknown, windowId?: string) {
    if (!this.worker) {
      throw new Error(`${this.carrot.manifest.name} is not running`);
    }

    const requestId = this.requestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    this.worker.postMessage({
      type: "request",
      requestId,
      method,
      params,
      windowId,
    } satisfies CarrotWorkerMessage);

    return promise;
  }

  sendEvent(name: string, payload?: unknown) {
    this.worker?.postMessage({
      type: "event",
      name,
      payload,
    } satisfies CarrotWorkerMessage);
  }

  pushLog(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.push(`${timestamp} ${message}`);
    if (this.logs.length > 24) {
      this.logs.splice(0, this.logs.length - 24);
    }
    console.log(`[carrot:${this.carrot.manifest.id}] ${message}`);
    runtime.notifyDashboardChanged();
  }

  private createControllerWindow(
    windowId = "main",
    options?: {
      hidden?: boolean;
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
    },
  ) {
    const existing = this.controllerWindows.get(windowId);
    if (existing) {
      return existing;
    }

    const rpc = BrowserView.defineRPC<CarrotViewRPC>({
      maxRequestTime: 10000,
      handlers: {
        requests: {
          invoke: async ({ method, params }) => this.invoke(method, params, windowId),
          _: async (method, params) => this.invoke(String(method), params, windowId),
        },
        messages: {
          "*": (messageName, payload) => {
            this.invoke(`send:${String(messageName)}`, payload, windowId).catch((error) => {
              this.pushLog(
                `view message failed: ${String(messageName)} ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          },
        },
      },
    });

    const hidden =
      options?.hidden ??
      (this.carrot.manifest.mode === "background" ||
        this.carrot.manifest.view.hidden === true);
    const frame = {
      width: options?.frame?.width ?? this.carrot.manifest.view.width,
      height: options?.frame?.height ?? this.carrot.manifest.view.height,
      x: options?.frame?.x ?? 120,
      y: options?.frame?.y ?? 120,
    };
    const url =
      typeof options?.url === "string" && options.url.length > 0
        ? options.url
        : this.carrot.viewUrl;

    const win = new BrowserWindow({
      title: options?.title || this.carrot.manifest.view.title,
      url,
      viewsRoot: this.carrot.currentDir,
      rpc,
      titleBarStyle: options?.titleBarStyle ?? this.carrot.manifest.view.titleBarStyle ?? "default",
      transparent: options?.transparent ?? this.carrot.manifest.view.transparent ?? false,
      passthrough: options?.passthrough ?? false,
      hidden,
      frame,
    });

    this.setControllerWindow(windowId, win);
    bootLog("controller window created", {
      id: this.carrot.manifest.id,
      windowId,
      hidden,
      url: this.carrot.viewUrl,
    });

    win.webview.on("dom-ready", () => {
      bootLog("controller dom-ready", { id: this.carrot.manifest.id });
      (win.webview.rpc as any)?.send?.carrotBoot({
        id: this.carrot.manifest.id,
        name: this.carrot.manifest.name,
        permissions: flattenCarrotPermissions(this.carrot.install.permissionsGranted),
        grantedPermissions: this.carrot.install.permissionsGranted,
        mode: this.carrot.manifest.mode,
      });
    });

    win.on("focus", () => {
      this.activateApplicationMenu();
      this.sendEvent("window-focus", { windowId });
    });

    win.on("move", (event: any) => {
      this.sendEvent("window-move", {
        windowId,
        x: event?.data?.x,
        y: event?.data?.y,
      });
    });

    win.on("resize", (event: any) => {
      this.sendEvent("window-resize", {
        windowId,
        x: event?.data?.x,
        y: event?.data?.y,
        width: event?.data?.width,
        height: event?.data?.height,
      });
    });

    win.on("close", () => {
      this.removeControllerWindow(windowId, win);
      this.restoreApplicationMenuIfActive();
      this.sendEvent("window-closed", { windowId });
      if (this.status === "running" && this.carrot.manifest.mode === "window") {
        if (this.controllerWindows.size === 0) {
          void this.stop();
        }
      }
    });

    return win;
  }

  private async handleWorkerMessage(message: CarrotWorkerMessage) {
    switch (message.type) {
      case "ready": {
        this.pushLog("worker ready");
        // Tell connected web clients to re-fetch state from the (new) worker.
        // This handles the case where the carrot was restarted while web
        // clients were still connected — their windowId is stale and they
        // need to call getInitialState again to pick up the new runtime window.
        for (const client of this.webClients.values()) {
          try {
            client.send(JSON.stringify({
              type: "message",
              name: "refreshBunnyDashState",
              payload: {},
            }));
          } catch {}
        }
        break;
      }
      case "response": {
        const pending = this.pending.get(message.requestId);
        if (!pending) break;
        this.pending.delete(message.requestId);
        if (message.success) {
          pending.resolve(message.payload);
        } else {
          pending.reject(new Error(message.error || "Unknown worker error"));
        }
        break;
      }
      case "action": {
        await this.handleHostAction(message.action, message.payload);
        break;
      }
      case "host-request": {
        const response = await this.handleHostRequest(message.method, message.params)
          .then((payload) => ({
            type: "host-response" as const,
            requestId: message.requestId,
            success: true,
            payload,
          }))
          .catch((error: unknown) => ({
            type: "host-response" as const,
            requestId: message.requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        this.worker?.postMessage(response);
        break;
      }
      default:
        break;
    }
  }

  private async handleHostRequest(method: string, params: unknown) {
    switch (method) {
      case "open-file-dialog": {
        const options = (params || {}) as {
          startingFolder?: string;
          allowedFileTypes?: string;
          canChooseFiles?: boolean;
          canChooseDirectory?: boolean;
          allowsMultipleSelection?: boolean;
        };
        return Utils.openFileDialog({
          startingFolder: options.startingFolder,
          allowedFileTypes: options.allowedFileTypes,
          canChooseFiles: options.canChooseFiles,
          canChooseDirectory: options.canChooseDirectory,
          allowsMultipleSelection: options.allowsMultipleSelection,
        });
      }
      case "open-path": {
        return Utils.openPath(String((params as { path?: string } | undefined)?.path || ""));
      }
      case "show-item-in-folder": {
        Utils.showItemInFolder(String((params as { path?: string } | undefined)?.path || ""));
        return true;
      }
      case "clipboard-write-text": {
        Utils.clipboardWriteText(String((params as { text?: string } | undefined)?.text || ""));
        return true;
      }
      case "window-get-frame": {
        const requestedWindowId = String((params as { windowId?: string } | undefined)?.windowId || "");
        const targetWindowId = requestedWindowId || this.getPrimaryControllerWindowId();
        const win = this.controllerWindows.get(targetWindowId);
        if (!win) {
          return null;
        }
        return win.getFrame();
      }
      case "invoke-carrot": {
        const invokePayload =
          params && typeof params === "object"
            ? (params as {
                carrotId?: string;
                method?: string;
                params?: unknown;
                windowId?: string;
              })
            : {};
        return (runtime as any).invokeCarrotFrom(
          this.carrot.manifest.id,
          String(invokePayload.carrotId || ""),
          String(invokePayload.method || ""),
          invokePayload.params,
          typeof invokePayload.windowId === "string" ? invokePayload.windowId : undefined,
        );
      }
      case "screen-get-primary-display": {
        return Screen.getPrimaryDisplay();
      }
      case "screen-get-cursor-screen-point": {
        return Screen.getCursorScreenPoint();
      }
      case "update-carrots": {
        void (runtime as any).handleTrayAction("update-carrots");
        return { ok: true };
      }
      case "get-auth-token": {
        return { token: runtime.authToken || null };
      }
      case "set-auth-token": {
        const token = String((params as any)?.token || "");
        if (token) {
          (runtime as any).saveAuthToken(token);
          // Notify all running carrots about the new token
          for (const carrot of runtime.carrots.values()) {
            if (carrot.status === "running") {
              carrot.sendEvent("auth-token-changed", { token });
            }
          }
        }
        return { ok: true };
      }
      case "list-carrots": {
        return runtime.summaries();
      }
      case "start-carrot": {
        const id = String((params as any)?.id || "");
        const carrot = runtime.carrots.get(id);
        if (!carrot) throw new Error(`Carrot not found: ${id}`);
        await carrot.start();
        if (carrot.carrot.manifest.mode === "background") {
          carrot.sendEvent("boot");
        }
        return { ok: true };
      }
      case "stop-carrot": {
        const id = String((params as any)?.id || "");
        const carrot = runtime.carrots.get(id);
        if (!carrot) throw new Error(`Carrot not found: ${id}`);
        await carrot.stop();
        return { ok: true };
      }
      default:
        throw new Error(`Unknown host request: ${method}`);
    }
  }

  private async handleHostAction(action: string, payload: unknown) {
    switch (action) {
      case "notify": {
        if (!hasHostPermission(this.carrot.install.permissionsGranted, "notifications")) {
          this.pushLog("notification denied by permissions");
          return;
        }
        const notification = payload as { title: string; body?: string };
        Utils.showNotification({ title: notification.title, body: notification.body });
        this.pushLog(`notification: ${notification.title}`);
        break;
      }
      case "set-tray": {
        if (!hasHostPermission(this.carrot.install.permissionsGranted, "tray")) {
          this.pushLog("tray denied by permissions");
          return;
        }
        if (this.carrot.manifest.id === "bunny-dash") {
          // Dash uses the runtime tray — don't create a separate one.
          // Tray click events are forwarded from the runtime tray.
          break;
        }
        const trayPayload = payload as { title?: string };
        if (!this.tray) {
          this.tray = new Tray({ title: trayPayload.title || this.carrot.manifest.name });
          this.tray.on("tray-clicked", (event: any) => {
            const actionName = event.data?.action || "click";
            this.sendEvent("tray", { action: actionName, raw: event.data });
          });
        }
        if (trayPayload.title) {
          this.tray.setTitle(trayPayload.title);
        }
        break;
      }
      case "set-tray-menu": {
        if (!hasHostPermission(this.carrot.install.permissionsGranted, "tray")) {
          return;
        }
        if (this.carrot.manifest.id === "bunny-dash") {
          // Dash carrot extends the runtime tray instead of owning its own
          runtime.dashTrayExtension = (payload as any[]) || [];
          runtime.tray?.setMenu(runtime.buildTrayMenu());
        } else if (this.tray) {
          this.tray.setMenu(payload as any);
        }
        break;
      }
      case "window-create": {
        const createPayload =
          payload && typeof payload === "object"
            ? (payload as {
                windowId?: string;
                options?: {
                  hidden?: boolean;
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
                };
              })
            : {};
        const windowId = createPayload.windowId || this.getPrimaryControllerWindowId();
        this.createControllerWindow(windowId, createPayload.options);
        break;
      }
      case "window-set-title": {
        const titlePayload =
          payload && typeof payload === "object"
            ? (payload as { windowId?: string; title?: string })
            : {};
        const win = this.controllerWindows.get(titlePayload.windowId || this.getPrimaryControllerWindowId());
        if (win && typeof titlePayload.title === "string") {
          win.setTitle(titlePayload.title);
        }
        break;
      }
      case "window-set-frame": {
        const framePayload =
          payload && typeof payload === "object"
            ? (payload as {
                windowId?: string;
                frame?: {
                  x?: number;
                  y?: number;
                  width?: number;
                  height?: number;
                };
              })
            : {};
        const win = this.controllerWindows.get(framePayload.windowId || this.getPrimaryControllerWindowId());
        const frame = framePayload.frame;
        if (win && frame) {
          const nextFrame = {
            x: frame.x ?? win.frame.x,
            y: frame.y ?? win.frame.y,
            width: frame.width ?? win.frame.width,
            height: frame.height ?? win.frame.height,
          };
          win.setFrame(nextFrame.x, nextFrame.y, nextFrame.width, nextFrame.height);
        }
        break;
      }
      case "window-set-always-on-top": {
        const alwaysOnTopPayload =
          payload && typeof payload === "object"
            ? (payload as { windowId?: string; alwaysOnTop?: boolean })
            : {};
        const win = this.controllerWindows.get(
          alwaysOnTopPayload.windowId || this.getPrimaryControllerWindowId(),
        );
        if (win) {
          win.setAlwaysOnTop(Boolean(alwaysOnTopPayload.alwaysOnTop));
        }
        break;
      }
      case "show-context-menu": {
        const menuPayload =
          payload && typeof payload === "object"
            ? (payload as { menu?: any[] })
            : {};
        if (Array.isArray(menuPayload.menu) && menuPayload.menu.length > 0) {
          (runtime as any).activeContextMenuOwnerId = this.carrot.manifest.id;
          HostContextMenu.showContextMenu(menuPayload.menu);
        }
        break;
      }
      case "set-application-menu": {
        const menuPayload =
          payload && typeof payload === "object"
            ? (payload as { menu?: any[] })
            : {};
        this.applicationMenu = Array.isArray(menuPayload.menu) ? menuPayload.menu : null;
        if ((runtime as any).activeApplicationMenuOwnerId === this.carrot.manifest.id) {
          this.activateApplicationMenu();
        }
        break;
      }
      case "clear-application-menu": {
        this.applicationMenu = null;
        this.restoreApplicationMenuIfActive();
        break;
      }
      case "focus-window": {
        const focusPayload =
          payload && typeof payload === "object"
            ? (payload as { windowId?: string; title?: string })
            : {};
        await this.openWindow(focusPayload.windowId, { title: focusPayload.title });
        break;
      }
      case "close-window": {
        const closePayload =
          payload && typeof payload === "object"
            ? (payload as { windowId?: string })
            : {};
        await this.closeWindow(closePayload.windowId);
        break;
      }
      case "open-bunny-window": {
        await this.toggleBunnyWindow(payload as { screenX?: number; screenY?: number } | undefined);
        break;
      }
      case "open-manager":
      case "open-farm": {
        void (runtime as any).handleTrayAction("open-farm");
        break;
      }
      case "remove-tray": {
        this.tray?.remove();
        this.tray = null;
        break;
      }
      case "stop-carrot": {
        this.pushLog("stop requested by carrot");
        await this.stop();
        break;
      }
      case "emit-view": {
        const eventPayload = payload as {
          name: string;
          payload?: unknown;
          raw?: boolean;
          windowId?: string;
        };
        const targets = eventPayload.windowId
          ? [this.controllerWindows.get(eventPayload.windowId)].filter(Boolean)
          : Array.from(this.controllerWindows.values());
        if (eventPayload.raw) {
          for (const target of targets) {
            (target?.webview.rpc as any)?.send?.[eventPayload.name]?.(eventPayload.payload);
          }
        } else {
          for (const target of targets) {
            (target?.webview.rpc as any)?.send?.runtimeEvent(eventPayload);
          }
        }
        // Also forward to all WebSocket clients — web clients mirror the
        // primary window so they receive all view messages.
        for (const client of this.webClients.values()) {
          try {
            client.send(JSON.stringify({
              type: "message",
              name: eventPayload.name,
              payload: eventPayload.payload,
            }));
          } catch {}
        }

        // Forward to Hop remote browsers (using electrobun RPC message format)
        if (runtime.hopWs && this.hopBrowserIds.size > 0) {
          for (const browserId of this.hopBrowserIds) {
            runtime.hopWs.send(JSON.stringify({
              browserId,
              payload: {
                type: "message",
                id: eventPayload.name,
                payload: eventPayload.payload,
              },
            }));
          }
        }
        break;
      }
      case "emit-carrot-event": {
        const eventPayload =
          payload && typeof payload === "object"
            ? (payload as {
                carrotId?: string;
                name?: string;
                payload?: unknown;
              })
            : {};
        (runtime as any).emitCarrotEventFrom(
          this.carrot.manifest.id,
          String(eventPayload.carrotId || ""),
          String(eventPayload.name || ""),
          eventPayload.payload,
        );
        break;
      }
      case "log": {
        const logPayload = payload as { message: string };
        this.pushLog(logPayload.message);
        break;
      }
      default:
        break;
    }
  }

  private closeBunnyWindow() {
    if (this.bunnyPollTimeout) {
      clearTimeout(this.bunnyPollTimeout);
      this.bunnyPollTimeout = null;
    }

    if (this.bunnyWindow) {
      const win = this.bunnyWindow;
      this.bunnyWindow = null;
      try {
        win.close();
      } catch {}
    }
  }

  private async toggleBunnyWindow(payload?: { screenX?: number; screenY?: number }) {
    if (this.bunnyWindow) {
      this.closeBunnyWindow();
      return;
    }

    const size = 80 + Math.floor(Math.random() * 90);
    const halfSize = Math.floor(size / 2);
    const display = Screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const x =
      typeof payload?.screenX === "number"
        ? payload.screenX - halfSize
        : workArea.x + Math.floor(Math.random() * Math.max(1, workArea.width - size));
    const y =
      typeof payload?.screenY === "number"
        ? payload.screenY - halfSize
        : workArea.y + Math.floor(Math.random() * Math.max(1, workArea.height - size));

    const bunnyRpc = BrowserView.defineRPC<any>({
      maxRequestTime: 5000,
      handlers: {
        requests: {},
        messages: {
          bunnyClicked: () => {
            this.closeBunnyWindow();
          },
        },
      },
    });

    const win = new BrowserWindow({
      title: `${this.carrot.manifest.name} Bunny`,
      url: "views://bunny/index.html",
      viewsRoot: this.carrot.currentDir,
      rpc: bunnyRpc,
      titleBarStyle: "hidden",
      transparent: true,
      passthrough: false,
      frame: { width: size, height: size, x, y },
    });

    win.setAlwaysOnTop(true);
    this.bunnyWindow = win;

    const sendCursor = () => {
      if (!this.bunnyWindow) {
        return;
      }
      const cursor = Screen.getCursorScreenPoint();
      const frame = this.bunnyWindow.getFrame();
      (this.bunnyWindow.webview.rpc as any)?.send?.cursorMove({
        screenX: cursor.x,
        screenY: cursor.y,
        winX: frame.x,
        winY: frame.y,
        winW: frame.width,
        winH: frame.height,
      });
    };

    const pollCursor = () => {
      this.bunnyPollTimeout = null;
      if (!this.bunnyWindow) {
        return;
      }
      try {
        sendCursor();
      } catch {}
      this.bunnyPollTimeout = setTimeout(pollCursor, 100);
    };

    win.webview.on("dom-ready", () => {
      try {
        sendCursor();
      } catch {}
      if (!this.bunnyPollTimeout) {
        this.bunnyPollTimeout = setTimeout(pollCursor, 100);
      }
    });

    win.on("close", () => {
      if (this.bunnyWindow === win) {
        this.closeBunnyWindow();
      }
    });
  }
}

class BunnyEarsRuntime {
  tray: Tray | null;
  dashTrayExtension: any[] = [];
  managerWindow: BrowserWindow | null = null;
  hopWs: WebSocket | null = null;
  channel: string = "dev";
  carrots = new Map<string, CarrotInstance>();
  activeApplicationMenuOwnerId: string | null = null;
  activeContextMenuOwnerId: string | null = null;
  updateStatus: "idle" | "checking" | "downloading" | "update-ready" | "error" = "idle";
  pendingConsent: {
    request: CarrotPermissionConsentRequest;
    prepared: PreparedCarrotInstall;
    grantedPermissions: CarrotPermissionGrant;
    options: { preserveRunningState?: boolean };
  } | null = null;
  nextConsentRequestId = 1;

  constructor() {
    for (const carrot of loadInstalledCarrots()) {
      this.carrots.set(carrot.manifest.id, new CarrotInstance(carrot));
    }

    // Bunny Ears owns the system tray. The dash carrot extends it with
    // workspaces/lenses/carrots via the set-tray-menu action.
    this.tray = new Tray({ title: "Electrobunny" });
    this.tray.setMenu(this.buildTrayMenu());
    this.tray.on("tray-clicked", (event: any) => {
      const action = event.data?.action;
      if (!action) return;
      void this.handleTrayAction(action);
    });

    ApplicationMenu.on("application-menu-clicked", (event: any) => {
      const action = event?.data?.action;
      if (!this.activeApplicationMenuOwnerId) {
        return;
      }

      if (action === "quit") {
        process.exit(0);
        return;
      }

      const carrot = this.carrots.get(this.activeApplicationMenuOwnerId);
      if (!carrot) {
        return;
      }
      carrot.sendApplicationMenuClicked(event?.data ?? event);
    });

    HostContextMenu.on("context-menu-clicked", (event: any) => {
      const ownerId = this.activeContextMenuOwnerId;
      this.activeContextMenuOwnerId = null;
      if (!ownerId) {
        return;
      }

      const carrot = this.carrots.get(ownerId);
      if (!carrot) {
        return;
      }
      carrot.sendContextMenuClicked(event?.data ?? event);
    });

    this.restoreDefaultApplicationMenu();
  }

  authToken: string | null = null;
  // Long-lived device token — used to authenticate to Hop and mint access tokens.
  deviceToken: string | null = null;
  // ID of the device token (from the API) — used for server-side revocation.
  deviceTokenId: string | null = null;
  // ID of this instance in the API (assigned at registration time) — used to
  // mark the instance offline on logout.
  instanceId: string | null = null;
  farmWindow: BrowserWindow | null = null;

  async boot() {
    this.channel = await Updater.localInfo.channel().catch(() => "dev");
    bootLog("runtime boot begin", {
      channel: this.channel,
      installRoot: getInstalledCarrotsRoot(),
      carrotIds: Array.from(this.carrots.keys()),
    });

    // Start all background carrots — always, regardless of auth
    for (const carrot of this.carrots.values()) {
      if (carrot.carrot.manifest.mode === "background") {
        bootLog("booting background carrot", {
          id: carrot.carrot.manifest.id,
        });
        await carrot.start();
        carrot.sendEvent("boot");
        bootLog("background carrot boot event sent", {
          id: carrot.carrot.manifest.id,
        });
      }
    }

    this.startWebBridge();

    // Auto-open dash for development
    this.handleTrayAction("open-dash").catch((err) => {
      console.error("[bunny-ears] auto-open dash failed:", err);
    });

    // Auth + instance registration — non-blocking, doesn't gate carrots
    this.loadAuthToken();
    this.loadDeviceToken();

    // If we have a device token, refresh the access token immediately
    if (this.deviceToken) {
      this.refreshAccessTokenFromDevice().catch(() => {});
      // Refresh access token every 10 minutes (access tokens live 15 min)
      setInterval(() => {
        this.refreshAccessTokenFromDevice().catch(() => {});
      }, 10 * 60 * 1000);
    }

    if (this.authToken) {
      // Register instance and start heartbeat in the background
      this.registerInstanceWithToken(this.authToken).catch(() => {});
      setInterval(() => {
        if (this.authToken) {
          this.registerInstanceWithToken(this.authToken).catch(() => {});
        }
      }, 60_000);
    } else if (!this.deviceToken) {
      // No auth and no device token — open Farm for login (non-blocking)
      this.openFarmForLogin().catch(() => {});
    }

    // Check for updates on boot and every hour
    this.checkForUpdates();
    setInterval(() => this.checkForUpdates(), 60 * 60 * 1000);

    // Connect to Hop for remote access (uses device token)
    if (this.deviceToken) {
      this.connectToHop();
    }

    // Wake detection: when ears runs inside a VM that gets frozen (common with
    // cloud/local VMs when not active), setInterval timers pause. When the VM
    // resumes, we detect the resulting large clock gap and force a full
    // re-sync: refresh the access token, re-register the instance, and
    // reconnect to Hop (its WebSocket is almost certainly stale).
    this.startWakeDetector();

    // Periodic Hop keepalive: detect silently-dead WebSockets that didn't
    // fire a close event (can happen with network/sleep transitions).
    this.startHopKeepalive();

    bootLog("runtime boot complete");
  }

  private lastWakeCheckAt = Date.now();
  private startWakeDetector() {
    // Fire every 30 seconds. If >2 minutes elapsed since the last tick, the
    // process was likely suspended (VM freeze, laptop sleep, etc.) — treat it
    // as a wake event.
    const INTERVAL_MS = 30_000;
    const WAKE_THRESHOLD_MS = 2 * 60_000;
    setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastWakeCheckAt;
      this.lastWakeCheckAt = now;
      if (gap > WAKE_THRESHOLD_MS) {
        console.log(`[bunny-ears] wake detected (gap=${Math.round(gap / 1000)}s) — resyncing`);
        this.handleWake().catch(() => {});
      }
    }, INTERVAL_MS);
  }

  // Called when we detect the process was suspended and has resumed.
  // Re-authenticates with the API and re-establishes all long-lived
  // connections so the user doesn't need to manually intervene.
  private async handleWake() {
    // 1. Refresh the access token from the device token. If the refresh
    //    succeeds, the new token is automatically saved and broadcast to
    //    running carrots via auth-token-changed.
    if (this.deviceToken) {
      await this.refreshAccessTokenFromDevice().catch(() => {});
    }

    // 2. Re-register the instance so it shows online in Farm again.
    if (this.authToken) {
      this.registerInstanceWithToken(this.authToken).catch(() => {});
    }

    // 3. Force-reconnect the Hop WebSocket. The old socket is very likely
    //    stale (TCP timeout during the freeze) but may not have fired close.
    try { this.hopWs?.close(); } catch {}
    this.hopWs = null;
    if (this.deviceToken) {
      this.connectToHop();
    }
  }

  private startHopKeepalive() {
    // Every 60 seconds, send a lightweight ping message through the Hop
    // WebSocket. Hop's DO silently drops unknown messages so this is safe.
    // If `.send()` throws or the socket isn't open, close + let the existing
    // reconnect logic handle it.
    setInterval(() => {
      const ws = this.hopWs;
      if (!ws) return;
      if (ws.readyState !== 1 /* OPEN */) {
        try { ws.close(); } catch {}
        this.hopWs = null;
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "hop:keepalive", ts: Date.now() }));
      } catch {
        try { ws.close(); } catch {}
        this.hopWs = null;
      }
    }, 60_000);
  }

  private async checkForUpdates() {
    if (this.updateStatus === "checking" || this.updateStatus === "downloading") return;

    try {
      this.updateStatus = "checking";
      const updateInfo = await Updater.checkForUpdate();

      if (updateInfo.error) {
        console.log(`[bunny-ears] Update check error: ${updateInfo.error}`);
        this.updateStatus = "error";
        return;
      }

      if (updateInfo.updateAvailable) {
        console.log(`[bunny-ears] Update available: ${updateInfo.version}`);
        this.updateStatus = "downloading";
        this.tray?.setMenu(this.buildTrayMenu());

        await Updater.downloadUpdate();

        if (Updater.updateInfo().updateReady) {
          console.log("[bunny-ears] Update ready to install");
          this.updateStatus = "update-ready";
          this.tray?.setMenu(this.buildTrayMenu());

          // Show system notification
          Utils.showNotification({
            title: "Bunny Ears Update Available",
            body: `Version ${updateInfo.version} is ready. Restart to update.`,
          });
        } else {
          this.updateStatus = "error";
        }
      } else {
        this.updateStatus = "idle";
      }
    } catch (err) {
      console.log(`[bunny-ears] Update check failed: ${err instanceof Error ? err.message : err}`);
      this.updateStatus = "idle";
    }

    this.tray?.setMenu(this.buildTrayMenu());
  }

  private connectToHop() {
    const hopBaseUrl = this.channel === "stable"
      ? "wss://hop.electrobunny.ai"
      : this.channel === "dev"
        ? "ws://localhost:8788"
        : "wss://staging-hop.electrobunny.ai";

    const machineId = this.getMachineId();
    if (!machineId || !this.deviceToken) {
      console.log("[hop] Skipping Hop connection (no machine ID or device token)");
      return;
    }

    const url = `${hopBaseUrl}/connect?instanceId=${encodeURIComponent(machineId)}&deviceToken=${encodeURIComponent(this.deviceToken)}`;
    console.log(`[hop] Connecting to Hop at ${hopBaseUrl}...`);

    try {
      const ws = new WebSocket(url);

      ws.addEventListener("open", () => {
        console.log("[hop] Connected to Hop");
        this.hopWs = ws;
      });

      ws.addEventListener("message", (event) => {
        this.handleHopMessage(event.data as string);
      });

      ws.addEventListener("close", (event) => {
        console.log(`[hop] Disconnected from Hop: ${event.code} ${event.reason}`);
        this.hopWs = null;
        // Reconnect after 10 seconds
        setTimeout(() => {
          if (this.deviceToken) this.connectToHop();
        }, 10_000);
      });

      ws.addEventListener("error", (event) => {
        console.error("[hop] Connection error");
      });
    } catch (err) {
      console.error("[hop] Failed to connect:", err instanceof Error ? err.message : err);
      // Retry after 10 seconds
      setTimeout(() => {
        if (this.authToken) this.connectToHop();
      }, 10_000);
    }
  }

  private handleHopMessage(data: string) {
    try {
      const message = JSON.parse(data);

      if (message.type === "hop:browser-connected") {
        console.log(`[hop] Browser connected: ${message.browserId} for ${message.carrotId}`);
        const carrot = this.carrots.get(message.carrotId);
        if (carrot) {
          carrot.hopBrowserIds.add(message.browserId);
        }
        return;
      }

      if (message.type === "hop:browser-disconnected") {
        console.log(`[hop] Browser disconnected: ${message.browserId}`);
        // Remove from all carrots
        for (const carrot of this.carrots.values()) {
          carrot.hopBrowserIds.delete(message.browserId);
        }
        return;
      }

      if (message.type === "hop:file-request") {
        this.handleHopFileRequest(message);
        return;
      }

      if (message.type === "hop:message") {
        const { browserId, carrotId, payload } = message;

        // Handle RPC messages (fire-and-forget from view → bun)
        if (payload?.type === "message") {
          const messageName = payload.id;
          const messagePayload = payload.payload;
          const carrot = this.carrots.get(carrotId);
          if (carrot && carrot.status === "running") {
            // Forward as an event to the carrot worker
            carrot.worker?.postMessage({
              type: "request",
              requestId: 0, // fire-and-forget, no response expected
              method: `send:${messageName}`,
              params: messagePayload,
            });
          }
          return;
        }

        // Handle RPC requests (view → bun, expects response)
        const method = payload?.method;
        const params = payload?.params;
        const requestId = payload?.id;

        if (!method || requestId === undefined) return;

        // Handle runtime-level requests (carrotId = "bunny-ears" or no carrot found)
        if (carrotId === "bunny-ears" || !this.carrots.has(carrotId)) {
          this.handleHopRuntimeRequest(browserId, requestId, method, params);
          return;
        }

        // Route to a specific carrot
        const carrot = this.carrots.get(carrotId)!;
        if (carrot.status !== "running") {
          this.hopWs?.send(JSON.stringify({
            browserId,
            payload: { type: "response", id: requestId, success: false, error: `Carrot ${carrotId} is not running` },
          }));
          return;
        }

        carrot.invoke(method, params)
          .then((result: unknown) => {
            this.hopWs?.send(JSON.stringify({
              browserId,
              payload: { type: "response", id: requestId, success: true, payload: result },
            }));
          })
          .catch((err: Error) => {
            this.hopWs?.send(JSON.stringify({
              browserId,
              payload: { type: "response", id: requestId, success: false, error: err.message },
            }));
          });
        return;
      }
    } catch (err) {
      console.error("[hop] Failed to handle message:", err instanceof Error ? err.message : err);
    }
  }

  private handleHopFileRequest(message: { requestId: number; carrotId: string; path: string }) {
    const { requestId, carrotId, path: filePath } = message;
    const carrot = getInstalledCarrot(carrotId);

    if (!carrot) {
      this.hopWs?.send(JSON.stringify({
        type: "hop:file-response",
        requestId,
        status: 404,
        contentType: "text/plain",
        body: btoa(`Carrot not found: ${carrotId}`),
      }));
      return;
    }

    // Resolve the file path within the carrot's current directory
    const fs = require("node:fs");
    const pathMod = require("node:path");
    const normalizedPath = filePath.replace(/^\/+/, "");
    const fullPath = pathMod.resolve(carrot.currentDir, normalizedPath);

    // Security: ensure path doesn't escape the carrot dir
    if (!fullPath.startsWith(carrot.currentDir)) {
      this.hopWs?.send(JSON.stringify({
        type: "hop:file-response",
        requestId,
        status: 403,
        contentType: "text/plain",
        body: btoa("Path escapes carrot directory"),
      }));
      return;
    }

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      this.hopWs?.send(JSON.stringify({
        type: "hop:file-response",
        requestId,
        status: 404,
        contentType: "text/plain",
        body: btoa(`File not found: ${normalizedPath}`),
      }));
      return;
    }

    const ext = pathMod.extname(fullPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".gif": "image/gif",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
    };

    const contentType = mimeTypes[ext] || "application/octet-stream";
    const fileData = fs.readFileSync(fullPath);
    const base64 = Buffer.from(fileData).toString("base64");

    this.hopWs?.send(JSON.stringify({
      type: "hop:file-response",
      requestId,
      contentType,
      body: base64,
    }));
  }

  private handleHopRuntimeRequest(browserId: string, requestId: number, method: string, params: unknown) {
    const sendResult = (result: unknown) => {
      this.hopWs?.send(JSON.stringify({
        browserId,
        payload: { type: "response", id: requestId, success: true, payload: result },
      }));
    };
    const sendError = (error: string) => {
      this.hopWs?.send(JSON.stringify({
        browserId,
        payload: { type: "response", id: requestId, success: false, error },
      }));
    };

    try {
      switch (method) {
        case "list-carrots":
          sendResult(this.summaries());
          break;
        case "update-carrots":
          this.handleTrayAction("update-carrots").then(() => sendResult({ ok: true })).catch((e) => sendError(String(e)));
          break;
        default:
          sendError(`Unknown runtime method: ${method}`);
      }
    } catch (err) {
      sendError(err instanceof Error ? err.message : String(err));
    }
  }

  private getAuthTokenPath() {
    const path = require("node:path");
    const os = require("node:os");
    return path.join(os.homedir(), ".electrobunny", this.channel, ".auth-token");
  }

  private getDeviceTokenPath() {
    const path = require("node:path");
    const os = require("node:os");
    return path.join(os.homedir(), ".electrobunny", this.channel, ".device-token");
  }

  private getDeviceTokenIdPath() {
    const path = require("node:path");
    const os = require("node:os");
    return path.join(os.homedir(), ".electrobunny", this.channel, ".device-token-id");
  }

  private loadAuthToken() {
    const fs = require("node:fs");
    const tokenPath = this.getAuthTokenPath();

    if (fs.existsSync(tokenPath)) {
      try {
        this.authToken = fs.readFileSync(tokenPath, "utf8").trim();
        bootLog("loaded auth token");
      } catch {}
    }
  }

  private loadDeviceToken() {
    const fs = require("node:fs");
    const tokenPath = this.getDeviceTokenPath();
    if (fs.existsSync(tokenPath)) {
      try {
        this.deviceToken = fs.readFileSync(tokenPath, "utf8").trim();
        console.log("[bunny-ears] loaded device token");
      } catch {}
    }
    const idPath = this.getDeviceTokenIdPath();
    if (fs.existsSync(idPath)) {
      try {
        this.deviceTokenId = fs.readFileSync(idPath, "utf8").trim();
      } catch {}
    }
  }

  private saveDeviceToken(token: string, tokenId?: string | null) {
    const fs = require("node:fs");
    const path = require("node:path");
    const tokenPath = this.getDeviceTokenPath();
    this.deviceToken = token;
    try {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, token);
      // Restrict permissions: rw owner only
      try { fs.chmodSync(tokenPath, 0o600); } catch {}
    } catch {}
    if (tokenId) {
      this.deviceTokenId = tokenId;
      const idPath = this.getDeviceTokenIdPath();
      try {
        fs.writeFileSync(idPath, tokenId);
        try { fs.chmodSync(idPath, 0o600); } catch {}
      } catch {}
    }
  }

  private clearDeviceToken() {
    const fs = require("node:fs");
    const tokenPath = this.getDeviceTokenPath();
    this.deviceToken = null;
    try { if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath); } catch {}
    const idPath = this.getDeviceTokenIdPath();
    this.deviceTokenId = null;
    try { if (fs.existsSync(idPath)) fs.unlinkSync(idPath); } catch {}
  }

  // Mark this instance as offline on the API. Best-effort, fire-and-forget.
  // Used on logout so the instance immediately appears offline in Farm.
  private async markInstanceOfflineOnServer(instanceId: string, accessToken: string) {
    const apiBase = this.channel === "dev"
      ? "http://localhost:8787"
      : this.channel === "canary"
        ? "https://staging-api.electrobunny.ai"
        : "https://api.electrobunny.ai";

    try {
      const resp = await fetch(`${apiBase}/v1/instances/${instanceId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ status: "offline" }),
      });
      if (!resp.ok) {
        console.log(`[bunny-ears] mark offline failed: ${resp.status}`);
      } else {
        console.log(`[bunny-ears] instance ${instanceId} marked offline`);
      }
    } catch (err) {
      console.log(`[bunny-ears] mark offline error: ${err}`);
    }
  }

  // Revoke the device token on the server. Best-effort — the local token is
  // already cleared by the time this returns.
  private async revokeDeviceTokenOnServer(tokenId: string, accessToken: string) {
    const apiBase = this.channel === "dev"
      ? "http://localhost:8787"
      : this.channel === "canary"
        ? "https://staging-api.electrobunny.ai"
        : "https://api.electrobunny.ai";

    try {
      const resp = await fetch(`${apiBase}/v1/auth/device-tokens/${tokenId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) {
        console.log(`[bunny-ears] device token revoke failed: ${resp.status}`);
      } else {
        console.log(`[bunny-ears] device token ${tokenId} revoked server-side`);
      }
    } catch (err) {
      console.log(`[bunny-ears] device token revoke error: ${err}`);
    }
  }

  private saveAuthToken(token: string) {
    const fs = require("node:fs");
    const path = require("node:path");
    const tokenPath = this.getAuthTokenPath();

    this.authToken = token;
    if (tokenPath) {
      try {
        fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
        fs.writeFileSync(tokenPath, token);
      } catch {}
    }
  }

  // Get a fresh short-lived access token by exchanging the device token.
  // Used to populate `this.authToken` and notify dash carrots.
  private async refreshAccessTokenFromDevice(): Promise<string | null> {
    if (!this.deviceToken) return null;
    const machineId = this.getMachineId();
    if (!machineId) return null;

    const apiBase = this.channel === "dev"
      ? "http://localhost:8787"
      : this.channel === "canary"
        ? "https://staging-api.electrobunny.ai"
        : "https://api.electrobunny.ai";

    try {
      const resp = await fetch(`${apiBase}/v1/auth/device-access-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine_id: machineId, device_token: this.deviceToken }),
      });
      if (!resp.ok) {
        console.log(`[bunny-ears] device-access-token failed: ${resp.status}`);
        if (resp.status === 401) {
          // Device token has been revoked or is otherwise invalid.
          // Clear everything and notify carrots so dash logs out.
          const oldAccessToken = this.authToken;
          const oldInstanceId = this.instanceId;
          this.clearDeviceToken();
          this.authToken = null;
          try {
            const fs = require("node:fs");
            const tokenPath = this.getAuthTokenPath();
            if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
          } catch {}
          try { this.hopWs?.close(); } catch {}
          this.hopWs = null;
          for (const carrot of this.carrots.values()) {
            if (carrot.status === "running") {
              carrot.sendEvent("auth-token-cleared");
            }
          }
          console.log("[bunny-ears] device token revoked — signed out");
          // If we still have a (soon-to-expire) access token, use it to mark
          // the instance offline so Farm reflects it immediately.
          if (oldInstanceId && oldAccessToken) {
            this.markInstanceOfflineOnServer(oldInstanceId, oldAccessToken).catch(() => {});
          }
        }
        return null;
      }
      const data = await resp.json() as { accessToken?: string };
      const token = data.accessToken || null;
      if (token) {
        this.saveAuthToken(token);
        // Notify all running carrots about the refreshed token
        for (const carrot of this.carrots.values()) {
          if (carrot.status === "running") {
            carrot.sendEvent("auth-token-changed", { token });
          }
        }
      }
      return token;
    } catch (err) {
      console.log(`[bunny-ears] device-access-token error: ${err}`);
      return null;
    }
  }

  private async getFarmUrl(): Promise<string> {
    try {
      const channel = await Updater.localInfo.channel();
      if (channel === "dev") return "http://localhost:5173";
      if (channel === "canary") return "https://staging-farm.electrobunny.ai";
    } catch {}
    return "https://farm.electrobunny.ai";
  }

  private async openFarmForLogin(): Promise<void> {
    const url = await this.getFarmUrl();
    return new Promise((resolve) => {
      bootLog("opening Farm for login", { url });

      const rpc = BrowserView.defineRPC({
        maxRequestTime: 300000, // 5 min for login flow
        handlers: {
          requests: {
            // Farm calls this after successful login
            getCarrots: () => {
              return runtime.summaries();
            },
            setAuthToken: ({ accessToken }: { accessToken: string }) => {
              this.saveAuthToken(accessToken);
              console.log(`[bunny-ears] Received auth token from Farm (len=${accessToken?.length || 0})`);
              // Immediately re-register the instance so it shows online in Farm
              // without waiting for the next 60s heartbeat tick.
              this.registerInstanceWithToken(accessToken).catch(() => {});
              // Notify all running carrots about the new token
              for (const carrot of this.carrots.values()) {
                if (carrot.status === "running") {
                  carrot.sendEvent("auth-token-changed", { token: accessToken });
                }
              }

              // Keep the Farm window open — user can see their dashboard.
              // Resize to a comfortable dashboard size.
              if (this.farmWindow) {
                this.farmWindow.setFrame(undefined, undefined, 960, 720);
                this.farmWindow.setTitle("Electrobunny Farm");
              }
              resolve();
              return { ok: true };
            },
            // Receives the long-lived device token from Farm after registration.
            setDeviceToken: ({ deviceToken, deviceTokenId }: { deviceToken: string; deviceTokenId?: string }) => {
              this.saveDeviceToken(deviceToken, deviceTokenId);
              console.log(`[bunny-ears] Received device token from Farm (len=${deviceToken?.length || 0}, id=${deviceTokenId || "none"})`);
              // Reconnect to Hop with the new device token
              try { this.hopWs?.close(); } catch {}
              this.hopWs = null;
              this.connectToHop();
              // Mint a fresh access token in the background
              this.refreshAccessTokenFromDevice().catch(() => {});
              return { ok: true };
            },
            // Allows Farm to read the local machine ID for device token registration.
            getMachineId: () => {
              return { machineId: this.getMachineId() || "" };
            },
            clearAuthToken: () => {
              // Capture values before clearing so we can do server-side cleanup
              const oldAccessToken = this.authToken;
              const oldDeviceTokenId = this.deviceTokenId;
              const oldInstanceId = this.instanceId;

              this.authToken = null;
              // Delete saved access token
              try {
                const fs = require("node:fs");
                const tokenPath = this.getAuthTokenPath();
                if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
              } catch {}
              // Also clear the device token (logout means full sign-out)
              this.clearDeviceToken();
              // Disconnect from Hop
              try { this.hopWs?.close(); } catch {}
              this.hopWs = null;
              // Notify all running carrots
              for (const carrot of this.carrots.values()) {
                if (carrot.status === "running") {
                  carrot.sendEvent("auth-token-cleared");
                }
              }
              console.log("[bunny-ears] auth + device token cleared");
              // Best-effort server-side cleanup (fire-and-forget).
              if (oldAccessToken) {
                if (oldInstanceId) {
                  this.markInstanceOfflineOnServer(oldInstanceId, oldAccessToken).catch(() => {});
                }
                if (oldDeviceTokenId) {
                  this.revokeDeviceTokenOnServer(oldDeviceTokenId, oldAccessToken).catch(() => {});
                }
              }
              return { ok: true };
            },
            updateCarrots: () => {
              void this.handleTrayAction("update-carrots");
              return { ok: true };
            },
          },
          messages: {},
        },
      });

      this.farmWindow = new BrowserWindow({
        title: "Electrobunny — Sign In",
        url,
        rpc,
        frame: { width: 900, height: 700 },
      });

      // Send carrot data to the Farm webview when it's ready
      this.farmWindow.webview.on("dom-ready", () => {
        const carrots = runtime.summaries();
        const machineId = this.getMachineId();
        const os = require("node:os");
        const hostname = os.hostname() || "Unknown";
        const platform = process.platform === "darwin" ? "macOS"
          : process.platform === "win32" ? "Windows"
          : process.platform === "linux" ? "Linux"
          : process.platform;
        this.farmWindow?.webview.executeJavascript(`
          window.__bunnyEarsData = {
            machineId: ${JSON.stringify(machineId)},
            hostname: ${JSON.stringify(hostname)},
            platform: ${JSON.stringify(platform)},
            carrots: ${JSON.stringify(carrots)},
          };
          window.dispatchEvent(new CustomEvent('bunnyEarsData'));
        `);
      });

      // If user closes the window without logging in, continue boot anyway
      this.farmWindow.on("close", () => {
        this.farmWindow = null;
        resolve();
      });
    });
  }

  getMachineId(): string {
    const fs = require("node:fs");
    const path = require("node:path");
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const idPath = home ? path.join(home, ".electrobunny", this.channel, "machine-id") : "";

    if (idPath && fs.existsSync(idPath)) {
      return fs.readFileSync(idPath, "utf8").trim();
    }
    const id = crypto.randomUUID();
    if (idPath) {
      try {
        fs.mkdirSync(path.dirname(idPath), { recursive: true });
        fs.writeFileSync(idPath, id);
      } catch {}
    }
    return id;
  }

  async registerInstanceWithToken(accessToken: string): Promise<{ ok: boolean; instanceId?: string; error?: string }> {
    try {
      const os = require("node:os");
      const machineId = this.getMachineId();
      const hostname = os.hostname() || "Unknown";
      const platform = process.platform === "darwin" ? "macos" : process.platform;

      const channel = await Updater.localInfo.channel().catch(() => "dev");
      const apiBase = channel === "dev" ? "http://localhost:8787"
        : channel === "canary" ? "https://staging-api.electrobunny.ai"
        : "https://api.electrobunny.ai";

      const response = await fetch(`${apiBase}/v1/instances`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          machine_id: machineId,
          name: hostname,
          os: platform,
        }),
      });

      if (!response.ok) {
        return { ok: false, error: `API ${response.status}` };
      }

      const data = await response.json() as any;
      const instanceId = data.instance?.id || null;
      if (instanceId) this.instanceId = instanceId;
      console.log(`[bunny-ears] Instance registered: ${data.instance?.name} (${instanceId})`);
      return { ok: true, instanceId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bunny-ears] Instance registration failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }


  /**
   * WebSocket bridge for web clients (e.g. Bunny Dash running in a browser).
   *
   * Web clients connect and specify a target carrot (default: bunny-dash).
   * Requests are routed to the carrot worker via CarrotInstance.invoke(),
   * and emit-view messages from the worker are forwarded back over WebSocket.
   */
  private startWebBridge() {
    const WEB_BRIDGE_PORT = 9333;
    const self = this;
    let clientId = 0;

    try {
      Bun.serve({
        port: WEB_BRIDGE_PORT,
        fetch(req, server) {
          if (server.upgrade(req, { data: { id: `web-${++clientId}` } })) {
            return;
          }
          return new Response("Bunny Ears Web Bridge", { status: 200 });
        },
        websocket: {
          open(ws) {
            const id = (ws.data as any).id as string;
            console.log(`[web-bridge] Client connected: ${id}`);

            const dashCarrot = self.carrots.get("bunny-dash");
            if (dashCarrot) {
              dashCarrot.webClients.set(id, {
                send: (data: string) => {
                  try { ws.send(data); } catch {}
                },
              });
              // The web renderer will call getInitialState on its own when
              // it mounts. No need to push state here.
            } else {
              console.warn("[web-bridge] bunny-dash carrot not found");
            }
          },
          async message(ws, data) {
            const id = (ws.data as any).id as string;
            try {
              const msg = JSON.parse(String(data));
              const dashCarrot = self.carrots.get("bunny-dash");
              if (!dashCarrot) {
                if (msg.type === "request") {
                  ws.send(JSON.stringify({
                    type: "response",
                    id: msg.id,
                    error: "bunny-dash carrot not running",
                  }));
                }
                return;
              }

              if (msg.type === "request") {
                try {
                  // Don't pass a windowId — let the worker use its current
                  // window so the request is processed in the right context.
                  const result = await dashCarrot.invoke(msg.method, msg.params);
                  ws.send(JSON.stringify({
                    type: "response",
                    id: msg.id,
                    result,
                  }));
                } catch (err) {
                  ws.send(JSON.stringify({
                    type: "response",
                    id: msg.id,
                    error: err instanceof Error ? err.message : String(err),
                  }));
                }
              }

              if (msg.type === "message") {
                // Fire-and-forget message to the carrot worker
                dashCarrot.invoke(`send:${msg.name}`, msg.payload).catch(() => {});
              }
            } catch (err) {
              console.error("[web-bridge] Failed to handle message:", err);
            }
          },
          close(ws) {
            const id = (ws.data as any).id as string;
            console.log(`[web-bridge] Client disconnected: ${id}`);
            const dashCarrot = self.carrots.get("bunny-dash");
            dashCarrot?.webClients.delete(id);
          },
        },
      });
      console.log(`[web-bridge] Listening on ws://localhost:${WEB_BRIDGE_PORT}`);
    } catch (err) {
      console.error(`[web-bridge] Failed to start on port ${WEB_BRIDGE_PORT}:`, err);
    }
  }

  summaries() {
    return Array.from(this.carrots.values()).map((carrot) => carrot.summary);
  }

  dashboardState(): DashboardState {
    return {
      installRoot: getInstalledCarrotsRoot(),
      carrots: this.summaries(),
      pendingConsent: this.pendingConsent?.request ?? null,
    };
  }

  notifyDashboardChanged() {
    this.tray?.setMenu(this.buildTrayMenu());
    (this.managerWindow?.webview.rpc as any)?.send?.dashboardChanged(this.dashboardState());
  }

  private defaultApplicationMenu() {
    return [
      {
        label: "Bunny Ears",
        submenu: [{ role: "quit", accelerator: "cmd+q" }],
      },
    ];
  }

  private installApplicationMenu(menu: any[]) {
    ApplicationMenu.setApplicationMenu(menu);
  }

  private restoreDefaultApplicationMenu() {
    this.activeApplicationMenuOwnerId = null;
    this.installApplicationMenu(this.defaultApplicationMenu());
  }

  activateCarrotApplicationMenu(carrot: CarrotInstance) {
    if (Array.isArray(carrot.applicationMenu) && carrot.applicationMenu.length > 0) {
      this.activeApplicationMenuOwnerId = carrot.carrot.manifest.id;
      this.installApplicationMenu(carrot.applicationMenu);
      return;
    }

    this.restoreDefaultApplicationMenu();
  }

  restoreApplicationMenuIfOwner(carrot: CarrotInstance) {
    if (this.activeApplicationMenuOwnerId !== carrot.carrot.manifest.id) {
      return;
    }

    const nextOwner = Array.from(this.carrots.values()).find(
      (candidate) =>
        candidate !== carrot &&
        candidate.status === "running" &&
        candidate.controllerWindows.size > 0 &&
        Array.isArray(candidate.applicationMenu) &&
        candidate.applicationMenu.length > 0,
    );

    if (nextOwner) {
      this.activateCarrotApplicationMenu(nextOwner);
      return;
    }

    this.restoreDefaultApplicationMenu();
  }

  private withSourceEnvelope(
    sourceCarrotId: string,
    sourceWindowId: string | undefined,
    payload: unknown,
  ) {
    const source = {
      carrotId: sourceCarrotId,
      windowId: sourceWindowId ?? null,
    };

    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return {
        ...(payload as Record<string, unknown>),
        __source: source,
      };
    }

    return {
      value: payload,
      __source: source,
    };
  }

  async invokeCarrotFrom(
    sourceCarrotId: string,
    targetCarrotId: string,
    method: string,
    params?: unknown,
    sourceWindowId?: string,
  ) {
    if (!targetCarrotId) {
      throw new Error("Missing target carrot id");
    }
    if (!method) {
      throw new Error("Missing target carrot method");
    }

    const target = this.carrots.get(targetCarrotId);
    if (!target) {
      throw new Error(`Target carrot not installed: ${targetCarrotId}`);
    }

    const wasStopped = target.status === "stopped";
    if (target.status !== "running") {
      await target.start();
      if (wasStopped && target.carrot.manifest.mode === "background") {
        target.sendEvent("boot");
      }
    }

    return target.invoke(
      method,
      this.withSourceEnvelope(sourceCarrotId, sourceWindowId, params),
    );
  }

  emitCarrotEventFrom(
    sourceCarrotId: string,
    targetCarrotId: string,
    name: string,
    payload?: unknown,
  ) {
    if (!targetCarrotId || !name) {
      return;
    }

    const target = this.carrots.get(targetCarrotId);
    if (!target || target.status !== "running") {
      return;
    }

    target.sendEvent(name, this.withSourceEnvelope(sourceCarrotId, undefined, payload));
  }

  buildTrayMenu() {
    const baseItems = [
      { type: "normal" as const, label: "Open Bunny Dash", action: "open-dash" },
      { type: "normal" as const, label: "Open Bunny Farm", action: "open-farm" },
    ];

    // Dash extension: workspaces, lenses, carrot controls — set by the dash carrot
    const dashItems = this.dashTrayExtension.length > 0
      ? [{ type: "divider" as const }, ...this.dashTrayExtension]
      : [];

    const updateLabel = this.updateStatus === "update-ready"
      ? "Restart to Update"
      : this.updateStatus === "downloading"
        ? "Downloading Update..."
        : "Check for Updates";

    const emergencyItems = [
      { type: "divider" as const },
      { type: "normal" as const, label: updateLabel, action: "check-for-updates" },
      { type: "normal" as const, label: "Update Carrots", action: "update-carrots" },
      { type: "normal" as const, label: "Reset Local State", action: "emergency-reset" },
      { type: "normal" as const, label: "Quit Bunny Ears", action: "quit" },
    ];

    return [...baseItems, ...dashItems, ...emergencyItems];
  }

  private async handleTrayAction(action: string) {
    if (action === "open-dash") {
      const dashCarrot = this.carrots.get("bunny-dash");
      if (!dashCarrot) return;
      if (dashCarrot.status !== "running") {
        await dashCarrot.start();
        dashCarrot.sendEvent("boot");
      }
      // Set dash as active menu owner so menu clicks route to it
      this.activeApplicationMenuOwnerId = dashCarrot.carrot.manifest.id;
      // Dash manages its own windows — send an event to focus/create
      dashCarrot.sendEvent("open-window");
      return;
    }
    if (action === "open-farm") {
      if (this.farmWindow) {
        this.farmWindow.focus();
      } else {
        this.openFarmForLogin().catch(() => {});
      }
      return;
    }
    if (action === "install-artifact") {
      await this.installCarrotArtifactFromDisk();
      return;
    }
    if (action === "update-carrots") {
      console.log("[bunny-ears] Updating carrots...");
      const ch = await Updater.localInfo.channel().catch(() => "dev");
      if (ch !== "dev") {
        // Stop all running carrots so files aren't locked during the download
        for (const carrot of this.carrots.values()) {
          if (carrot.status === "running") {
            try { await carrot.stop(); } catch {}
          }
        }
        this.carrots.clear();

        try {
          await installFoundationCarrotsFromR2(ch, true);
          console.log("[bunny-ears] Carrots updated, restarting Bunny Ears...");
        } catch (err) {
          console.error("[bunny-ears] Carrot update failed:", err);
          return;
        }

        // Restart the whole process — restarting workers in-place causes
        // segfaults due to dangling references in still-open windows.
        // The detached shell waits for this process to exit then relaunches.
        try {
          if (process.platform === "darwin") {
            const pathMod = require("node:path");
            // process.execPath is .../Contents/MacOS/bun → app bundle is two dirs up
            const appBundlePath = pathMod.resolve(pathMod.dirname(process.execPath), "..", "..");
            const pid = process.pid;
            Bun.spawn(
              [
                "sh",
                "-c",
                `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done; sleep 1; open "${appBundlePath}"`,
              ],
              { detached: true, stdio: ["ignore", "ignore", "ignore"] } as any,
            );
          }
        } catch (err) {
          console.error("[bunny-ears] Failed to schedule restart:", err);
        }
        process.exit(0);
      }
      return;
    }
    if (action === "check-for-updates") {
      if (this.updateStatus === "update-ready") {
        Updater.applyUpdate();
      } else {
        this.checkForUpdates();
      }
      return;
    }
    if (action === "quit") {
      process.exit(0);
      return;
    }
    if (action === "emergency-reset") {
      // Stop all carrots and wipe their state
      for (const carrot of this.carrots.values()) {
        if (carrot.status === "running") {
          try { await carrot.stop(); } catch {}
        }
        // Wipe carrot state
        const stateDir = carrot.stateDir;
        try {
          const { rmSync } = await import("node:fs");
          rmSync(stateDir, { recursive: true, force: true });
        } catch {}
      }
      console.log("[bunny-ears] Emergency reset complete. Restarting...");
      process.exit(0);
      return;
    }
    const [verb, ...rest] = action.split(":");
    const carrotId = rest.join(":");
    const carrot = carrotId ? this.carrots.get(carrotId) : null;
    if (!carrot) return;
    if (verb === "start") {
      await carrot.start();
      if (carrot.carrot.manifest.mode === "background") {
        carrot.sendEvent("boot");
      }
      return;
    }
    if (verb === "stop") {
      await carrot.stop();
      return;
    }
    if (verb === "rebuild") {
      await this.reinstallCarrot(carrotId);
      return;
    }

    // Forward unhandled actions to the dash carrot (workspace/lens/carrot actions)
    const dashCarrot = this.carrots.get("bunny-dash");
    if (dashCarrot && dashCarrot.status === "running") {
      dashCarrot.sendEvent("tray", { action });
    }
  }

  private async installPreparedCarrot(
    prepared: PreparedCarrotInstall,
    grantedPermissions: CarrotPermissionGrant,
    options: { preserveRunningState?: boolean } = {},
  ) {
    try {
      const installed = await prepared.install(grantedPermissions);
      await this.upsertInstalledCarrot(installed, {
        openWindow: installed.manifest.mode === "window",
        preserveRunningState: options.preserveRunningState,
      });
      return { ok: true, id: installed.manifest.id };
    } finally {
      prepared.cleanup();
    }
  }

  private async queuePreparedInstall(
    prepared: PreparedCarrotInstall,
    options: { preserveRunningState?: boolean } = {},
  ) {
    if (this.pendingConsent) {
      prepared.cleanup();
      this.openManagerWindow();
      return {
        ok: false,
        error: "Another Carrot install is already waiting for permission approval.",
      };
    }

    const requestId = `consent-${Date.now()}-${this.nextConsentRequestId++}`;
    const consentPlan = buildCarrotPermissionConsentRequest(prepared, requestId);

    if (!consentPlan.request) {
      return await this.installPreparedCarrot(prepared, consentPlan.grantedPermissions, options);
    }

    this.pendingConsent = {
      request: consentPlan.request,
      prepared,
      grantedPermissions: consentPlan.grantedPermissions,
      options,
    };
    this.openManagerWindow();
    this.notifyDashboardChanged();

    return {
      ok: false,
      id: prepared.manifest.id,
      reason: "awaiting-consent",
    };
  }

  private clearPendingConsent() {
    const pending = this.pendingConsent;
    if (!pending) {
      return;
    }

    this.pendingConsent = null;
    pending.prepared.cleanup();
  }

  private async respondToConsent(requestId: string, approved: boolean) {
    const pending = this.pendingConsent;
    if (!pending || pending.request.requestId !== requestId) {
      return { ok: false, error: "Consent request not found." };
    }

    this.pendingConsent = null;
    this.notifyDashboardChanged();

    if (!approved) {
      pending.prepared.cleanup();
      return { ok: false, reason: "canceled" };
    }

    try {
      return await this.installPreparedCarrot(
        pending.prepared,
        pending.grantedPermissions,
        pending.options,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Utils.showMessageBox({
        type: "error",
        title: "Carrot install failed",
        message,
      });
      this.refreshInstalledCarrot(pending.request.carrotId);
      return { ok: false, error: message };
    }
  }

  private async installCarrotSourceFromDisk() {
    const selectedPaths = await Utils.openFileDialog({
      startingFolder: Utils.paths.documents,
      canChooseFiles: false,
      canChooseDirectory: true,
      allowsMultipleSelection: false,
    });

    const selectedPath = selectedPaths[0];
    if (!selectedPath) {
      return { ok: false, reason: "canceled" };
    }

    try {
      const prepared = await prepareDevCarrotInstallFromSource(selectedPath);
      return await this.queuePreparedInstall(prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Utils.showMessageBox({
        type: "error",
        title: "Carrot source install failed",
        message,
      });
      return { ok: false, error: message };
    }
  }

  private async installCarrotArtifactFromDisk() {
    const selectedPaths = await Utils.openFileDialog({
      startingFolder: Utils.paths.documents,
      canChooseFiles: true,
      canChooseDirectory: true,
      allowsMultipleSelection: false,
    });

    const selectedPath = selectedPaths[0];
    if (!selectedPath) {
      return { ok: false, reason: "canceled" };
    }

    try {
      const prepared = await prepareArtifactCarrotInstall(selectedPath);
      return await this.queuePreparedInstall(prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Utils.showMessageBox({
        type: "error",
        title: "Carrot artifact install failed",
        message,
      });
      return { ok: false, error: message };
    }
  }

  private async reinstallCarrot(id: string) {
    try {
      const installed = this.carrots.get(id)?.carrot ?? getInstalledCarrot(id);
      if (!installed) {
        return { ok: false, error: "Carrot not found" };
      }

      let prepared: PreparedCarrotInstall;
      if (installed.install.source.kind === "local") {
        prepared = await prepareDevCarrotInstallFromSource(installed.install.source.path);
      } else if (installed.install.source.kind === "artifact") {
        const artifactLocation =
          installed.install.source.updateLocation ??
          installed.install.source.tarballLocation ??
          installed.install.source.location;
        prepared = await prepareArtifactCarrotInstall(artifactLocation);
      } else {
        return { ok: false, error: "Prototype carrots cannot be reinstalled" };
      }

      return await this.queuePreparedInstall(prepared, {
        preserveRunningState: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Utils.showMessageBox({
        type: "error",
        title: "Carrot reinstall failed",
        message,
      });
      this.refreshInstalledCarrot(id);
      return { ok: false, error: message };
    }
  }

  private async uninstallCarrot(id: string) {
    const carrot = this.carrots.get(id);
    if (!carrot) {
      return { ok: false, reason: "missing" };
    }

    const confirmed = await requestCarrotUninstallConsent(carrot.carrot.manifest.name);
    if (!confirmed) {
      return { ok: false, reason: "canceled" };
    }

    await carrot.stop();
    uninstallInstalledCarrot(id);
    this.carrots.delete(id);
    this.notifyDashboardChanged();
    return { ok: true };
  }

  private async revealCarrot(id: string) {
    const carrot = this.carrots.get(id);
    if (!carrot) {
      return { ok: false };
    }

    const source = carrot.carrot.install.source;
    let targetPath: string | null = null;

    if (source.kind === "local") {
      targetPath = source.path;
    } else if (source.kind === "artifact") {
      if (/^https?:\/\//i.test(source.location)) {
        Utils.openExternal(source.location);
        return { ok: true };
      }
      targetPath = source.location;
    } else {
      targetPath = carrot.carrot.rootDir;
    }

    if (!targetPath) {
      return { ok: false };
    }

    if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
      Utils.openPath(targetPath);
    } else {
      Utils.showItemInFolder(targetPath);
    }

    return { ok: true };
  }

  private refreshInstalledCarrot(id: string) {
    const installed = loadInstalledCarrots().find((carrot) => carrot.manifest.id === id);
    if (!installed) {
      return;
    }

    const existing = this.carrots.get(id);
    if (existing) {
      existing.carrot = installed;
    } else {
      this.carrots.set(id, new CarrotInstance(installed));
    }
    this.notifyDashboardChanged();
  }

  private async upsertInstalledCarrot(
    installed: InstalledCarrot,
    options: { openWindow?: boolean; preserveRunningState?: boolean } = {},
  ) {
    const existing = this.carrots.get(installed.manifest.id);
    const wasRunning = existing?.status === "running";
    const existingLogs = existing?.logs ?? [];

    if (existing) {
      await existing.stop();
    }

    const instance = new CarrotInstance(installed);
    instance.logs = existingLogs;
    this.carrots.set(installed.manifest.id, instance);
    this.notifyDashboardChanged();

    const shouldStart =
      installed.manifest.mode === "background" ||
      options.openWindow === true ||
      (options.preserveRunningState === true && wasRunning);

    if (!shouldStart) {
      return;
    }

    await instance.start();
    if (installed.manifest.mode === "background") {
      instance.sendEvent("boot");
      return;
    }
    if (options.openWindow === true || wasRunning) {
      await instance.openWindow();
    }
  }

  private openManagerWindow() {
    if (this.managerWindow) {
      bootLog("manager window focus existing");
      this.managerWindow.focus();
      return;
    }

    bootLog("creating manager window");

    const rpc = BrowserView.defineRPC<DashboardRPC>({
      maxRequestTime: 300000,
      handlers: {
        requests: {
          getDashboard: async () => this.dashboardState(),
          installCarrotSourceFromDisk: async () => this.installCarrotSourceFromDisk(),
          installCarrotArtifactFromDisk: async () => this.installCarrotArtifactFromDisk(),
          reinstallCarrot: async ({ id }) => this.reinstallCarrot(id),
          respondToConsent: async ({ requestId, approved }) =>
            this.respondToConsent(requestId, approved),
          uninstallCarrot: async ({ id }) => this.uninstallCarrot(id),
          revealCarrot: async ({ id }) => this.revealCarrot(id),
          launchCarrot: async ({ id }) => {
            const carrot = this.carrots.get(id);
            if (!carrot) return { ok: false };
            if (carrot.status === "running") {
              await carrot.stop();
            }
            await carrot.start();
            if (carrot.carrot.manifest.mode === "background") {
              carrot.sendEvent("boot");
            }
            return { ok: true };
          },
          stopCarrot: async ({ id }) => {
            const carrot = this.carrots.get(id);
            if (!carrot) return { ok: false };
            await carrot.stop();
            return { ok: true };
          },
          openCarrot: async ({ id }) => {
            const carrot = this.carrots.get(id);
            if (!carrot) return { ok: false };
            await carrot.openWindow();
            return { ok: true };
          },
        },
        messages: {},
      },
    });

    const win = new BrowserWindow({
      title: "Bunny Ears",
      url: "views://mainview/index.html",
      rpc,
      frame: {
        width: 960,
        height: 720,
        x: 80,
        y: 80,
      },
    });

    this.managerWindow = win;
    win.webview.on("dom-ready", () => {
      bootLog("manager dom-ready");
      (win.webview.rpc as any)?.send?.dashboardChanged(this.dashboardState());
    });
    win.on("focus", () => {
      this.restoreDefaultApplicationMenu();
    });
    win.on("close", () => {
      this.clearPendingConsent();
      if (this.managerWindow === win) {
        this.managerWindow = null;
      }
    });
  }
}

const FOUNDATION_CARROTS = [
  { id: "bunny.git", artifact: "bunny.git-0.1.0.tar.zst" },
  { id: "bunny.pty", artifact: "bunny.pty-0.1.0.tar.zst" },
  { id: "bunny.search", artifact: "bunny.search-0.1.0.tar.zst" },
  { id: "bunny.tsserver", artifact: "bunny.tsserver-0.1.0.tar.zst" },
  { id: "bunny.biome", artifact: "bunny.biome-0.1.0.tar.zst" },
  { id: "bunny.llama", artifact: "bunny.llama-0.1.0.tar.zst" },
  { id: "bunny-dash", artifact: "bunny-dash-0.1.0.tar.zst" },
];

async function installFoundationCarrotsFromR2(channel: string, forceReinstall: boolean) {
  const baseUrl = channel === "stable"
    ? "https://carrots.electrobunny.ai"
    : "https://staging-carrots.electrobunny.ai";

  // Cache-bust against Cloudflare's CDN. Without this, a stale cached artifact
  // can be served indefinitely after a fresh CI build pushes new contents.
  const cacheBuster = Date.now().toString();

  for (const carrot of FOUNDATION_CARROTS) {
    if (!forceReinstall) {
      const existing = getInstalledCarrot(carrot.id);
      if (existing) continue;
    }

    const url = `${baseUrl}/${carrot.artifact}?t=${cacheBuster}`;
    console.log(`[bunny-ears] ${forceReinstall ? "Updating" : "Installing"} ${carrot.id} from ${url}...`);
    try {
      const prepared = await prepareArtifactCarrotInstall(url);
      await prepared.install();
      prepared.cleanup();
      console.log(`[bunny-ears] ${forceReinstall ? "Updated" : "Installed"} ${carrot.id}`);
    } catch (err) {
      console.error(`[bunny-ears] Failed to install ${carrot.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

pruneLegacyPrototypeCarrots();

// In dev mode, rebuild carrots from source. In staging/prod, download pre-built artifacts.
const channel = await Updater.localInfo.channel().catch(() => "dev");
if (channel === "dev") {
  const refreshErrors = await refreshTrackedDevCarrots();
  if (refreshErrors.length > 0) {
    console.error("[bunny-ears] dev carrot refresh failures", refreshErrors);
  }
} else {
  await installFoundationCarrotsFromR2(channel, false);
}

const runtime = new BunnyEarsRuntime();
await runtime.boot();
