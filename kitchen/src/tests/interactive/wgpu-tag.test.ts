// Interactive WGPU Tag Tests - Playground for <electrobun-wgpu>

import { defineTest } from "../../test-framework/types";
import { BrowserView, BrowserWindow } from "electrobun/bun";
import { WgpuTagRenderer } from "../../bun/wgpuTagRenderer";

function createWgpuTagTest(name: string, transparent: boolean) {
  return defineTest({
    name,
    category: "WGPU Tag (Interactive)",
    description: transparent
      ? "Test WGPU tag rendering in a transparent window"
      : "Test WGPU view positioning, transparency, passthrough, and resizing",
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      await showInstructions(transparent ? [
        "A transparent window with a WGPU tag will open",
        "The desktop should be visible behind the HTML content",
        "The WGPU surface should render correctly within the page",
        ...(process.platform === "linux" ? [
          "Linux note: passthrough/mask interaction for WGPU tags inside transparent windows is not supported; verify rendering and resize only",
        ] : []),
        "Close the window when done to pass the test",
      ] : [
        "A WGPU tag playground will open",
        "Use the controls to toggle transparency/passthrough and resize",
        "Close the window when done to pass the test",
      ]);

      log(`Opening ${transparent ? "transparent " : ""}WGPU tag playground`);

      await new Promise<void>((resolve) => {
        let winRef: BrowserWindow<any> | null = null;
        const renderer = new WgpuTagRenderer();

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 600000,
          handlers: {
            requests: {
              closeWindow: () => {
                renderer.stopAll();
                winRef?.close();
                return { success: true };
              },
              wgpuTagReady: ({ id, rect }: { id: number; rect: { x: number; y: number; width: number; height: number } }) => {
                if (!winRef) return { success: false };
                try {
                  renderer.start(id, winRef, rect);
                  return { success: true };
                } catch (err: any) {
                  log(`WGPU tag start failed: ${String(err?.message ?? err)}`);
                  return { success: false };
                }
              },
              wgpuTagToggleShader: ({ id }: { id: number }) => {
                renderer.toggleShader(id);
                return { success: true };
              },
            },
            messages: {
              wgpuTagRect: ({ id, rect }: { id: number; rect: { x: number; y: number; width: number; height: number } }) => {
                renderer.updateRect(id, rect);
              },
            },
          },
        });

        winRef = new BrowserWindow({
          title: transparent ? "Transparent WGPU Tag" : "WGPU Tag Playground",
          url: "views://playgrounds/wgpu-tag/index.html",
          renderer: "native",
          frame: { width: 860, height: 720, x: 120, y: 60 },
          transparent,
          rpc,
        });

        winRef.setAlwaysOnTop(true);
        const win = winRef;

        win.on("close", () => {
          renderer.stopAll();
          log("Playground closed - test complete");
          resolve();
        });
      });
    },
  });
}

export const wgpuTagTests = [
  createWgpuTagTest("WGPU Tag playground", false),
  createWgpuTagTest("Transparent WGPU Tag", true),
];
