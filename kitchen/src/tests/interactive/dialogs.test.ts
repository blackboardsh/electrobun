// Interactive Dialog Tests - Require user interaction

import { defineTest, expect } from "../../test-framework/types";
import { BrowserView, BrowserWindow, Utils } from "electrobun/bun";
import { homedir, tmpdir } from "os";
import { join } from "path";

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
          url: "views://playgrounds/file-dialog/index.html",
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

  defineTest({
    name: "openExternal - open URL in browser",
    category: "Dialogs (Interactive)",
    description: "Test opening a URL in the default browser",
    interactive: true,
    async run({ log, showInstructions }) {
      await showInstructions([
        "This will open electrobun.dev in your browser",
        "Verify the browser opens correctly",
        "The test will auto-pass after attempting",
      ]);

      log("Opening https://electrobun.dev in default browser");
      const result = Utils.openExternal("https://electrobun.dev");
      log(`openExternal returned: ${result}`);

      // Give time for browser to open
      await new Promise((resolve) => setTimeout(resolve, 1000));
      log("Test complete - verify browser opened");
    },
  }),

  defineTest({
    name: "openPath - open folder",
    category: "Dialogs (Interactive)",
    description: "Test opening a folder in Finder/Explorer",
    interactive: true,
    async run({ log, showInstructions }) {
      const targetPath = homedir();

      await showInstructions([
        `This will open your home folder: ${targetPath}`,
        "Verify Finder/Explorer opens correctly",
        "The test will auto-pass after attempting",
      ]);

      log(`Opening folder: ${targetPath}`);
      const result = Utils.openPath(targetPath);
      log(`openPath returned: ${result}`);

      await new Promise((resolve) => setTimeout(resolve, 1000));
      log("Test complete - verify folder opened");
    },
  }),

  defineTest({
    name: "showItemInFolder",
    category: "Dialogs (Interactive)",
    description: "Test revealing an item in Finder/Explorer",
    interactive: true,
    async run({ log, showInstructions }) {
      // Use a path that should exist on most systems
      const targetPath = join(homedir(), ".zshrc");

      await showInstructions([
        `This will reveal ${targetPath} in Finder`,
        "(Or fallback to home folder if file doesn't exist)",
        "Verify Finder opens and highlights the item",
      ]);

      // Try the target path, fall back to home folder
      let pathToReveal = targetPath;
      try {
        const { access } = await import("fs/promises");
        await access(targetPath);
      } catch {
        pathToReveal = homedir();
        log(`${targetPath} not found, using home folder instead`);
      }

      log(`Revealing: ${pathToReveal}`);
      const result = Utils.showItemInFolder(pathToReveal);
      log(`showItemInFolder returned: ${result}`);

      await new Promise((resolve) => setTimeout(resolve, 1000));
      log("Test complete - verify Finder opened");
    },
  }),

  defineTest({
    name: "showNotification - interactive",
    category: "Dialogs (Interactive)",
    description: "Test showing a desktop notification",
    interactive: true,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A notification will be sent in 3 seconds",
        "CLICK AWAY from this app to see it",
        "(macOS hides notifications when app is focused)",
      ]);

      log("Sending notification in 3 seconds - click away from this app!");

      // Give user time to click away
      await new Promise((resolve) => setTimeout(resolve, 3000));

      log("Showing notification now");
      Utils.showNotification({
        title: "Electrobun Test Notification",
        body: "This is a test notification from the kitchen sink",
        subtitle: "Interactive Test",
        silent: false, // Play sound so it's noticeable
      });

      // Wait for notification to appear
      await new Promise((resolve) => setTimeout(resolve, 3000));
      log("Notification sent - check your notification center");
    },
  }),
];
