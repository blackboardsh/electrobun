---
title: "CLI Commands"
---

# CLI Commands

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

```text
electrobun build [options]

```

#### Options

<table class="options-table">
<thead>
<tr>
<th>Option</th>
<th>Description</th>
<th>Values</th>
<th>Default</th>
</tr>
</thead>
<tbody>
<tr>
<td><code style="text-wrap:nowrap;">--env</code></td>
<td>Build environment</td>
<td>`dev`, `canary`, `stable`</td>
<td>`dev`</td>
</tr>
</tbody>
</table>
Builds always target the current host platform and architecture. To build for multiple platforms, use CI runners for each OS/architecture (see [Cross-Platform Development](/guide/cross-platform-development)).

#### Examples

```bash

# Development build for current platform
electrobun build

# Development build with environment flag
electrobun build --env=dev

# Canary build
electrobun build --env=canary

# Stable (production) build
electrobun build --env=stable

```

### `electrobun run`

Launches an already-built dev bundle. This is useful when you've already run `electrobun build` and just want to relaunch the app without rebuilding.

#### Usage

```text
electrobun run

```

### `electrobun dev`

Builds your application in dev mode and then launches it. This is the primary command for day-to-day development — equivalent to running `electrobun build --env=dev` followed by `electrobun run`.

#### Usage

```text
electrobun dev [options]

```

#### Options

<table class="options-table">
<thead>
<tr>
<th>Option</th>
<th>Description</th>
</tr>
</thead>
<tbody>
<tr>
<td><code style="text-wrap:nowrap;">--watch</code></td>
<td>Watch source files for changes and automatically rebuild + relaunch</td>
</tr>
</tbody>
</table>

#### Examples

```bash

# Build and launch in dev mode
electrobun dev

# Build, launch, and watch for changes
electrobun dev --watch

```

#### Watch Mode

When using `--watch`, Electrobun automatically watches your source directories for file changes:

- The directory containing your `build.bun.entrypoint`

- Directories containing each view entrypoint

- Source paths from `build.copy`

- Any additional paths specified in `build.watch`
When a file change is detected, the running app is killed, a fresh build runs (including all lifecycle hooks like `postBuild`), and the app is relaunched. File watchers are paused during builds to avoid false triggers from build output.Changes are debounced (300ms) so rapid saves only trigger a single rebuild. If a build fails, the error is logged and the watcher keeps running — the app will rebuild on the next file change.Use `build.watchIgnore` in your config to exclude files from triggering rebuilds (e.g., generated assets). See [Build Configuration](/api/build-configuration) for details.Press <kbd>Ctrl+C</kbd> to stop the app and exit watch mode.

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

```ts
// package.json
{
  "scripts": {
    "start": "electrobun run",
    "dev": "electrobun dev",
    "dev:watch": "electrobun dev --watch",
    "build:canary": "electrobun build --env=canary",
    "build:stable": "electrobun build --env=stable"
  }
}

```

### CI Build Scripts

For multi-platform distribution, run the same build command on each platform's CI runner:

```ts
// package.json
{
  "scripts": {
    "build:dev": "electrobun build",
    "build:canary": "electrobun build --env=canary",
    "build:stable": "electrobun build --env=stable"
  }
}

```
