// Interactive Multi-Window OOPIF Test
// Tests concurrent OOPIF loading through CEF or Electrobun's system fallback.

import { defineTest } from "../../test-framework/types";
import { BrowserView, BrowserWindow } from "electrobun/main";

export const multiwindowCefTests = [
  defineTest({
    name: "Multi-window OOPIF load test",
    category: "Webview Tag (Interactive)",
    description: "Opens 3 windows concurrently and verifies every embedded OOPIF loads, including the normal system-webview fallback when CEF is not bundled.",
    instructions: [
      "This test opens 3 windows simultaneously, each containing a <webview> tag (OOPIF).",
      "CEF builds should use CEF; system-only builds should exercise Electrobun's normal fallback to the system webview.",
      "Do not move your mouse after opening the test.",
      "Verify all 3 webviews load and show green status dots, then close all 3 windows.",
    ],
    interactive: true,
    timeout: 120000,
    async run({ log }) {
      const expectedWindowCount = 3;
      log("Creating 3 windows with OOPIFs...");

      const windows: BrowserWindow<any>[] = [];
      const closedWindows = new Set<BrowserWindow<any>>();
      const oopifLoadedPromises: Promise<number>[] = [];
      const loadTimers = new Set<ReturnType<typeof setTimeout>>();
      let loadedCount = 0;
      let resolveCloseWait: (() => void) | null = null;
      let closeWaitTimer: ReturnType<typeof setTimeout> | null = null;

      const closeWindow = (win: BrowserWindow<any>) => {
        if (closedWindows.has(win)) return;
        try {
          win.close();
        } catch {}
      };

      const closeRemainingWindows = () => {
        for (const win of windows) closeWindow(win);
      };

      const waitForAllWindowsToClose = async () => {
        if (closedWindows.size === expectedWindowCount) return;

        try {
          await new Promise<void>((resolve) => {
            resolveCloseWait = resolve;
            closeWaitTimer = setTimeout(() => {
              log("Auto-closing remaining windows after timeout");
              resolve();
            }, 60000);
          });
        } finally {
          if (closeWaitTimer !== null) clearTimeout(closeWaitTimer);
          closeWaitTimer = null;
          resolveCloseWait = null;
        }
      };

      try {
        // Create 3 windows
        for (let i = 1; i <= expectedWindowCount; i++) {
          const windowIndex = i;
          let resolveOopifLoad!: (result: number) => void;
          let loadSettled = false;
          let loadTimer: ReturnType<typeof setTimeout> | null = null;
          const oopifPromise = new Promise<number>((resolve) => {
            resolveOopifLoad = resolve;
          });
          const settleOopifLoad = (result: number) => {
            if (loadSettled) return false;
            loadSettled = true;
            if (loadTimer !== null) {
              clearTimeout(loadTimer);
              loadTimers.delete(loadTimer);
              loadTimer = null;
            }
            resolveOopifLoad(result);
            return true;
          };

          // Arm the timeout before construction. If construction or any later
          // setup step fails, the outer finally block clears it and closes all
          // windows that were successfully constructed earlier in the loop.
          loadTimer = setTimeout(() => {
            settleOopifLoad(-windowIndex);
          }, 30000);
          loadTimers.add(loadTimer);

          const rpc = BrowserView.defineRPC<any>({
            maxRequestTime: 60000,
            handlers: {
              requests: {},
              messages: {
                oopifLoaded: () => {
                  if (settleOopifLoad(windowIndex)) {
                    loadedCount++;
                    log(`Window ${windowIndex}: OOPIF loaded (${loadedCount}/${expectedWindowCount})`);
                  }
                },
              },
            },
          });

          const win = new BrowserWindow({
            title: `OOPIF Test Window ${windowIndex}`,
            url: "views://playgrounds/multiwindow-cef/index.html",
            // Deliberately request CEF in every matrix variant. When CEF is not
            // bundled, Electrobun's supported fallback to the system renderer is
            // part of what this test verifies.
            renderer: "cef",
            frame: {
              width: 400,
              height: 450,
              x: 100 + (i - 1) * 420,
              y: 100,
            },
            rpc,
          });

          windows.push(win);

          // Track closure immediately after construction so closing during load
          // still settles both the load and close lifecycles.
          win.on("close", () => {
            settleOopifLoad(-windowIndex);
            if (closedWindows.has(win)) return;
            closedWindows.add(win);
            log(`Window closed (${closedWindows.size}/${expectedWindowCount})`);
            if (closedWindows.size === expectedWindowCount) {
              resolveCloseWait?.();
            }
          });

          // Send window ID to the view
          win.webview.on("dom-ready", () => {
            (win.webview.rpc as any)?.send?.setWindowId({ id: windowIndex });
          });

          oopifLoadedPromises.push(oopifPromise);
          log(`Window ${i}: Created`);
        }

        log("Waiting for OOPIFs to load (30s timeout)...");
        log("DO NOT MOVE YOUR MOUSE - observing if OOPIFs load automatically");

        // Wait for all OOPIFs or timeout
        const results = await Promise.all(oopifLoadedPromises);

        const successful = results.filter(r => r > 0).length;
        const failed = results.filter(r => r < 0).length;

        log(`Results: ${successful}/${expectedWindowCount} OOPIFs loaded, ${failed} failed`);

        if (failed > 0) {
          const failedWindows = results.filter(r => r < 0).map(r => -r);
          log(`FAILED: Windows ${failedWindows.join(", ")} did not load`);
        }

        await waitForAllWindowsToClose();

        if (failed > 0) {
          throw new Error(`${failed} of ${expectedWindowCount} OOPIFs failed to load`);
        }

        log("Test complete - all OOPIFs loaded without mouse movement");
      } finally {
        for (const timer of loadTimers) clearTimeout(timer);
        loadTimers.clear();
        if (closeWaitTimer !== null) clearTimeout(closeWaitTimer);
        closeWaitTimer = null;
        resolveCloseWait = null;
        closeRemainingWindows();
      }
    },
  }),
];
