import {
  BrowserView,
  BrowserWindow,
  Tray,
  Utils,
  type RPCSchema,
} from "electrobun/bun";
import { join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import type {
  CarrotManifest,
  CarrotPermission,
  CarrotViewRPC,
  CarrotWorkerMessage,
} from "../carrot-runtime/types";

type CarrotStatus = "stopped" | "starting" | "running";

type CarrotInfo = {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: "window" | "background";
  permissions: CarrotPermission[];
  status: CarrotStatus;
  logTail: string[];
};

type DashboardRPC = {
  bun: RPCSchema<{
    requests: {
      getDashboard: {
        params: {};
        response: { carrots: CarrotInfo[] };
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
      dashboardChanged: { carrots: CarrotInfo[] };
    };
  }>;
};

const APP_ROOT = resolve("../Resources/app");
const CARROTS_ROOT = join(APP_ROOT, "carrots");
const DATA_ROOT = join(Utils.paths.userData, "bunny-ears");
const CARROT_DATA_ROOT = join(DATA_ROOT, "carrots");

mkdirSync(CARROT_DATA_ROOT, { recursive: true });

function readManifest(id: string): CarrotManifest {
  return JSON.parse(
    readFileSync(join(CARROTS_ROOT, id, "carrot.json"), "utf8"),
  ) as CarrotManifest;
}

function loadManifests(): CarrotManifest[] {
  if (!existsSync(CARROTS_ROOT)) {
    return [];
  }

  return readdirSync(CARROTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readManifest(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const manifests = loadManifests();

class CarrotInstance {
  manifest: CarrotManifest;
  status: CarrotStatus = "stopped";
  logs: string[] = [];
  tray: Tray | null = null;
  controllerWindow: BrowserWindow | null = null;
  worker: Worker | null = null;
  requestId = 1;
  pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(manifest: CarrotManifest) {
    this.manifest = manifest;
  }

  get stateDir() {
    return join(CARROT_DATA_ROOT, this.manifest.id);
  }

  get statePath() {
    return join(this.stateDir, "state.json");
  }

  get logsPath() {
    return join(this.stateDir, "logs.txt");
  }

  get summary(): CarrotInfo {
    return {
      id: this.manifest.id,
      name: this.manifest.name,
      description: this.manifest.description,
      version: this.manifest.version,
      mode: this.manifest.mode,
      permissions: this.manifest.permissions,
      status: this.status,
      logTail: this.logs.slice(-4),
    };
  }

  async start() {
    if (this.status === "running" || this.status === "starting") {
      if (this.manifest.mode === "window") {
        this.controllerWindow?.focus();
      }
      return;
    }

    mkdirSync(this.stateDir, { recursive: true });
    this.status = "starting";
    runtime.notifyDashboardChanged();

    const workerPath = join(CARROTS_ROOT, this.manifest.id, this.manifest.worker.relativePath);
    if (!existsSync(workerPath)) {
      throw new Error(`Missing worker script for ${this.manifest.id}: ${workerPath}`);
    }

    this.worker = new Worker(workerPath, { type: "module" });
    this.worker.onmessage = (event: MessageEvent<CarrotWorkerMessage>) => {
      void this.handleWorkerMessage(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.pushLog(`worker error: ${event.message}`);
      void this.stop();
    };

    this.createControllerWindow();

    this.worker.postMessage({
      type: "init",
      manifest: this.manifest,
      context: {
        statePath: this.statePath,
        logsPath: this.logsPath,
        permissions: this.manifest.permissions,
      },
    } satisfies CarrotWorkerMessage);

    this.status = "running";
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
      pending.reject(new Error(`${this.manifest.name} stopped`));
    }
    this.pending.clear();

    if (this.tray) {
      this.tray.remove();
      this.tray = null;
    }

    if (this.controllerWindow) {
      const win = this.controllerWindow;
      this.controllerWindow = null;
      try {
        win.close();
      } catch {
        // Best effort; window may already be gone.
      }
    }

    this.pushLog("carrot stopped");
    runtime.notifyDashboardChanged();
  }

  async openWindow() {
    if (this.manifest.mode !== "window") {
      return;
    }

    if (this.status !== "running") {
      await this.start();
      return;
    }

    this.controllerWindow?.focus();
  }

  async invoke(method: string, params?: unknown) {
    if (!this.worker) {
      throw new Error(`${this.manifest.name} is not running`);
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
    runtime.notifyDashboardChanged();
  }

  private createControllerWindow() {
    const rpc = BrowserView.defineRPC<CarrotViewRPC>({
      maxRequestTime: 10000,
      handlers: {
        requests: {
          invoke: async ({ method, params }) => {
            return this.invoke(method, params);
          },
        },
        messages: {},
      },
    });

    const hidden = this.manifest.mode === "background" || this.manifest.view.hidden === true;

    const win = new BrowserWindow({
      title: this.manifest.view.title,
      url: this.manifest.view.url,
      rpc,
      hidden,
      frame: {
        width: this.manifest.view.width,
        height: this.manifest.view.height,
        x: 120,
        y: 120,
      },
    });

    this.controllerWindow = win;

    win.webview.on("dom-ready", () => {
      (win.webview.rpc as any)?.send?.carrotBoot({
        id: this.manifest.id,
        name: this.manifest.name,
        permissions: this.manifest.permissions,
        mode: this.manifest.mode,
      });
    });

    win.on("close", () => {
      if (this.controllerWindow === win) {
        this.controllerWindow = null;
        if (this.status === "running") {
          if (this.manifest.mode === "window") {
            void this.stop();
          }
        }
      }
    });
  }

  private async handleWorkerMessage(message: CarrotWorkerMessage) {
    switch (message.type) {
      case "ready": {
        this.pushLog("worker ready");
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
      default:
        break;
    }
  }

  private async handleHostAction(action: string, payload: unknown) {
    switch (action) {
      case "notify": {
        if (!this.manifest.permissions.includes("notifications")) {
          this.pushLog("notification denied by permissions");
          return;
        }
        const notification = payload as { title: string; body?: string };
        Utils.showNotification({ title: notification.title, body: notification.body });
        this.pushLog(`notification: ${notification.title}`);
        break;
      }
      case "set-tray": {
        if (!this.manifest.permissions.includes("tray")) {
          this.pushLog("tray denied by permissions");
          return;
        }
        const trayPayload = payload as { title?: string };
        if (!this.tray) {
          this.tray = new Tray({ title: trayPayload.title || this.manifest.name });
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
        if (!this.manifest.permissions.includes("tray") || !this.tray) {
          return;
        }
        this.tray.setMenu(payload as any);
        break;
      }
      case "remove-tray": {
        this.tray?.remove();
        this.tray = null;
        break;
      }
      case "emit-view": {
        const eventPayload = payload as { name: string; payload?: unknown };
        (this.controllerWindow?.webview.rpc as any)?.send?.runtimeEvent(eventPayload);
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
}

class BunnyEarsRuntime {
  tray: Tray;
  managerWindow: BrowserWindow | null = null;
  carrots = new Map<string, CarrotInstance>();

  constructor() {
    for (const manifest of manifests) {
      this.carrots.set(manifest.id, new CarrotInstance(manifest));
    }

    this.tray = new Tray({ title: "Bunny Ears" });
    this.tray.setMenu(this.buildTrayMenu());
    this.tray.on("tray-clicked", (event: any) => {
      const action = event.data?.action;
      if (!action) return;
      void this.handleTrayAction(action);
    });
  }

  async boot() {
    this.openManagerWindow();
    for (const carrot of this.carrots.values()) {
      if (carrot.manifest.mode === "background") {
        await carrot.start();
        carrot.sendEvent("boot");
      }
    }
  }

  summaries() {
    return Array.from(this.carrots.values()).map((carrot) => carrot.summary);
  }

  notifyDashboardChanged() {
    this.tray.setMenu(this.buildTrayMenu());
    (this.managerWindow?.webview.rpc as any)?.send?.dashboardChanged({
      carrots: this.summaries(),
    });
  }

  private buildTrayMenu() {
    const summaries = this.summaries();
    const carrotItems = summaries.map((carrot) => ({
      type: "normal" as const,
      label: `${carrot.status === "running" ? "Stop" : "Launch"} ${carrot.name}`,
      action: carrot.status === "running" ? `stop:${carrot.id}` : `start:${carrot.id}`,
    }));

    return [
      { type: "normal" as const, label: "Open Bunny Ears", action: "open-manager" },
      ...carrotItems,
      { type: "divider" as const },
      { type: "normal" as const, label: "Quit Bunny Ears", action: "quit" },
    ];
  }

  private async handleTrayAction(action: string) {
    if (action === "open-manager") {
      this.openManagerWindow();
      return;
    }
    if (action === "quit") {
      process.exit(0);
      return;
    }
    const [verb, carrotId] = action.split(":");
    const carrot = carrotId ? this.carrots.get(carrotId) : null;
    if (!carrot) return;
    if (verb === "start") {
      await carrot.start();
      if (carrot.manifest.mode === "background") {
        carrot.sendEvent("boot");
      }
      return;
    }
    if (verb === "stop") {
      await carrot.stop();
    }
  }

  private openManagerWindow() {
    if (this.managerWindow) {
      this.managerWindow.focus();
      return;
    }

    const rpc = BrowserView.defineRPC<DashboardRPC>({
      maxRequestTime: 10000,
      handlers: {
        requests: {
          getDashboard: async () => ({ carrots: this.summaries() }),
          launchCarrot: async ({ id }) => {
            const carrot = this.carrots.get(id);
            if (!carrot) return { ok: false };
            await carrot.start();
            if (carrot.manifest.mode === "background") {
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
      (win.webview.rpc as any)?.send?.dashboardChanged({ carrots: this.summaries() });
    });
    win.on("close", () => {
      if (this.managerWindow === win) {
        this.managerWindow = null;
      }
    });
  }
}

const runtime = new BunnyEarsRuntime();
await runtime.boot();
console.log("[bunny-ears] runtime booted");
