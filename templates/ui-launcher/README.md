# ui-launcher — command palette in a Cottontail UI window

A Raycast-style palette that lives as a small always-on-top pill you can
drag anywhere on screen. Click the pill (or hit the global shortcut — it
tries `cmd+shift+space`, then `cmd+opt+space`, then `cmd+shift+K`, since
password managers often own the first) to expand into the palette:
fuzzy-search your installed applications, or type math (`(42*3)+1`) for an
inline calculator whose result copies to the clipboard. The pill position
persists across launches. Rendered entirely by the experimental
`electrobun/main/ui` runtime — no webview idles in memory for a surface
that idles 98% of the time, and the collapsed pill costs zero CPU.

What it exercises:

- `textInput` — focus, caret editing, placeholder, submit
- `ui.each` — keyed rows that survive filtering without rebuilding
- `overflow: "scroll"` — clipped list with selection follow-scroll
- Transparent, rounded, always-on-top UI window + `GlobalShortcut`

## Run it

```
bun install
bun start
```

Production packaging: `hutch electrobun build --env=production`.

Keys: type to filter, `up`/`down` to navigate, `enter` to launch/copy,
`esc` to collapse back to the pill. Drag the pill to reposition.

## Prototype limitations

- Keyboard mapping assumes a US layout with macOS virtual key codes.
- No mouse-wheel scrolling yet (selection follow-scroll only) — native
  pointer/wheel events on WGPUView are the planned fix.
- App scan is a flat directory listing (no Spotlight metadata, no icons).
