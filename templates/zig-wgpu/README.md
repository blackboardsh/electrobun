# Zig WGPU Mandelbrot

An Electrobun template with a Zig main process and an `<electrobun-wgpu>` overlay surface. The webview owns layout and controls; Zig creates a native WGPU render pipeline and draws an animated Mandelbrot/Julia shader directly into the surface.

```sh
bun install
bun dev
```

The main process lives in `src/zig/main.zig`; the webview lives in `src/mainview`.
