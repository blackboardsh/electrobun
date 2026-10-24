# Zig UI todos

An Electrobun template with a Zig main process and a GPU-rendered UI: no
webview and no JavaScript. The app's state is a plain Zig struct, its markup
is an HTML template with `{bindings}`, and its styling is CSS. The Electrobun
UI engine is compiled into the executable and draws straight into a WGPU view
through Dawn.

```sh
hutch run dev
```

`hutch run dev` builds the app, launches it, and rebuilds when source files
change. The template has no npm dependencies. macOS only for now.

## Layout

- `src/zig/main.zig`: the `App` struct (signals, a list of todos, handler
  methods, `template` and `style`) and the bootstrap. Bootstrap creates a
  window and a full-window WGPU view, then calls
  `electrobun_ui.electrobun.mountApp(App, &state, ...)`.
- `build.zig` builds the `main` executable. It adds the Zig SDK
  (`electrobun`) and the UI engine (`electrobun_ui`, shipped as source next to
  the SDK), and links the macOS frameworks the engine uses.
- `electrobun.config.ts`: `mainProcess: "zig"` and `bundleWGPU: true` (Dawn).

How fields and methods map to the template (signals, lists, handlers,
computed values) is documented in the docs under *Electrobun UI → Zig*.
