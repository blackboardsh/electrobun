# Kitchen Matrix

From `package/`, prepare the local JSC -> Cottontail -> Hutch -> Electrobun
stack, build the reduced interactive matrix in parallel, and launch every app:

```sh
hutch dev:matrix --local
```

The reduced matrix has seven variants: every main-process backend with the
platform system renderer, plus Cottontail with CEF. The renderer implementation
lives below the SDK bridges, so this covers the useful interactive boundaries
without requiring the full Cartesian product on every pass.

Use the full 6 x 2 matrix after changes to renderer selection, build metadata,
or an SDK's renderer handling:

```sh
hutch dev:matrix --local --full
```

Build and launch can be split when repeating an interactive pass:

```sh
hutch dev:matrix --local --build-only
hutch dev:matrix --local --launch-only
```

Select exact main-process and webview combinations:

```sh
hutch dev:matrix --local --with=go:system,rust:cef,go:cef
```

Each `--with` entry is `<main-process>:<webview>`. Main processes are
`cottontail,bun,zig,rust,go,odin`; webviews are `system,cef`.

`--jobs=N` controls concurrent builds. From `kitchen/`, the equivalent commands
are `hutch matrix` and `hutch matrix:full` when the local stack is already ready.
