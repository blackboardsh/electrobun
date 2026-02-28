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
          url: "views://playgrounds/window-events-move-resize/index.html",
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
    name: "Window blur and focus events",
    category: "Window Events (Interactive)",
    description: "Test both blur and focus events are detected with live updates",
    interactive: true,
    timeout: 120000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A test window will open",
        "1. Focus another window to detect blur event",
        "2. Focus the test window to detect focus event",
        "Test passes when both events are detected",
      ]);

      log("Opening test window for blur and focus event detection");

      await new Promise<void>((resolve, reject) => {
        let blurDetected = false;
        let focusDetected = false;
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
          title: "Blur & Focus Test",
          url: "views://playgrounds/window-events-blur-focus/index.html",
          renderer: "cef",
          frame: { width: 350, height: 400, x: 200, y: 200 },
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("blur", () => {
          if (!blurDetected) {
            blurDetected = true;
            log(`Blur event detected`);
            win.webview.rpc?.send.updateStatus({ blurDetected, focusDetected });

            win.on("focus", () => {
              if (win.webview.rpc && !focusDetected) {
                focusDetected = true;
                log(`Focus event detected`);
                win.webview.rpc?.send.updateStatus({ blurDetected, focusDetected });

                log("Both events detected - closing in 2 seconds");
                setTimeout(() => {
                  win.close();
                }, 2000);
              }
            });
          }
        });

        win.on("close", () => {
          if (blurDetected && focusDetected) {
            log("Blur and focus event test passed");
            resolve();
          } else {
            const missing: string[] = [];
            if (!blurDetected) missing.push("blur");
            if (!focusDetected) missing.push("focus");
            log(`Window closed without detecting: ${missing.join(", ")}`);
            reject(new Error(`Missing events: ${missing.join(", ")}`));
          }
        });
      });
    },
  }),
];
