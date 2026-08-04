# Odin WGPU Tree Studio

An Electrobun template with an Odin main process generating an animated procedural tree on a native `<electrobun-wgpu>` surface. The webview owns the compact studio controls; Odin owns the tree model, growth animation, wind field, projection, instance packing, and Dawn rendering resources.

```sh
hutch run dev
```

`hutch run dev` installs dependencies on the first run, builds the app, launches it, and rebuilds when source files change.

The native model and renderer live in `src/odin/main.odin`; the webview overlay lives in `src/mainview`.

## Procedural techniques

- **Recursive parametric branching**: every branch tapers into a continuation and stochastic lateral children. Species profiles vary recursion depth, length and radius decay, branch angle, upward tropism, crown spread, bark, and foliage color.
- **Phyllotactic placement**: lateral branches advance around their parent with a golden-angle phase. Seeded xorshift randomness perturbs attachment points and angles without losing reproducibility.
- **Progressive botanical growth**: branch generations carry birth intervals. The renderer extends each segment from its parent before fading in terminal leaf clusters, so regeneration visibly grows from roots to canopy.
- **Connected wind deformation**: a height-weighted continuous wind field deforms both endpoints of every branch and all leaves. Shared world-space sampling keeps adjacent segments visually connected while the crown sways more than the trunk.
- **Layered 3D model**: generation happens in three-dimensional world coordinates. A slowly changing camera projection, depth-based lighting, tapered silhouettes, overlapping foliage, and a ground shadow make depth legible without requiring a depth texture.
- **Instanced WGPU rendering**: one conservative render pipeline expands branch records into tapered ribbons and leaf records into rotated ellipse billboards in WGSL. The CPU uploads a flat instance stream each frame; there are no per-branch draw calls.

## Controls

Choose field oak, silver birch, or alpine pine profiles; enter a deterministic seed; and adjust branching, leaf density, growth speed, and wind. **Regenerate** rebuilds the model from the current controls. The restart button replays growth without changing the generated tree.

## Platform notes

- Uses the Dawn WebGPU C ABI already bundled by Electrobun and deliberately avoids backend-sensitive extensions, compute shaders, storage buffers, depth textures, and external assets.
- The Odin toolchain is pinned and vendored by Electrobun. Odin pre-1.0 compiler releases can contain breaking language or core-library changes.
- Windows requires Visual Studio Build Tools and is x64-only for the currently vendored Odin release. macOS requires Xcode Command Line Tools; Linux requires `clang`.
- Builds are native per target rather than cross-compiled.
