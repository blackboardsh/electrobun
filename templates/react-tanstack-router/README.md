# Electrobun TanStack Router React Template

A modern desktop application template built with **Electrobun**, **React 19**, **TanStack Router**, **Tailwind CSS**, and **Vite** with Hot Module Replacement (HMR) support.

## Tech Stack

- **React** 19.2.4 - Modern UI with components
- **TanStack Router** 1.168.10 - Type-safe and fully-featured routing
- **Vite** 8.0.3 - Lightning-fast build tool with HMR
- **Tailwind CSS** 4.2.2 - Utility-first styling
- **TypeScript** 6.0.2 - Full type safety
- **Electrobun** 1.16.0 - Framework for desktop apps with Electron and Bun
- **Bun** - Ultra-fast JavaScript/TypeScript runtime

## Project Structure

```
├── src/
│   ├── bun/
│   │   └── index.ts              # Main process (Electrobun)
│   ├── mainview/                 # Frontend React app
│   │   ├── index.html            # HTML template
│   │   ├── main.tsx              # React entry point
│   │   ├── index.css             # Tailwind styles
│   │   ├── routeTree.gen.ts      # Generated router (auto)
│   │   ├── hooks/
│   │   │   └── use-rpc.ts        # Hook for RPC communication
│   │   ├── routes/               # TanStack Router
│   │   │   ├── __root.tsx        # Root layout
│   │   │   ├── index.tsx         # Home page
│   │   │   └── about.tsx         # About page
│   └── shared/
│       └── types/
│           └── rpc/              # Shared RPC types
├── electrobun.config.ts          # Electrobun config (window, icon, etc)
├── vite.config.ts                # Vite and HMR config
├── tsconfig.json                 # TypeScript configuration
└── package.json
```

## Available Scripts

| Command                | Description                           |
| ---------------------- | ------------------------------------- |
| `bun run dev`          | Start Electrobun (without HMR)        |
| `bun run dev:hmr`      | Development with HMR (live JS/CSS)    |
| `bun run hmr`          | Vite dev server only (port 5173)      |
| `bun run start`        | Build + Electrobun (local production) |
| `bun run build:canary` | Canary build for development          |
| `bun run build:stable` | Stable build for distribution         |
