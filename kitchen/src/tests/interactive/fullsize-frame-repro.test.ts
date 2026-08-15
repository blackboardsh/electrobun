import { defineTest } from "../../test-framework/types";
import { BrowserView, BrowserWindow } from "electrobun/main";

export const fullsizeFrameReproTests = [
  defineTest({
    name: "macOS fullSize webview frame repro",
    category: "Layout (Interactive)",
    description:
      "Repro for macOS fullSize webview sizing against titlebar; verifies bottom sentinel remains visible while resizing",
    instructions: [
      "A native-rendered window will open with default titlebar.",
      "Resize the window height up/down several times.",
      "Verify the green 'BOTTOM SENTINEL' bar stays fully visible at the bottom.",
      "Close the window when done to pass the test.",
    ],
    interactive: true,
    timeout: 180000,
    async run({ log }) {
      if (process.platform !== "darwin") {
        log("Skipping: repro target is macOS-specific");
        return;
      }

      await new Promise<void>((resolve) => {
        let winRef: BrowserWindow<any> | null = null;

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 180000,
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
          title: "FullSize Frame Repro",
          url: "views://playgrounds/fullsize-frame-repro/index.html",
          renderer: "native",
          titleBarStyle: "default",
          frame: { width: 760, height: 560, x: 160, y: 90 },
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        winRef.on("close", () => {
          resolve();
        });
      });

      log("No clipping observed in fullSize frame repro");
    },
  }),
];
