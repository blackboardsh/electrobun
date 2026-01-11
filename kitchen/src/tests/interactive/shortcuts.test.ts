// Interactive Global Shortcut Tests - Playground

import { defineTest, expect } from "../../test-framework/types";
import { BrowserView, BrowserWindow, GlobalShortcut, Utils } from "electrobun/bun";

export const shortcutTests = [
  defineTest({
    name: "Global shortcuts playground",
    category: "Shortcuts (Interactive)",
    description: "Interactive playground for testing global keyboard shortcuts",
    interactive: true,
    timeout: 600000, // 10 minutes for exploration
    async run({ log, showInstructions }) {
      await showInstructions([
        "A shortcuts control panel will open",
        "Register shortcuts and press them anywhere to test",
        "Close the window when done to pass the test",
      ]);

      log("Opening shortcuts playground window");

      await new Promise<void>((resolve) => {
        // Track registered shortcuts for cleanup
        const registeredAccelerators: Set<string> = new Set();
        let winRef: BrowserWindow | null = null;

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 600000,
          handlers: {
            requests: {
              closeWindow: () => {
                winRef?.close();
                return { success: true };
              },
              registerShortcut: ({ accelerator }: { accelerator: string }) => {
                log(`Registering: ${accelerator}`);
                const success = GlobalShortcut.register(accelerator, () => {
                  log(`Triggered: ${accelerator}`);
                  // Send notification
                  Utils.showNotification({
                    title: "Shortcut Triggered!",
                    body: accelerator,
                    silent: true,
                  });
                  // Notify the view
                  rpc.send.shortcutTriggered({ accelerator });
                });

                if (success) {
                  registeredAccelerators.add(accelerator);
                  log(`Registered successfully: ${accelerator}`);
                } else {
                  log(`Failed to register: ${accelerator}`);
                }

                return { success };
              },

              unregisterShortcut: ({ accelerator }: { accelerator: string }) => {
                log(`Unregistering: ${accelerator}`);
                GlobalShortcut.unregister(accelerator);
                registeredAccelerators.delete(accelerator);
                return { success: true };
              },

              isRegistered: ({ accelerator }: { accelerator: string }) => {
                return { registered: GlobalShortcut.isRegistered(accelerator) };
              },
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Global Shortcuts Playground",
          url: "views://shortcuts-playground/index.html",
          renderer: "cef",
          frame: { width: 550, height: 750, x: 200, y: 50 },
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("close", () => {
          // Cleanup all registered shortcuts
          for (const accelerator of registeredAccelerators) {
            GlobalShortcut.unregister(accelerator);
            log(`Cleaned up: ${accelerator}`);
          }
          log("Playground closed - test complete");
          resolve();
        });
      });
    },
  }),

  defineTest({
    name: "GlobalShortcut.isRegistered API",
    category: "Shortcuts (Automated)",
    description: "Verify isRegistered correctly reports shortcut registration state",
    interactive: false,
    async run({ log }) {
      const accelerator = "CommandOrControl+Shift+R";

      log("Checking unregistered shortcut");
      expect(GlobalShortcut.isRegistered(accelerator)).toBe(false);

      log("Registering shortcut");
      GlobalShortcut.register(accelerator, () => {});

      log("Checking registered shortcut");
      expect(GlobalShortcut.isRegistered(accelerator)).toBe(true);

      log("Unregistering shortcut");
      GlobalShortcut.unregister(accelerator);

      log("Checking unregistered shortcut again");
      expect(GlobalShortcut.isRegistered(accelerator)).toBe(false);

      log("isRegistered works correctly");
    },
  }),
];
