# Odin Alchemy Sandbox

An interactive Electrobun falling-sand sandbox with an Odin main process and a
native `<electrobun-wgpu>` surface.

```sh
hutch run dev
```

`hutch run dev` installs dependencies on the first run, builds the app,
launches it, and rebuilds when source files change. The production contract is:

```sh
hutch run build
```

That invokes `hutch electrobun build --env=production`. WGPU is bundled and
CEF is disabled on macOS, Linux, and Windows.

## The simulation

Paint sand, water, fire, seeds, oil, stone, or empty space into a deterministic
320 x 180 cellular world. Sand falls and piles, water seeks low open space,
oil floats over water and burns, fire rises and expires, seeds settle and grow
when they find water, and stone forms permanent terrain. Water extinguishes
fire while fire propagates through oil and plants.

The webview owns the compact controls and normalized pointer input. Odin owns
the grid, interaction rules, fixed-step clock, WGPU pipeline, and statistics.
Brush traffic uses one-way host messages so pointer movement does not create a
chain of request promises.

## Odin techniques

- **Fixed-capacity state:** the complete material grid, update stamps, and
  bounded brush queue are fixed arrays. The simulation hot path performs no
  allocation.
- **Deterministic cellular ordering:** a xorshift32 generator controls lateral
  choices and color variation. Horizontal scan direction alternates while
  per-cell tick stamps prevent a moved cell from updating twice.
- **Density-aware movement:** sand displaces liquids, water displaces oil, and
  oil therefore collects above water without a separate buoyancy pass.
- **Low-contention host input:** RPC callbacks append compact strokes under a
  mutex. The simulation thread drains the bounded queue once per frame and
  rasterizes continuous brush segments into grid circles.
- **Direct Dawn ABI:** Odin loads the small set of WGPU C symbols it needs,
  verifies descriptor layouts at compile time, and streams occupied cells as
  instanced quads.

## Controls

Choose a material from the palette, change brush size, and paint on the native
surface. Right-click erases. Pause freezes material updates without disabling
painting; Step advances one deterministic tick. Applying a numeric seed resets
the same starter scene and random sequence.

## Platform notes

- The Odin compiler is vendored by Hutch/Electrobun. Odin is pre-1.0 and
  external compiler releases can contain breaking changes.
- Windows requires Visual Studio Build Tools and supports x64.
- macOS requires Xcode Command Line Tools.
- Linux requires `clang`.
- Native main-process builds run on their target platform; this template does
  not cross-compile.
