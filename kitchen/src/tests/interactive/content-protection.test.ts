// Content Protection Tests - Tests for preventing screen capture (macOS only)

import { defineTest } from "../../test-framework/types";
import { BrowserView, BrowserWindow } from "electrobun/bun";

export const contentProtectionTests = [
  defineTest({
    name: "Window content protection playground",
    category: "BrowserWindow",
    description: "Interactive playground for content protection",
    interactive: true,
    timeout: 600000, // 10 minutes
    async run({ log, showInstructions }) {
      await showInstructions([
        "A playground window will open with a toggle button.",
        "1. TRY TO CAPTURE: Take a screenshot (Cmd+Shift+4 -> Space).",
        "2. TOGGLE: Use the button in the new window to turn protection ON/OFF.",
        "3. VERIFY: The window should be BLACK/INVISIBLE only when ON.",
        "Close the playground window when finished.",
      ]);

      log("Opening content protection playground");

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
            },
            messages: {
              toggleContentProtection: ({ enabled }: { enabled: boolean }) => {
                log(`Toggling protection to: ${enabled}`);
                winRef?.setContentProtection(enabled);
              },
            },
          },
        });

        winRef = new BrowserWindow({
          title: "Content Protection Playground",
          url: "views://playgrounds/content-protection/index.html",
          renderer: "cef",
          frame: { width: 600, height: 500, x: 200, y: 100 },
          contentProtection: true, // Start enabled
          rpc,
        });

        winRef.setAlwaysOnTop(true);

        winRef.on("close", () => {
          log("Playground closed");
          resolve();
        });
      });
    },
  }),
];
