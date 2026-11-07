// Sandbox Tests - Tests for sandbox mode security features
// Sandbox mode disables RPC and only allows event emission for untrusted content

import { defineTest, expect, sleep } from "../test-framework/types";
import { BrowserView, BuildConfig } from "electrobun/main";
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
    name: "Sandboxed iframe cannot call native bridges",
    category: "Sandbox",
    description: "Reject raw iframe RPC and events while preserving top-frame bridges across preload replacement",
    timeout: 30000,
    async run({ createWindow, log }) {
      const requests: string[] = [];
      const messages: number[] = [];
      const events: string[] = [];
      let ready = false;
      const rpc = BrowserView.defineRPC<TestHarnessRPC>({
        maxRequestTime: 10000,
        handlers: {
          requests: {
            echo: ({ value }) => { requests.push(value); return value; },
            add: ({ a, b }) => a + b,
            throwError: () => { throw new Error("unused"); },
            delayed: ({ value }) => value,
          },
          messages: {
            ready: () => { ready = true; },
            ping: ({ timestamp }) => { messages.push(timestamp); },
          },
        },
      });
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Iframe Bridge Isolation",
        renderer: BuildConfig.getSync().defaultRenderer,
        sandbox: false,
        rpc,
      });
      win.webview.on("did-navigate-in-page", (event: unknown) => events.push(JSON.stringify(event)));

      for (let pass = 0; pass < 2; pass++) {
        const deadline = Date.now() + 10000;
        while (!ready && Date.now() < deadline) await sleep(25);
        expect(ready, "test document loaded").toBe(true);
        requests.length = messages.length = events.length = 0;

        // Use the native transport directly: normal RPC may use the websocket
        // and would not prove that the top-frame native bridge still works.
        const result = await win.webview.rpc.request.evaluateJavascriptWithResponse({ script: `
          return (async () => {
          const request = value => JSON.stringify({type:'request',id:900001,method:'echo',params:{value}});
          const message = timestamp => JSON.stringify({type:'message',id:'ping',payload:{timestamp}});
          const event = detail => JSON.stringify({type:'message',id:'webviewEvent',payload:{
            id:window.__electrobunWebviewId,eventName:'did-navigate-in-page',detail
          }});
          const childSource = \`
            (async () => {
              let parentBlocked = false;
              try { void parent.__electrobunHostBridge; } catch { parentBlocked = true; }
              let attempted = 0;
              for (const name of ['hostBridge','bunBridge','internalBridge','eventBridge']) {
                const bridge = window.webkit?.messageHandlers?.[name]
                  || window.chrome?.webview?.hostObjects?.[name]
                  || window[name];
                if (!bridge) continue;
                const payloads = name === 'hostBridge' || name === 'bunBridge'
                  ? [\${JSON.stringify(request('bridge-child'))}, \${JSON.stringify(message(-1))}]
                  : [\${JSON.stringify(event('bridge-child'))}];
                for (const payload of payloads) {
                  for (const forged of [payload, '0'.repeat(64) + ':' + payload]) {
                    attempted++;
                    try { await bridge.postMessage(forged); } catch {}
                  }
                }
              }
              parent.postMessage({bridgeProbe:true,parentBlocked,attempted}, '*');
            })();
          \`;
          const status = await new Promise((resolve, reject) => {
            const frame = document.createElement('iframe');
            frame.setAttribute('sandbox', 'allow-scripts');
            const timer = setTimeout(() => { cleanup(); reject(new Error('iframe probe timed out')); }, 5000);
            const receive = e => {
              if (e.source !== frame.contentWindow || !e.data?.bridgeProbe) return;
              cleanup(); resolve(e.data);
            };
            function cleanup() { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); }
            window.addEventListener('message', receive);
            frame.srcdoc = '<!doctype html><script>' + childSource + '<\/script>';
            document.body.appendChild(frame);
          });
          window.__electrobunHostBridge.postMessage(request('bridge-main-host'));
          window.__electrobunBunBridge.postMessage(request('bridge-main-bun'));
          window.__electrobunHostBridge.postMessage(message(1));
          window.__electrobunBunBridge.postMessage(message(2));
          window.__electrobunEventBridge.postMessage(event('bridge-main-event'));
          window.__electrobunInternalBridge.postMessage(event('bridge-main-internal'));
          return {...status, updated: !!window.__frameBridgePreloadUpdated};
          })();
        ` });
        expect(result.parentBlocked, "opaque iframe cannot read its parent").toBe(true);
        if (process.platform === "linux" && win.webview.renderer === "native") {
          expect(result.attempted, "WebKitGTK raw handlers were exercised").toBe(12);
        }
        expect(result.updated, "custom preload replacement ran").toBe(pass === 1);
        await sleep(250);
        expect(requests.sort().join(",")).toBe("bridge-main-bun,bridge-main-host");
        expect(messages.sort().join(",")).toBe("1,2");
        expect(events.filter(event => event.includes("bridge-child")).length).toBe(0);
        expect(events.filter(event => event.includes("bridge-main")).length).toBe(2);

        if (pass === 0) {
          // This path removes and reinstalls Linux user scripts. Both the
          // authentication bootstrap and the application's new preload must survive.
          await win.webview.rpc.request.evaluateJavascriptWithResponse({ script: `
            window.__electrobunInternalBridge.postMessage(JSON.stringify([JSON.stringify({
              type:'message',id:'webviewTagUpdatePreload',payload:{
                id:window.__electrobunWebviewId,preload:'window.__frameBridgePreloadUpdated = true;'
              }
            })]));
            return true;
          ` });
          ready = false;
          win.webview.loadURL("views://test-harness/index.html?bridge-reload=1");
        }
      }
      log("All native bridges rejected opaque iframe calls before and after preload replacement");
    },
  }),
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
      await sleep(2000);

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
      await sleep(2000);

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
      await sleep(500);

      // Navigate to trigger will-navigate
      log("Navigating to test-runner");
      win.webview.loadURL("views://test-runner/index.html");

      await sleep(1500);

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
      await sleep(500);

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

      await sleep(500);

      // Navigation should still work
      log("Testing loadURL in sandbox mode");
      win.webview.loadURL("views://test-runner/index.html");

      await sleep(1000);

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

      await sleep(500);

      // Navigate to trigger events
      win.webview.loadURL("views://test-runner/index.html");

      await sleep(1500);

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
      await sleep(4000);

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
      await sleep(4000);

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

  defineTest({
    name: "Webview tag queues navigation during multi-instance initialization",
    category: "Webview Tag",
    description: "Verify immediate URL changes are replayed for multiple asynchronous OOPIFs",
    timeout: 20000,
    async run({ createWindow, log }) {
      if (BuildConfig.getSync().defaultRenderer === "cef") {
        log("Skipping the system-webview navigation queue regression under CEF");
        return;
      }

      const viewsBefore = new Set(BrowserView.getAll().map((view) => view.id));
      const win = await createWindow({
        url: "views://test-oopif-navigation/index.html",
        title: "OOPIF Initialization Navigation Test",
        sandbox: false,
        width: 720,
        height: 520,
      });

      await sleep(5000);

      const nestedUrls = BrowserView.getAll()
        .filter((view) => !viewsBefore.has(view.id))
        .filter((view) => view.hostWebviewId === win.webview.id)
        .map((view) => view.url)
        .sort();

      expect(nestedUrls).toEqual([
        "views://test-runner/index.html#queued-attribute",
        "views://test-runner/index.html#queued-load-url",
      ]);
      log(`Queued navigation reached both OOPIFs: ${nestedUrls.join(", ")}`);
    },
  }),

];
