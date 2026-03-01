import { defineTest, expect } from "../test-framework/types";
import { GpuWindow, babylon, webgpu } from "electrobun/bun";

const TextureUsage = {
  RenderAttachment: 0x10,
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCanvasShim(win: GpuWindow) {
  const size = win.getSize();
  return {
    width: size.width,
    height: size.height,
    clientWidth: size.width,
    clientHeight: size.height,
    style: {},
    getContext: (type: string) => {
      if (type !== "webgpu") return null;
      const ctx = webgpu.createContext(win);
      return ctx.context;
    },
    getBoundingClientRect: () => {
      const current = win.getSize();
      return {
        left: 0,
        top: 0,
        width: current.width,
        height: current.height,
      };
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
  };
}

export const babylonAdapterTests = [
  defineTest({
    name: "Babylon adapter: textured quad",
    category: "Babylon",
    description: "Initialize Babylon WebGPU and render a textured quad",
    timeout: 20000,
    async run({ log }) {
      if (!webgpu?.createContext) {
        log("WebGPU adapter not available; skipping test");
        return;
      }

      const win = new GpuWindow({
        title: "Babylon Adapter Test",
        frame: { width: 360, height: 240, x: 160, y: 160 },
        titleBarStyle: "default",
        transparent: false,
      });

      try {
        webgpu.install();
        const canvas = createCanvasShim(win);
        const engine = new babylon.WebGPUEngine(canvas as any, { antialias: false });
        await engine.initAsync();

        const scene = new babylon.Scene(engine);
        scene.clearColor = new babylon.Color4(0.05, 0.05, 0.08, 1);

        const camera = new babylon.FreeCamera(
          "camera",
          new babylon.Vector3(0, 0, -3),
          scene,
        );
        camera.inputs.clear();
        camera.setTarget(babylon.Vector3.Zero());

        const light = new babylon.HemisphericLight(
          "light",
          new babylon.Vector3(0, 1, 0),
          scene,
        );
        light.intensity = 0.9;

        const width = 64;
        const height = 4;
        const data = new Uint8Array(width * height * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 220;
          data[i + 1] = 140;
          data[i + 2] = 40;
          data[i + 3] = 255;
        }

        const texture = new babylon.RawTexture(
          data,
          width,
          height,
          babylon.Engine.TEXTUREFORMAT_RGBA,
          scene,
          false,
          false,
          babylon.Texture.NEAREST_SAMPLINGMODE,
          babylon.Engine.TEXTURETYPE_UNSIGNED_INT,
        );

        const material = new babylon.StandardMaterial("mat", scene);
        material.diffuseTexture = texture;
        material.emissiveColor = new babylon.Color3(1, 1, 1);
        material.specularColor = babylon.Color3.Black();

        const quad = babylon.MeshBuilder.CreatePlane("quad", { size: 1.5 }, scene);
        quad.material = material;

        engine.runRenderLoop(() => {
          scene.render();
        });

        await sleep(250);
        expect(scene.meshes.length).toBeGreaterThan(0);
        log(`Babylon rendered ${scene.meshes.length} meshes`);
        engine.stopRenderLoop();
        engine.dispose();
      } finally {
        win.close();
      }
    },
  }),
];
