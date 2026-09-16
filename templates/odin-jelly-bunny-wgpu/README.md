# Jelly Bunny Lab

An Electrobun template with an Odin main process and a native
`<electrobun-wgpu>` surface. A luminous articulated bunny falls, rebounds,
squashes, and can be grabbed and thrown. The webview owns the compact control
panel and pointer forwarding; Odin owns simulation, hit testing, and rendering.

```sh
hutch run dev
```

`hutch run dev` builds the app, launches it, and rebuilds when source files
change. This native template has no npm dependencies. A production bundle uses:

```sh
hutch run build
```

The main process is `src/odin/main.odin`; the webview is in
`src/mainview`.

## Odin techniques

- **Deterministic Verlet integration** stores current and previous positions for
  a fixed 20-node rig. Velocity is implicit, so throwing only requires carrying
  pointer motion into a node's position history.
- **Position-based dynamics** solves a fixed-capacity constraint graph twice per
  display frame. Body and head cages use spokes, perimeter links, and cross
  braces; triangular ear chains bend without collapsing.
- **Allocation-free simulation** initializes all nodes and constraints once.
  The physics and render-packing hot paths use fixed arrays.
- **Material controls** map gravity, squish, and stiffness into acceleration,
  restitution, damping, constraint compliance, and solver iterations.
- **Native hit testing and collisions** keep pointer selection, viewport
  boundaries, rebound, and friction in Odin rather than duplicating behavior in
  JavaScript.
- **Analytic WGPU rendering** packs the deformed rig into a small instanced
  stream. A conservative WGSL shader draws layered soft ellipses for the body,
  head, segmented ears, feet, arms, tail, muzzle, eyes, highlights, and glow.
- **C ABI discipline** uses explicit Dawn layouts guarded by compile-time size
  and offset assertions. Native callbacks use Odin's `proc "c"` convention.

## Interaction

The WGPU tag is configured for passthrough. Pointer events land in the webview,
are normalized to the surface, and are serialized through Electrobun host
messages. Odin maps them into simulation space, chooses the closest rig node,
and retains the final drag velocity when released.

Pause freezes integration while leaving rendering and configuration active.
Reset restores the exact initial rig, making the simulation reproducible.

## Platform notes

- WGPU is bundled and CEF is disabled on macOS, Linux, and Windows.
- The template uses no external assets and makes no network requests at runtime.
- Windows requires Visual Studio Build Tools (MSVC `link.exe`), x64 only.
- macOS requires Xcode Command Line Tools.
- Linux requires `clang`.
- Odin is built on the target host; this template does not cross-compile.
