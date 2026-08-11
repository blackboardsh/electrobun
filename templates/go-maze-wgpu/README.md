# Go Maze WGPU

A native Go main-process template for Electrobun. Go generates a maze with adjustable shortcut density, solves it with parallel goroutines running bidirectional search, and renders the live grid directly into an `<electrobun-wgpu>` surface.

```bash
hutch run dev
```

`hutch run dev` builds the app, launches it, and rebuilds when source files
change. This native template has no npm dependencies.

The Go app is a standard project-owned module. Its `go.mod` keeps the SDK import
local to `.hutch/devkit/go-sdk`; Hutch copies the exact SDK selected by
`electrobun.version` in `hutch.config.ts`, resolves the configured Go toolchain,
and runs `go build` from this project root. The resulting binary dynamically
loads the bundled Electrobun core and Dawn WebGPU libraries at runtime.
