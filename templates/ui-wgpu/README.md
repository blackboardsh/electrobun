# ui-wgpu — Cottontail UI

A reactive, Solid-inspired UI runtime rendered by Dawn (WebGPU) directly from
the Cottontail main process, consumed from `electrobun/main/ui`. No webview
for the chrome, no browser DOM, no CEF — and no compile step: plain
TypeScript through Electrobun's bundler.

```
signals / stores (createSignal, createStore + produce)
        ↓  fine-grained per-prop effects
retained UI tree (u32 ids, POD props — ABI-shaped)
        ↓
flex-lite layout + hit testing
        ↓
flat rect/glyph instance buffer
        ↓
one instanced draw call → Dawn surface in a GpuWindow
```

## Run it

```
bun install
bun start
```

Production packaging: `hutch electrobun build --env=production`.

## What it demonstrates

- **Fine-grained reactivity without a compiler.** Any prop can be a thunk:
  `bg: () => hover() ? "#232336" : "#1b1b28"` becomes one effect updating one
  tree prop. `createStore` + `produce()` give Solid-style immutable-feeling
  batch updates with path-level invalidation.
- **Builder API that reads like markup.** `ui.column({...}, () => { ... })`;
  components are plain functions (see `Button` in `src/main.ts`).
- **Native layers as elements.** The right side of the demo embeds
  `wgpuSurface` (a real Dawn view whose clear color follows the accent
  signal) and `webview` (an out-of-process webview) — the UIWindow
  equivalents of `<electrobun-wgpu>` and `<electrobun-webview>`, positioned
  by the UI layout with nativeWrapper as the compositor.
- **Invalidation-only rendering.** The frame tick polls input; layout, paint,
  and the draw call only happen when something marked the tree dirty.

The runtime itself lives in the Electrobun SDK
(`package/src/sdks/main/ui/`), with headless unit tests beside it and
kitchen-sink coverage (automated + interactive, including the
`<electrobun-ui>` overlay tag) in `kitchen/src/tests/`.

## Prototype limitations

- Input is polled (cursor point + global button bitmask, edge-detected);
  keyboard arrives via native window key events. Production work is native
  pointer/move/button/wheel events on WGPUView.
- Typography is a built-in 5x7 bitmap font: no shaping, wrapping, selection,
  bidi, system fonts, or accessibility yet.
- Layout is a flex subset: row/column, gap, padding, fixed/auto sizes, grow,
  justify, align. No wrapping, no absolute positioning, no min/max.
- Keyboard mapping in the demo uses macOS virtual key codes.
