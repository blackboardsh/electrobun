import {
  BrowserView,
  BrowserWindow,
  Tray,
  Utils,
  type RPCSchema,
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

function bootLog(message: string, details?: unknown) {
  if (details === undefined) {
    console.log(`[bunny-ears:boot] ${message}`);
    return;
  }
  console.log(`[bunny-ears:boot] ${message}`, details);
}

type CarrotStatus = "stopped" | "starting" | "running";

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
    };
  }

  async start() {
    if (this.status === "running" || this.status === "starting") {
      if (this.carrot.manifest.mode === "window") {
        this.controllerWindow?.focus();
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

    const shouldCreateControllerWindow =
      this.carrot.manifest.mode === "window" ||
      this.carrot.manifest.view.hidden !== true;

    if (shouldCreateControllerWindow) {
      bootLog("creating carrot controller window", {
        id: this.carrot.manifest.id,
        url: this.carrot.viewUrl,
      });
      this.createControllerWindow();
    } else {
      bootLog("skipping hidden background controller window", {
        id: this.carrot.manifest.id,
      });
    }

    bootLog("posting carrot init", { id: this.carrot.manifest.id });
    this.worker.postMessage({
      type: "init",
      manifest: this.carrot.manifest,
      context: {
        statePath: this.statePath,
        logsPath: this.logsPath,
        permissions: flattenCarrotPermissions(this.carrot.install.permissionsGranted),
        grantedPermissions: this.carrot.install.permissionsGranted,
      },
    } satisfies CarrotWorkerMessage);

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
    if (this.carrot.manifest.mode !== "window") {
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
          invoke: async ({ method, params }) => this.invoke(method, params),
        },
        messages: {},
      },
    });

    const hidden =
      this.carrot.manifest.mode === "background" ||
      this.carrot.manifest.view.hidden === true;

    const win = new BrowserWindow({
      title: this.carrot.manifest.view.title,
      url: this.carrot.viewUrl,
      viewsRoot: this.carrot.currentDir,
      rpc,
      titleBarStyle: this.carrot.manifest.view.titleBarStyle ?? "default",
      transparent: this.carrot.manifest.view.transparent ?? false,
      hidden,
      frame: {
        width: this.carrot.manifest.view.width,
        height: this.carrot.manifest.view.height,
        x: 120,
        y: 120,
      },
    });

    this.controllerWindow = win;
    bootLog("controller window created", {
      id: this.carrot.manifest.id,
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

    win.on("close", () => {
      if (this.controllerWindow === win) {
        this.controllerWindow = null;
        if (this.status === "running" && this.carrot.manifest.mode === "window") {
          void this.stop();
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
        if (!hasHostPermission(this.carrot.install.permissionsGranted, "tray") || !this.tray) {
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
      case "stop-carrot": {
        this.pushLog("stop requested by carrot");
        await this.stop();
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

    this.tray = new Tray({ title: "Bunny Ears" });
    this.tray.setMenu(this.buildTrayMenu());
    this.tray.on("tray-clicked", (event: any) => {
      const action = event.data?.action;
      if (!action) return;
      void this.handleTrayAction(action);
    });
  }

  async boot() {
    bootLog("runtime boot begin", {
      installRoot: getInstalledCarrotsRoot(),
      carrotIds: Array.from(this.carrots.keys()),
    });
    this.openManagerWindow();
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
    bootLog("runtime boot complete");
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
    this.tray.setMenu(this.buildTrayMenu());
    (this.managerWindow?.webview.rpc as any)?.send?.dashboardChanged(this.dashboardState());
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
      { type: "normal" as const, label: "Install Carrot Source", action: "install-source" },
      { type: "normal" as const, label: "Install Carrot Artifact", action: "install-artifact" },
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
    if (action === "install-source") {
      await this.installCarrotSourceFromDisk();
      return;
    }
    if (action === "install-artifact") {
      await this.installCarrotArtifactFromDisk();
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
      if (carrot.carrot.manifest.mode === "background") {
        carrot.sendEvent("boot");
      }
      return;
    }
    if (verb === "stop") {
      await carrot.stop();
    }
  }

  private async installPreparedCarrot(
    prepared: PreparedCarrotInstall,
    grantedPermissions: CarrotPermissionGrant,
    options: { preserveRunningState?: boolean } = {},
  ) {
    try {
      const installed = prepared.install(grantedPermissions);
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
    win.on("close", () => {
      this.clearPendingConsent();
      if (this.managerWindow === win) {
        this.managerWindow = null;
      }
    });
  }
}

pruneLegacyPrototypeCarrots();
const refreshErrors = await refreshTrackedDevCarrots();
if (refreshErrors.length > 0) {
  console.error("[bunny-ears] dev carrot refresh failures", refreshErrors);
}

const runtime = new BunnyEarsRuntime();
await runtime.boot();
console.log("[bunny-ears] runtime booted");
