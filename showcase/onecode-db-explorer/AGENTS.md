## Showcase App Principles (DB Explorer)

This folder is a **real showcase app**, not a toy template. Changes should push it toward a polished, usable DB explorer.

### Version Control
- Use **`jj` (Jujutsu)** for VCS operations (not `git`).

### Build Tooling
- **No Vite.** UI bundling uses `Bun.build` (see `scripts/build-ui.ts`).
- Solid JSX compilation is **currently handled by a temporary Babel plugin** (see `scripts/solid-plugin.ts`).
- `solid-jsx-oxc` is included as a dev dependency but **is not wired into the build yet**.

### UI Libraries
- Prefer **Corvu** for unstyled, accessible primitives (dialogs, popovers, tooltips).
- Use **Kobalte** when Corvu isn’t a fit (or upstream patterns rely on it).
- Use **Solid Primitives** for utilities (storage, event listeners, resize observers, etc).

### SolidJS Guidelines
- Prefer idiomatic Solid patterns (`createSignal`, `createMemo`, `createEffect`, `<Show>`, `<For>`, `<Switch>`).
- Avoid unnecessary reactivity churn (memoize derived data, minimize effects).
- Keep the UI fast for large datasets (virtualize where needed; avoid expensive rerenders).

### Product Direction
- Target a high-performance, “1code-style” DB explorer UX:
  - Multiple connections (profiles) and multi-window support (eventually).
  - SQL editor with schema-aware autocomplete.
  - Table/data browsing with editing, filtering, and good ergonomics.
  - Schema + relationship visualization (ERD/graph) implemented in Solid.
