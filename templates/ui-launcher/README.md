# ui-launcher — command palette in an Electrobun UI window

A Raycast-style palette that lives as a small always-on-top pill you can
drag anywhere on screen. Click the pill (or hit the global shortcut — it
tries `cmd+shift+space`, then `cmd+opt+space`, then `cmd+shift+K`, since
password managers often own the first) to expand into the palette:
fuzzy-search your installed applications, or type math (`(42*3)+1`) for an
inline calculator whose result copies to the clipboard. The pill position
persists across launches.

The UI is plain HTML/CSS written as JSX and rendered by `electrobun/main/ui`
straight to the GPU — no webview idles in memory for a surface that idles
98% of the time, and the collapsed pill costs zero CPU.

What it exercises:

- `createUIWindow` with a transparent, rounded, always-on-top window
- `-webkit-app-region: drag` — the pill drags the window; a press that
  doesn't move it still clicks
- `<input autofocus placeholder>` with `onInput`, `:focus` styling
- `<For each key>` — keyed rows that survive filtering without rebuilding
- `overflow: auto` + `scrollIntoView()` for keyboard follow-scroll
- a `keydown` listener on `ui.body` for window-level keys, plus
  `GlobalShortcut`

## Run it

```
hutch run install
hutch run start
```

Production packaging: `hutch run build`.

Keys: type to filter, `up`/`down` to navigate, `enter` to launch/copy,
`esc` to collapse back to the pill. Drag the pill to reposition.

## Prototype limitations

- macOS only for now (the UI engine ships on macOS first).
- App scan is a flat directory listing (no Spotlight metadata, no icons).
