// RPC Tests - Tests for bidirectional RPC communication

import { defineTest, expect } from "../test-framework/types";
import { BrowserView } from "electrobun/bun";
import type {
  HostSocketStressState,
  SocketSendSummary,
  StressMessageStats,
  StressRequestSummary,
  TestHarnessRPC,
} from "../test-harness/index";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function createStressMessageCollector() {
  const ids = new Set<number>();
  const duplicates = new Set<number>();

  return {
    reset() {
      ids.clear();
      duplicates.clear();
    },
    record(id: number) {
      if (ids.has(id)) {
        duplicates.add(id);
      }
      ids.add(id);
    },
    getStats(expectedCount: number): StressMessageStats {
      const missing: number[] = [];
      for (let id = 0; id < expectedCount; id++) {
        if (!ids.has(id)) {
          missing.push(id);
        }
      }

      return {
        count: ids.size,
        expectedCount,
        missing,
        duplicates: Array.from(duplicates).sort((a, b) => a - b),
      };
    },
  };
}

type StressValueCollector<T> = {
  set(value: T): void;
  wait(label: string, timeoutMs?: number): Promise<T>;
};

function createStressValueCollector<T>(): StressValueCollector<T> {
  let value: T | undefined;

  return {
    set(nextValue: T) {
      value = nextValue;
    },
    async wait(label: string, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (value !== undefined) {
          return value;
        }
        await sleep(50);
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
  };
}

function describeStressFailure(label: string, stats: StressMessageStats) {
  return [
    `${label}: expected ${stats.expectedCount}, received ${stats.count}`,
    `missing=${stats.missing.length ? stats.missing.slice(0, 20).join(",") : "none"}`,
    `duplicates=${stats.duplicates.length ? stats.duplicates.slice(0, 20).join(",") : "none"}`,
  ].join("; ");
}

async function waitForStressStats(
  readStats: () => StressMessageStats | Promise<StressMessageStats>,
  expectedCount: number,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let stats = await readStats();

  while (
    Date.now() < deadline &&
    (stats.count < expectedCount || stats.missing.length > 0)
  ) {
    await sleep(50);
    stats = await readStats();
  }

  return stats;
}

function assertAllStressMessagesArrived(label: string, stats: StressMessageStats) {
  if (
    stats.count !== stats.expectedCount ||
    stats.missing.length > 0 ||
    stats.duplicates.length > 0
  ) {
    throw new Error(describeStressFailure(label, stats));
  }
}

async function waitForHostSocketOpen(webviewRpc: any, timeoutMs = 10000): Promise<HostSocketStressState> {
	const deadline = Date.now() + timeoutMs;
	let lastState: HostSocketStressState | undefined;

	while (Date.now() < deadline) {
		const currentState = await webviewRpc.request.getHostSocketStressState({}) as HostSocketStressState;
		lastState = currentState;
		if (currentState.readyState === 1) {
			return currentState;
		}
		await sleep(100);
	}

  throw new Error(`Timed out waiting for webview host socket to open: ${JSON.stringify(lastState)}`);
}

// Create RPC config for test harness
type StressHandlers = {
  bunStressMessages?: ReturnType<typeof createStressMessageCollector>;
  webviewMessageSummary?: StressValueCollector<StressMessageStats>;
  webviewRequestSummary?: StressValueCollector<StressRequestSummary>;
  socketSendSummary?: StressValueCollector<SocketSendSummary>;
};

export function createTestHarnessRPC(
  maxRequestTime = 10000,
  stressHandlers: StressHandlers = {},
) {
  return BrowserView.defineRPC<TestHarnessRPC>({
    maxRequestTime,
    handlers: {
      requests: {
        echo: ({ value }) => value,
        add: ({ a, b }) => a + b,
        throwError: ({ message }) => {
          throw new Error(message || "Intentional test error");
        },
        delayed: async ({ ms, value }) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          return value;
        },
      },
      messages: {
        ping: ({ timestamp }) => {
          console.log(`Received ping at ${timestamp}`);
        },
        stressMessageToBun: ({ id }) => {
          stressHandlers.bunStressMessages?.record(id);
        },
        stressWebviewMessageSummary: (stats) => {
          stressHandlers.webviewMessageSummary?.set(stats);
        },
        stressWebviewRequestSummary: (summary) => {
          stressHandlers.webviewRequestSummary?.set(summary);
        },
        stressSocketSendSummary: (summary) => {
          stressHandlers.socketSendSummary?.set(summary);
        },
      },
    },
  });
}

export const rpcTests = [
  defineTest({
    name: "bun to webview: request with response",
    category: "RPC",
    description: "Test that bun can make RPC requests to webview and receive responses",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Test",
        renderer: 'cef',
      });

      // Wait longer for webview to be ready when running in parallel
      // CEF takes longer to initialize under heavy load
      await new Promise((resolve) => setTimeout(resolve, 2000));

      log("Calling webview.multiply({ a: 6, b: 7 })");
      const result = await win.webview.rpc?.request.multiply({ a: 6, b: 7 });

      expect(result).toBe(42);
      log(`Got result: ${result}`);
    },
  }),

  defineTest({
    name: "webview to bun: request with response",
    category: "RPC",
    description: "Test that webview can make RPC requests to bun and receive responses",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Execute JS in webview to call bun's add method
      log("Triggering webview to call bun.add({ a: 100, b: 23 })");
      const result = await win.webview.rpc?.request.evaluateJavascriptWithResponse({
        script: `return window.electrobun.rpc.request.add({ a: 100, b: 23 });`,
      });

      expect(result).toBe(123);
      log(`Got result: ${result}`);
    },
  }),

  defineTest({
    name: "RPC echo with string",
    category: "RPC",
    description: "Test echo with a simple string",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const testString = "Hello, Electrobun!";
      log(`Testing echo with: "${testString}"`);

      const result = await win.webview.rpc?.request.evaluateJavascriptWithResponse({
        script: `return window.electrobun.rpc.request.echo({ value: "${testString}" });`,
      });

      expect(result).toBe(testString);
      log(`Echo successful: ${result}`);
    },
  }),

  defineTest({
    name: "RPC large payload transfer",
    category: "RPC",
    description: "Test transferring 1MB of data via RPC",
    timeout: 30000,
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const size = 1024 * 1024; // 1MB
      log(`Sending ${size} bytes to bun`);

      const result = await win.webview.rpc?.request.evaluateJavascriptWithResponse({
        script: `
          const bigData = 'x'.repeat(${size});
          return window.electrobun.rpc.request.echo({ value: bigData }).then(r => r.length);
        `,
      });

      expect(result).toBe(size);
      log(`Received ${result} bytes back`);
    },
  }),

  defineTest({
    name: "evaluateJavascriptWithResponse - sync",
    category: "RPC",
    description: "Test evaluating synchronous JavaScript in webview",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      log("Evaluating: 2 + 2");
      const result = await win.webview.rpc?.request.evaluateJavascriptWithResponse({
        script: `return 2 + 2`,
      });

      expect(result).toBe(4);
      log(`Result: ${result}`);
    },
  }),

  defineTest({
    name: "evaluateJavascriptWithResponse - async/promise",
    category: "RPC",
    description: "Test evaluating async JavaScript that returns a promise",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Test",
        renderer: 'cef',
      });

      // Wait longer for webview to be ready when running in parallel
      // CEF takes longer to initialize under heavy load
      await new Promise((resolve) => setTimeout(resolve, 2000));

      log("Evaluating async script with 200ms delay");
      const startTime = Date.now();

      const result = await win.webview.rpc?.request.evaluateJavascriptWithResponse({
        script: `
          return new Promise(resolve => {
            setTimeout(() => resolve('delayed result'), 200);
          });
        `,
      });

      const elapsed = Date.now() - startTime;
      expect(result).toBe("delayed result");
      expect(elapsed).toBeGreaterThanOrEqual(200);
      log(`Result: ${result}, took ${elapsed}ms`);
    },
  }),

  defineTest({
    name: "evaluateJavascriptWithResponse - DOM access",
    category: "RPC",
    description: "Test that evaluated JS can access the DOM",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Test Window",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      log("Getting H1 content via JS evaluation");
      const result = await win.webview.rpc?.request.evaluateJavascriptWithResponse({
        script: `return document.querySelector('h1')?.textContent`,
      });

      expect(result).toBe("Test Harness");
      log(`H1 content: ${result}`);
    },
  }),

  defineTest({
    name: "RPC getDocumentTitle",
    category: "RPC",
    description: "Test getting document title via RPC request",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      log("Getting document title via RPC");
      const title = await win.webview.rpc?.request.getDocumentTitle({});

      expect(title).toBe("Test Harness");
      log(`Document title: ${title}`);
    },
  }),

  defineTest({
    name: "RPC stress: native burst delivery",
    category: "RPC",
    description: "Stress native renderer RPC bursts to catch dropped messages or responses",
    timeout: 120000,
    async run({ createWindow, log }) {
      const messageCount = 5000;
      const requestCount = 1000;
      const bunStressMessages = createStressMessageCollector();
      const webviewMessageSummary = createStressValueCollector<StressMessageStats>();
      const webviewRequestSummary = createStressValueCollector<StressRequestSummary>();
      const rpc = createTestHarnessRPC(30000, {
        bunStressMessages,
        webviewMessageSummary,
        webviewRequestSummary,
      });
      bunStressMessages.reset();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Native Stress Test",
        renderer: 'native',
      });

      const webviewRpc = win.webview.rpc;
      if (!webviewRpc) {
        throw new Error("Expected webview RPC to be available");
      }

      await sleep(1000);
      log("Starting webview stress burst via bun -> webview RPC message");
      webviewRpc.send.startStressFromBun({ messageCount, requestCount });

      log(`Sending ${messageCount} large fire-and-forget messages from bun to webview concurrently`);
      const outputPayload = "x".repeat(16384);
      for (let id = 0; id < messageCount; id++) {
        webviewRpc.send.stressMessageToWebview({
          id,
          payload: `${id}:${outputPayload}`,
        });
      }
      webviewRpc.send.finishStressMessageToWebview({ expectedCount: messageCount });

      log(`Waiting for ${messageCount} fire-and-forget messages from webview to bun`);
      const bunStats = await waitForStressStats(
        () => bunStressMessages.getStats(messageCount),
        messageCount,
        30000,
      );
      assertAllStressMessagesArrived("webview -> bun messages", bunStats);
      log(`Received all ${bunStats.count} webview -> bun messages`);

      log(`Waiting for ${requestCount} concurrent requests from webview to bun`);
      const webviewRequestResult = await webviewRequestSummary.wait(
        "webview -> bun request summary",
        45000,
      );
      expect(webviewRequestResult.received).toBe(requestCount);
      expect(webviewRequestResult.errorCount).toBe(0);
      expect(webviewRequestResult.mismatchCount).toBe(0);
      log(`Completed ${webviewRequestResult.received} webview -> bun requests`);

      const webviewStats = await webviewMessageSummary.wait(
        "bun -> webview message summary",
        30000,
      );
      assertAllStressMessagesArrived("bun -> webview messages", webviewStats);
      log(`Received all ${webviewStats.count} bun -> webview messages`);

      log(`Running ${requestCount} concurrent requests from bun to webview`);
      const bunRequestResults = await Promise.all(
        Array.from({ length: requestCount }, (_, id) =>
          webviewRpc.request.multiply({ a: id, b: 1 })
            .then((value: number) => ({ id, value }))
            .catch((error: Error) => ({ id, error: String(error?.message || error) })),
        ),
      );
      const bunRequestErrors = bunRequestResults.filter((result) => "error" in result);
      const bunRequestMismatches = bunRequestResults.filter(
        (result) => !("error" in result) && result.value !== result.id,
      );

      expect(bunRequestResults).toHaveLength(requestCount);
      expect(bunRequestErrors).toHaveLength(0);
      expect(bunRequestMismatches).toHaveLength(0);
      log(`Completed ${bunRequestResults.length} bun -> webview requests`);
    },
  }),

  defineTest({
    name: "RPC stress: native fallback to socket transition",
    category: "RPC",
    description: "Stress the webview-to-bun RPC transition from postMessage fallback to websocket transport",
    timeout: 120000,
    async run({ createWindow, log }) {
      const messageCount = 5000;
      const requestCount = 500;
      const enableSocketAt = Math.floor(messageCount / 2);
      const bunStressMessages = createStressMessageCollector();
      const webviewRequestSummary = createStressValueCollector<StressRequestSummary>();
      const rpc = createTestHarnessRPC(30000, {
        bunStressMessages,
        webviewRequestSummary,
      });
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Native Transport Transition Test",
        renderer: 'native',
      });

      const webviewRpc = win.webview.rpc;
      if (!webviewRpc) {
        throw new Error("Expected webview RPC to be available");
      }

      await sleep(1000);
      const socketState = await waitForHostSocketOpen(webviewRpc);
      log(`Host socket open before transition: ${JSON.stringify(socketState)}`);
      expect(socketState.socketUrl, "transition socket URL").toContain("ws://127.0.0.1:");
      expect(socketState.canSend, "transition socket send-ready").toBe(true);

      bunStressMessages.reset();
      log(
        `Starting ${messageCount} webview -> bun messages: first ${enableSocketAt} via fallback, rest via websocket`,
      );
      webviewRpc.send.startTransportTransitionStressFromBun({
        messageCount,
        requestCount,
        enableSocketAt,
      });

      const bunStats = await waitForStressStats(
        () => bunStressMessages.getStats(messageCount),
        messageCount,
        30000,
      );
      assertAllStressMessagesArrived("webview -> bun fallback/socket transition messages", bunStats);
      log(`Received all ${bunStats.count} transition messages`);

      const webviewRequestResult = await webviewRequestSummary.wait(
        "webview -> bun transition request summary",
        45000,
      );
      expect(webviewRequestResult.received).toBe(requestCount);
      expect(webviewRequestResult.errorCount).toBe(0);
      expect(webviewRequestResult.mismatchCount).toBe(0);
      log(`Completed ${webviewRequestResult.received} post-transition webview -> bun requests`);
    },
  }),

  defineTest({
    name: "RPC stress: native steady socket delivery",
    category: "RPC",
    description: "Send low-rate webview-to-bun RPC messages over websocket to catch persistent socket drops",
    timeout: 30000,
    async run({ createWindow, log }) {
      const messageCount = 30;
      const intervalMs = 100;
      const bunStressMessages = createStressMessageCollector();
      const socketSendSummary = createStressValueCollector<SocketSendSummary>();
      const rpc = createTestHarnessRPC(10000, {
        bunStressMessages,
        socketSendSummary,
      });
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "RPC Native Steady Socket Test",
        renderer: 'native',
      });

      const webviewRpc = win.webview.rpc;
      if (!webviewRpc) {
        throw new Error("Expected webview RPC to be available");
      }

      await sleep(1000);
      const socketState = await waitForHostSocketOpen(webviewRpc);
      log(`Host socket open before steady socket test: ${JSON.stringify(socketState)}`);
      expect(socketState.socketUrl, "steady socket URL").toContain("ws://127.0.0.1:");
      expect(socketState.canSend, "steady socket send-ready").toBe(true);

      bunStressMessages.reset();
      log(`Starting ${messageCount} webview -> bun websocket messages at ${intervalMs}ms intervals`);
      webviewRpc.send.startTimedSocketStressFromBun({
        messageCount,
        intervalMs,
      });

      const summary = await socketSendSummary.wait("webview socket send summary", 15000);
      log(`Socket send summary: ${JSON.stringify(summary)}`);

      const bunStats = await waitForStressStats(
        () => bunStressMessages.getStats(messageCount),
        messageCount,
        10000,
      );
      assertAllStressMessagesArrived("steady webview -> bun socket messages", bunStats);
      log(`Received all ${bunStats.count} steady socket messages`);
    },
  }),

  defineTest({
    name: "BrowserView.getAll",
    category: "BrowserView",
    description: "Test getting all browser views",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();

      // Get count before creating windows
      const viewsBefore = BrowserView.getAll();
      const countBefore = viewsBefore.length;
      log(`Views before: ${countBefore}`);

      // Create two windows
      const win1 = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "GetAll Test 1",
        renderer: 'cef',
      });
      const win2 = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "GetAll Test 2",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      const viewsAfter = BrowserView.getAll();
      log(`Views after creating 2 windows: ${viewsAfter.length}`);

      // Should have at least 2 more views (the webviews for the windows we created)
      expect(viewsAfter.length).toBeGreaterThanOrEqual(countBefore + 2);

      // Verify our webviews are in the list
      const found1 = viewsAfter.find((v) => v.id === win1.webview.id);
      const found2 = viewsAfter.find((v) => v.id === win2.webview.id);

      expect(found1).toBeTruthy();
      expect(found2).toBeTruthy();

      log("BrowserView.getAll works correctly");
    },
  }),

  defineTest({
    name: "BrowserView.getById",
    category: "BrowserView",
    description: "Test getting a browser view by ID",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "GetById Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      const webviewId = win.webview.id;
      log(`Looking up webview with ID: ${webviewId}`);

      const found = BrowserView.getById(webviewId);
      expect(found).toBeTruthy();
      expect(found?.id).toBe(webviewId);

      // Test non-existent ID
      const notFound = BrowserView.getById(999999);
      expect(notFound).toBeFalsy();

      log("BrowserView.getById works correctly");
    },
  }),
];
