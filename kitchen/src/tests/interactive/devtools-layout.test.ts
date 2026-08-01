import { BrowserWindow } from "electrobun/bun";
import { defineTest } from "../../test-framework/types";

export const devtoolsLayoutTests = [
  defineTest({
    name: "macOS docked Web Inspector layout",
    category: "Layout (Interactive)",
    description:
      "Verifies that focusing and closing a docked system WebKit inspector does not shift or gray the app content",
    interactive: true,
    timeout: 180000,
    async run({ log, showInstructions, waitForUserVerification }) {
      if (process.platform !== "darwin") {
        log("Skipping: docked WKWebView inspector is macOS-specific");
        return;
      }

      await showInstructions([
        "A hidden-inset native window will open and show its Web Inspector.",
        "Dock the inspector to the bottom if it opens in a separate window.",
        "Move the pointer over the inspector and click several tabs and controls.",
        "Verify the red/green app content remains aligned and never turns gray.",
        "Close the inspector and verify the app content fills the window again.",
        "Close the test window, then mark the result.",
      ]);

      await new Promise<void>((resolve) => {
        const win = new BrowserWindow({
          title: "Docked Web Inspector Layout",
          renderer: "native",
          titleBarStyle: "hiddenInset",
          frame: { width: 900, height: 700, x: 180, y: 100 },
          html: `<!doctype html>
            <style>
              * { box-sizing: border-box; }
              html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
              body { display: grid; grid-template-rows: 72px 1fr 72px; font: 600 18px system-ui; }
              header { padding: 34px 24px 12px; color: white; background: #c73535; }
              main { display: grid; place-items: center; background: white; color: #202020; }
              footer { display: grid; place-items: center; color: white; background: #18864b; }
            </style>
            <header>TOP EDGE</header>
            <main>Content must remain aligned while hovering the docked inspector.</main>
            <footer>BOTTOM EDGE</footer>`,
        });

        setTimeout(() => win.webview.openDevTools(), 500);
        win.on("close", () => resolve());
      });

      const result = await waitForUserVerification();
      if (result.action === "fail") {
        throw new Error(result.notes || "Docked inspector shifted or grayed app content");
      }
      if (result.action === "retest") {
        throw new Error("RETEST: User requested another run");
      }

      log("Docked inspector layout remained stable through hover and close");
    },
  }),
];
