// Interactive Webview Tag Tests - Playgrounds for various webview features

import { defineTest, expect } from "../../test-framework/types";
import { BrowserView, BrowserWindow } from "electrobun/bun";

export const webviewTagTests = [
  defineTest({
    name: "Webview Tag playground",
    category: "Webview Tag (Interactive)",
    description: "Test masks, passthrough, navigation, and inline HTML",
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A webview tag playground will open",
        "Test masks, passthrough, navigation, and more",
        "Close the window when done to pass the test",
      ]);

      log("Opening webview tag playground window");

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
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Webview Tag Playground",
          url: "views://playgrounds/webviewtag/index.html",
          renderer: "cef",
          frame: { width: 800, height: 900, x: 100, y: 50 },
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

  defineTest({
    name: "Draggable region playground",
    category: "Webview Tag (Interactive)",
    description: "Test frameless window with draggable regions",
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A frameless window with draggable regions will open",
        "Try dragging the window by the dark header area",
        "The 'Done' button should work without triggering drag",
        "Close the window when done to pass the test",
      ]);

      log("Opening draggable region playground window");

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
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Draggable Region Test",
          url: "views://playgrounds/draggable/index.html",
          renderer: "cef",
          frame: { width: 500, height: 450, x: 200, y: 100 },
          frameless: true,
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

  defineTest({
    name: "Host message playground",
    category: "Webview Tag (Interactive)",
    description: "Test sendToHost communication from nested webview",
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A window will open with a nested webview",
        "Click buttons in the webview to send messages to the host",
        "Messages will appear in the log area",
        "Close the window when done to pass the test",
      ]);

      log("Opening host message playground window");

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
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Host Message Playground",
          url: "views://playgrounds/host-message/index.html",
          renderer: "cef",
          frame: { width: 700, height: 600, x: 150, y: 80 },
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

  defineTest({
    name: "Session & partition playground",
    category: "Webview Tag (Interactive)",
    description: "Test webview partitions, cookies, and session storage",
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A window will open to test webview sessions",
        "Click +/- buttons in webviews to test localStorage isolation",
        "Webviews with same partition should share counter values",
        "Close the window when done to pass the test",
      ]);

      log("Opening session playground window");

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
            },
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Session & Partition Playground",
          url: "views://playgrounds/session/index.html",
          renderer: "cef",
          frame: { width: 900, height: 800, x: 100, y: 50 },
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
