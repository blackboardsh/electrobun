# Kitchen Matrix

From `package/`, prepare the local JSC -> Cottontail -> Hutch -> Electrobun
stack, build the reduced interactive matrix in parallel, and launch every app:

```sh
hutch dev:matrix --local
```

The reduced matrix has seven variants: every main-process backend with the
platform system renderer, plus Cottontail with CEF. It is a quick interactive
pass, not full renderer coverage: CEF delivers bridge callbacks on different
threads and message-pump states than the system webview, and each SDK handles
them differently (for example, the Zig and Rust Kitchens create webview tags
synchronously inside a CEF process-message callback). `hutch test:vm` therefore
runs every backend's automated suite against CEF as well.

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

`--jobs=N` controls concurrent builds. `--timeout=SECONDS` fails and kills any
launched variant still running after that long; use it with `AUTO_RUN=1` so a
deadlocked app fails the run instead of hanging it. From `kitchen/`, the equivalent commands
are `hutch matrix` and `hutch matrix:full` when the local stack is already ready.

## Windows WebView2 initialization regression

The automated test **WebView2 applies pre-controller bounds and reveal** uses a
real nested native webview and a one-shot controller-creation hold. It verifies
actual controller bounds and visibility after queued bounds, mask and reveal
updates, and rejects a later resize that could hide an initialization failure.
It runs in Windows Kitchen's automated suite (or select that exact test with
`AUTO_RUN_TEST_NAME`); other platforms report it as skipped. The internal native
diagnostics are enabled in a local `dev` build. For a packaged release-channel
test, set `ELECTROBUN_KITCHEN_WEBVIEW2_TEST=1` **before launching** the Kitchen
executable, alongside `AUTO_RUN_TEST_NAME="WebView2 applies pre-controller bounds and reveal"`.
The bundled native wrapper must include these diagnostics; missing/disabled
hooks fail the test, not silently pass it. This verifies native initialization
state, not screenshot pixels or the separately reported whole-window cutout.
Use an already-built Kitchen executable for this filtered run; it does not
prepare or rebuild JSC, Cottontail, or the rest of the local stack.
