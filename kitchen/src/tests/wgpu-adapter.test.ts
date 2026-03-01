import { defineTest, expect } from "../test-framework/types";
import { GpuWindow, webgpu } from "electrobun/bun";

const TextureUsage = {
  CopyDst: 0x2,
  TextureBinding: 0x4,
  RenderAttachment: 0x10,
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const wgpuAdapterTests = [
  defineTest({
    name: "WebGPU adapter: writeTexture + render pass",
    category: "WebGPU",
    description: "Upload a texture and run a basic render pass without errors",
    timeout: 15000,
    async run({ log }) {
      if (!webgpu?.createContext) {
        log("WebGPU adapter not available; skipping test");
        return;
      }

      const win = new GpuWindow({
        title: "WGPU Adapter Test",
        frame: { width: 320, height: 240, x: 120, y: 120 },
        titleBarStyle: "default",
        transparent: false,
      });

      try {
        webgpu.install();
        const ctx = webgpu.createContext(win);
        const adapter = await webgpu.navigator.requestAdapter({
          compatibleSurface: ctx.context,
        });
        expect(!!adapter).toBeTruthy();
        const device = await adapter.requestDevice();

        ctx.context.configure({
          device,
          format: "bgra8unorm",
          usage: TextureUsage.RenderAttachment,
        });

        const width = 64;
        const height = 4;
        const data = new Uint8Array(width * height * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 255;
          data[i + 1] = 128;
          data[i + 2] = 32;
          data[i + 3] = 255;
        }

        const texture = device.createTexture({
          size: { width, height, depthOrArrayLayers: 1 },
          format: "rgba8unorm",
          usage:
            TextureUsage.CopyDst |
            TextureUsage.TextureBinding |
            TextureUsage.RenderAttachment,
        });

        device.queue.writeTexture(
          { texture },
          data,
          { bytesPerRow: width * 4, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 },
        );

        const view = texture.createView();
        expect(!!view).toBeTruthy();

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        });
        pass.end();
        const commandBuffer = encoder.finish();
        device.queue.submit([commandBuffer]);
        log("Render pass submitted");
        await sleep(100);
      } finally {
        win.close();
      }
    },
  }),
];
