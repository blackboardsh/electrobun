# bun-ui — Electrobun UI starter (Bun)

A small task tracker whose window is rendered by **Electrobun UI**: HTML/CSS
and JSX laid out and painted by Electrobun's Zig UI engine straight to the
GPU (Dawn), driven from a **Bun** main process. There is no webview — the app
is a single TypeScript file.

## Run it

```
hutch run install
hutch run start        # or: hutch run dev (rebuild on change)
```

Production packaging: `hutch run build`.

## Structure

```
src/bun/index.tsx      the whole app: state, CSS, components, window
electrobun.config.ts   Bun entrypoint; bundleWGPU ships Dawn + the UI engine
tsconfig.json          jsxImportSource: electrobun/main/ui (editor/typecheck only)
```

## How it works

- **Window:** `createUIWindow({ title, width, height, css, components: true }, App)`
  opens a GPU window and renders `App` into it. `components: true` adds the
  built-in `eb-*` design system (buttons, inputs, switches, tabs, cards,
  badges, lists); your `css` string layers on top.
- **Components** are plain functions returning JSX, called once. Nothing
  re-renders: `live(() => ...)` marks each reactive expression, and only that
  text node, attribute or style updates when its signals change.
- **State:** `store` holds the tasks (mutate a draft in the setter:
  `setState((s) => { s.tasks.push(...) })`), `signal` holds UI state, `memo`
  derives the filtered list and the remaining count.
- **Lists and conditionals:** `<For each={...} key={...}>` keeps rows (and
  their focus/animation state) as items are added, removed or filtered;
  `<Show when={...}>` renders the empty state.
- **Forms** behave like the web: Enter in the input or clicking the submit
  button fires the form's `onSubmit`; `onInput`/`onChange` events carry the
  control's value in `e.data`.
- **Dark mode:** `app.ui.setDark(on)` sets the engine's `prefers-color-scheme`
  value and the `eb-*` theme. It does not automatically follow system appearance.
- **Window dragging:** the header uses `-webkit-app-region: drag`, with the
  native traffic lights inset on macOS (`titleBarStyle: "hiddenInset"`).

The UI engine is experimental on macOS, Windows, and Linux (X11), on x64 and
ARM64. See the [platform support and limitations](https://docs.electrobun.dev/electrobun/apis/ui/overview/#platform-support)
before relying on transparent windows, text shaping, or native accessibility.
