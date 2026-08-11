# Go Maze WGPU

A native Go main-process template for Electrobun. Go generates a maze with adjustable shortcut density, solves it with parallel goroutines running bidirectional search, and renders the live grid directly into an `<electrobun-wgpu>` surface.

```bash
hutch run dev
```

`hutch run dev` builds the app, launches it, and rebuilds when source files
change. This native template has no npm dependencies.

The renderer uses no Go modules. It builds with Electrobun's vendored Go toolchain and links to Electrobun's Go SDK plus the bundled Dawn WebGPU library.
