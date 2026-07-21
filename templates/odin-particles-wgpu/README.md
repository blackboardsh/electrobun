# Odin WGPU Particles

An Electrobun template with an Odin main process and an `<electrobun-wgpu>` overlay surface. The webview owns layout and controls; Odin runs a data-oriented particle simulation (~10k-50k particles) on the CPU and renders it as additive-blended instanced quads through a native WGPU pipeline. Three emitter modes: fountain, fireworks, and vortex.

```sh
bun install
bun dev
```

The main process lives in `src/odin/main.odin`; the webview lives in `src/mainview`.

## What's Odin-idiomatic here

- **`#soa` arrays**: particle state is declared as a plain `Particle` struct but stored as `#soa[MAX_PARTICLES]Particle` — the language itself lays out one contiguous array per field (all positions together, all velocities together, ...). This is the structure-of-arrays layout game and VFX tooling reaches for, without the bookkeeping of maintaining parallel arrays by hand.
- **Data-oriented update loop**: the simulation runs as separate passes over `#soa` slices — a force pass, a drag/integration pass, an aging pass, and a swap-remove compaction pass — each streaming linearly through only the field arrays it touches.
- **Deterministic, allocation-free hot path**: a fixed-capacity particle pool, a tiny xorshift PRNG, and fixed-timestep updates; nothing allocates per frame.
- The Dawn webgpu C ABI is used through plain Odin structs whose layouts are locked with `#assert(size_of(...))` / `offset_of` checks, and C callbacks are `proc "c"` procedures.

## Controls

The webview UI talks to the Odin process over Electrobun's host-message RPC: particle count, emitter mode, gravity and force sliders, and pause/reset all update the simulation live. The Odin side streams frame/particle stats back to the HUD.

## Platform notes / limitations

- The Odin toolchain is pinned to a pre-1.0 release vendored by Electrobun. Odin ships monthly dev releases that can include breaking language/core-library changes, so building against a different compiler version may not work.
- **Windows**: requires Visual Studio Build Tools (MSVC `link.exe`). x64 only — there are no windows-arm64 Odin prebuilts.
- **macOS**: requires Xcode Command Line Tools.
- **Linux**: requires `clang`.
- No cross-compilation: build on each target platform.
