// Interactive Dialog Tests - Require user interaction

import { defineTest, expect } from "../../test-framework/types";
import { BrowserView, BrowserWindow, Utils } from "electrobun/bun";

export const dialogTests = [
  defineTest({
    name: "showMessageBox - info dialog",
    category: "Dialogs (Interactive)",
    description: "Test info message box - clicking any button auto-passes",
    interactive: true,
    async run({ log, showInstructions }) {
      // Show instructions FIRST, before the dialog
      await showInstructions([
        "An info dialog will appear with OK and Cancel buttons",
        "Click either button to pass the test",
      ]);

      log("Showing info dialog");

      const result = await Utils.showMessageBox({
        type: "info",
        title: "Test Info Dialog",
        message: "This is a test info dialog",
        detail: "Click any button - the test will auto-pass.",
        buttons: ["OK", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });

      // Dialog returned = test passed (user interacted with it)
      const buttonName = result.response === 0 ? "OK" : "Cancel";
      log(`Dialog closed with: ${buttonName} (index ${result.response})`);
      log("Test passed - dialog interaction confirmed");
    },
  }),

  defineTest({
    name: "showMessageBox - question dialog",
    category: "Dialogs (Interactive)",
    description: "Test question dialog - clicking any button auto-passes",
    interactive: true,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A question dialog will appear with Yes/No/Cancel",
        "Click any button to pass the test",
      ]);

      log("Showing question dialog");

      const result = await Utils.showMessageBox({
        type: "question",
        title: "Test Question Dialog",
        message: "Would you like to proceed?",
        detail: "Click any button - the test will auto-pass.",
        buttons: ["Yes", "No", "Cancel"],
        defaultId: 0,
        cancelId: 2,
      });

      const buttonNames = ["Yes", "No", "Cancel"];
      log(`Dialog closed with: ${buttonNames[result.response]} (index ${result.response})`);
      log("Test passed - dialog interaction confirmed");
    },
  }),

  defineTest({
    name: "File dialog playground",
    category: "Dialogs (Interactive)",
    description: "Interactive playground to test file dialog with configurable options",
    interactive: true,
    timeout: 600000, // 10 minutes for exploration
    async run({ log, showInstructions }) {
      await showInstructions([
        "A control panel will open for file dialog testing",
        "Configure options and click 'Open Dialog' to test",
        "Close the window when done to pass the test",
      ]);

      log("Opening file dialog playground window");

      // Create a promise that resolves when user closes the window
      await new Promise<void>((resolve) => {
        let winRef: BrowserWindow | null = null;

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 600000, // 10 minutes - file dialogs can take a while
          handlers: {
            requests: {
              closeWindow: () => {
                winRef?.close();
                return { success: true };
              },
              openFileDialog: async (opts: any) => {
                // Expand ~ to home directory since macOS NSURL doesn't handle tilde expansion
                if (opts.startingFolder && opts.startingFolder.startsWith("~")) {
                  opts.startingFolder = opts.startingFolder.replace("~", Bun.env.HOME || "/Users");
                }
                log(`Opening dialog with options: ${JSON.stringify(opts)}`);
                const result = await Utils.openFileDialog(opts);
                if (result.length > 0 && result[0] !== "") {
                  log(`Selected ${result.length} item(s):`);
                  result.forEach((path: string, i: number) => log(`  ${i + 1}. ${path}`));
                } else {
                  log("Dialog cancelled or no selection");
                }
                return result;
              },
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "File Dialog Playground",
          url: "views://file-dialog-playground/index.html",
          renderer: "cef",
          frame: { width: 600, height: 850, x: 200, y: 50 },
          rpc,
        });

        // Keep playground on top so it doesn't hide behind test runner
        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("close", () => {
          log("Playground window closed - test complete");
          resolve();
        });
      });
    },
  }),
];
