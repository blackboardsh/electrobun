// RPC Tests - Tests for bidirectional RPC communication

import { defineTest, expect } from "../test-framework/types";
import { BrowserView, type RPCSchema } from "electrobun/bun";
import type { TestHarnessRPC } from "../test-harness/index";

// Create RPC config for test harness
function createTestHarnessRPC() {
  return BrowserView.defineRPC<TestHarnessRPC>({
    maxRequestTime: 10000,
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
      });

      // Wait for webview to be ready
      await new Promise((resolve) => setTimeout(resolve, 1000));

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
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

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
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      log("Getting document title via RPC");
      const title = await win.webview.rpc?.request.getDocumentTitle({});

      expect(title).toBe("Test Harness");
      log(`Document title: ${title}`);
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
      });
      const win2 = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "GetAll Test 2",
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
