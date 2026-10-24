# Electrobun UI core

A GPU-direct UI engine for Electrobun apps, written in Zig. HTML + CSS (a stable,
practical subset) + fine-grained reactivity, rendered with WebGPU (Dawn) — no
webview, no browser engine. One C ABI serves every Electrobun backend
(TypeScript via FFI, Zig, Rust, Go, Odin, C).

## What's in here

| Area | Module | Notes |
|---|---|---|
| DOM | `dom.zig`, `html.zig` | retained tree, u32 ids, dirty bits, forgiving HTML5-ish parser |
| CSS | `css/*.zig`, `style.zig`, `ua.css` | selectors L4 subset (`:is/:where/:not/:has`, nth), nesting, `@layer`, `@media` (incl. range syntax), `@supports`, `@property`, `@keyframes`, `var()`, `calc/min/max/clamp`, oklch/lab/hsl colors — enough for Tailwind v4 output |
| Layout | `layout.zig`, `inline.zig`, `grid.zig` | block (margin collapsing), inline formatting (wrapping, baselines, ellipsis, line-clamp), flexbox (full §9 algorithm), grid (tracks, fr, minmax, repeat/auto-fill, placement), absolute/fixed, replaced elements, per-node layout caching |
| Text | `text/*.zig` | platform shaping + rasterization (CoreText today; zero binary cost), font fallback, color emoji |
| Paint | `paint.zig` | stacking contexts/z-index, clips, transforms, opacity/filter layers, shadows, gradients (linear/radial/conic), borders (per-side, dashed/dotted), decorations, hit regions |
| Render | `render/gpu.zig` + `ui.wgsl`, `render/cpu.zig` | instanced SDF quads on Dawn; CPU twin with identical math for tests / headless / fallback; backdrop-filter, blur |
| Input | `events.zig` | hit testing, hover/active/focus(-visible/-within), bubbling, wheel scroll, Tab order, form-control behaviors, select popups, text editing with undo, IME composition |
| Motion | `anim.zig` | CSS transitions (interruptible, reversal shortening), `@keyframes`, velocity-preserving springs |
| Reactivity | `reactive.zig`, `template.zig`, `app.zig` | signals/computeds/effects in the core; HTML templates with `{expr}`, `if/else`, keyed `each`, `bind:value`, components + slots; comptime-bound Zig apps |
| A11y | `a11y.zig` | semantic tree → NSAccessibility (macOS host) |
| Media | `images.zig`, `svg.zig` | ImageIO decode, inline SVG via CoreGraphics |
| ABI | `capi.zig`, `host/electrobun.zig` | `ebui_*` functions, batched command buffer, event queue; host for Electrobun WGPU views |
| Components | `components/electrobun.css` | `eb-*` design system (buttons, inputs, switch, tabs, cards, dialogs, menus, toasts, tables …) — plain CSS, also works in browsers |

## Using it

* **TypeScript (Electrobun main process):** `import { createUIWindow } from "electrobun/main/ui"`
  with `jsxImportSource: "electrobun/main/ui"`. The warren DOM renderer runs on a
  DOM-compatible shim, so the same JSX renders in a webview. See `templates/bun-ui`.
* **Zig:** `const ui = @import("electrobun_ui");` — see `examples/todo.zig` (struct with
  `ui.Signal`/`ui.List` fields + an HTML template + CSS).
* **Any language:** the C ABI in `src/capi.zig` (templates + named signals/handlers need no
  callbacks across the boundary).

## Developing

```
zig build test                      # unit tests (style, layout, events, templates, a11y, ABI…)
zig build -Doptimize=ReleaseFast    # tools: shot (CPU → PNG), gpushot (Dawn → PNG + CPU diff), devhost, todo
zig-out/bin/devhost page.html --dawn path/to/libwebgpu_dawn.dylib   # live-reloading window
```
