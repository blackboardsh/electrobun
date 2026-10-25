# Electrobun UI: Windows and Linux host bring-up

Handoff for the Claude sessions running in the Windows and Linux VMs. Read
this first; it tells you what exists, what to build, how to verify it, and
how to stay out of the other VM's way.

## Where things stand

Branch `agent/gpu-ui-research`. The native UI engine lives in
`package/src/ui-core` (Zig). It is an HTML/CSS-subset engine with a WebGPU
(Dawn) renderer and a C ABI (`ebui_*`), loaded by apps as `libElectrobunUI`.

- **macOS is complete**: windows, input, IME, clipboard, cursor, drag
  regions, accessibility, and a kitchen suite that passes 14/14.
- **Already portable and green in CI on Windows and Linux** (x64 and arm64,
  `.github/workflows/ui-core.yml`): DOM, CSS, layout, painting, the CPU
  renderer, and the pure-Zig text, image and SVG stacks. On CI the system
  font test resolves sans-serif/serif/monospace to Segoe UI / Times New
  Roman / Cascadia Mono on Windows and DejaVu Sans / Serif / Sans Mono on
  Linux. Cross-platform dynamic loading is in `src/platform/dynlib.zig`.
- **Missing, and your job**: the native host on your OS. Nothing draws in a
  window on Windows or Linux yet.

## Linux status (done on `agent/gpu-ui-research`)

Linux host works in GTK windows (the default renderer); Windows is next.
Verified on an arm64 Ubuntu 25.04 VM (GNOME Wayland, XWayland, Dawn on
Vulkan/llvmpipe):

- `bun-ui`, `zig-ui`, `ui-launcher`, `ui-color-picker`, `ui-wgpu` render and
  take input: hover, click, wheel scroll, select popup, cursors, typing,
  editing keys, Ctrl+A/C/V, Tab focus, Enter submit, IME composition and
  commit (ibus XIM, Cangjie), resize, crisp at `GDK_SCALE=2`.
- Kitchen `Native UI`: 14/14. ui-core tests: 103 pass, 2 skipped.

What Windows can reuse or must know:

- **Key contract (landed, platform-neutral on Windows/Linux)**: `code` is 0
  and `charactersIgnoringModifiers` is the DOM `key` value ("Enter",
  "ArrowLeft", "a", "A"; Ctrl/Alt ignored, Shift applied). `characters` is
  the text the key types, empty for non-text keys. Return value as before.
  See `namedKey()` in `host/electrobun.zig`; macOS still sends virtual key
  codes (`macNamedKey`) until its wrapper moves to the same contract.
- `host/electrobun.zig` is compiled on every OS now and creates the surface
  per OS (`createSurface`): Windows uses `SurfaceSourceWindowsHWND` with
  `wgpuViewGetNativeHandle` = HWND (untested). Linux adds an optional export
  `wgpuViewGetNativeDisplay(view)` (the Xlib `Display*`).
- The alpha mode comes from the surface capabilities (premultiplied if
  offered, else opaque).
- Callbacks resolve their ctx through `liveView()`, so a callback that races
  `ebui_detach_view` is dropped. Still, make `wgpuViewSetUIHandlers` (and the
  a11y handler setter) **not wait on the main thread**: the app thread calls
  it holding the UI lock, which main-thread callbacks also take.
- `clipboardReadText` returns a malloc'd string; the host frees it on
  macOS/Linux but not on Windows (CRT mismatch risk). Add a wrapper-side free
  or confirm both sides share the CRT.
- Still Windows-only TODOs in step 1: `buildUI()` returns early on Windows;
  Zig puts `ElectrobunUI.dll` in `zig-out/bin` (not `lib`), see
  `copyToDist`; the devkit manifest lists no UI library for Windows yet.
- `zig-ui` now bundles Dawn on all platforms and takes the library name from
  the Zig SDK (`electrobun.wgpu_library_name`).

Linux implementation notes (in `src/native/linux/nativeWrapper.cpp`,
"Native UI core host"): input comes from the view's InputOnly X window via a
global GDK filter (GTK windows) or the CEF X11 loop; frames are paced by a
GLib timer at the monitor refresh rate; XIM on-the-spot preedit (the IM is
opened under a UTF-8 `LC_CTYPE` because the process locale may be "C");
window drag is modal until the 4 px threshold, then `_NET_WM_MOVERESIZE`;
X-child WGPU views now scale their frames by the GDK window scale.

Known Linux gaps, by user impact:

1. A `BrowserView` anchored with `ui.anchor` is hidden: WebKitGTK draws in
   the GTK toplevel, below the UI's X child window. Needs a hole (XShape
   mask) in the UI view for anchored GTK views.
2. `transparent: true` windows show black corners: the X child uses the
   default (opaque) visual.
3. Window drag sends `_NET_WM_MOVERESIZE` correctly but could not be
   confirmed with XTest on mutter/XWayland; check with a real mouse.
4. No AT-SPI accessibility yet (the engine tree and kitchen test work).
5. Wheel uses core buttons 4-7 (48 px/notch); no XInput2 smooth scrolling.
6. Fractional scale only via `Xft.dpi`/`GDK_DPI_SCALE` (UI zoom; not
   verified on this VM, which hung its XWayland during that test).
7. Candidate-window placement (XNSpotLocation) is set but unverified (the
   VM's ibus panel is disabled). CEF windows (separate X11 path) are
   untested.
8. Engine (likely all platforms): in `bun-ui`, a task appended while the
   list is scrolled draws below its card's border until the next relayout.
   A headless test of the same DOM does not reproduce it.

## How the host works (read the macOS one first)

The engine does not create windows. It renders into an existing Electrobun
**WGPU view** (`AbstractView*`) that `libNativeWrapper` already creates on
all three platforms. The glue is:

1. TS: `src/sdks/main/ui/index.ts` calls
   `ebui_attach_wgpu_view(ui_id, view_ptr, dawn_path)` (FFI table in
   `src/sdks/main/ui/ffi.ts`).
2. Zig: `src/ui-core/src/host/electrobun.zig` looks up exported functions in
   the already-loaded native wrapper (`libNativeWrapper.dll`,
   `libNativeWrapper.so` or `libNativeWrapper_cef.so`), creates a Dawn
   surface from the view's native handle, and registers callbacks.
3. The native wrapper delivers input, IME and frame callbacks **on the main
   thread**. The engine renders inside the frame callback.

The reference implementation is `src/native/macos/nativeWrapper.mm`. Search
for `Per-view hooks used by the native UI core`. The callback typedefs and
their semantics are documented there; mirror them exactly.

### Exports your native wrapper must provide

| Symbol | Required | What it does |
|---|---|---|
| `wgpuViewSetUIHandlers(view, ctx, pointer, key, text, frame)` | yes | Install the per-view callbacks; null callbacks uninstall. While set, they take precedence over the global WGPU handlers. |
| `wgpuViewRequestFrame(view)` | yes | Schedule one `frame(ctx, timestamp)` call on the main thread at the next vsync-ish tick. Coalesce repeated requests. Never call `frame` re-entrantly from inside this function. |
| `wgpuViewGetMetrics(view, &w, &h, &scale)` | yes | Size in logical px plus the device scale factor. |
| `wgpuViewGetNativeHandle(view)` | exists | Windows returns the HWND. Linux returns the X11 Window XID (the view is a child X window; GDK is forced to X11). |
| `wgpuViewSetImeRect(view, x, y, w, h)` | yes | Caret rect in view coordinates, for placing the IME candidate window. |
| `wgpuViewBeginWindowDrag(view)` | yes | Start an OS window move (for CSS drag regions). Returns true if the window moved. |
| `uiSetCursor(name)` | yes | CSS cursor name (`default`, `pointer`, `text`, `grab`, ...). |
| `wgpuViewSetAccessibilityHandlers`, `wgpuViewSetAccessibilityTree` | optional | Accessibility. The engine builds a serialized tree on request; see `a11y.zig` and the macOS `EBAXElement` code. |
| `clipboardReadText`, `clipboardWriteText` | exist | Already exported on both platforms. Check they work from the main thread. |

Callback encodings (from `host/electrobun.zig`):

- **pointer** `kind`: 0 move, 1 down, 2 up (`a` = button), 3 wheel
  (`a`, `b` = dx, dy; the engine negates them), 5 leave. Coordinates are
  logical px from the view's top-left.
- **modifiers** bitmask: 1 shift, 2 ctrl, 4 alt, 8 meta.
- **key** `(code, mods, isDown, isRepeat, characters, charactersIgnoringModifiers)`.
  Return 1 if the key was consumed. Printable keys return 0 and are then
  expected to arrive as text through the text callback. **`code` is
  currently a macOS virtual key code** (`namedKey()`: 36 Enter, 48 Tab,
  51 Backspace, 53 Escape, 117 Delete, 115 Home, 119 End, 116/121
  PageUp/PageDown, 123-126 arrows). See "Prerequisite" below.
- **text** `kind`: 0 insert committed text, 1 set marked (composition) text
  with selection at `selLoc`, 2 unmark (commit the current composition).

## Prerequisite: a platform-neutral key contract

Do not have each wrapper translate its native key codes into macOS virtual
key codes. That spreads one platform's encoding into three codebases and
invites a class of "wrong key on one OS" bugs. The contract should carry the
DOM `key` name for non-printable keys (`"Enter"`, `"ArrowLeft"`, ...), so
`namedKey()` disappears and each wrapper maps its own codes once.

This is one shared change (the contract, `host/electrobun.zig`, the macOS
wrapper and the kitchen suite on macOS). It lands on `agent/gpu-ui-research`
from the macOS session **before** you start key handling. `git log` for
"key contract" on that branch. If it is not there yet, do pointer, frames
and rendering first, and stub key handling.

## Shared setup (both VMs)

```sh
git clone https://github.com/blackboardsh/electrobun.git
cd electrobun && git checkout agent/gpu-ui-research
cd package && npm ci
hutch build:dev                 # builds native wrappers, core, devkit
```

- Zig is vendored at `package/vendors/zig/zig` (0.17) and Bun at
  `package/vendors/bun/bun`. Use the vendored zig, not a system one.
- Engine unit tests: `cd package/src/ui-core && ../../vendors/zig/zig build test`.
  They should already pass on your OS. Run them before and after your
  changes.
- Run an app: `hutch dev:template bun-ui` (TypeScript) or
  `hutch dev:template zig-ui` (Zig). Also `ui-launcher`, `ui-color-picker`,
  `ui-wgpu`.
- Kitchen suite for the engine: `AUTO_RUN_CATEGORY="Native UI" hutch dev`.
  The goal is 14/14 on your OS as well.

## Work plan

Do these in order. Each step ends with something you can see or test.

### 1. Ship the library (both)

These places hard-code macOS today:

- `package/build.ts` `buildUI()`: returns early unless macOS
  (`TODO(ui-core)`). Build with `-Dtools=false`, ReleaseSafe for dev and
  ReleaseSmall for release, as the macOS branch does.
- `package/src/shared/native-devkit-manifest.ts`: `wgpuAuxiliaryLibraries`
  ships `libElectrobunUI.dylib` only on macOS. Add `ElectrobunUI.dll` and
  `libElectrobunUI.so`; keep `d3dcompiler_47.dll` on Windows. Update
  `native-devkit-manifest.test.ts`, `scripts/dev-template.test.ts` and the
  `scripts/fixtures/native-devkit.*.json` fixtures to match.
- `src/ui-core/src/lib.zig`: compiles the Electrobun host only on macOS.
- `src/sdks/main/ui/ffi.ts` `candidates()`: check the library is found
  where the devkit places it on your OS.
- `templates/zig-ui/build.zig` and the devkit Zig SDK: the macOS SDK path is
  only applied on macOS. Check the template builds and links on your OS.

Done when `hutch dev:template bun-ui` starts, finds `libElectrobunUI`, and
logs a clear error from `ebui_attach_wgpu_view` (not a crash).

### 2. Surface and frames

- `ebui_attach_wgpu_view` builds a `SurfaceSourceMetalLayer` unconditionally.
  Switch on the OS. `render/wgpu.zig` already has the sType constants
  (`windows_hwnd` 0x05, `xlib_window` 0x06); add the extern structs.
  - Windows: `{ hinstance, hwnd }`, D3D12 backend.
  - Linux: `{ display, window }`, Vulkan backend. The view only exposes the
    XID today, so add an export for the `Display*`, or return a small struct.
    Don't reach for GDK from Zig.
- Implement `wgpuViewRequestFrame` with real pacing. There is no display
  link. Options: a main-thread timer at the monitor refresh rate, or
  `DwmFlush` on a helper thread posting to the main thread on Windows, or
  the GTK frame clock / a timerfd on Linux. Frames must not run while a
  previous frame is in progress.
- Implement `wgpuViewGetMetrics`, including the scale factor (per-monitor
  DPI v2 on Windows; `linux_dpi.h` exists in `src/native/shared`).
- Resize: `onFrame` reconfigures the surface when size or scale changes.
  Confirm this on live window resizes and on moving between monitors with
  different DPI.

Done when the `bun-ui` template window shows the rendered UI, resizes
cleanly, and is crisp at 100%/150%/200% scale. Screenshot the app window
only.

### 3. Pointer, wheel, cursor, drag regions

- Pointer and wheel events from the view's window. On Linux the WGPU view
  already has an `inputXWindow`; reuse it. Wheel deltas should be in
  logical px; check the direction against macOS.
- `uiSetCursor`, and `wgpuViewBeginWindowDrag` (Windows: `ReleaseCapture`
  plus `WM_NCLBUTTONDOWN`/`HTCAPTION`; X11: `_NET_WM_MOVERESIZE`).

Done when hover, click, scroll containers, select popups, cursors and window
drag regions work in `ui-launcher` and `ui-color-picker`.

### 4. Keyboard, text input and IME

- Key down/up with the neutral key contract. Printable characters go
  through the text callback.
  - Windows: `WM_KEYDOWN` + `WM_CHAR`, IMM32 (`WM_IME_COMPOSITION`) or TSF
    for composition, `ImmSetCompositionWindow`/`ImmSetCandidateWindow` from
    `wgpuViewSetImeRect`.
  - Linux: XIM or IBus via the existing X11 input path. Map preedit to text
    kind 1 and commit to kind 0.
- Clipboard: Ctrl+C/X/V in inputs, through the existing exports.
- Focus: the view must take keyboard focus on click.

Done when typing, editing shortcuts, Tab focus order, and Japanese/Chinese
IME (composition plus candidate window placement) work in inputs, and the
kitchen keyboard and forms tests pass.

### 5. Accessibility

Map the engine's tree to UI Automation on Windows and AT-SPI on Linux.
Follow the macOS `EBAXElement` code for roles, states and actions (0 press,
1 focus, 2 increment, 3 decrement, 4 set value). Done when Narrator or Orca
reads and operates the `bun-ui` controls, and the kitchen
"accessibility tree" test passes.

### 6. Kitchen suite and CI

Get `AUTO_RUN_CATEGORY="Native UI" hutch dev` to 14/14. If a test uses
macOS-only behaviour, make it platform-aware; don't skip it. Add anything
the CI runners can run headlessly to `ui-core.yml`.

## Things to check along the way (likely to differ by OS)

- Fonts: compare text against a native app on the same machine. Families,
  weights, line height and baseline. Emoji: Windows 11 Segoe UI Emoji
  relies on COLRv1 for some glyphs, which the engine does not support yet.
  Note what renders and what doesn't; don't implement COLRv1 in this pass.
- Image formats: PNG, JPEG, GIF, BMP and SVG all decode through the
  portable stack. Spot-check them in `ui-launcher`.
- GPU: VM GPUs are weak or software-only (WARP, llvmpipe). Correct output
  there is the bar; performance numbers are only meaningful on real
  hardware. Record which adapter Dawn picked.

## Coordination between the two VMs

- Work on your own branch, `agent/gpu-ui-windows` or `agent/gpu-ui-linux`,
  cut from `agent/gpu-ui-research`. Rebase onto it often.
- Most of your work is in your own wrapper (`src/native/win/` or
  `src/native/linux/`). The shared files are `src/ui-core/src/host/electrobun.zig`,
  `render/wgpu.zig`, `lib.zig`, `package/build.ts`,
  `native-devkit-manifest.ts` (and its tests/fixtures), `src/sdks/main/ui/*`
  and the kitchen tests. Keep changes there small and switched on the OS.
  Don't restructure them. Do step 1 as a small separate commit so it
  rebases easily.
- Don't touch the macOS wrapper or change callback semantics. If the
  contract needs to change, write it down in your report instead.

## Working rules

- Commit messages: no Co-Authored-By or any AI attribution.
- Screenshots: capture only the app window, never the full screen.
- Fix bug classes, not instances. When a bug comes from an interface that
  allows misuse, change the interface (types, invariants, a test or fuzz
  case) so the whole class can't recur.
- Before reporting done, run the ui-core tests, the kitchen Native UI suite
  and at least the `bun-ui` and `zig-ui` templates on your OS.

## Report back

When you stop, write a short report:

- what works, with app-window screenshots of `bun-ui`, `ui-launcher` and
  `ui-color-picker`
- kitchen results (x/14) and ui-core test results
- the Dawn adapter and backend used
- contract changes you need from the shared code
- known gaps, ordered by user impact

Out of scope for this pass: bidi and complex-script shaping, variable font
instances, COLRv1, and DirectWrite/fontconfig integration. List what you
observe about them in your report; don't implement them.
