import { defineTest, expect } from "../test-framework/types";
import { GpuWindow, WGPU, webgpu } from "electrobun/bun";

const WGPUNative = WGPU.native;

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
  defineTest({
    name: "WebGPU adapter: canvas resize reconfigures surface",
    category: "WebGPU",
    description: "Acquire a surface texture matching the resized canvas",
    timeout: 15000,
    async run({ log }) {
      if (!webgpu?.createContext || !WGPUNative.available) {
        log("WebGPU adapter not available; skipping test");
        return;
      }

      const win = new GpuWindow({
        title: "WGPU Adapter Resize Test",
        frame: { width: 320, height: 240, x: 140, y: 140 },
        titleBarStyle: "default",
        transparent: false,
      });

      try {
        webgpu.install();
        const canvas = webgpu.utils.createCanvasShim(win);
        const context = canvas.getContext("webgpu");
        if (!context) {
          throw new Error("Failed to create WebGPU canvas context");
        }
        const adapter = await webgpu.navigator.requestAdapter({
          compatibleSurface: context,
        });
        const device = await adapter.requestDevice();
        context.configure({
          device,
          format: "bgra8unorm",
          usage: TextureUsage.RenderAttachment,
        });

        const initialTexture = context.getCurrentTexture();
        const initialWidth = WGPUNative.symbols.wgpuTextureGetWidth(
          initialTexture.ptr as any,
        );
        const initialHeight = WGPUNative.symbols.wgpuTextureGetHeight(
          initialTexture.ptr as any,
        );
        context.present();
        WGPUNative.symbols.wgpuTextureRelease(initialTexture.ptr as any);

        win.setSize(initialWidth + 120, initialHeight + 80);
        await sleep(100);
        const resized = win.getSize();
        canvas.width = resized.width;
        canvas.height = resized.height;

        const resizedTexture = context.getCurrentTexture();
        const textureWidth = WGPUNative.symbols.wgpuTextureGetWidth(
          resizedTexture.ptr as any,
        );
        const textureHeight = WGPUNative.symbols.wgpuTextureGetHeight(
          resizedTexture.ptr as any,
        );
        context.present();
        WGPUNative.symbols.wgpuTextureRelease(resizedTexture.ptr as any);

        expect(textureWidth, "resized surface texture width").toBe(
          resized.width,
        );
        expect(textureHeight, "resized surface texture height").toBe(
          resized.height,
        );
        log(
          `Surface texture resized from ${initialWidth}x${initialHeight} to ${textureWidth}x${textureHeight}`,
        );
      } finally {
        win.close();
      }
    },
  }),
];
