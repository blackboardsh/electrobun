# Neon Fluid Lab

An Electrobun template with an Odin main process driving a real-time stable-fluid simulation and rendering it through a native `<electrobun-wgpu>` surface. Drag across the field to inject dye and momentum, spin vortices, add buoyant heat, or erase the flow.

```sh
hutch run dev
```

`hutch run dev` installs dependencies on the first run, builds the app, launches it, and rebuilds when source files change.

The Odin main process lives in `src/odin/main.odin`; the webview UI lives in `src/mainview`.

## What Odin does

- **Stable-fluid solver**: Odin advances velocity and RGB dye on a fixed-capacity grid using semi-Lagrangian advection, iterative diffusion, pressure projection, vorticity confinement, buoyancy, and exponential dissipation.
- **Allocation-free frame loop**: simulation fields and scratch buffers are allocated once. Solver passes swap fixed slices and reuse memory every frame.
- **Native rendering**: visible cells are packed into one instanced vertex stream. A compact WGSL shader turns each cell into a soft luminous tile on Electrobun's Dawn-backed WGPU surface.
- **Thread-safe input handoff**: the webview sends normalized pointer samples and controls over host-message RPC. Odin drains a bounded input queue under a mutex before each simulation step.
- **Deterministic startup**: an initial curl and a quiet emitter seed the field without network requests or external assets.

## Tools

- **Ink** adds colored dye and follows the direction of your drag.
- **Vortex** injects tangential velocity for tight spirals.
- **Heat** adds warm dye and upward buoyancy.
- **Erase** removes dye and calms velocity inside the brush.

Palette, hue, brush radius, force, swirl, viscosity, and fade controls update the Odin simulation live. The HUD reports measured FPS, solver grid dimensions, and active dye cells.

## Platform notes

- The conservative CPU solver avoids compute-shader feature dependencies and uses the same Dawn C ABI path on macOS, Windows, and Linux.
- **Windows** requires Visual Studio Build Tools (MSVC `link.exe`). x64 only, because Odin does not publish Windows ARM64 prebuilts.
- **macOS** requires Xcode Command Line Tools.
- **Linux** requires `clang`.
- Odin builds natively on each target; this template does not cross-compile.
