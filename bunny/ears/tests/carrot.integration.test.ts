import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CarrotManifest,
  CarrotPermissionGrant,
  CarrotWorkerMessage,
  HostActionMessage,
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
const CARROTS_ROOT = resolve(EARS_ROOT, "..", "carrots");
const PACKAGE_ROOT = resolve(EARS_ROOT, "..", "..", "package");

process.env.BUNNY_EARS_SDK_VIEW_MODULE = join(
  EARS_ROOT,
  "src",
  "carrot-runtime",
  "view.ts",
);
process.env.BUNNY_EARS_ZSTD_BIN = join(PACKAGE_ROOT, "dist-macos-arm64", "zig-zstd");

const { buildCarrotSource } = await import("../src/bun/carrotBuilder");

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

function actionTitle(message: HostActionMessage) {
  return (message.payload as { title?: string } | undefined)?.title;
}

async function buildCarrot(id: string) {
  const sourceDir = join(CARROTS_ROOT, id);
  const outDir = makeTempDir(`bunny-ears-${id}-build-`);
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
  const runtimeDir = makeTempDir(`bunny-ears-${id}-runtime-`);
  const statePath = join(runtimeDir, "state.json");
  const logsPath = join(runtimeDir, "logs.txt");
  const grantedPermissions = normalizeCarrotPermissions(
    permissionsOverride ?? built.manifest.permissions,
  );

  const worker = new Worker(join(built.outDir, built.manifest.worker.relativePath), {
    type: "module",
    permissions: toBunWorkerPermissions(grantedPermissions),
  });

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
        reject(new Error(`Timed out waiting for carrot message from ${id}`));
      }, timeoutMs);

      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  worker.onmessage = (event: MessageEvent<CarrotWorkerMessage>) => {
    queue.push(event.data);
    flushQueue();
  };

  worker.onerror = (event: ErrorEvent) => {
    const error = new Error(event.message || `${id} worker failed`);
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
    rmSync(runtimeDir, { recursive: true, force: true });
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
        throw new Error(response.error || `${id} request failed: ${method}`);
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
