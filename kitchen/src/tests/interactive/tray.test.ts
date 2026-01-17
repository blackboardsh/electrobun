// Interactive Tray Tests - Playground for exploring tray functionality

import { defineTest, expect } from "../../test-framework/types";
import { BrowserView, BrowserWindow, Tray } from "electrobun/bun";

export const trayTests = [
  defineTest({
    name: "Tray playground",
    category: "Tray (Interactive)",
    description: "Interactive playground for testing tray icon, title, and menus",
    interactive: true,
    timeout: 600000, // 10 minutes for exploration
    async run({ log, showInstructions }) {
      await showInstructions([
        "A tray control panel will open",
        "Configure tray options and click buttons to test",
        "Close the window when done to pass the test",
      ]);

      log("Opening tray playground window");

      await new Promise<void>((resolve) => {
        let currentTray: Tray | null = null;
        let updateInterval: any = null;
        let winRef: BrowserWindow | null = null;

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 600000, // 10 minutes for interactive exploration
          handlers: {
            requests: {
              closeWindow: () => {
                winRef?.close();
                return { success: true };
              },
              createTray: (opts: { title: string; showMenu: boolean; hasSubmenu: boolean }) => {
                // Remove existing tray
                if (currentTray) {
                  if (updateInterval) clearInterval(updateInterval);
                  currentTray.remove();
                }

                currentTray = new Tray({
                  title: opts.title || "Test Tray",
                  image: "views://assets/electrobun-logo-32-template.png",
                  template: true,
                  width: 32,
                  height: 32,
                });

                if (opts.showMenu) {
                  const menu: any[] = [
                    { type: "normal", label: "Action 1", action: "action-1" },
                    { type: "normal", label: "Action 2", action: "action-2" },
                    { type: "divider" },
                  ];

                  if (opts.hasSubmenu) {
                    menu.push({
                      type: "normal",
                      label: "More Options",
                      submenu: [
                        { type: "normal", label: "Sub Item A", action: "sub-a" },
                        { type: "normal", label: "Sub Item B", action: "sub-b" },
                      ],
                    });
                  }

                  menu.push({ type: "normal", label: "Close", action: "close" });
                  currentTray.setMenu(menu);
                }

                currentTray.on("tray-clicked", (e: any) => {
                  log(`Tray clicked: ${e.data.action}`);
                });

                log(`Created tray: "${opts.title}"`);
                return { success: true };
              },

              updateTitle: (opts: { title: string }) => {
                if (currentTray) {
                  currentTray.setTitle(opts.title);
                  log(`Updated title to: "${opts.title}"`);
                }
                return { success: true };
              },

              startCounter: () => {
                if (!currentTray) return { success: false };
                let count = 0;
                if (updateInterval) clearInterval(updateInterval);
                updateInterval = setInterval(() => {
                  count++;
                  currentTray?.setTitle(`Count: ${count}`);
                }, 1000);
                log("Started counter");
                return { success: true };
              },

              stopCounter: () => {
                if (updateInterval) {
                  clearInterval(updateInterval);
                  updateInterval = null;
                  log("Stopped counter");
                }
                return { success: true };
              },

              removeTray: () => {
                if (updateInterval) clearInterval(updateInterval);
                if (currentTray) {
                  currentTray.remove();
                  currentTray = null;
                  log("Removed tray");
                }
                return { success: true };
              },
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Tray Playground",
          url: "views://playgrounds/tray/index.html",
          renderer: "cef",
          frame: { width: 500, height: 750, x: 200, y: 50 },
          rpc,
        });

        // Keep playground on top so it doesn't hide behind test runner
        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("close", () => {
          if (updateInterval) clearInterval(updateInterval);
          if (currentTray) currentTray.remove();
          log("Playground closed - test complete");
          resolve();
        });
      });
    },
  }),
];
