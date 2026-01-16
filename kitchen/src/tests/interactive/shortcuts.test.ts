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

              unregisterAllShortcuts: () => {
                log(`Unregistering all ${registeredAccelerators.size} shortcuts`);
                GlobalShortcut.unregisterAll();
                registeredAccelerators.clear();
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
      // Clean up any shortcuts from previous test runs
      log("Cleaning up any existing shortcuts");
      GlobalShortcut.unregisterAll();

      // Try shortcuts with 3 modifiers and uncommon keys
      // Avoid using all 4 modifiers as Windows may block that combination
      const candidates = [
        "Alt+Shift+Super+F13",
        "Alt+Shift+Super+F14",
        "Alt+Shift+Super+F15",
        "CommandOrControl+Shift+Super+F13",
        "CommandOrControl+Alt+Super+F13",
      ];

      let accelerator = "";
      let registered = false;

      for (const candidate of candidates) {
        log(`Trying to register: ${candidate}`);
        registered = GlobalShortcut.register(candidate, () => {});
        if (registered) {
          accelerator = candidate;
          log(`Successfully registered: ${accelerator}`);
          break;
        } else {
          log(`Failed to register ${candidate}, trying next...`);
        }
      }

      if (!registered) {
        log("ERROR: Could not register any test shortcuts - all candidates in use");
        throw new Error("No shortcuts could be registered for testing");
      }

      log("Verifying isRegistered returns true");
      expect(GlobalShortcut.isRegistered(accelerator)).toBe(true);

      log("Unregistering shortcut");
      GlobalShortcut.unregister(accelerator);

      log("Verifying isRegistered returns false after unregister");
      expect(GlobalShortcut.isRegistered(accelerator)).toBe(false);

      log("isRegistered works correctly");
    },
  }),

  defineTest({
    name: "GlobalShortcut.unregisterAll API",
    category: "Shortcuts (Automated)",
    description: "Verify unregisterAll clears all registered shortcuts",
    interactive: false,
    async run({ log }) {
      // Clean up any shortcuts from previous test runs
      log("Cleaning up any existing shortcuts");
      GlobalShortcut.unregisterAll();

      // Try shortcuts with 3 modifiers and uncommon keys
      // Avoid using all 4 modifiers as Windows may block that combination
      const candidates = [
        "Alt+Shift+Super+F16",
        "Alt+Shift+Super+F17",
        "Alt+Shift+Super+F18",
        "CommandOrControl+Shift+Super+F16",
        "CommandOrControl+Alt+Super+F16",
        "CommandOrControl+Alt+Super+F17",
      ];

      log("Registering multiple shortcuts");
      const registeredShortcuts: string[] = [];

      for (const accelerator of candidates) {
        const success = GlobalShortcut.register(accelerator, () => {});
        if (success) {
          registeredShortcuts.push(accelerator);
          expect(GlobalShortcut.isRegistered(accelerator)).toBe(true);
          log(`Registered: ${accelerator}`);
          // Stop after successfully registering 3 shortcuts
          if (registeredShortcuts.length >= 3) {
            break;
          }
        } else {
          log(`Could not register ${accelerator} (in use), trying next...`);
        }
      }

      if (registeredShortcuts.length === 0) {
        log("ERROR: Could not register any shortcuts for testing");
        throw new Error("No shortcuts could be registered - all candidates are in use");
      }

      log(`Registered ${registeredShortcuts.length} shortcuts`);

      log("Calling unregisterAll");
      GlobalShortcut.unregisterAll();

      log("Verifying all shortcuts are unregistered");
      for (const accelerator of registeredShortcuts) {
        expect(GlobalShortcut.isRegistered(accelerator)).toBe(false);
      }

      log("unregisterAll works correctly");
    },
  }),
];
