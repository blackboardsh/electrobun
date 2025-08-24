---
title: CLI Commands
sidebar_label: CLI Commands
---

# Electrobun CLI Commands

The Electrobun CLI provides commands for initializing new projects and building your applications for different environments.

## Installation

When you install Electrobun, the CLI tool is added to your `node_modules/bin` folder:

```bash
bun install electrobun
```

This makes the `electrobun` command available in your npm scripts or via `bunx`/`npx`.

## Commands

### `electrobun init`

Initializes a new Electrobun project with starter templates.

#### Usage

```bash
# Interactive template selection
electrobun init

# Direct template selection
electrobun init [template-name]
```

#### Available Templates

- `hello-world` - Basic single-window application
- `photo-booth` - Camera app with photo capture functionality  
- `interactive-playground` - An interactive playground of Electrobun apis
- `multitab-browser` - Multi-tabbed web browser

#### Examples

```bash
# Choose template interactively
bunx electrobun init

# Initialize with photo-booth template directly
bunx electrobun init photo-booth

# Initialize with multitab-browser template
bunx electrobun init multitab-browser
```

### `electrobun build`

Builds your Electrobun application according to the configuration in `electrobun.config.ts`.

#### Usage

```bash
electrobun build [options]
```

#### Options

| Option | Description | Values | Default |
|--------|-------------|---------|---------|
| `--env` | Build environment | `dev`, `canary`, `stable` | `dev` |
| `--targets` | Platform targets to build | `current`, `all`, or comma-separated list | `current` |

#### Target Formats

- `current` - Build for current platform/architecture only
- `all` - Build for all configured platforms
- `macos-arm64` - macOS Apple Silicon
- `macos-x64` - macOS Intel
- `win-x64` - Windows 64-bit
- `linux-x64` - Linux 64-bit

#### Examples

```bash
# Development build for current platform
electrobun build

# Development build with environment flag
electrobun build --env=dev

# Canary build for current platform
electrobun build --env=canary

# Stable build for all platforms
electrobun build --env=stable --targets=all

# Build for specific platforms
electrobun build --env=stable --targets=macos-arm64,win-x64

# Build for macOS Universal (both architectures)
electrobun build --env=stable --targets=macos-arm64,macos-x64
```

## Build Environments

### Development (`dev`)

- Outputs logs and errors to terminal
- No code signing or notarization
- Creates build in `build/` folder
- No artifacts generated
- Fast iteration for testing

### Canary

- Pre-release/beta builds
- Optional code signing and notarization
- Generates distribution artifacts
- Creates update manifests for auto-updates
- Suitable for testing with limited users

### Stable

- Production-ready builds
- Full code signing and notarization (if configured)
- Optimized and compressed artifacts
- Ready for distribution to end users
- Generates all update files

## Build Script Examples

### Basic Setup

```json title="package.json"
{
  "scripts": {
    "dev": "electrobun build && electrobun dev",
    "build": "electrobun build --env=canary",
    "build:stable": "electrobun build --env=stable"
  }
}
```

### Development Workflow

```json title="package.json"
{
  "scripts": {
    "dev": "electrobun build --env=dev && electrobun dev",
    "dev:watch": "nodemon --watch src --exec 'bun run dev'",
    "test": "bun test && bun run build"
  }
}
```

### Multi-Platform Builds

```json title="package.json"
{
  "scripts": {
    "build:dev": "electrobun build",
    "build:canary": "electrobun build --env=canary",
    "build:canary:all": "electrobun build --env=canary --targets=all",
    "build:stable": "electrobun build --env=stable",
    "build:stable:mac": "electrobun build --env=stable --targets=macos-arm64,macos-x64",
    "build:stable:win": "electrobun build --env=stable --targets=win-x64",
    "build:stable:linux": "electrobun build --env=stable --targets=linux-x64",
    "build:stable:all": "electrobun build --env=stable --targets=all"
  }
}
```
