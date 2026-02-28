// Interactive Window Event Tests

import { defineTest } from "../../test-framework/types";
import { BrowserView, BrowserWindow } from "electrobun/bun";

export const windowEventTests = [
  defineTest({
    name: "Window move and resize events",
    category: "Window Events (Interactive)",
    description: "Test both move and resize events are detected with live updates",
    interactive: true,
    timeout: 120000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A test window will open",
        "1. Drag the window to detect move event",
        "2. Resize the window by dragging edges/corners",
        "Test passes when both events are detected",
      ]);

      log("Opening test window for move and resize event detection");

      await new Promise<void>((resolve, reject) => {
        let moveDetected = false;
        let resizeDetected = false;
        let winRef: BrowserWindow<any> | null = null;

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 120000,
          handlers: {
            requests: {
              closeWindow: () => {
                winRef?.close();
                return { success: true };
              },
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Move & Resize Test",
          url: "views://playgrounds/window-events/index.html",
          renderer: "cef",
          frame: { width: 350, height: 400, x: 200, y: 200 },
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("move", (event: any) => {
          const x = event.data?.x ?? 0;
          const y = event.data?.y ?? 0;

          // Send position update via RPC
          win.webview.rpc?.send.updatePosition({ x: Math.round(x), y: Math.round(y) });

          if (!moveDetected) {
            moveDetected = true;
            log(`Move event detected: (${Math.round(x)}, ${Math.round(y)})`);
            win.webview.rpc?.send.updateStatus({ moveDetected, resizeDetected });
            checkComplete();
          }
        });

        win.on("resize", (event: any) => {
          const width = event.data?.width ?? 0;
          const height = event.data?.height ?? 0;

          // Send size update via RPC
          win.webview.rpc?.send.updateSize({ width: Math.round(width), height: Math.round(height) });

          if (!resizeDetected) {
            resizeDetected = true;
            log(`Resize event detected: ${Math.round(width)}x${Math.round(height)}`);
            win.webview.rpc?.send.updateStatus({ moveDetected, resizeDetected });
            checkComplete();
          }
        });

        function checkComplete() {
          if (moveDetected && resizeDetected) {
            log("Both events detected - closing in 2 seconds");
            setTimeout(() => {
              win.close();
            }, 2000);
          }
        }

        win.on("close", () => {
          if (moveDetected && resizeDetected) {
            log("Move and resize event test passed");
            resolve();
          } else {
            const missing: string[] = [];
            if (!moveDetected) missing.push("move");
            if (!resizeDetected) missing.push("resize");
            log(`Window closed without detecting: ${missing.join(", ")}`);
            reject(new Error(`Missing events: ${missing.join(", ")}`));
          }
        });
      });
    },
  }),
  defineTest({
    name: "Window visibleOnAllWorkspaces (macOS)",
    category: "Window Events (Interactive)",
    description: "Test window appears on all macOS Spaces",
    interactive: true,
    timeout: 120000,
    async run({ createWindow, log, showInstructions, waitForUserVerification }) {
      // Only relevant on macOS
      if (process.platform !== "darwin") {
        log("Skipping test - only available on macOS");
        return;
      }

      await showInstructions([
        "A test window will open",
        "Use Mission Control (Ctrl+Up or swipe up) to switch to another Space/Desktop",
        "Verify the test window appears on ALL Spaces, not just the current one",
        "Then return to this Space",
      ]);

      log("Creating test window for visibleOnAllWorkspaces");
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Visible On All Workspaces Test",
        renderer: "cef",
        width: 400,
        height: 300,
      });

      log("Checking initial visibleOnAllWorkspaces state");
      if (win.window.isVisibleOnAllWorkspaces()) {
        throw new Error("Window should not be visible on all workspaces initially");
      }

      log("Setting window visible on all workspaces");
      win.window.setAlwaysOnTop(true); // Just for better DX

      win.window.setVisibleOnAllWorkspaces(true);

      log("Verifying state is set to true");
      if (!win.window.isVisibleOnAllWorkspaces()) {
        throw new Error("Window should be visible on all workspaces after setting");
      }

      log("Window is now visible on all workspaces - verify in Mission Control");
      const result = await waitForUserVerification();

      if (result.action === "pass") {
        log("Test passed - window successfully visible on all workspaces");
      } else if (result.action === "fail") {
        throw new Error("User reported window not visible on all workspaces");
      } else if (result.action === "retest") {
        log("Re-test requested");
        return;
      }

      // Cleanup
      log("Setting window back to single workspace");
      win.window.setVisibleOnAllWorkspaces(false);
      if (win.window.isVisibleOnAllWorkspaces()) {
        throw new Error("Window should not be visible on all workspaces after unsetting");
      }
      log("Test completed successfully");
    },
  }),
];
