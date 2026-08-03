// CEF Origin Private File System (OPFS) integration regression.

import { BrowserView, BuildConfig } from "electrobun/main";
import { defineTest, expect } from "../test-framework/types";

type OpfsOperation =
  | { action: "read"; name: string }
  | { action: "write"; name: string; value: string }
  | { action: "delete"; name: string };

type OpfsResult = {
  ok: boolean;
  value?: string | null;
  written?: number;
  error?: string;
};

type OpfsHarness = {
  pageUrl: string;
  results: Map<string, OpfsResult>;
};

const workerSource = String.raw`
self.onmessage = async ({ data }) => {
  let accessHandle;
  let step = "open OPFS root";
  try {
    const root = await navigator.storage.getDirectory();

    if (data.action === "delete") {
      step = "delete OPFS entry";
      try {
        await root.removeEntry(data.name);
      } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
      }
      self.postMessage({ ok: true });
      return;
    }

    let fileHandle;
    try {
      step = "open OPFS file";
      fileHandle = await root.getFileHandle(data.name, {
        create: data.action === "write",
      });
    } catch (error) {
      if (data.action === "read" && error?.name === "NotFoundError") {
        self.postMessage({ ok: true, value: null });
        return;
      }
      throw error;
    }

    step = "create sync access handle";
    accessHandle = await fileHandle.createSyncAccessHandle();

    if (data.action === "write") {
      step = "write through sync access handle";
      const bytes = new TextEncoder().encode(data.value);
      accessHandle.truncate(0);
      const written = accessHandle.write(bytes, { at: 0 });
      accessHandle.flush();
      self.postMessage({ ok: true, written });
      return;
    }

    step = "read through sync access handle";
    const bytes = new Uint8Array(accessHandle.getSize());
    accessHandle.read(bytes, { at: 0 });
    self.postMessage({ ok: true, value: new TextDecoder().decode(bytes) });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: step + ": " + String(error?.name || "Error") + ": " +
        String(error?.stack || error?.message || error),
    });
  } finally {
    accessHandle?.close();
  }
};
`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const opfsPage = `<!doctype html>
<html>
<head><title>OPFS regression</title></head>
<body>
<script>
(() => {
  const params = new URLSearchParams(location.search);
  const taskId = params.get("taskId");
  if (!taskId) return;

  const operation = {
    action: params.get("action"),
    name: params.get("name"),
    value: params.get("value"),
  };
  const workerUrl = URL.createObjectURL(
    new Blob([${JSON.stringify(workerSource)}], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl);
  let finished = false;

  const report = async (result) => {
    if (finished) return;
    finished = true;
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    await fetch("/result?taskId=" + encodeURIComponent(taskId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
  };

  const timeout = setTimeout(() => {
    report({ ok: false, error: "OPFS worker timed out" });
  }, 10000);
  worker.onmessage = ({ data }) => {
    clearTimeout(timeout);
    report(data);
  };
  worker.onerror = ({ message }) => {
    clearTimeout(timeout);
    report({ ok: false, error: message });
  };
  worker.postMessage(operation);
})();
</script>
</body>
</html>`;

let taskCounter = 0;

async function runOpfsOperation(
  webview: BrowserView<any>,
  harness: OpfsHarness,
  operation: OpfsOperation,
): Promise<OpfsResult> {
  const taskId = `opfs-${Date.now()}-${++taskCounter}`;
  const url = new URL(harness.pageUrl);
  url.searchParams.set("taskId", taskId);
  url.searchParams.set("action", operation.action);
  url.searchParams.set("name", operation.name);
  if (operation.action === "write") {
    url.searchParams.set("value", operation.value);
  }
  webview.loadURL(url.href);

  const deadline = Date.now() + 15000;
  let result: OpfsResult | undefined;
  while (Date.now() < deadline) {
    result = harness.results.get(taskId);
    if (result) {
      harness.results.delete(taskId);
      break;
    }
    await sleep(50);
  }

  if (!result?.ok) {
    throw new Error(
      `OPFS ${operation.action} failed: ${result?.error ?? "page did not report a result"}`,
    );
  }

  return result;
}

async function createPartitionView(
  windowId: number,
  partition: string,
  pageUrl: string,
): Promise<BrowserView<any>> {
  const view = new BrowserView({
    windowId,
    renderer: "cef",
    partition,
    url: pageUrl,
    frame: { x: 0, y: 0, width: 640, height: 480 },
  });

  // CEF creates and navigates the browser asynchronously.
  await sleep(1000);
  return view;
}

export const opfsTests = [
  defineTest({
    name: "CEF OPFS persistent partitions and isolation",
    category: "Session",
    description:
      "Verify sync-access OPFS, persist:default sharing, named persistent isolation, and ephemeral reset",
    timeout: 90000,
    async run({ createWindow, log }) {
      if (process.platform !== "linux" && process.platform !== "win32") {
        log("Skipping the CEF OPFS regression on this platform");
        return;
      }

      const buildConfig = BuildConfig.getSync();
      if (!buildConfig.availableRenderers.includes("cef")) {
        log("Skipping OPFS because this kitchen variant does not bundle CEF");
        return;
      }

      // Chromium does not grant OPFS to Electrobun's custom views:// scheme.
      // A loopback origin is potentially trustworthy and exercises the same
      // origin/profile path that applications use for SQLite-backed web apps.
      // Keep the port stable so a second app process opens the same OPFS origin.
      const port = buildConfig.mainProcess === "bun" ? 19383 : 19382;
      const pageUrl = `http://127.0.0.1:${port}/opfs.html`;
      const results = new Map<string, OpfsResult>();
      const harness = { pageUrl, results };
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/result" && request.method === "POST") {
            const taskId = url.searchParams.get("taskId");
            if (!taskId) return new Response("Missing taskId", { status: 400 });
            results.set(taskId, (await request.json()) as OpfsResult);
            return new Response("ok");
          }
          if (url.pathname === "/opfs.html") {
            return new Response(opfsPage, {
              headers: {
                "Cache-Control": "no-store",
                "Content-Type": "text/html; charset=utf-8",
              },
            });
          }
          return new Response("Not found", { status: 404 });
        },
      });

      const host = await createWindow({
        url: pageUrl,
        title: "CEF OPFS Regression",
        renderer: "cef",
        hidden: true,
        activate: false,
      });
      const createdViews: BrowserView<any>[] = [];
      const runToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const isolatedFile = `electrobun-opfs-isolation-${runToken}`;
      const restartFile = "electrobun-opfs-restart-v1";
      const restartValue = "electrobun-opfs-persisted-v1";
      const namedRestartFile = "electrobun-opfs-named-restart-v1";
      const namedRestartValue = "electrobun-opfs-named-persisted-v1";

      await sleep(1000);

      try {
        // The public default maps to persist:default. Leave this fixed marker in
        // place so running the focused test again in a new app process verifies
        // real process-restart persistence as well as same-process sharing.
        const beforeRestart = await runOpfsOperation(host.webview, harness, {
          action: "read",
          name: restartFile,
        });
        if (beforeRestart.value !== null) {
          expect(beforeRestart.value, "persisted restart marker").toBe(restartValue);
        }

        const defaultWrite = await runOpfsOperation(host.webview, harness, {
          action: "write",
          name: restartFile,
          value: restartValue,
        });
        expect(defaultWrite.written, "sync access handle bytes written").toBe(
          restartValue.length,
        );

        const sharedDefault = await createPartitionView(
          host.id,
          "persist:default",
          pageUrl,
        );
        createdViews.push(sharedDefault);
        const sharedDefaultRead = await runOpfsOperation(sharedDefault, harness, {
          action: "read",
          name: restartFile,
        });
        expect(sharedDefaultRead.value, "persist:default shared profile").toBe(
          restartValue,
        );

        const persistentA = await createPartitionView(
          host.id,
          "persist:electrobun-opfs-regression-a",
          pageUrl,
        );
        createdViews.push(persistentA);
        const namedBeforeRestart = await runOpfsOperation(
          persistentA,
          harness,
          { action: "read", name: namedRestartFile },
        );
        if (namedBeforeRestart.value !== null) {
          expect(namedBeforeRestart.value, "named persisted restart marker").toBe(
            namedRestartValue,
          );
        }
        await runOpfsOperation(persistentA, harness, {
          action: "write",
          name: namedRestartFile,
          value: namedRestartValue,
        });
        await runOpfsOperation(persistentA, harness, {
          action: "write",
          name: isolatedFile,
          value: `account-a-${runToken}`,
        });
        persistentA.remove();
        await sleep(300);

        const reopenedA = await createPartitionView(
          host.id,
          "persist:electrobun-opfs-regression-a",
          pageUrl,
        );
        createdViews.push(reopenedA);
        const reopenedARead = await runOpfsOperation(reopenedA, harness, {
          action: "read",
          name: isolatedFile,
        });
        expect(reopenedARead.value, "named persistent profile reopens").toBe(
          `account-a-${runToken}`,
        );

        const persistentB = await createPartitionView(
          host.id,
          "persist:electrobun-opfs-regression-b",
          pageUrl,
        );
        createdViews.push(persistentB);
        const isolatedBeforeWrite = await runOpfsOperation(persistentB, harness, {
          action: "read",
          name: isolatedFile,
        });
        expect(isolatedBeforeWrite.value, "named persistent profile isolation").toBeNull();
        await runOpfsOperation(persistentB, harness, {
          action: "write",
          name: isolatedFile,
          value: `account-b-${runToken}`,
        });
        const persistentARead = await runOpfsOperation(reopenedA, harness, {
          action: "read",
          name: isolatedFile,
        });
        expect(persistentARead.value, "profile A remains isolated from B").toBe(
          `account-a-${runToken}`,
        );

        const ephemeral = await createPartitionView(
          host.id,
          "temp:electrobun-opfs-regression",
          pageUrl,
        );
        createdViews.push(ephemeral);
        await runOpfsOperation(ephemeral, harness, {
          action: "write",
          name: isolatedFile,
          value: `ephemeral-${runToken}`,
        });
        ephemeral.remove();
        await sleep(300);

        const reopenedEphemeral = await createPartitionView(
          host.id,
          "temp:electrobun-opfs-regression",
          pageUrl,
        );
        createdViews.push(reopenedEphemeral);
        const ephemeralRead = await runOpfsOperation(reopenedEphemeral, harness, {
          action: "read",
          name: isolatedFile,
        });
        expect(ephemeralRead.value, "named ephemeral profile reset").toBeNull();

        await runOpfsOperation(reopenedA, harness, {
          action: "delete",
          name: isolatedFile,
        });
        await runOpfsOperation(persistentB, harness, {
          action: "delete",
          name: isolatedFile,
        });

        log(
          beforeRestart.value === restartValue &&
              namedBeforeRestart.value === namedRestartValue
            ? "OPFS sync handles passed; default and named markers survived an earlier app process"
            : "OPFS sync handles and partition semantics passed; restart markers primed for the next app process",
        );
      } finally {
        for (const view of createdViews) {
          view.remove();
        }
        await server.stop(true);
      }
    },
  }),
];
