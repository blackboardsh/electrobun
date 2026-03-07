import { defineTest, expect } from "../test-framework/types";
import { GpuWindow, webgpu } from "electrobun/bun";

const BufferUsage = {
  MapRead: 0x1,
  MapWrite: 0x2,
  CopySrc: 0x4,
  CopyDst: 0x8,
  Uniform: 0x40,
};

const TextureUsage = {
  CopyDst: 0x2,
  TextureBinding: 0x4,
  RenderAttachment: 0x10,
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createDeviceWithContext(win: GpuWindow) {
  webgpu.install();
  const ctx = webgpu.createContext(win);
  const adapter = await webgpu.navigator.requestAdapter({
    compatibleSurface: ctx.context,
  });
  if (!adapter) throw new Error("Failed to get adapter");
  const device = await adapter.requestDevice();
  ctx.context.configure({
    device,
    format: "bgra8unorm",
    usage: TextureUsage.RenderAttachment,
  });
  return { device, ctx };
}

export const wgpuAdapterExtendedTests = [
  defineTest({
    name: "WebGPU adapter: texture view variants",
    category: "WebGPU",
    description: "Create texture views with mip settings",
    timeout: 12000,
    async run({ log }) {
      if (!webgpu?.createContext) {
        log("WebGPU adapter not available; skipping test");
        return;
      }
      const win = new GpuWindow({
        title: "WGPU Texture View Test",
        frame: { width: 200, height: 160, x: 180, y: 180 },
        titleBarStyle: "default",
        transparent: false,
      });
      try {
        const { device } = await createDeviceWithContext(win);
        const tex = device.createTexture({
          size: { width: 8, height: 8, depthOrArrayLayers: 1 },
          format: "rgba8unorm",
          usage: TextureUsage.TextureBinding | TextureUsage.RenderAttachment | TextureUsage.CopyDst,
          mipLevelCount: 2,
        });
        const view = tex.createView({ baseMipLevel: 0, mipLevelCount: 1 });
        expect(!!view).toBeTruthy();
        log("Texture view created");
      } finally {
        win.close();
      }
    },
  }),

  defineTest({
    name: "WebGPU adapter: depth attachment render pass",
    category: "WebGPU",
    description: "Render pass with depth texture",
    timeout: 12000,
    async run({ log }) {
      if (!webgpu?.createContext) {
        log("WebGPU adapter not available; skipping test");
        return;
      }
      const win = new GpuWindow({
        title: "WGPU Depth Test",
        frame: { width: 220, height: 160, x: 220, y: 220 },
        titleBarStyle: "default",
        transparent: false,
      });
      try {
        const { device } = await createDeviceWithContext(win);
        const color = device.createTexture({
          size: { width: 64, height: 64, depthOrArrayLayers: 1 },
          format: "bgra8unorm",
          usage: TextureUsage.RenderAttachment,
        });
        const depth = device.createTexture({
          size: { width: 64, height: 64, depthOrArrayLayers: 1 },
          format: "depth24plus-stencil8",
          usage: TextureUsage.RenderAttachment,
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: color.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 1,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          },
        });
        pass.end();
        const cmd = encoder.finish();
        device.queue.submit([cmd]);
        log("Depth render pass submitted");
      } finally {
        win.close();
      }
    },
  }),

  defineTest({
    name: "WebGPU adapter: bind group layout",
    category: "WebGPU",
    description: "Create bind group layout and bind group",
    timeout: 12000,
    async run({ log }) {
      if (!webgpu?.createContext) {
        log("WebGPU adapter not available; skipping test");
        return;
      }
      const win = new GpuWindow({
        title: "WGPU BindGroup Test",
        frame: { width: 220, height: 160, x: 260, y: 260 },
        titleBarStyle: "default",
        transparent: false,
      });
      try {
        const { device } = await createDeviceWithContext(win);
        const buffer = device.createBuffer({
          size: 64,
          usage: BufferUsage.Uniform | BufferUsage.CopyDst,
        });
        const tex = device.createTexture({
          size: { width: 4, height: 4, depthOrArrayLayers: 1 },
          format: "rgba8unorm",
          usage: TextureUsage.TextureBinding | TextureUsage.CopyDst,
        });
        const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
        const layout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 3, buffer: { type: "uniform" } },
            { binding: 1, visibility: 3, sampler: { type: "filtering" } },
            { binding: 2, visibility: 3, texture: { sampleType: "float" } },
          ],
        });
        const group = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, buffer: { buffer } },
            { binding: 1, sampler },
            { binding: 2, textureView: tex.createView() },
          ],
        });
        expect(!!group).toBeTruthy();
        log("Bind group created");
      } finally {
        win.close();
      }
    },
  }),

  defineTest({
    name: "WebGPU adapter: sampler descriptor",
    category: "WebGPU",
    description: "Create sampler with filtering",
    timeout: 12000,
    async run({ log }) {
      if (!webgpu?.createContext) {
        log("WebGPU adapter not available; skipping test");
        return;
      }
      const win = new GpuWindow({
        title: "WGPU Sampler Test",
        frame: { width: 200, height: 160, x: 300, y: 300 },
        titleBarStyle: "default",
        transparent: false,
      });
      try {
        const { device } = await createDeviceWithContext(win);
        const sampler = device.createSampler({
          minFilter: "linear",
          magFilter: "linear",
          mipmapFilter: "nearest",
          addressModeU: "repeat",
          addressModeV: "repeat",
        });
        expect(!!sampler).toBeTruthy();
        log("Sampler created");
      } finally {
        win.close();
      }
    },
  }),

  defineTest({
    name: "WebGPU adapter: copyBufferToTexture",
    category: "WebGPU",
    description: "Copy from mapped buffer into texture",
    timeout: 12000,
    async run({ log }) {
      if (!webgpu?.createContext) {
        log("WebGPU adapter not available; skipping test");
        return;
      }
      const win = new GpuWindow({
        title: "WGPU CopyBufferToTexture Test",
        frame: { width: 220, height: 160, x: 340, y: 340 },
        titleBarStyle: "default",
        transparent: false,
      });
      try {
        const { device } = await createDeviceWithContext(win);
        const width = 8;
        const height = 8;
        const buffer = device.createBuffer({
          size: width * height * 4,
          usage: BufferUsage.MapWrite | BufferUsage.CopySrc,
          mappedAtCreation: true,
        });
        const mapped = buffer.getMappedRange(0, width * height * 4);
        const view = new Uint8Array(mapped);
        for (let i = 0; i < view.length; i += 4) {
          view[i] = 40;
          view[i + 1] = 140;
          view[i + 2] = 230;
          view[i + 3] = 255;
        }
        buffer.unmap();

        const tex = device.createTexture({
          size: { width, height, depthOrArrayLayers: 1 },
          format: "rgba8unorm",
          usage: TextureUsage.CopyDst | TextureUsage.TextureBinding | TextureUsage.RenderAttachment,
        });

        const encoder = device.createCommandEncoder();
        encoder.copyBufferToTexture(
          { buffer, offset: 0, bytesPerRow: width * 4, rowsPerImage: height },
          { texture: tex },
          { width, height, depthOrArrayLayers: 1 },
        );
        const cmd = encoder.finish();
        device.queue.submit([cmd]);
        await sleep(50);
        log("copyBufferToTexture submitted");
      } finally {
        win.close();
      }
    },
  }),
];
