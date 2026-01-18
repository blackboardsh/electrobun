# 1Code-Style DB Explorer (Solid + Bun.SQL, No Vite)

An Electrobun desktop app with:
- SolidJS UI
- `solid-jsx-oxc` for JSX compilation
- Bun's bundler (`Bun.build`) for static `dist/` assets (no Vite)
- `Bun.SQL` for running SQL against SQLite / Postgres / MySQL
- `solid-ag-grid` for rendering result sets
- Corvu dialog primitives (command palette)

## Getting Started

```bash
# Install dependencies
bun install

# Build + run (dev)
bun run dev

# Build (dev)
bun run build

# Build (stable / production)
bun run build:prod
```

## Using It

- Default connection string is `:memory:` (SQLite) and boots with a small demo database.
- Default theme is dark (toggle from the toolbar).
- Manage saved connections via **Connections** (and open the same profile in a **new window**).
- Click a table to populate a `SELECT * ... LIMIT 100` query.
- Run a query with the **Run** button or `Cmd/Ctrl+Enter`.
- Use **Schema Graph** to visualize tables + foreign-key relationships.
- Schema Manager shows column metadata (types / PK / defaults).
- Table cells are editable when the table has a primary key (updates run via `Bun.SQL` on the Bun side).

## Customizing

- **Solid UI**: `src/mainview/App.tsx`
- **Bun SQL/RPC**: `src/bun/index.ts`
- **UI build pipeline (Solid + OXC)**: `scripts/build-ui.ts`
- **App metadata**: `electrobun.config.ts`
