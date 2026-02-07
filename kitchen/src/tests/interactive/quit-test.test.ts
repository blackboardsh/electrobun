// Interactive Quit/Shutdown Tests - Playground

import { defineTest } from "../../test-framework/types";
import Electrobun, { BrowserView, BrowserWindow, Utils } from "electrobun/bun";

// Register the beforeQuit handler globally so it's active for all quit paths
let beforeQuitRegistered = false;
let activeRpc: any = null;

function ensureBeforeQuitHandler() {
  if (beforeQuitRegistered) return;
  beforeQuitRegistered = true;

  Electrobun.events.on("before-quit", (event: any) => {
    console.log("before-quit handler running");
    
    // Send message to the UI so the user can see it fired
    try {
      activeRpc?.send.beforeQuitFired({
        message: "beforeQuit handler fired! Waiting 2 seconds for cleanup...",
      });
    } catch {
      // RPC may not be available during shutdown
    }

    // Wait 2 seconds to prove the handler has time to do cleanup
    const start = Date.now();
    while (Date.now() - start < 2000) {
      // Synchronous busy-wait to simulate cleanup work
    }

    try {
      activeRpc?.send.beforeQuitDone({
        message: "beforeQuit cleanup complete (2s elapsed). Quitting now.",
      });
    } catch {
      // RPC may not be available during shutdown
    }

    // Allow the quit to proceed (don't set event.response = { allow: false })
  });
}

export const quitTests = [
  defineTest({
    name: "Quit/Shutdown playground",
    category: "Quit (Interactive)",
    description:
      "Interactive playground for testing quit modes and verifying beforeQuit handler fires correctly",
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      // Ensure the beforeQuit handler is registered
      ensureBeforeQuitHandler();

      await showInstructions([
        "A quit test control panel will open",
        "Use buttons to test programmatic quit, or follow instructions for system quit",
        "The beforeQuit handler will log to the event log and wait 2 seconds",
        "Close the window when done exploring to pass the test",
      ]);

      log("Opening quit test playground window");

      await new Promise<void>((resolve) => {
        let winRef: BrowserWindow<any> | null = null;

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 600000,
          handlers: {
            requests: {
              closeWindow: () => {
                winRef?.close();
                return { success: true };
              },
              triggerQuit: ({ mode }: { mode: string }) => {
                log(`Quit triggered via: ${mode}`);

                if (mode === "utils-quit") {
                  // Small delay so the RPC response can be sent back
                  setTimeout(() => {
                    Utils.quit();
                  }, 100);
                } else if (mode === "process-exit") {
                  setTimeout(() => {
                    process.exit(0);
                  }, 100);
                }

                return { success: true, message: `${mode} will execute shortly` };
              },
            },
            messages: {
              beforeQuitFired: (data: { message: string }) => {},
              beforeQuitDone: (data: { message: string }) => {},
            },
          },
        });

        // Store RPC ref so the beforeQuit handler can send messages
        activeRpc = rpc;

        winRef = new BrowserWindow({
          title: "Quit/Shutdown Test Playground",
          url: "views://playgrounds/quit-test/index.html",
          renderer: "cef",
          frame: { width: 600, height: 700, x: 200, y: 50 },
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("close", () => {
          activeRpc = null;
          log("Playground closed - test complete");
          resolve();
        });
      });

      log("Quit test playground finished");
    },
  }),
];
