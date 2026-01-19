// Interactive Clipboard Tests - Playground

import { defineTest, expect } from "../../test-framework/types";
import { BrowserView, BrowserWindow, Utils } from "electrobun/bun";

export const clipboardInteractiveTests = [
  defineTest({
    name: "Clipboard playground",
    category: "Clipboard (Interactive)",
    description: "Interactive playground for testing clipboard read/write functionality",
    interactive: true,
    timeout: 600000, // 10 minutes for exploration
    async run({ log, showInstructions }) {
      await showInstructions([
        "A clipboard control panel will open",
        "Test reading and writing to the clipboard",
        "Close the window when done to pass the test",
      ]);

      log("Opening clipboard playground window");

      await new Promise<void>((resolve) => {
        let winRef: BrowserWindow | null = null;

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 600000,
          handlers: {
            requests: {
              closeWindow: () => {
                winRef?.close();
                return { success: true };
              },
              readClipboard: () => {
                const text = Utils.clipboardReadText();
                const formats = Utils.clipboardAvailableFormats();
                log(`Clipboard read: "${text ? text.substring(0, 50) : "(empty)"}..."`);
                return { text, formats };
              },
              writeClipboard: ({ text }: { text: string }) => {
                Utils.clipboardWriteText(text);
                log(`Clipboard written: "${text.substring(0, 50)}..."`);
                return { success: true };
              },
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Clipboard Playground",
          url: "views://playgrounds/clipboard/index.html",
          renderer: "cef",
          frame: { width: 550, height: 800, x: 200, y: 50 },
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("close", () => {
          log("Playground closed - test complete");
          resolve();
        });
      });
    },
  }),
];
