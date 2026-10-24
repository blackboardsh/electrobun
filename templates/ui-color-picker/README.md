# ui-color-picker — tray eyedropper in an Electrobun UI window

The "webview is too much, raw GpuWindow is too little" showcase: a color
picker that lives in the system tray. The window is transparent with rounded
corners and always on top. Its UI is HTML/CSS written as JSX and rendered by
`electrobun/main/ui` straight to the GPU — no webview.

- **Left:** an 11x11 zoomed loupe of the pixels around your cursor,
  refreshed live (sampling pauses automatically while your cursor is over
  the picker itself, or when frozen with the space bar).
- **Right:** the center pixel in HEX / RGB / RGBA / HSL. Click any row to
  copy that format; `cmd+C` copies your preferred format, selected in the
  dropdown and persisted across launches (`userData/ui-color-picker.json`).
- **Tray:** click the tray glyph to show/hide; Escape hides too.

What it exercises:

- `createUIWindow` with a transparent, rounded, always-on-top window
- a CSS grid of 121 cells whose `style` is bound with `live()` — only the
  cells whose color changed are touched each sample
- `:hover` states, `-webkit-app-region: drag` on the loupe (clicks inside it,
  like the permission status, still work)
- `<Show>` / `<For>` and a `keydown` listener on `ui.body` (cmd+C, space, esc)

## Run it

```
hutch run install
hutch run start
```

Production packaging: `hutch run build`.

Screen pixels are sampled through Electrobun's native `Screen.captureRegion()`
API on macOS, Windows, Linux/X11, and Linux/Wayland. On Wayland, the first
sample opens the desktop's monitor-sharing chooser; sampling starts as soon as
the portal supplies its first PipeWire frame. Ubuntu/Debian systems need the
PipeWire runtime library (`libpipewire-0.3-0`, or `libpipewire-0.3-0t64` on
newer releases).

**Permission:** reading screen pixels requires macOS Screen Recording
permission. The app requests it at startup (system prompt via
`Utils.screenCapture.requestAccess()`); if it's not granted the status dot
turns red — click it to open the right System Settings pane. macOS requires
a relaunch after granting. Note for dev runs from a terminal: macOS may
attribute the permission to your terminal app rather than the dev bundle.

## Prototype limitations

- Wayland capture currently shares one selected monitor. Regions outside that
  monitor are unavailable until the app is restarted and another is selected.
- Wayland live tracking uses compositor-owned PipeWire cursor metadata, so it
  continues across native Wayland and XWayland surfaces. Passive global mouse
  button state is not available, so the template replaces outside-click pick
  mode with an explicit **freeze sample** button there.
- After the first Wayland grant, monitor sharing remains active until the app
  exits; the desktop's sharing indicator shows that state.
- Drag the loupe (left panel) to move the window.
- The UI engine ships on macOS first; the template's Windows/Linux capture
  paths are kept for when it does.
