---
title: "&lt;electrobun-wgpu&gt;"
---

# &lt;electrobun-wgpu&gt;

`<electrobun-wgpu>` embeds a native WGPU-backed surface inside a webview layout. It behaves like a DOM element but renders via a real GPU surface layered above the host view, with optional masking and passthrough for punch‑through UI.

## When To Use It

- Compositing high-performance GPU content with a web UI (editors, game tools, IDEs).

- Running Bun-side WGPU rendering while keeping HTML/CSS for layout.

- Mixing native GPU surfaces with webview content without a single WebGL canvas.
If your rendering is simple and you don’t need Bun‑side control or native surface layering, a standard `<canvas>` inside the webview is still the simplest option.

## Platform Notes

On Linux, `passthrough` and mask punch-through behavior for `<electrobun-wgpu>` is not supported inside transparent `BrowserWindow`s. Transparent CEF windows use offscreen rendering painted into the parent X11 window, while `<electrobun-wgpu>` is a separate native child window. The WGPU surface can render and resize correctly, but X11 cannot reliably hit-test through that child surface into the offscreen-rendered host DOM.For punch-through UI on Linux, use a non-transparent window, keep the interactive HTML outside the WGPU surface, or render the GPU content into a normal in-webview canvas when that composition model is required.

## Basic Usage

```ts
// In your webview HTML
<electrobun-wgpu id="gpu"></electrobun-wgpu>

// In Bun (RPC handler), create a WGPU surface for the view ID
// and render via WGPU.native or webgpu.createContext(...)

```

## API

```ts
const wgpu = document.querySelector("electrobun-wgpu");

// Properties
console.log(wgpu.wgpuViewId);
console.log(wgpu.transparent, wgpu.passthroughEnabled, wgpu.hidden);

// Methods
wgpu.toggleTransparent(true);
wgpu.togglePassthrough(true);
wgpu.toggleHidden(false);
wgpu.syncDimensions(true);

// Masks
wgpu.addMaskSelector("#hud");
wgpu.removeMaskSelector("#hud");

// Events
wgpu.on("ready", (evt) => {
  console.log("WGPU view ready", evt.detail);
});

```

The `wgpuViewId` is the native view identifier. Pass it to your Bun process to create a surface for that view.

## Lifecycle + Resize

WebGPU surfaces must be reconfigured on size changes. When your WGPU view or window resizes, update the surface config and re-create any size-dependent resources.

```ts
// Bun-side render loop example
const ctx = webgpu.createContext(win);
let size = win.getSize();

function resizeIfNeeded() {
  const next = win.getSize();
  if (next.width !== size.width || next.height !== size.height) {
    size = next;
    ctx.configure({
      device,
      format: webgpu.navigator.getPreferredCanvasFormat(),
      alphaMode: "premultiplied",
      size: [size.width, size.height],
    });
  }
}

```

Call `syncDimensions()` after any DOM layout changes so the native view tracks the element bounds.
