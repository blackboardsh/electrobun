// Interactive Chromeless/Transparent Window Tests

import { defineTest, expect } from "../../test-framework/types";
import { BrowserView, BrowserWindow } from "electrobun/bun";

export const chromelessTests = [
  defineTest({
    name: "Custom titlebar with window controls",
    category: "Chromeless Windows (Interactive)",
    description: "Test custom titlebar with draggable region and custom close/minimize/maximize buttons",
    interactive: true,
    timeout: 120000,
    async run({ log, showInstructions, waitForUserVerification }) {
      await showInstructions([
        "A window with a custom titlebar will open",
        "Test the following:",
        "- Drag the window by the dark titlebar area",
        "- Click the colored buttons (close, minimize, maximize)",
        "- Verify text input works in the content area",
        "Click Pass if all controls work correctly",
      ]);

      log("Opening custom titlebar test window");

      await new Promise<void>((resolve, reject) => {
        let winRef: BrowserWindow | null = null;
        let isMaximized = false;

        const rpc = BrowserView.defineRPC<{
          requests: {
            closeWindow: () => { success: boolean };
            minimizeWindow: () => { success: boolean };
            maximizeWindow: () => { success: boolean };
          };
          messages: {};
        }>({
          maxRequestTime: 120000,
          handlers: {
            requests: {
              closeWindow: () => {
                log("Close button clicked");
                winRef?.close();
                return { success: true };
              },
              minimizeWindow: () => {
                log("Minimize button clicked");
                winRef?.minimize();
                return { success: true };
              },
              maximizeWindow: () => {
                if (isMaximized) {
                  log("Unmaximize button clicked");
                  winRef?.unmaximize();
                  isMaximized = false;
                } else {
                  log("Maximize button clicked");
                  winRef?.maximize();
                  isMaximized = true;
                }
                return { success: true };
              },
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Custom Titlebar",
          url: "views://playgrounds/custom-titlebar/index.html",
          renderer: "cef",
          frame: { width: 500, height: 700, x: 150, y: 50 },
          // 'hidden' titleBarStyle hides both titlebar AND native window controls
          titleBarStyle: "hidden",
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("close", () => {
          log("Window closed");
          resolve();
        });
      });

      // Wait for user verification
      const result = await waitForUserVerification();
      if (result.action === "fail") {
        throw new Error(result.notes || "User marked test as failed");
      }
      if (result.action === "retest") {
        throw new Error("RETEST: User requested to run the test again");
      }

      log("Custom titlebar test completed");
    },
  }),

  defineTest({
    name: "Transparent/borderless window for floating UI",
    category: "Chromeless Windows (Interactive)",
    description: "Test transparent window with custom-shaped floating UI elements",
    interactive: true,
    timeout: 120000,
    async run({ log, showInstructions, waitForUserVerification }) {
      await showInstructions([
        "A transparent borderless window will open",
        "The window background should be transparent/see-through",
        "Test the following:",
        "- Verify you can see through the window background",
        "- Drag any of the floating cards to move the window",
        "- Click the red close button when done",
        "Click Pass if transparency and dragging work",
      ]);

      log("Opening transparent window test");

      await new Promise<void>((resolve, reject) => {
        let winRef: BrowserWindow | null = null;

        const rpc = BrowserView.defineRPC<{
          requests: {
            closeWindow: () => { success: boolean };
          };
          messages: {};
        }>({
          maxRequestTime: 120000,
          handlers: {
            requests: {
              closeWindow: () => {
                log("Close button clicked");
                winRef?.close();
                return { success: true };
              },
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Transparent Window",
          url: "views://playgrounds/transparent-window/index.html",
          renderer: "cef",
          frame: { width: 450, height: 500, x: 200, y: 100 },
          // 'hidden' titleBarStyle hides titlebar and native controls
          titleBarStyle: "hidden",
          // transparent: true makes window background see-through
          transparent: true,
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("close", () => {
          log("Window closed");
          resolve();
        });
      });

      // Wait for user verification
      const result = await waitForUserVerification();
      if (result.action === "fail") {
        throw new Error(result.notes || "User marked test as failed");
      }
      if (result.action === "retest") {
        throw new Error("RETEST: User requested to run the test again");
      }

      log("Transparent window test completed");
    },
  }),
];
