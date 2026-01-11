// Interactive Menu Tests - Playgrounds for Application Menu and Context Menu

import { defineTest, expect } from "../../test-framework/types";
import { ApplicationMenu, ContextMenu, BrowserView, BrowserWindow } from "electrobun/bun";
import Electrobun from "electrobun/bun";

export const menuTests = [
  defineTest({
    name: "Application menu playground",
    category: "Menus (Interactive)",
    description: "Interactive playground for testing application menu configurations",
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "An application menu playground will open",
        "Click buttons to apply different menu configurations",
        "Check the menu bar to see changes",
        "Close the window when done to pass the test",
      ]);

      log("Opening application menu playground window");

      await new Promise<void>((resolve) => {
        let winRef: BrowserWindow | null = null;
        let menuHandler: ((e: any) => void) | null = null;

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 600000,
          handlers: {
            requests: {
              closeWindow: () => {
                if (menuHandler) {
                  Electrobun.events.off("application-menu-clicked", menuHandler);
                }
                winRef?.close();
                return { success: true };
              },
              setApplicationMenu: ({ menu }: { menu: any }) => {
                ApplicationMenu.setApplicationMenu(menu);
                return { success: true };
              },
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Application Menu Playground",
          url: "views://application-menu-playground/index.html",
          renderer: "cef",
          frame: { width: 800, height: 600, x: 100, y: 50 },
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        // Listen for menu clicks and forward to view
        menuHandler = (e: any) => {
          log(`Menu clicked: ${e.data.action || e.data.role || "unknown"}`);
          win.webview.rpc?.send.menuClicked({
            action: e.data.action,
            role: e.data.role,
          });
        };
        Electrobun.events.on("application-menu-clicked", menuHandler);

        win.on("close", () => {
          if (menuHandler) {
            Electrobun.events.off("application-menu-clicked", menuHandler);
          }
          log("Playground closed - test complete");
          resolve();
        });
      });
    },
  }),

  defineTest({
    name: "Context menu playground",
    category: "Menus (Interactive)",
    description: "Interactive playground for context menus",
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A context menu playground will open",
        "Click buttons to show different context menus",
        "Right-click in the test area to show current menu",
        "Close the window when done to pass the test",
      ]);

      log("Opening context menu playground window");

      await new Promise<void>((resolve) => {
        let winRef: BrowserWindow | null = null;
        let contextHandler: ((e: any) => void) | null = null;

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 600000,
          handlers: {
            requests: {
              closeWindow: () => {
                if (contextHandler) {
                  Electrobun.events.off("context-menu-clicked", contextHandler);
                }
                winRef?.close();
                return { success: true };
              },
              showContextMenu: ({ menu }: { menu: any }) => {
                ContextMenu.showContextMenu(menu);
                return { success: true };
              },
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Context Menu Playground",
          url: "views://context-menu-playground/index.html",
          renderer: "cef",
          frame: { width: 800, height: 600, x: 150, y: 80 },
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        // Listen for context menu clicks and forward to view
        contextHandler = (e: any) => {
          log(`Context menu clicked: ${e.data.action || e.data.role || "unknown"}`);
          if (e.data.data) {
            log(`  Data: ${JSON.stringify(e.data.data)}`);
          }
          win.webview.rpc?.send.contextMenuClicked({
            action: e.data.action,
            role: e.data.role,
            data: e.data.data,
          });
        };
        Electrobun.events.on("context-menu-clicked", contextHandler);

        win.on("close", () => {
          if (contextHandler) {
            Electrobun.events.off("context-menu-clicked", contextHandler);
          }
          log("Playground closed - test complete");
          resolve();
        });
      });
    },
  }),
];
