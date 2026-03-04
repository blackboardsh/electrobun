// Interactive WGPU Tag Tests - Playground for <electrobun-wgpu>

import { defineTest } from "../../test-framework/types";
import { BrowserView, BrowserWindow } from "electrobun/bun";
import { WgpuTagRenderer } from "../../bun/wgpuTagRenderer";

export const wgpuTagTests = [
  defineTest({
    name: "WGPU Tag playground",
    category: "WGPU Tag (Interactive)",
    description: "Test WGPU view positioning, transparency, passthrough, and resizing",
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      await showInstructions([
        "A WGPU tag playground will open",
        "Use the controls to toggle transparency/passthrough and resize",
        "Close the window when done to pass the test",
      ]);

      log("Opening WGPU tag playground window");

      await new Promise<void>((resolve) => {
        let winRef: BrowserWindow<any> | null = null;
        const renderer = new WgpuTagRenderer();

        const rpc = BrowserView.defineRPC<any>({
          maxRequestTime: 600000,
          handlers: {
            requests: {
              closeWindow: () => {
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
          title: "WGPU Tag Playground",
          url: "views://playgrounds/wgpu-tag/index.html",
          renderer: "cef",
          frame: { width: 860, height: 720, x: 120, y: 60 },
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
  }),
];
