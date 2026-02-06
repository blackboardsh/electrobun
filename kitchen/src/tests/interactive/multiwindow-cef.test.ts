// Interactive Multi-Window CEF OOPIF Test
// Tests that multiple CEF windows with OOPIFs load correctly without mouse movement

import { defineTest } from "../../test-framework/types";
import { BrowserView, BrowserWindow } from "electrobun/bun";

export const multiwindowCefTests = [
  defineTest({
    name: "Multi-window CEF OOPIF test",
    category: "CEF (Interactive)",
    description: "Test that 3 CEF windows with OOPIFs all load correctly without mouse movement",
    interactive: true,
    timeout: 120000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "This test will open 3 CEF windows simultaneously",
        "Each window contains a <webview> tag (OOPIF)",
        "DO NOT MOVE YOUR MOUSE after clicking Ready",
        "Verify ALL 3 webviews load (green dots)",
        "Close all windows when done",
      ]);

      log("Creating 3 CEF windows with OOPIFs...");

      const windows: BrowserWindow<any>[] = [];
      const oopifLoadedPromises: Promise<number>[] = [];
      let loadedCount = 0;

      // Create 3 windows
      for (let i = 1; i <= 3; i++) {
        const windowIndex = i;

        const oopifPromise = new Promise<number>((resolve) => {
          const rpc = BrowserView.defineRPC<any>({
            maxRequestTime: 60000,
            handlers: {
              requests: {},
              messages: {
                oopifLoaded: () => {
                  loadedCount++;
                  log(`Window ${windowIndex}: OOPIF loaded (${loadedCount}/3)`);
                  resolve(windowIndex);
                },
              },
            },
          });

          const win = new BrowserWindow({
            title: `CEF Test Window ${windowIndex}`,
            url: "views://playgrounds/multiwindow-cef/index.html",
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

          // Send window ID to the view
          win.webview.on("dom-ready", () => {
            win.webview.rpc?.send.setWindowId({ id: windowIndex });
          });

          // Timeout after 30 seconds
          setTimeout(() => {
            resolve(-windowIndex); // Negative means timeout
          }, 30000);
        });

        oopifLoadedPromises.push(oopifPromise);
        log(`Window ${i}: Created`);
      }

      log("Waiting for OOPIFs to load (30s timeout)...");
      log("DO NOT MOVE YOUR MOUSE - observing if OOPIFs load automatically");

      // Wait for all OOPIFs or timeout
      const results = await Promise.all(oopifLoadedPromises);

      const successful = results.filter(r => r > 0).length;
      const timedOut = results.filter(r => r < 0).length;

      log(`Results: ${successful}/3 OOPIFs loaded, ${timedOut} timed out`);

      if (timedOut > 0) {
        const timedOutWindows = results.filter(r => r < 0).map(r => -r);
        log(`WARNING: Windows ${timedOutWindows.join(", ")} timed out - this may indicate the bug is present`);
      }

      // Wait for user to close windows
      await new Promise<void>((resolve) => {
        let closedCount = 0;

        for (const win of windows) {
          win.on("close", () => {
            closedCount++;
            log(`Window closed (${closedCount}/3)`);
            if (closedCount === 3) {
              resolve();
            }
          });
        }

        // Also resolve after 60s if user doesn't close windows
        setTimeout(() => {
          log("Auto-closing remaining windows after timeout");
          for (const win of windows) {
            try { win.close(); } catch {}
          }
          resolve();
        }, 60000);
      });

      log("Test complete - check if all OOPIFs loaded without mouse movement");
    },
  }),
];
