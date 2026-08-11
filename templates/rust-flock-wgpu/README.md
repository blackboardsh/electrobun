# Rust Flock WGPU

A native Rust main-process template for Electrobun. Rust owns the threaded flocking simulation, samples the native cursor position, and renders directly into an `<electrobun-wgpu>` surface.

```bash
hutch run dev
```

`hutch run dev` builds the app, launches it, and rebuilds when source files
change. This native template has no npm dependencies.

The renderer uses no Rust crates. It links to Electrobun's Rust SDK and the bundled Dawn WebGPU library.
