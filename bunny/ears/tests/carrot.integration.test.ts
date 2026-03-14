import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  CarrotManifest,
  CarrotPermissionGrant,
  CarrotWorkerMessage,
  HostActionMessage,
  HostRequestMessage,
  WorkerResponseMessage,
} from "../src/carrot-runtime/types";
import {
  flattenCarrotPermissions,
  normalizeCarrotPermissions,
} from "../src/carrot-runtime/types";
import { prepareArtifactPayloadFromPath } from "../src/bun/carrotArtifacts";
import { buildCarrotPermissionConsentRequest } from "../src/bun/carrotConsent";
import type { PreparedCarrotInstall } from "../src/bun/carrotStore";
import { toBunWorkerPermissions } from "../src/bun/workerPermissions";

const EARS_ROOT = resolve(import.meta.dir, "..");
const TEST_CARROTS_ROOT = resolve(EARS_ROOT, "..", "test-carrots");
const DASH_ROOT = resolve(EARS_ROOT, "..", "dash");
const PACKAGE_ROOT = resolve(EARS_ROOT, "..", "..", "package");
const COLAB_GOLDFISHDB_ROOT = resolve(
  EARS_ROOT,
  "..",
  "..",
  "..",
  "colab",
  "node_modules",
  "goldfishdb",
);

process.env.BUNNY_EARS_SDK_VIEW_MODULE = join(
  EARS_ROOT,
  "src",
  "carrot-runtime",
  "view.ts",
);
process.env.BUNNY_EARS_SDK_BUN_MODULE = join(
  EARS_ROOT,
  "src",
  "carrot-runtime",
  "bun.ts",
);
process.env.BUNNY_EARS_ZSTD_BIN = join(PACKAGE_ROOT, "dist-macos-arm64", "zig-zstd");

const { buildCarrotSource } = await import("../src/bun/carrotBuilder");
const GoldfishDB = (await import(COLAB_GOLDFISHDB_ROOT)).default;

const {
  array,
  boolean,
  collection,
  defaultOpts,
  number,
  object,
  schema,
  string,
} = GoldfishDB.v1.schemaType;

const layoutWindowSchema = object(
  {
    id: string({ required: true, internal: false }),
    title: string({ required: true, internal: false }),
    workspaceId: string({ required: true, internal: false }),
    mainTabIds: array(string(defaultOpts), { required: true, internal: false }),
    sideTabIds: array(string(defaultOpts), { required: true, internal: false }),
    currentMainTabId: string({ required: true, internal: false }),
    currentSideTabId: string({ required: true, internal: false }),
  },
  { required: true, internal: false },
);

const dashTestSchema = schema({
  v: 1,
  stores: {
    workspaces: collection({
      key: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      subtitle: string({ required: true, internal: false }),
      sortOrder: number({ required: true, internal: false }),
    }),
    projectMounts: collection({
      key: string({ required: true, internal: false }),
      workspaceId: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      instanceId: string({ required: true, internal: false }),
      instanceLabel: string({ required: true, internal: false }),
      path: string({ required: true, internal: false }),
      kind: string({ required: true, internal: false }),
      status: string({ required: true, internal: false }),
      sortOrder: number({ required: true, internal: false }),
    }),
    layouts: collection({
      key: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      description: string({ required: true, internal: false }),
      sortOrder: number({ required: true, internal: false }),
      windows: array(layoutWindowSchema, { required: true, internal: false }),
    }),
    sessionSnapshots: collection({
      key: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
      currentLayoutId: string({ required: true, internal: false }),
      currentWindowId: string({ required: true, internal: false }),
      windows: array(layoutWindowSchema, { required: true, internal: false }),
    }),
    uiSettings: collection({
      key: string({ required: true, internal: false }),
      sidebarCollapsed: boolean({ required: true, internal: false }),
      bunnyPopoverOpen: boolean({ required: true, internal: false }),
      currentLayoutId: string({ required: true, internal: false }),
      currentWindowId: string({ required: true, internal: false }),
      activeTreeNodeId: string({ required: true, internal: false }),
    }),
  },
});

type RunningCarrot = {
  manifest: CarrotManifest;
  statePath: string;
  cleanup: () => void;
  nextAction: (
    action: HostActionMessage["action"],
    predicate?: (message: HostActionMessage) => boolean,
  ) => Promise<HostActionMessage>;
  request: (method: string, params?: unknown) => Promise<unknown>;
  postEvent: (name: string, payload?: unknown) => void;
};

const cleanups = new Set<() => void>();

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups.clear();
});

function makeTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function isActionMessage(message: CarrotWorkerMessage): message is HostActionMessage {
  return message.type === "action";
}

function isResponseMessage(message: CarrotWorkerMessage): message is WorkerResponseMessage {
  return message.type === "response";
}

function isHostRequestMessage(message: CarrotWorkerMessage): message is HostRequestMessage {
  return message.type === "host-request";
}

function actionTitle(message: HostActionMessage) {
  return (message.payload as { title?: string } | undefined)?.title;
}

function flattenTree(
  nodes: Array<{ id: string; label: string; children?: Array<{ id: string; label: string; children?: any[] }> }>,
): Array<{ id: string; label: string }> {
  return nodes.flatMap((node) => [
    { id: node.id, label: node.label },
    ...(node.children ? flattenTree(node.children as any) : []),
  ]);
}

function createDashTestDb(dbFolder: string) {
  return new (GoldfishDB as any)().init({
    schemaHistory: [{ v: 1, schema: dashTestSchema, migrationSteps: false }],
    db_folder: dbFolder,
  });
}

function seedDashTestDb(db: ReturnType<typeof createDashTestDb>) {
  db.collection("workspaces").insert({
    key: "local-workspace",
    name: "Local Workspace",
    subtitle: "Project folders on this Bunny Ears instance.",
    sortOrder: 0,
  });

  db.collection("layouts").insert({
    key: "starter-lens",
    name: "Starter Lens",
    description: "Default Bunny Dash lens for local work.",
    sortOrder: 0,
    windows: [
      {
        id: "main",
        title: "Main",
        workspaceId: "local-workspace",
        mainTabIds: ["workspace"],
        sideTabIds: ["current-state"],
        currentMainTabId: "workspace",
        currentSideTabId: "current-state",
      },
    ],
  });

  db.collection("sessionSnapshots").insert({
    key: "last",
    updatedAt: Date.now(),
    currentLayoutId: "starter-lens",
    currentWindowId: "main",
    windows: [
      {
        id: "main",
        title: "Main",
        workspaceId: "local-workspace",
        mainTabIds: ["workspace"],
        sideTabIds: ["current-state"],
        currentMainTabId: "workspace",
        currentSideTabId: "current-state",
      },
    ],
  });

  db.collection("uiSettings").insert({
    key: "primary",
    sidebarCollapsed: false,
    bunnyPopoverOpen: false,
    currentLayoutId: "starter-lens",
    currentWindowId: "main",
    activeTreeNodeId: "lens-overview:starter-lens",
  });

  (db as any).trySave?.();
}

async function buildCarrot(id: string) {
  const sourceDir = join(TEST_CARROTS_ROOT, id);
  return buildCarrotAt(sourceDir, `bunny-ears-${id}-build-`);
}

async function buildCarrotAt(sourceDir: string, tempPrefix: string) {
  const outDir = makeTempDir(tempPrefix);
  const manifest = await buildCarrotSource(sourceDir, outDir);
  const cleanup = () => rmSync(outDir, { recursive: true, force: true });
  cleanups.add(cleanup);
  return {
    sourceDir,
    outDir,
    manifest,
    cleanup,
  };
}

async function startCarrot(
  id: string,
  permissionsOverride?: CarrotPermissionGrant,
): Promise<RunningCarrot> {
  const built = await buildCarrot(id);
  return startBuiltCarrot(built, permissionsOverride);
}

async function startBuiltCarrot(
  built: Awaited<ReturnType<typeof buildCarrotAt>>,
  permissionsOverride?: CarrotPermissionGrant,
  options?: {
    runtimeDir?: string;
    keepRuntime?: boolean;
    setupRuntime?: (args: { runtimeDir: string; statePath: string; logsPath: string }) => void | Promise<void>;
  },
): Promise<RunningCarrot> {
  const runtimeLabel = built.manifest.id || "carrot";
  const runtimeDir = options?.runtimeDir || makeTempDir(`bunny-ears-${runtimeLabel}-runtime-`);
  const statePath = join(runtimeDir, "state.json");
  const logsPath = join(runtimeDir, "logs.txt");
  const grantedPermissions = normalizeCarrotPermissions(
    permissionsOverride ?? built.manifest.permissions,
  );

  await options?.setupRuntime?.({
    runtimeDir,
    statePath,
    logsPath,
  });

  const worker = new Worker(join(built.outDir, built.manifest.worker.relativePath), {
    type: "module",
    permissions: toBunWorkerPermissions(grantedPermissions),
  });
  const fakeWindowFrames = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();

  const queue: CarrotWorkerMessage[] = [];
  const waiters: Array<{
    predicate: (message: CarrotWorkerMessage) => boolean;
    resolve: (message: CarrotWorkerMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  function flushQueue() {
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      const queueIndex = queue.findIndex(waiter.predicate);
      if (queueIndex === -1) {
        continue;
      }

      const [message] = queue.splice(queueIndex, 1);
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      index -= 1;
    }
  }

  function nextMessage(
    predicate: (message: CarrotWorkerMessage) => boolean,
    timeoutMs = 5000,
  ) {
    const queueIndex = queue.findIndex(predicate);
    if (queueIndex !== -1) {
      return Promise.resolve(queue.splice(queueIndex, 1)[0]);
    }

    return new Promise<CarrotWorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex !== -1) {
          waiters.splice(waiterIndex, 1);
        }
        reject(new Error(`Timed out waiting for carrot message from ${runtimeLabel}`));
      }, timeoutMs);

      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  worker.onmessage = (event: MessageEvent<CarrotWorkerMessage>) => {
    if (isHostRequestMessage(event.data)) {
      const method = event.data.method as string;
      let payload: unknown = null;
      let success = true;
      let error: string | undefined;

      switch (method) {
        case "open-file-dialog":
          payload = [];
          break;
        case "screen-get-primary-display":
          payload = {
            workArea: { x: 0, y: 0, width: 1440, height: 900 },
          };
          break;
        case "screen-get-cursor-screen-point":
          payload = { x: 720, y: 450 };
          break;
        case "window-get-frame":
          payload =
            fakeWindowFrames.get(
              String((event.data.params as { windowId?: string } | undefined)?.windowId || "main"),
            ) || {
              x: 120,
              y: 120,
              width: 1400,
              height: 920,
            };
          break;
        case "open-path":
        case "show-item-in-folder":
        case "clipboard-write-text":
          payload = true;
          break;
        default:
          success = false;
          error = `Unknown host request: ${method}`;
          break;
      }

      worker.postMessage({
        type: "host-response",
        requestId: event.data.requestId,
        success,
        payload,
        error,
      } satisfies CarrotWorkerMessage);
      return;
    }

    if (isActionMessage(event.data)) {
      if (event.data.action === "window-create") {
        const payload = event.data.payload as
          | {
              windowId?: string;
              options?: {
                frame?: { x?: number; y?: number; width?: number; height?: number };
              };
            }
          | undefined;
        const frame = payload?.options?.frame;
        fakeWindowFrames.set(payload?.windowId || "main", {
          x: frame?.x ?? 120,
          y: frame?.y ?? 120,
          width: frame?.width ?? 1400,
          height: frame?.height ?? 920,
        });
      } else if (event.data.action === "window-set-frame") {
        const payload = event.data.payload as
          | {
              windowId?: string;
              frame?: { x?: number; y?: number; width?: number; height?: number };
            }
          | undefined;
        const existing = fakeWindowFrames.get(payload?.windowId || "main") || {
          x: 120,
          y: 120,
          width: 1400,
          height: 920,
        };
        fakeWindowFrames.set(payload?.windowId || "main", {
          x: payload?.frame?.x ?? existing.x,
          y: payload?.frame?.y ?? existing.y,
          width: payload?.frame?.width ?? existing.width,
          height: payload?.frame?.height ?? existing.height,
        });
      }
    }

    queue.push(event.data);
    flushQueue();
  };

  worker.onerror = (event: ErrorEvent) => {
    const error = new Error(event.message || `${runtimeLabel} worker failed`);
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  worker.postMessage({
    type: "init",
    manifest: built.manifest,
    context: {
      statePath,
      logsPath,
      permissions: flattenCarrotPermissions(grantedPermissions),
      grantedPermissions,
    },
  } satisfies CarrotWorkerMessage);

  await nextMessage((message) => message.type === "ready");

  const cleanup = () => {
    worker.terminate();
    if (!options?.keepRuntime) {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
    built.cleanup();
  };
  cleanups.add(cleanup);

  return {
    manifest: built.manifest,
    statePath,
    cleanup,
    nextAction(action, predicate) {
      return nextMessage((message) => {
        if (!isActionMessage(message) || message.action !== action) {
          return false;
        }
        return predicate ? predicate(message) : true;
      }).then((message) => message as HostActionMessage);
    },
    async request(method, params) {
      const requestId = Math.floor(Math.random() * 1_000_000_000);
      worker.postMessage({
        type: "request",
        requestId,
        method,
        params,
      } satisfies CarrotWorkerMessage);

      const message = await nextMessage(
        (candidate) => isResponseMessage(candidate) && candidate.requestId === requestId,
      );
      const response = message as WorkerResponseMessage;

      if (!response.success) {
        throw new Error(response.error || `${runtimeLabel} request failed: ${method}`);
      }

      return response.payload;
    },
    postEvent(name, payload) {
      worker.postMessage({
        type: "event",
        name,
        payload,
      } satisfies CarrotWorkerMessage);
    },
  };
}

describe("Bunny Ears carrots", () => {
  test("permission consent requests enumerate requested host and Bun permissions", () => {
    const prepared: PreparedCarrotInstall = {
      manifest: {
        id: "consent-test",
        name: "Consent Test",
        version: "0.1.0",
        description: "Checks consent rendering",
        mode: "window",
        permissions: normalizeCarrotPermissions({
          host: {
            windows: true,
            notifications: true,
          },
          bun: {
            read: true,
            write: true,
            env: true,
          },
          isolation: "shared-worker",
        }),
        view: {
          relativePath: "views/index.html",
          title: "Consent Test",
          width: 640,
          height: 480,
        },
        worker: {
          relativePath: "worker.js",
        },
      },
      previousInstall: null,
      source: {
        kind: "local",
        path: "/tmp/consent-test",
      },
      devMode: true,
      lastBuildAt: Date.now(),
      currentHash: null,
      install: () => {
        throw new Error("not used");
      },
      cleanup: () => {},
    };

    const plan = buildCarrotPermissionConsentRequest(prepared, "request-1");
    expect(plan.request).not.toBeNull();
    expect(plan.request?.hostPermissions).toEqual(["windows", "notifications"]);
    expect(plan.request?.bunPermissions).toEqual(["read", "write", "env"]);
    expect(plan.request?.requestedPermissions).toContain("host:windows");
    expect(plan.request?.requestedPermissions).toContain("bun:read");
    expect(plan.request?.requestedPermissions).toContain("isolation:shared-worker");
  });

  test("permission consent is skipped when permissions match the current install", () => {
    const grantedPermissions = normalizeCarrotPermissions({
      host: { tray: true },
      bun: { read: true },
      isolation: "shared-worker",
    });
    const prepared: PreparedCarrotInstall = {
      manifest: {
        id: "consent-match",
        name: "Consent Match",
        version: "0.1.0",
        description: "Skips redundant prompts",
        mode: "background",
        permissions: grantedPermissions,
        view: {
          relativePath: "views/index.html",
          title: "Consent Match",
          width: 320,
          height: 240,
        },
        worker: {
          relativePath: "worker.js",
        },
      },
      previousInstall: {
        id: "consent-match",
        name: "Consent Match",
        version: "0.0.9",
        currentHash: null,
        installedAt: Date.now(),
        updatedAt: Date.now(),
        permissionsGranted: grantedPermissions,
        status: "installed",
        source: {
          kind: "local",
          path: "/tmp/consent-match",
        },
      },
      source: {
        kind: "local",
        path: "/tmp/consent-match",
      },
      devMode: true,
      lastBuildAt: Date.now(),
      currentHash: null,
      install: () => {
        throw new Error("not used");
      },
      cleanup: () => {},
    };

    const plan = buildCarrotPermissionConsentRequest(prepared, "request-2");
    expect(plan.request).toBeNull();
    expect(plan.grantedPermissions).toEqual(grantedPermissions);
  });

  test("Charlie builds from source and respects restricted Bun permissions", async () => {
    const carrot = await startCarrot("charlie");

    const readResult = (await carrot.request("probeFs")) as {
      probes: Record<string, string>;
    };
    expect(readResult.probes.read).toStartWith("allowed:");

    const envResult = (await carrot.request("probeEnv")) as {
      probes: Record<string, string>;
    };
    expect(envResult.probes.env).toStartWith("blocked:");

    const runResult = (await carrot.request("probeSpawn")) as {
      probes: Record<string, string>;
    };
    expect(runResult.probes.run).toStartWith("blocked:");

    const ffiResult = (await carrot.request("probeFFI")) as {
      probes: Record<string, string>;
    };
    expect(ffiResult.probes.ffi).toStartWith("blocked:");

    const incrementResult = (await carrot.request("increment")) as {
      count: number;
    };
    expect(incrementResult.count).toBe(1);
    expect(existsSync(carrot.statePath)).toBe(true);
  });

  test("carrot ApplicationMenu can set a menu and receive click events through electrobun/bun", async () => {
    const sourceDir = makeTempDir("bunny-ears-menu-carrot-source-");
    cleanups.add(() => rmSync(sourceDir, { recursive: true, force: true }));

    mkdirSync(join(sourceDir, "web"), { recursive: true });
    writeFileSync(
      join(sourceDir, "carrot.json"),
      JSON.stringify(
        {
          id: "menu-carrot",
          name: "Menu Carrot",
          version: "0.0.1",
          description: "ApplicationMenu test carrot",
          mode: "background",
          permissions: {
            host: {
              storage: true,
            },
          },
          view: {
            relativePath: "views/index.html",
            title: "Menu Carrot",
            width: 600,
            height: 400,
          },
          worker: {
            relativePath: "worker.js",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(sourceDir, "web", "index.html"), "<!doctype html><div>menu carrot</div>\n");
    writeFileSync(join(sourceDir, "web", "index.ts"), "export {};\n");
    writeFileSync(
      join(sourceDir, "worker.ts"),
      [
        'import { ApplicationMenu } from "electrobun/bun";',
        "",
        "ApplicationMenu.setApplicationMenu([",
        '  { label: "Menu Carrot", submenu: [{ label: "Workspace Settings", action: "workspace-settings" }] },',
        "]);",
        "",
        'ApplicationMenu.on("application-menu-clicked", (payload) => {',
        "  self.postMessage({",
        '    type: "action",',
        '    action: "log",',
        "    payload: { message: JSON.stringify(payload) },",
        "  });",
        "});",
        "",
        'self.postMessage({ type: "ready" });',
        "",
      ].join("\n"),
    );

    const built = await buildCarrotAt(sourceDir, "bunny-ears-menu-carrot-build-");
    const carrot = await startBuiltCarrot(built);

    const setMenu = await carrot.nextAction("set-application-menu");
    const menu = (setMenu.payload as { menu?: Array<{ label?: string; submenu?: Array<{ action?: string }> }> })
      .menu;
    expect(menu?.[0]?.label).toBe("Menu Carrot");
    expect(menu?.[0]?.submenu?.[0]?.action).toBe("workspace-settings");

    carrot.postEvent("application-menu-clicked", {
      action: "workspace-settings",
    });

    const logAction = await carrot.nextAction(
      "log",
      (message) =>
        typeof (message.payload as { message?: string } | undefined)?.message === "string" &&
        (message.payload as { message: string }).message.includes("workspace-settings"),
    );
    expect((logAction.payload as { message: string }).message).toContain("workspace-settings");
  });

  test("Bunny Dash builds from source and exposes a Colab-shaped shell snapshot", async () => {
    const built = await buildCarrotAt(DASH_ROOT, "bunny-ears-dash-build-");
    expect(built.manifest.id).toBe("bunny-dash");
    expect(built.manifest.dependencies).toEqual({
      "bunny.pty": "file:../foundation-carrots/pty",
      "bunny.search": "file:../foundation-carrots/search",
      "bunny.git": "file:../foundation-carrots/git",
    });
    expect(existsSync(join(built.outDir, "lens", "index.js"))).toBe(true);
    expect(existsSync(join(built.outDir, "lens", "index.css"))).toBe(true);
    expect(existsSync(join(built.outDir, "worker.js"))).toBe(true);
    expect(built.manifest.view.relativePath).toBe("lens/index.html");
    const html = await Bun.file(join(built.outDir, "lens", "index.html")).text();
    expect(html).toContain('href="views://lens/index.css"');

    const carrot = await startBuiltCarrot(built);
    const initialApplicationMenu = await carrot.nextAction("set-application-menu");
    expect(initialApplicationMenu.payload).toEqual({
      menu: [
      {
        label: "Bunny Dash",
        submenu: [{ role: "quit", accelerator: "cmd+q" }],
      },
      {
        label: "File",
        submenu: [
          { type: "normal", label: "Open File...", action: "open-file", accelerator: "cmd+o" },
          {
            type: "normal",
            label: "Open Folder...",
            action: "open-folder",
            accelerator: "cmd+shift+o",
          },
          { type: "separator" },
          {
            type: "normal",
            label: "New Browser Tab",
            action: "new-browser-tab",
            accelerator: "cmd+t",
          },
          { type: "normal", label: "Close Tab", action: "close-tab", accelerator: "cmd+w" },
          {
            type: "normal",
            label: "Close Window",
            action: "close-window",
            accelerator: "cmd+shift+w",
          },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            type: "normal",
            label: "Next Tab",
            action: "global-shortcut:ctrl+tab",
            accelerator: "ctrl+tab",
          },
          {
            type: "normal",
            label: "Previous Tab",
            action: "global-shortcut:ctrl+shift+tab",
            accelerator: "ctrl+shift+tab",
          },
        ],
      },
      {
        label: "Tools",
        submenu: [
          {
            type: "normal",
            label: "Command Palette",
            action: "open-command-palette",
            accelerator: "cmd+p",
          },
          {
            type: "normal",
            label: "Command Palette (Commands)",
            action: "global-shortcut:cmd+shift+p",
            accelerator: "cmd+shift+p",
          },
          {
            type: "normal",
            label: "Find in Files",
            action: "global-shortcut:cmd+shift+f",
            accelerator: "cmd+shift+f",
          },
        ],
      },
      {
        label: "Settings",
        submenu: [
          { type: "normal", label: "Plugins", action: "plugin-marketplace" },
          { type: "normal", label: "Llama Settings", action: "llama-settings" },
          { type: "normal", label: "Bunny Dash Settings", action: "colab-settings" },
          { type: "normal", label: "Workspace Settings", action: "workspace-settings" },
        ],
      },
      {
        role: "help",
        label: "Help",
        submenu: [
          { type: "normal", label: "Terms of Service", action: "terms-of-service" },
          { type: "normal", label: "Privacy Statement", action: "privacy-statement" },
          { type: "normal", label: "Acknowledgements", action: "acknowledgements" },
        ],
      },
      ],
    });
    const initialTray = await carrot.nextAction("set-tray");
    expect(initialTray.payload).toEqual({ title: "Dash: Starter Lens" });
    const initialTrayMenu = await carrot.nextAction("set-tray-menu");
    expect(Array.isArray(initialTrayMenu.payload)).toBe(true);

    const initialColabState = (await carrot.request("getInitialState")) as {
      buildVars: { channel: string };
      workspace: { id: string; name: string; windows: Array<{ id: string }> };
      bunnyDash: {
        currentWorkspaceId: string;
        currentLensId: string;
        workspaces: Array<{
          id: string;
          name: string;
          lenses: Array<{ id: string; name: string; isCurrent: boolean }>;
        }>;
      };
      projects: Array<{ id: string; name: string }>;
      tokens: unknown[];
      appSettings: { colabCloud: { email: string } };
    };
    expect(initialColabState.buildVars.channel).toBe("dev");
    expect(initialColabState.workspace.name).toBe("Local Workspace");
    expect(initialColabState.workspace.windows[0]?.id).toBe("main");
    expect(initialColabState.bunnyDash.currentWorkspaceId).toBe("local-workspace");
    expect(initialColabState.bunnyDash.currentLensId).toBe("starter-lens");
    expect(initialColabState.bunnyDash.workspaces[0]?.lenses[0]?.name).toBe("Starter Lens");
    expect(initialColabState.projects).toEqual([]);
    expect(initialColabState.tokens).toEqual([]);
    expect(initialColabState.appSettings.colabCloud.email).toBe("");

    const initial = (await carrot.request("getSnapshot")) as {
      shellTitle: string;
      cloudLabel: string;
      commandHint: string;
      currentLens: { id: string; name: string };
      currentWorkspace: { id: string; name: string };
      currentWindow: { id: string; title: string; currentMainTabId: string; currentSideTabId: string };
      openWindows: Array<{ id: string; title: string; workspaceName: string }>;
      workspaces: Array<{ id: string; name: string }>;
      topActions: Array<{ id: string; label: string }>;
      state: {
        activeTreeNodeId: string;
        commandPaletteOpen: boolean;
        sidebarCollapsed: boolean;
      };
      tree: Array<{ id: string; label: string }>;
    };
    expect(initial.shellTitle).toBe("Bunny Dash");
    expect(initial.cloudLabel).toBe("Bunny Cloud");
    expect(initial.currentLens.name).toBe("Starter Lens");
    expect(initial.currentWorkspace.name).toBe("Local Workspace");
    expect(initial.openWindows.length).toBe(1);
    expect(initial.workspaces.length).toBe(1);
    expect(initial.topActions.map((action) => action.label)).toEqual([
      "Command Palette",
      "Resume Current State",
      "Pop Out Bunny",
      "Bunny Cloud",
    ]);
    expect(initial.currentWindow.currentMainTabId).toBe("workspace");
    expect(initial.commandHint.length).toBeGreaterThan(0);

    const openBunnyRequest = carrot.request("send:openBunnyWindow", { screenX: 10, screenY: 20 });
    const openBunnyWindow = await carrot.nextAction("open-bunny-window");
    await openBunnyRequest;
    expect(openBunnyWindow.action).toBe("open-bunny-window");
    expect(openBunnyWindow.payload).toEqual({ screenX: 10, screenY: 20 });

    await carrot.request("send:createWorkspace");
    const createdWorkspaceState = (await carrot.request("getInitialState")) as {
      workspace: { name: string };
    };
    expect(createdWorkspaceState.workspace.name).toBe("Workspace 2");

    const palette = (await carrot.request("togglePalette")) as typeof initial;
    expect(palette.state.commandPaletteOpen).toBe(true);

    const cloud = (await carrot.request("openCloudPanel")) as typeof initial;
    expect(cloud.currentWindow.currentMainTabId).toBe("cloud");
    expect(cloud.currentWindow.currentSideTabId).toBe("cloud");
    expect(cloud.state.activeTreeNodeId).toBe(`lens-overview:${cloud.currentLens.id}`);

    const sidebar = (await carrot.request("toggleSidebar")) as typeof initial;
    expect(sidebar.state.sidebarCollapsed).toBe(true);
    expect(existsSync(carrot.statePath)).toBe(true);
  }, 20000);

  test("Bunny Dash uses GoldfishDB to create workspaces, attach projects, and save lenses", async () => {
    const built = await buildCarrotAt(DASH_ROOT, "bunny-ears-dash-goldfish-build-");
    const carrot = await startBuiltCarrot(built);
    const projectDir = makeTempDir("bunny-dash-project-");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "README.md"), "# Acme Studio\n");
    writeFileSync(join(projectDir, "src", "index.ts"), "export const dash = true;\n");

    await carrot.nextAction("set-tray");
    await carrot.nextAction("set-tray-menu");

    const createdWorkspace = (await carrot.request("createWorkspace", {
      name: "Acme Studio",
      subtitle: "Shared client work for Acme.",
    })) as {
      currentWorkspace: { id: string; name: string };
      workspaces: Array<{ id: string; name: string }>;
    };
    expect(createdWorkspace.currentWorkspace.name).toBe("Acme Studio");
    expect(createdWorkspace.workspaces.some((workspace) => workspace.name === "Acme Studio")).toBe(
      true,
    );

    const withProject = (await carrot.request("addProjectMount", {
      workspaceId: createdWorkspace.currentWorkspace.id,
      name: "acme-site",
      path: projectDir,
    })) as {
      tree: Array<{ id: string; label: string; children?: Array<{ id: string; label: string }> }>;
      workspaces: Array<{ id: string; name: string; projectCount: number }>;
      state: { activeTreeNodeId: string };
    };
    expect(withProject.state.activeTreeNodeId).toBe("project:acme-studio-acme-site");
    expect(
      withProject.workspaces.find((workspace) => workspace.id === createdWorkspace.currentWorkspace.id)
        ?.projectCount,
    ).toBe(1);
    const labels = flattenTree(withProject.tree).map((node) => node.label);
    expect(labels).toContain("README.md");
    expect(labels).toContain("src");

    const filePreview = (await carrot.request("selectNode", {
      nodeId: `fsfile:${join(projectDir, "README.md")}`,
    })) as {
      currentWindow: { currentMainTabId: string };
      mainTabs: Array<{ id: string; body: string }>;
    };
    expect(filePreview.currentWindow.currentMainTabId).toBe("projects");
    expect(filePreview.mainTabs.find((tab) => tab.id === "projects")?.body).toContain(
      "# Acme Studio",
    );

    const cloud = (await carrot.request("openCloudPanel")) as {
      currentWindow: { currentMainTabId: string; currentSideTabId: string };
    };
    expect(cloud.currentWindow.currentMainTabId).toBe("cloud");
    expect(cloud.currentWindow.currentSideTabId).toBe("cloud");

    const savedLens = (await carrot.request("saveLens", {
      name: "Acme Sprint",
      description: "Saved from the Acme workspace.",
    })) as {
      currentLens: { id: string; name: string };
      currentWindow: { id: string };
      lenses: Array<{ id: string; name: string }>;
    };
    expect(savedLens.currentLens.name).toBe("Acme Sprint");
    expect(savedLens.lenses.some((lens) => lens.name === "Acme Sprint")).toBe(true);

    const firstSuggestedLensName = (await carrot.request("getUniqueLensName", {
      workspaceId: createdWorkspace.currentWorkspace.id,
      baseName: "Lens",
    })) as string;
    expect(firstSuggestedLensName).toBe("Lens 1");

    const createdLensOne = (await carrot.request("createLens", {
      workspaceId: createdWorkspace.currentWorkspace.id,
      name: firstSuggestedLensName,
    })) as {
      currentLens: { id: string; name: string };
      lenses: Array<{ id: string; name: string }>;
    };
    expect(createdLensOne.currentLens.name).toBe("Lens 1");
    expect(createdLensOne.lenses.some((lens) => lens.name === "Lens 1")).toBe(true);

    const secondSuggestedLensName = (await carrot.request("getUniqueLensName", {
      workspaceId: createdWorkspace.currentWorkspace.id,
      baseName: "Lens",
    })) as string;
    expect(secondSuggestedLensName).toBe("Lens 2");

    const renamedLens = (await carrot.request("renameLens", {
      lensId: createdLensOne.currentLens.id,
      name: "Focus",
      description: "Renamed lens.",
    })) as {
      currentLens: { id: string; name: string };
      lenses: Array<{ id: string; name: string; description: string }>;
    };
    expect(renamedLens.currentLens.name).toBe("Focus");
    expect(
      renamedLens.lenses.some(
        (lens) => lens.id === createdLensOne.currentLens.id && lens.name === "Focus",
      ),
    ).toBe(true);

    const syncedState = (await carrot.request("getInitialState")) as {
      workspace: {
        id: string;
        name: string;
        color: string;
        windows: Array<{
          id: string;
          ui: { showSidebar: boolean; sidebarWidth: number };
          position: { x: number; y: number; width: number; height: number };
          expansions: string[];
          rootPane: any;
          currentPaneId: string;
          tabs: Record<string, any>;
        }>;
      };
    };
    const splitWorkspace = structuredClone(syncedState.workspace);
    const splitWindow = splitWorkspace.windows[0]!;
    splitWindow.rootPane = {
      id: "container-1",
      type: "container",
      direction: "row",
      divider: 50,
      panes: [
        {
          id: "left-pane",
          type: "pane",
          tabIds: ["workspace"],
          currentTabId: "workspace",
        },
        {
          id: "right-pane",
          type: "pane",
          tabIds: ["cloud"],
          currentTabId: "cloud",
        },
      ],
    };
    splitWindow.currentPaneId = "right-pane";
    splitWindow.tabs.workspace = {
      ...(splitWindow.tabs.workspace || {}),
      id: "workspace",
      paneId: "left-pane",
    };
    splitWindow.tabs.cloud = {
      ...(splitWindow.tabs.cloud || {}),
      id: "cloud",
      paneId: "right-pane",
    };
    await carrot.request("syncWorkspace", { workspace: splitWorkspace });

    const splitLens = (await carrot.request("saveLens", {
      name: "Acme Split",
      description: "Saved split pane state.",
    })) as {
      currentLens: { id: string; name: string };
      lenses: Array<{ id: string; name: string }>;
    };
    expect(splitLens.currentLens.name).toBe("Acme Split");

    const unsplitWorkspace = structuredClone(splitWorkspace);
    const unsplitWindow = unsplitWorkspace.windows[0]!;
    unsplitWindow.rootPane = {
      id: "root",
      type: "pane",
      tabIds: ["workspace"],
      currentTabId: "workspace",
    };
    unsplitWindow.currentPaneId = "root";
    unsplitWindow.tabs.workspace = {
      ...(unsplitWindow.tabs.workspace || {}),
      id: "workspace",
      paneId: "root",
    };
    await carrot.request("syncWorkspace", { workspace: unsplitWorkspace });

    await carrot.request("openLens", { lensId: splitLens.currentLens.id });
    const restoredSplitState = (await carrot.request("getInitialState")) as {
      workspace: {
        windows: Array<{
          rootPane: { type: string; panes?: Array<{ id: string }> };
          currentPaneId: string;
        }>;
      };
    };
    expect(restoredSplitState.workspace.windows[0]?.rootPane.type).toBe("container");
    expect(restoredSplitState.workspace.windows[0]?.currentPaneId).toBe("right-pane");

    const switchedWorkspace = (await carrot.request("openWorkspace", {
      workspaceId: createdWorkspace.currentWorkspace.id,
    })) as {
      currentWorkspace: { id: string; name: string };
      currentLens: { id: string; name: string };
      currentWindow: { id: string; currentMainTabId: string; currentSideTabId: string };
      openWindows: Array<{ id: string; workspaceName: string }>;
    };
    expect(switchedWorkspace.currentWorkspace.name).toBe("Acme Studio");
    expect(switchedWorkspace.currentLens.id).toBe(`__workspace-current__:${createdWorkspace.currentWorkspace.id}`);
    expect(switchedWorkspace.currentWindow.id).toBe("main");
    expect(switchedWorkspace.openWindows.length).toBe(1);

    const switchedStarterLens = (await carrot.request("activateLens", {
      lensId: "starter-lens",
    })) as {
      currentLens: { id: string; name: string };
      currentWorkspace: { id: string; name: string };
      currentWindow: { id: string };
      openWindows: Array<{ id: string }>;
    };
    expect(switchedStarterLens.currentLens.name).toBe("Starter Lens");
    expect(switchedStarterLens.currentWorkspace.name).toBe("Local Workspace");
    expect(switchedStarterLens.currentWindow.id).toBe("main");
    expect(switchedStarterLens.openWindows.length).toBe(1);

    const switchedSprintLens = (await carrot.request("activateLens", {
      lensId: savedLens.currentLens.id,
    })) as {
      currentLens: { id: string; name: string };
      currentWorkspace: { id: string; name: string };
      currentWindow: { id: string };
      openWindows: Array<{ id: string }>;
    };
    expect(switchedSprintLens.currentLens.name).toBe("Acme Sprint");
    expect(switchedSprintLens.currentWorkspace.name).toBe("Acme Studio");
    expect(switchedSprintLens.currentWindow.id).toBe("main");
    expect(switchedSprintLens.openWindows.length).toBe(1);

    carrot.postEvent("context-menu-clicked", {
      action: "workspace_open_in_new_window",
      data: { workspaceId: createdWorkspace.currentWorkspace.id },
    });
    const openedWorkspaceWindow = await carrot.nextAction(
      "focus-window",
      (message) =>
        typeof (message.payload as { windowId?: string } | undefined)?.windowId === "string" &&
        (message.payload as { windowId?: string } | undefined)?.windowId !== "main",
    );
    const workspaceContextState = (await carrot.request("getSnapshot")) as {
      currentWindow: { id: string };
      openWindows: Array<{ id: string }>;
    };
    const workspaceContextWindowId = (openedWorkspaceWindow.payload as { windowId: string }).windowId;
    expect(workspaceContextState.currentWindow.id).toBe(workspaceContextWindowId);
    expect(workspaceContextState.openWindows.length).toBe(2);

    const directWorkspaceWindowRequest = carrot.request("openWorkspaceInNewWindow", {
      workspaceId: createdWorkspace.currentWorkspace.id,
    });
    const directWorkspaceWindow = await carrot.nextAction(
      "focus-window",
      (message) =>
        typeof (message.payload as { windowId?: string } | undefined)?.windowId === "string" &&
        !["main", workspaceContextWindowId].includes(
          String((message.payload as { windowId?: string } | undefined)?.windowId || ""),
        ),
    );
    const directWorkspaceWindowState = (await directWorkspaceWindowRequest) as {
      currentWindow: { id: string };
      openWindows: Array<{ id: string }>;
    };
    const directWorkspaceWindowId = (directWorkspaceWindow.payload as { windowId: string }).windowId;
    expect(directWorkspaceWindowState.currentWindow.id).toBe(directWorkspaceWindowId);
    expect(directWorkspaceWindowState.openWindows.length).toBe(3);

    carrot.postEvent("context-menu-clicked", {
      action: "lens_open_in_new_window",
      data: { lensId: savedLens.currentLens.id },
    });
    const openedLensWindow = await carrot.nextAction(
      "focus-window",
      (message) =>
        typeof (message.payload as { windowId?: string } | undefined)?.windowId === "string" &&
        !["main", workspaceContextWindowId, directWorkspaceWindowId].includes(
          String((message.payload as { windowId?: string } | undefined)?.windowId || ""),
        ),
    );
    const lensContextState = (await carrot.request("getSnapshot")) as {
      currentLens: { id: string; name: string };
      currentWindow: { id: string };
      openWindows: Array<{ id: string }>;
      lenses: Array<{ id: string; name: string }>;
    };
    expect(lensContextState.currentWindow.id).toBe(
      (openedLensWindow.payload as { windowId: string }).windowId,
    );
    expect(lensContextState.currentLens.name).toBe("Acme Sprint");
    expect(lensContextState.openWindows.length).toBe(4);

    const directLensWindowRequest = carrot.request("openLensInNewWindow", {
      lensId: savedLens.currentLens.id,
    });
    const directLensWindow = await carrot.nextAction(
      "focus-window",
      (message) =>
        typeof (message.payload as { windowId?: string } | undefined)?.windowId === "string" &&
        ![
          "main",
          workspaceContextWindowId,
          directWorkspaceWindowId,
          (openedLensWindow.payload as { windowId: string }).windowId,
        ].includes(String((message.payload as { windowId?: string } | undefined)?.windowId || "")),
    );
    const directLensWindowState = (await directLensWindowRequest) as {
      currentLens: { id: string; name: string };
      currentWindow: { id: string };
      openWindows: Array<{ id: string }>;
    };
    expect(directLensWindowState.currentWindow.id).toBe(
      (directLensWindow.payload as { windowId: string }).windowId,
    );
    expect(directLensWindowState.currentLens.name).toBe("Acme Sprint");
    expect(directLensWindowState.openWindows.length).toBe(5);

    carrot.postEvent("context-menu-clicked", {
      action: "lens_fork",
      data: {
        lensId: savedLens.currentLens.id,
        windowId: savedLens.currentWindow.id,
      },
    });
    const forkSettings = await carrot.nextAction(
      "emit-view",
      (message) =>
        (message.payload as { name?: string; payload?: { mode?: string; sourceLensId?: string; name?: string } } | undefined)
          ?.name === "showLensSettings" &&
        (message.payload as { windowId?: string } | undefined)?.windowId ===
          savedLens.currentWindow.id &&
        (message.payload as { payload?: { sourceLensId?: string } } | undefined)?.payload?.sourceLensId ===
          savedLens.currentLens.id,
    );
    expect((forkSettings.payload as { payload: { mode: string; name: string } }).payload.mode).toBe(
      "create",
    );
    expect((forkSettings.payload as { payload: { name: string } }).payload.name).toBe(
      "Acme Sprint Copy",
    );

    const createdForkedLens = (await carrot.request("createLens", {
      workspaceId: createdWorkspace.currentWorkspace.id,
      sourceLensId: savedLens.currentLens.id,
      name: "Acme Sprint Copy",
      description: "Forked from Acme Sprint",
    })) as {
      lenses: Array<{ id: string; name: string }>;
    };
    expect(createdForkedLens.lenses.some((lens) => lens.name === "Acme Sprint Copy")).toBe(true);

    const forkedLens = createdForkedLens.lenses.find((lens) => lens.name === "Acme Sprint Copy");
    expect(forkedLens).toBeTruthy();
    carrot.postEvent("context-menu-clicked", {
      action: "lens_delete",
      data: {
        lensId: forkedLens!.id,
        windowId: savedLens.currentWindow.id,
      },
    });
    await carrot.nextAction(
      "emit-view",
      (message) =>
        (message.payload as { name?: string } | undefined)?.name === "refreshBunnyDashState",
    );
    await carrot.nextAction(
      "log",
      (message) =>
        typeof (message.payload as { message?: string } | undefined)?.message === "string" &&
        (message.payload as { message: string }).message.includes("lens deleted: Acme Sprint Copy"),
    );
    const deletedLensState = (await carrot.request("getSnapshot")) as {
      lenses: Array<{ id: string; name: string }>;
    };
    expect(deletedLensState.lenses.some((lens) => lens.name === "Acme Sprint Copy")).toBe(false);

    const goldfishDbPath = join(dirname(carrot.statePath), "goldfishdb", "goldfish.db");
    expect(existsSync(goldfishDbPath)).toBe(true);
  }, 20000);

  test("Bunny Dash reopens the windows that were open when the worker restarts", async () => {
    const runtimeDir = makeTempDir("bunny-ears-dash-reopen-runtime-");
    cleanups.add(() => rmSync(runtimeDir, { recursive: true, force: true }));

    const firstBuilt = await buildCarrotAt(DASH_ROOT, "bunny-ears-dash-reopen-build-a-");
    const first = await startBuiltCarrot(firstBuilt, undefined, {
      runtimeDir,
      keepRuntime: true,
    });

    await first.nextAction("set-tray");
    await first.nextAction("set-tray-menu");

    await first.request("createWorkspace", {
      name: "Restart Workspace",
      subtitle: "Restored after restart.",
    });

    await first.request("saveLens", {
      name: "Restart Lens",
      description: "Saved before restart.",
    });

    const openLensInNewWindow = first.request("openLensInNewWindow", {
      lensId: "restart-lens",
    });
    const secondWindowFocus = await first.nextAction(
      "focus-window",
      (message) =>
        typeof (message.payload as { windowId?: string } | undefined)?.windowId === "string" &&
        (message.payload as { windowId?: string }).windowId !== "main",
    );
    await openLensInNewWindow;
    const secondWindowId = (secondWindowFocus.payload as { windowId: string }).windowId;

    const beforeRestart = (await first.request("getSnapshot")) as {
      openWindows: Array<{ id: string }>;
    };
    expect(beforeRestart.openWindows.map((window) => window.id).sort()).toEqual(
      ["main", secondWindowId].sort(),
    );

    first.cleanup();
    cleanups.delete(first.cleanup);

    const secondBuilt = await buildCarrotAt(DASH_ROOT, "bunny-ears-dash-reopen-build-b-");
    const second = await startBuiltCarrot(secondBuilt, undefined, {
      runtimeDir,
      keepRuntime: true,
    });

    const recreatedMain = await second.nextAction(
      "window-create",
      (message) => (message.payload as { windowId?: string } | undefined)?.windowId === "main",
    );
    const recreatedSecond = await second.nextAction(
      "window-create",
      (message) =>
        (message.payload as { windowId?: string } | undefined)?.windowId === secondWindowId,
    );
    expect((recreatedMain.payload as { windowId?: string }).windowId).toBe("main");
    expect((recreatedSecond.payload as { windowId?: string }).windowId).toBe(secondWindowId);

    const afterRestart = (await second.request("getSnapshot")) as {
      openWindows: Array<{ id: string }>;
    };
    expect(afterRestart.openWindows.map((window) => window.id).sort()).toEqual(
      ["main", secondWindowId].sort(),
    );
  }, 20000);

  test("Bunny Dash exposes the Colab PTY terminal backend", async () => {
    const built = await buildCarrotAt(DASH_ROOT, "bunny-ears-dash-terminal-build-");
    expect(existsSync(join(built.outDir, process.platform === "win32" ? "colab-pty.exe" : "colab-pty"))).toBe(true);

    const carrot = await startBuiltCarrot(built);
    await carrot.nextAction("set-tray");
    await carrot.nextAction("set-tray-menu");

    const terminalId = (await carrot.request("createTerminal", {
      cwd: tmpdir(),
    })) as string;
    expect(typeof terminalId).toBe("string");
    expect(terminalId.length).toBeGreaterThan(0);

    const output = await carrot.nextAction(
      "emit-view",
      (message) =>
        (message.payload as { name?: string; payload?: { terminalId?: string; data?: string } } | undefined)
          ?.name === "terminalOutput" &&
        (message.payload as { payload?: { terminalId?: string } } | undefined)?.payload?.terminalId === terminalId,
    );
    expect((output.payload as { name: string }).name).toBe("terminalOutput");

    const cwd = (await carrot.request("getTerminalCwd", { terminalId })) as string | null;
    expect(cwd).toBe(realpathSync(tmpdir()));

    const killed = (await carrot.request("killTerminal", { terminalId })) as boolean;
    expect(killed).toBe(true);
  }, 20000);

  test("Bunny Dash migrates the old current-session seed into the starter lens and current state", async () => {
    const built = await buildCarrotAt(DASH_ROOT, "bunny-ears-dash-migrate-build-");
    const carrot = await startBuiltCarrot(built, undefined, {
      setupRuntime({ runtimeDir }) {
        const dbFolder = join(runtimeDir, "goldfishdb");
        const db = createDashTestDb(dbFolder);
        seedDashTestDb(db);

        const layoutDoc = db
          .collection("layouts")
          .query({
            where: (item: { key: string }) => item.key === "starter-lens",
            limit: 1,
          }).data?.[0];
        const snapshotDoc = db
          .collection("sessionSnapshots")
          .query({
            where: (item: { key: string }) => item.key === "last",
            limit: 1,
          }).data?.[0];
        const uiDoc = db
          .collection("uiSettings")
          .query({
            where: (item: { key: string }) => item.key === "primary",
            limit: 1,
          }).data?.[0];

        expect(layoutDoc).toBeTruthy();
        expect(snapshotDoc).toBeTruthy();
        expect(uiDoc).toBeTruthy();

        const legacyWindow = {
          id: "main",
          title: "Main",
          workspaceId: "local-workspace",
          mainTabIds: ["workspace", "projects", "lens", "instances", "cloud"],
          sideTabIds: ["current-state", "windows", "notes", "cloud"],
          currentMainTabId: "lens",
          currentSideTabId: "current-state",
        };

        db.collection("layouts").update(layoutDoc!.id, {
          key: "current-session",
          name: "Current Session",
          description: "Local Bunny Dash window layout.",
          windows: [legacyWindow],
        });
        db.collection("sessionSnapshots").update(snapshotDoc!.id, {
          currentLayoutId: "current-session",
          currentWindowId: "main",
          windows: [legacyWindow],
        });
        db.collection("uiSettings").update(uiDoc!.id, {
          currentLayoutId: "current-session",
          currentWindowId: "main",
          activeTreeNodeId: "lens-overview:current-session",
        });

        (db as any).trySave?.();
      },
    });

    await carrot.nextAction("set-tray");
    await carrot.nextAction("set-tray-menu");

    const initial = (await carrot.request("getSnapshot")) as {
      currentLens: { id: string; name: string };
      currentWindow: { currentMainTabId: string; currentSideTabId: string };
      mainTabs: Array<{ id: string }>;
      sideTabs: Array<{ id: string }>;
      state: { activeTreeNodeId: string };
    };

    expect(initial.currentLens.id).toBe("starter-lens");
    expect(initial.currentLens.name).toBe("Starter Lens");
    expect(initial.currentWindow.currentMainTabId).toBe("workspace");
    expect(initial.currentWindow.currentSideTabId).toBe("current-state");
    expect(initial.mainTabs.map((tab) => tab.id)).toEqual(["workspace"]);
    expect(initial.sideTabs.map((tab) => tab.id)).toEqual(["current-state"]);
    expect(initial.state.activeTreeNodeId).toBe("lens-overview:starter-lens");

    const persistedState = JSON.parse(readFileSync(carrot.statePath, "utf8")) as {
      lens: { id: string; name: string };
      sessionSnapshot: { windows: Array<{ mainTabIds: string[]; sideTabIds: string[] }> };
      currentState: { windows: Array<{ mainTabIds: string[]; sideTabIds: string[] }> };
    };
    expect(persistedState.lens).toEqual({ id: "starter-lens", name: "Starter Lens" });
    expect(persistedState.sessionSnapshot.windows[0]?.mainTabIds).toEqual(["workspace"]);
    expect(persistedState.sessionSnapshot.windows[0]?.sideTabIds).toEqual(["current-state"]);
    expect(persistedState.currentState.windows[0]?.mainTabIds).toEqual(["workspace"]);
    expect(persistedState.currentState.windows[0]?.sideTabIds).toEqual(["current-state"]);
  }, 20000);

  test("Forrager emits tray and notification actions from its built worker", async () => {
    const carrot = await startCarrot("forrager");

    const initialTray = await carrot.nextAction(
      "set-tray",
      (message) => actionTitle(message) === "Forrager: Calm",
    );
    expect(initialTray.payload).toEqual({ title: "Forrager: Calm" });

    const initialMenu = await carrot.nextAction("set-tray-menu");
    expect(Array.isArray(initialMenu.payload)).toBe(true);

    carrot.postEvent("tray", { action: "ping" });
    const notify = await carrot.nextAction(
      "notify",
      (message) => actionTitle(message) === "Forrager: Calm",
    );
    expect(notify.payload).toEqual({
      title: "Forrager: Calm",
      body: "Background Carrot idling in the tray.",
    });

    carrot.postEvent("tray", { action: "cycle" });
    const cycledTray = await carrot.nextAction(
      "set-tray",
      (message) => actionTitle(message) === "Forrager: Focus",
    );
    expect(cycledTray.payload).toEqual({ title: "Forrager: Focus" });

    carrot.postEvent("tray", { action: "stop" });
    const stopRequest = await carrot.nextAction("stop-carrot");
    expect(stopRequest.action).toBe("stop-carrot");

    const status = (await carrot.request("getStatus")) as {
      label: string;
      body: string;
    };
    expect(status.label).toBe("Forrager: Focus");
    expect(status.body).toBe("Forrager switched to focus mode.");
  });

  test("Charlie can be prepared from a local update.json artifact", async () => {
    const built = await buildCarrot("charlie");
    const artifactRoot = makeTempDir("bunny-ears-charlie-artifact-");
    const payloadDir = join(artifactRoot, "charlie-artifact");
    mkdirSync(payloadDir, { recursive: true });
    cpSync(built.outDir, payloadDir, { recursive: true, force: true });

    const tarPath = join(artifactRoot, "charlie.tar");
    const tarballPath = join(artifactRoot, "charlie-artifact.tar.zst");
    const tarResult = Bun.spawnSync(["tar", "-cf", tarPath, "-C", artifactRoot, "charlie-artifact"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(tarResult.exitCode).toBe(0);

    const zstdResult = Bun.spawnSync(
      [
        process.env.BUNNY_EARS_ZSTD_BIN!,
        "compress",
        "-i",
        tarPath,
        "-o",
        tarballPath,
        "--no-timing",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(zstdResult.exitCode).toBe(0);

    const updatePath = join(artifactRoot, "update.json");
    writeFileSync(
      updatePath,
      JSON.stringify(
        {
          version: built.manifest.version,
          hash: "charlie-local-hash",
          tarball: "charlie-artifact.tar.zst",
        },
        null,
        2,
      ),
    );

    const prepared = await prepareArtifactPayloadFromPath(updatePath, artifactRoot);
    cleanups.add(() => prepared.cleanup());

    expect(prepared.source.kind).toBe("artifact");
    if (prepared.source.kind !== "artifact") {
      throw new Error("Expected artifact source");
    }
    expect(prepared.source.updateLocation).toBe(updatePath);
    expect(prepared.currentHash).toBe("charlie-local-hash");

    const preparedManifest = JSON.parse(
      await Bun.file(join(prepared.payloadDir, "carrot.json")).text(),
    ) as CarrotManifest;
    expect(preparedManifest.id).toBe("charlie");
    expect(existsSync(join(prepared.payloadDir, "worker.js"))).toBe(true);
    expect(existsSync(join(prepared.payloadDir, "views", "index.html"))).toBe(true);
  });
});
