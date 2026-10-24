# ui-wgpu — Electrobun UI showcase

HTML/CSS + JSX rendered by Electrobun's UI engine (`electrobun/main/ui`)
straight to the GPU through Dawn, from the Cottontail main process. No
webview for the app chrome and no build tooling beyond the TypeScript
transpiler Hutch already ships.

The right-hand column mixes in two **native layers**, positioned by the UI
layout with `ui.anchor(element, view)`:

- a `WGPUView` running a WebGPU Mandelbrot zoom (its palette follows the
  counter signal), and
- a `BrowserView` (an out-of-process webview).

## Run it

```
hutch run install
hutch run start
```

Production packaging: `hutch run build`.

## What it demonstrates

- **Familiar authoring.** Components are plain functions returning JSX; the
  look is a CSS string with variables, nesting, `:hover`/`:active`,
  transitions and keyframes (see `css` in `src/main.tsx`).
- **Fine-grained reactivity.** `signal`, `memo` and `store` from
  `electrobun/main/ui`; `live(() => ...)` marks each reactive expression, so
  a click updates one text node and one style — nothing re-renders.
- **Control flow.** `<For>` (keyed) renders the event log, `<Show>` its empty
  state.
- **Native layers in the layout.** `ref={attach}` hands each slot element to
  `ui.anchor`, which keeps the native view over it through layout changes,
  window resizes and scrolling, and hides it with the element.
- **Window-level keys.** Key events bubble to `<body>`:
  `app.ui.body.addEventListener("keydown", ...)`.

Rendering is invalidation-driven: style, layout, paint and the draw only run
when something changed.

## Layout

```
src/main.tsx            window, CSS, components, WebGPU scene
electrobun.config.ts    Cottontail entrypoint, bundleWGPU (ships Dawn + the UI engine)
tsconfig.json           jsxImportSource: electrobun/main/ui (editor/typecheck only)
```

The UI engine is macOS-only for now.
