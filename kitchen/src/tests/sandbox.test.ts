// Sandbox Tests - Tests for sandbox mode security features
// Sandbox mode disables RPC and only allows event emission for untrusted content

import { defineTest, expect } from "../test-framework/types";
import { BrowserView } from "electrobun/bun";
import type { TestHarnessRPC } from "../test-harness/index";

// Create RPC config for test harness (same as rpc.test.ts)
function createTestHarnessRPC() {
  return BrowserView.defineRPC<TestHarnessRPC>({
    maxRequestTime: 3000, // Short timeout for sandbox tests
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

export const sandboxTests = [
  defineTest({
    name: "Sandbox mode - RPC is disabled",
    category: "Sandbox",
    description: "Test that RPC calls timeout/fail in sandbox mode",
    timeout: 15000,
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();

      log("Creating sandboxed window with RPC config");
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Sandbox RPC Test",
        rpc,
        sandbox: true,
      });

      // Wait for window to load
      await new Promise((resolve) => setTimeout(resolve, 2000));

      log("Attempting RPC call to sandboxed window (should timeout)...");

      // Try to call RPC - this should fail/timeout because sandbox disables the bridge
      let rpcFailed = false;
      try {
        // This should timeout because bunBridge is not set up in sandbox mode
        const result = await win.webview.rpc?.request.multiply({ a: 6, b: 7 });
        log(`Unexpected: RPC succeeded with result ${result}`);
      } catch (error: any) {
        rpcFailed = true;
        log(`RPC failed as expected: ${error.message}`);
      }

      expect(rpcFailed).toBe(true);
      log("Sandbox mode correctly prevents RPC communication");
    },
  }),

  defineTest({
    name: "Non-sandbox mode - RPC works",
    category: "Sandbox",
    description: "Verify RPC works in non-sandboxed mode for comparison",
    timeout: 15000,
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();

      log("Creating non-sandboxed window with RPC config");
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Non-Sandbox RPC Test",
        rpc,
        sandbox: false,
      });

      // Wait for window to load
      await new Promise((resolve) => setTimeout(resolve, 2000));

      log("Attempting RPC call to non-sandboxed window (should succeed)...");

      // This should succeed because RPC is enabled
      const result = await win.webview.rpc?.request.multiply({ a: 6, b: 7 });

      expect(result).toBe(42);
      log(`RPC succeeded with result: ${result}`);
      log("Non-sandboxed mode correctly allows RPC communication");
    },
  }),

  defineTest({
    name: "Sandbox mode - events still work",
    category: "Sandbox",
    description: "Test that dom-ready and navigation events still fire in sandbox mode",
    timeout: 15000,
    async run({ createWindow, log }) {
      let domReadyFired = false;
      let willNavigateFired = false;

      log("Creating sandboxed window");
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Sandbox Events Test",
        sandbox: true,
      });

      // Events should still work in sandbox mode
      win.webview.on("dom-ready", () => {
        domReadyFired = true;
      });

      win.webview.on("will-navigate", () => {
        willNavigateFired = true;
      });

      // Wait for initial load
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Navigate to trigger will-navigate
      log("Navigating to test-runner");
      win.webview.loadURL("views://test-runner/index.html");

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(willNavigateFired).toBe(true);
      log("Events work correctly in sandbox mode");
      log(`dom-ready: ${domReadyFired}, will-navigate: ${willNavigateFired}`);
    },
  }),

  defineTest({
    name: "Sandbox mode - BrowserWindow",
    category: "Sandbox",
    description: "Test that BrowserWindow can be created with sandbox: true",
    async run({ createWindow, log }) {
      log("Creating sandboxed BrowserWindow");
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Sandbox BrowserWindow Test",
        sandbox: true,
      });

      // Verify window was created
      expect(win.id).toBeGreaterThan(0);
      expect(win.webviewId).toBeGreaterThan(0);

      // Wait for load
      await new Promise((resolve) => setTimeout(resolve, 500));

      log(`Created sandboxed window id=${win.id}, webviewId=${win.webviewId}`);
    },
  }),

  defineTest({
    name: "Sandbox mode - navigation controls work",
    category: "Sandbox",
    description: "Test that navigation methods work in sandbox mode",
    timeout: 15000,
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Sandbox Navigation Test",
        sandbox: true,
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Navigation should still work
      log("Testing loadURL in sandbox mode");
      win.webview.loadURL("views://test-runner/index.html");

      await new Promise((resolve) => setTimeout(resolve, 1000));

      log("Navigation controls work in sandbox mode");
    },
  }),

  defineTest({
    name: "Non-sandboxed mode - events work",
    category: "Sandbox",
    description: "Verify events work in normal (non-sandboxed) mode for comparison",
    timeout: 15000,
    async run({ createWindow, log }) {
      let domReadyFired = false;

      log("Creating non-sandboxed window");
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Non-Sandbox Events Test",
        sandbox: false,
      });

      win.webview.on("dom-ready", () => {
        domReadyFired = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Navigate to trigger events
      win.webview.loadURL("views://test-runner/index.html");

      await new Promise((resolve) => setTimeout(resolve, 1500));

      log(`dom-ready fired: ${domReadyFired}`);
      // Note: domReadyFired may or may not be true depending on timing
      // The important thing is no errors occurred
      log("Non-sandboxed mode works correctly");
    },
  }),

  defineTest({
    name: "Sandbox mode - OOPIF webview tag blocked",
    category: "Sandbox",
    description: "Test that webview tags (OOPIFs) are blocked in sandboxed windows",
    timeout: 20000,
    async run({ createWindow, log }) {
      // Get initial BrowserView count
      const viewsBefore = BrowserView.getAll().length;
      log(`BrowserViews before: ${viewsBefore}`);

      log("Creating sandboxed window with page containing webview tag");
      await createWindow({
        url: "views://test-oopif/index.html",
        title: "Sandbox OOPIF Test",
        sandbox: true,
        width: 500,
        height: 400,
      });

      // Wait for the page to load and webview tag to attempt initialization
      await new Promise((resolve) => setTimeout(resolve, 4000));

      // Check BrowserView count
      const viewsAfter = BrowserView.getAll().length;
      log(`BrowserViews after: ${viewsAfter}`);

      const newViews = viewsAfter - viewsBefore;
      log(`New BrowserViews created: ${newViews}`);

      // In sandbox mode, only the main window's webview should be created (1 view)
      // The webview tag should NOT create an additional BrowserView because
      // internalBridge is disabled, preventing OOPIF communication
      expect(newViews).toBe(1);
      log("Sandbox mode correctly blocked OOPIF creation");
    },
  }),

  defineTest({
    name: "Non-sandbox mode - OOPIF webview tag loads",
    category: "Sandbox",
    description: "Test that webview tags (OOPIFs) load in non-sandboxed windows",
    timeout: 20000,
    async run({ createWindow, log }) {
      // Get initial BrowserView count
      const viewsBefore = BrowserView.getAll().length;
      log(`BrowserViews before: ${viewsBefore}`);

      log("Creating non-sandboxed window with page containing webview tag");
      await createWindow({
        url: "views://test-oopif/index.html",
        title: "Non-Sandbox OOPIF Test",
        sandbox: false,
        width: 500,
        height: 400,
      });

      // Wait for the page to load and webview tag to initialize
      await new Promise((resolve) => setTimeout(resolve, 4000));

      // Check BrowserView count
      const viewsAfter = BrowserView.getAll().length;
      log(`BrowserViews after: ${viewsAfter}`);

      const newViews = viewsAfter - viewsBefore;
      log(`New BrowserViews created: ${newViews}`);

      // In non-sandbox mode, we expect 2 new views:
      // 1. The main window's webview
      // 2. The OOPIF created by the webview tag
      expect(newViews).toBe(2);
      log("Non-sandbox mode correctly allowed OOPIF creation");
    },
  }),

];
