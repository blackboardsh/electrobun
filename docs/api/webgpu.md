---
title: "WebGPU"
---

Electrobun can bundle a native WebGPU implementation (Dawn) and expose it to your Bun process. This lets you render with GPU-backed windows, run compute workloads, and integrate WebGPU-first libraries without a browser webview.

## Enable Bundling
Enable WebGPU per platform in `electrobun.config.ts`:

```ts
// electrobun.config.ts
export const config: ElectrobunConfig = {
  build: {
    macos: { bundleWGPU: true },
    win: { bundleWGPU: true },
    linux: { bundleWGPU: true },
  },
};

```

When enabled, Electrobun bundles the Dawn dynamic library alongside your app so it is available at runtime.

## Create A GPU Window
WebGPU rendering runs inside a `GpuWindow` (which owns a native WGPU-backed view). You can then create a WebGPU context from that window:

```ts
const win = new GpuWindow({
  title: "WebGPU",
  frame: { width: 800, height: 600, x: 200, y: 120 },
});

// Create a WebGPU context bound to this window.
const ctx = webgpu.createContext(win);

const adapter = await webgpu.navigator.requestAdapter({
  compatibleSurface: ctx,
});
const device = await adapter.requestDevice();

ctx.configure({
  device,
  format: webgpu.navigator.getPreferredCanvasFormat(),
  alphaMode: "premultiplied",
});

```

## GpuWindow Controls
`GpuWindow` follows the same newer visibility and activation model as `BrowserWindow`.

- `activate?: boolean` controls whether the window takes focus when it is first shown. Default: `true`.

- `show()` shows and activates the window.

- `showInactive()` shows the window without activating it.

- `activate()` focuses an already-visible window.

- `focus()` still works, but is deprecated in favor of `activate()`.

```ts
const win = new GpuWindow({
  title: "WebGPU HUD",
  frame: { width: 900, height: 600, x: 200, y: 120 },
  activate: false,
});

// Later:
win.showInactive();
win.activate();

```

On macOS, `GpuWindow` also supports `trafficLightOffset` and `setWindowButtonPosition(x, y)` for windows using `titleBarStyle: "hiddenInset"`. These are ignored on Windows and Linux.

```ts
const win = new GpuWindow({
  title: "Inset GPU Window",
  titleBarStyle: "hiddenInset",
  trafficLightOffset: { x: 12, y: 10 },
});

win.setWindowButtonPosition(16, 12);

```

## &lt;electrobun-wgpu&gt; (GPU Views Inside Web UIs)
You can embed native GPU surfaces inside a webview layout using the `<electrobun-wgpu>` custom element. This is documented separately on the WGPU Tag page.[Read the &lt;electrobun-wgpu&gt; Tag docs →](/api/browser-wgpu-tag)

## Raw FFI Access
If you want direct access to Dawn's C API, use the raw FFI bindings:

```ts
if (!WGPU.native.available) {
  throw new Error("WGPU not bundled or failed to load");
}

const instance = WGPU.native.symbols.wgpuCreateInstance(0);
// ...use Dawn C API via WGPU.native.symbols

```

The raw FFI layer mirrors the Dawn C API and is useful for low-level control, custom bindings, or compute workloads.

## Compute + Readback
Electrobun's WebGPU adapter also supports compute workloads from Bun. You can create compute pipelines, dispatch workgroups, and read results back into Bun-managed memory. This is how the `wgpu-mlp` template performs GPU inference while keeping a WebView UI.

### Readback Example
For readback, write GPU output into a buffer with `MAP_READ`, then `mapAsync` and copy the data into a Bun-managed ArrayBuffer.

```ts
// After a compute pass writes into readbackBuffer
await readbackBuffer.mapAsync(GPUMapMode.READ);
const mapped = readbackBuffer.getMappedRange();
const out = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();

```

## Bundling + Runtime Resolution
When `bundleWGPU` is enabled, Electrobun packages the Dawn dynamic library with your app. At runtime, the loader searches:

- The explicit path in `ELECTROBUN_WGPU_PATH` (if set).

- The current working directory.

- The executable’s `Resources` / `MacOS` folders on macOS.
If `WGPU.native.available` is `false`, confirm the library is bundled for that platform and check that the loader path is valid.

## Examples + Templates
Reference implementations you can copy from:

- `wgpu`: raw FFI rendering in a GPU window.

- `wgpu-threejs`: Three.js running on WebGPU.

- `wgpu-babylon`: Babylon.js WebGPU integration.

- `wgpu-mlp`: compute + readback for MLP inference.

- `electrobun-doom`: real game rendering via WGPU + `GpuWindow`.

## Three.js Integration
Electrobun re-exports `three` for convenience. Use the WebGPU renderer with a simple canvas shim that proxies to the GPU window:

```ts
const win = new GpuWindow({ title: "three.js + WebGPU" });
webgpu.install();

const size = win.getSize();
const canvas = {
  width: size.width,
  height: size.height,
  clientWidth: size.width,
  clientHeight: size.height,
  style: {},
  getContext: (type) => {
    if (type !== "webgpu") return null;
    return webgpu.createContext(win).context;
  },
  getBoundingClientRect: () => ({
    left: 0,
    top: 0,
    width: win.getSize().width,
    height: win.getSize().height,
  }),
  addEventListener: () => {},
  removeEventListener: () => {},
  setAttribute: () => {},
};

const renderer = new (three as any).WebGPURenderer({ canvas });
await renderer.init();

const scene = new three.Scene();
const camera = new three.PerspectiveCamera(60, size.width / size.height, 0.1, 100);
camera.position.z = 2;

const mesh = new three.Mesh(
  new three.BoxGeometry(0.6, 0.6, 0.6),
  new three.MeshStandardMaterial({ color: 0x202020 })
);
scene.add(mesh);

renderer.setAnimationLoop(() => {
  mesh.rotation.y += 0.01;
  renderer.render(scene, camera);
});

```

## Babylon.js Integration
Electrobun also re-exports `@babylonjs/core`. Use `WebGPUEngine` with the same canvas shim approach:

```ts
const win = new GpuWindow({ title: "Babylon + WebGPU" });
webgpu.install();

const size = win.getSize();
const canvas = {
  width: size.width,
  height: size.height,
  clientWidth: size.width,
  clientHeight: size.height,
  style: {},
  getContext: (type) => {
    if (type !== "webgpu") return null;
    return webgpu.createContext(win).context;
  },
  getBoundingClientRect: () => ({
    left: 0,
    top: 0,
    width: win.getSize().width,
    height: win.getSize().height,
  }),
  addEventListener: () => {},
  removeEventListener: () => {},
  setAttribute: () => {},
};

const engine = new babylon.WebGPUEngine(canvas, { antialias: false });
await engine.initAsync();

const scene = new babylon.Scene(engine);
scene.clearColor = new babylon.Color4(0.12, 0.12, 0.14, 1);

const camera = new babylon.ArcRotateCamera(
  "camera",
  Math.PI / 4,
  Math.PI / 3,
  2.5,
  new babylon.Vector3(0, 0, 0),
  scene
);
camera.attachControl(canvas, true);

new babylon.HemisphericLight("light", new babylon.Vector3(0.4, 1, 0.6), scene);

const box = babylon.MeshBuilder.CreateBox("box", { size: 0.7 }, scene);
const mat = new babylon.StandardMaterial("mat", scene);
mat.diffuseColor = new babylon.Color3(0.12, 0.12, 0.12);
mat.specularColor = new babylon.Color3(0.4, 0.4, 0.5);
box.material = mat;

engine.runRenderLoop(() => scene.render());

```
