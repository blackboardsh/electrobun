# Zig WGPU Mandelbrot

An Electrobun template with a Zig main process and an `<electrobun-wgpu>` overlay surface. The webview owns layout and controls; Zig creates a native WGPU render pipeline and draws an animated Mandelbrot/Julia shader directly into the surface.

```sh
hutch run dev
```

`hutch run dev` builds the app, launches it, and rebuilds when source files
change. This native template has no npm dependencies.

The main process lives in `src/zig/main.zig`; the webview lives in `src/mainview`.
