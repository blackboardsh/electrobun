import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { toBunWorkerPermissions } from "../src/bun/workerPermissions";

const EARS_ROOT = resolve(import.meta.dir, "..");
const CARROTS_ROOT = resolve(EARS_ROOT, "..", "carrots");

process.env.BUNNY_EARS_SDK_VIEW_MODULE = join(
  EARS_ROOT,
  "src",
  "carrot-runtime",
  "view.ts",
);

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
});
