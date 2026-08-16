// Interactive Webview Tag Tests - Playgrounds for various webview features

import { defineTest } from "../../test-framework/types";
import { BrowserView, BrowserWindow, BuildConfig } from "electrobun/main";
import { resolveWebviewTagPlaygroundCapabilities } from "./webview-tag-capabilities";

const webviewTagCapabilities = resolveWebviewTagPlaygroundCapabilities(
  process.platform,
  BuildConfig.getSync().availableRenderers,
);

const unsupportedCapabilityNotes = [
  ...(!webviewTagCapabilities.masks
    ? ["Mask selectors are unavailable with this system webview renderer; the mask controls will be disabled"]
    : []),
  ...(!webviewTagCapabilities.passthrough
    ? ["Passthrough is unavailable with this system webview renderer; the passthrough control will be disabled"]
    : []),
];

export const webviewTagTests = [
  defineTest({
    name: "Webview Tag playground",
    category: "Webview Tag (Interactive)",
    description: "Test masks, passthrough, navigation, and inline HTML",
    instructions: [
      "A webview tag playground will open",
      `Effective renderer: ${webviewTagCapabilities.renderer}`,
      "Test masks, passthrough, navigation, and more",
      ...unsupportedCapabilityNotes,
      "Close the window when done to pass the test",
    ],
    interactive: true,
    timeout: 600000,
    async run({ log }) {
      log("Opening webview tag playground window");

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
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Webview Tag Playground",
          url: `views://playgrounds/webviewtag/index.html?renderer=${webviewTagCapabilities.renderer}&platform=${process.platform}&masks=${webviewTagCapabilities.masks ? "1" : "0"}&passthrough=${webviewTagCapabilities.passthrough ? "1" : "0"}`,
          renderer: webviewTagCapabilities.renderer,
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
    instructions: [
      "A frameless window with draggable regions will open",
      "Drag from both the dark class-based box and outlined stylesheet-based box",
      "The stylesheet region is transparent and must work on system webviews",
      "The no-drag controls and 'Done' button must remain clickable",
      "Close the window when done to pass the test",
    ],
    interactive: true,
    timeout: 600000,
    async run({ log }) {
      log("Opening draggable region playground window");

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
            messages: {},
          },
        });

        winRef = new BrowserWindow({
          title: "Draggable Region Test",
          url: "views://playgrounds/draggable/index.html",
          renderer: "native",
          frame: { width: 500, height: 600, x: 200, y: 100 },
          titleBarStyle: "hidden",
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
    instructions: [
      "A window will open with a nested webview",
      "Click buttons in the webview to send messages to the host",
      "Messages will appear in the log area",
      "Close the window when done to pass the test",
    ],
    interactive: true,
    timeout: 600000,
    async run({ log }) {
      log("Opening host message playground window");

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
    instructions: [
      "A window will open to test webview sessions",
      "Click +/- buttons in webviews to test localStorage isolation",
      "Webviews with same partition should share counter values",
      "Close the window when done to pass the test",
    ],
    interactive: true,
    timeout: 600000,
    async run({ log }) {
      log("Opening session playground window");

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
