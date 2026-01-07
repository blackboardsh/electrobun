# Svelte Electrobun Template

A fast Electrobun desktop app template with Svelte 5 and Vite for hot module replacement (HMR).

## Getting Started

```bash
# Install dependencies
bun install

# Development without HMR (uses bundled assets)
bun run dev

# Development with HMR (recommended)
bun run dev:hmr

# Build for production
bun run build

# Build for production release
bun run build:prod
```

## How HMR Works

When you run `bun run dev:hmr`:

1. **Vite dev server** starts on `http://localhost:5173` with HMR enabled
2. **Electrobun** starts and detects the running Vite server
3. The app loads from the Vite dev server instead of bundled assets
4. Changes to Svelte components update instantly without full page reload

When you run `bun run dev` (without HMR):

1. Electrobun starts and loads from `views://mainview/index.html`
2. You need to rebuild (`bun run build`) to see changes

## Project Structure

```
├── src/
│   ├── bun/
│   │   └── index.ts        # Main process (Electrobun/Bun)
│   └── mainview/
│       ├── App.svelte      # Svelte app component
│       ├── main.ts         # Svelte entry point
│       ├── index.html      # HTML template
│       └── app.css         # Global styles
├── electrobun.config.ts    # Electrobun configuration
├── vite.config.ts          # Vite configuration
├── svelte.config.js        # Svelte configuration
└── package.json
```

## Svelte 5 Features

This template uses Svelte 5 with the new runes syntax:

- `$state()` - reactive state
- `$derived()` - computed values
- `$effect()` - side effects

## Customizing

- **Svelte components**: Edit files in `src/mainview/`
- **Global styles**: Edit `src/mainview/app.css`
- **Vite settings**: Edit `vite.config.ts`
- **Window settings**: Edit `src/bun/index.ts`
- **App metadata**: Edit `electrobun.config.ts`
