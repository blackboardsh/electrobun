# Rust Flock WGPU

A native Rust main-process template for Electrobun. Rust owns the flocking simulation, samples the native cursor position, and renders directly into an `<electrobun-wgpu>` surface.

```bash
bun install
bun dev
```

Use `bun watch` to opt into rebuild-on-change mode.

The renderer uses no Rust crates. It links to Electrobun's Rust SDK and the bundled Dawn WebGPU library.
