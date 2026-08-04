# ui-color-picker — tray eyedropper in a Cottontail UI window

The "webview is too much, raw GpuWindow is too little" showcase: a color
picker that lives in the system tray. The window is transparent with rounded
corners, always on top, and rendered entirely by the `electrobun/main/ui`
runtime — no webview.

- **Left:** an 11x11 zoomed loupe of the pixels around your cursor,
  refreshed live (sampling pauses automatically while your cursor is over
  the picker itself, or when frozen with the space bar).
- **Right:** the center pixel in HEX / RGB / RGBA / HSL. Click any row to
  copy that format; `cmd+C` copies your preferred format, selected in the
  dropdown and persisted across launches (`userData/ui-color-picker.json`).
- **Tray:** click the tray glyph to show/hide; Escape hides too.

## Run it

```
bun install
bun start
```

Production packaging: `hutch electrobun build --env=production`.

**Permission:** reading screen pixels requires macOS Screen Recording
permission. The app requests it at startup (system prompt via
`Utils.screenCapture.requestAccess()`); if it's not granted the status dot
turns red — click it to open the right System Settings pane. macOS requires
a relaunch after granting. Note for dev runs from a terminal: macOS may
attribute the permission to your terminal app rather than the dev bundle.

## Prototype limitations

- Screen sampling shells out to `screencapture` (~6Hz); production work is a
  native capture API in Electrobun's core (macOS-only for now).
- Drag the loupe (left panel) to move the window.
- Keyboard mapping uses macOS virtual key codes.
