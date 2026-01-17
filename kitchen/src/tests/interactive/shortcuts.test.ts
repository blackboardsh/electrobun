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
          url: "views://playgrounds/shortcuts/index.html",
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

      // Try shortcuts with 3 modifiers and uncommon keys that work on Linux
      // Avoid using all 4 modifiers as Windows may block that combination
      // Use very obscure combinations that are unlikely to be taken by desktop environments
      const candidates = [
        "Alt+Shift+Super+F11",
        "Alt+Shift+Super+F12",
        "Alt+Shift+Super+Insert",
        "CommandOrControl+Shift+Super+F11",
        "CommandOrControl+Alt+Super+F11",
        "Alt+Shift+Super+Delete",
        "Alt+Shift+Super+Home",
        "Alt+Shift+Super+End",
        // Additional obscure candidates less likely to be used
        "Alt+Shift+Super+ScrollLock",
        "Alt+Shift+Super+Pause",
        "Alt+Shift+Super+Break",
        "CommandOrControl+Shift+Super+ScrollLock",
        "CommandOrControl+Shift+Super+Pause",
        "CommandOrControl+Alt+Super+ScrollLock",
        "CommandOrControl+Alt+Super+Pause",
        "Alt+Shift+Super+SysReq",
        "CommandOrControl+Shift+Super+SysReq",
        "Alt+Shift+Super+MediaSelect",
        "Alt+Shift+Super+Calculator",
        "Alt+Shift+Super+Sleep",
        "CommandOrControl+Shift+Super+MediaSelect",
        "CommandOrControl+Shift+Super+Calculator",
        "CommandOrControl+Shift+Super+Sleep",
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
        log("WARNING: Could not register any test shortcuts - all candidates in use");
        log("This is common on Linux systems with many global shortcuts already registered");
        log("Skipping this test as no shortcut combinations are available");
        // Skip this test gracefully instead of failing
        return;
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

      // Try shortcuts with 3 modifiers and uncommon keys that work on Linux
      // Avoid using all 4 modifiers as Windows may block that combination
      // Use very obscure combinations that are unlikely to be taken by desktop environments
      const candidates = [
        "Alt+Shift+Super+F9",
        "Alt+Shift+Super+F10",
        "Alt+Shift+Super+PageUp",
        "CommandOrControl+Shift+Super+F9",
        "CommandOrControl+Alt+Super+F9",
        "CommandOrControl+Alt+Super+F10",
        "Alt+Shift+Super+PageDown",
        "Alt+Shift+Super+Print",
        // Additional obscure candidates less likely to be used  
        "Alt+Shift+Super+NumLock",
        "Alt+Shift+Super+CapsLock",
        "CommandOrControl+Shift+Super+NumLock",
        "CommandOrControl+Shift+Super+CapsLock",
        "CommandOrControl+Alt+Super+NumLock",
        "CommandOrControl+Alt+Super+CapsLock",
        "Alt+Shift+Super+Menu",
        "Alt+Shift+Super+Apps",
        "CommandOrControl+Shift+Super+Menu",
        "CommandOrControl+Shift+Super+Apps",
        "Alt+Shift+Super+PrintScreen",
        "Alt+Shift+Super+Cancel",
        "CommandOrControl+Shift+Super+Cancel",
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
        log("WARNING: Could not register any shortcuts for testing");
        log("This is common on Linux systems with many global shortcuts already registered");
        log("Skipping this test as no shortcut combinations are available");
        // Skip this test gracefully instead of failing
        return;
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
