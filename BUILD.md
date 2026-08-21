# Build System

This document describes Electrobun's build system and cross-platform compilation approach.

## Overview

Electrobun uses a custom build system (`build.ts`) that handles:
- Resolving the globally installed Hutch and its selected Cottontail runtime
- Resolving application toolchains and platform artifacts such as Zig, CEF, and WebView2
- Building native wrappers for each platform
- Creating distribution packages

## Platform-Specific Native Wrappers

### macOS
- Single `libNativeWrapper.dylib` with weak linking to CEF framework
- Uses `-weak_framework 'Chromium Embedded Framework'` for optional CEF support
- Gracefully falls back to WebKit when CEF is not bundled

### Windows  
- Single `libNativeWrapper.dll` with runtime CEF detection
- Links both WebView2 and CEF libraries at build time
- Uses runtime checks to determine which webview engine to use

### Linux
**Dual Binary Approach** - Linux builds create two separate native wrapper binaries:

#### `libNativeWrapper.so` (GTK-only)
- Size: ~1.46MB
- Dependencies: WebKitGTK, GTK+3, AppIndicator only
- No CEF dependencies linked
- Used when `bundleCEF: false` in electrobun.config

#### `libNativeWrapper_cef.so` (CEF-enabled)  
- Size: ~3.47MB
- Dependencies: WebKitGTK, GTK+3, AppIndicator + CEF libraries
- Full CEF functionality available
- Used when `bundleCEF: true` in electrobun.config

#### Why Dual Binaries?

Unlike macOS and Windows, Linux doesn't have reliable weak linking for shared libraries. Hard linking CEF libraries causes `dlopen` failures when CEF isn't bundled. The dual binary approach provides:

1. **Small bundle sizes** - Developers can ship lightweight apps without CEF overhead
2. **Flexibility** - Same codebase supports both system WebKitGTK and CEF rendering
3. **Reliability** - No runtime linking failures or undefined symbols

#### Build-Time Binary Selection

The native devkit manifest identifies both wrappers. Hutch selects and stages
the CEF-enabled wrapper only when `build.linux.bundleCEF` is true; otherwise it
uses the GTK-only wrapper. This selection is part of application packaging,
not the thin npm bootstrap.

Both binaries are published with the versioned Electrobun devkit. Hutch resolves
the explicit `electrobun.version` when present, otherwise the npm-paired or
floating channel default, verifies that release's artifacts, and installs them
under `~/.hutch/releases/electrobun`. The thin `electrobun` npm bootstrap
contains no runtime binaries or SDK source.

## Build Commands

All commands are run from the `/package` directory:

```bash
cd electrobun/package
npm ci

# Full build with all platforms
hutch build.ts

# Development build with the kitchen sink test app
hutch dev

# Build Electrobun and run one repository template against package/dist
hutch dev:template hello-world

# Release build
hutch build.ts --release

# CI build
hutch build.ts --ci
```

From `package/`, `hutch dev` builds `package/dist` and launches Kitchen with
that local Electrobun devkit. Running `hutch dev` from `kitchen/` uses its
published version pin instead.

`hutch dev:template <template-name>` applies the same local-devkit workflow to
one source template: it builds `package/dist`, installs the template's configured
dependencies, and launches its `dev` task with the local Electrobun version and
bytes. Release publication leaves the repository source unpinned but adds the
exact release version to the staged template archive.

## Hutch and Cottontail

Canonical Hutch and Cottontail releases are published independently of
Electrobun. The Electrobun release workflow downloads and verifies the four
archives from its exact paired upstream Hutch release, then mirrors those same
bytes into the Electrobun GitHub Release under `electrobun-hutch-*` names. Its
`hutch-artifacts.json` binds each mirror's immutable URL, byte size, and SHA-256
digest for the single npm bootstrap; the mirror does not replace the canonical
Hutch release.

The first-line `// @hutch` pragma in `package/hutch.config.ts` pins the exact
Hutch and build-time Cottontail versions used for reproducible Electrobun
builds. The Cottontail bundled into an application is a separate component
pinned by the selected Electrobun devkit manifest.

For full local-stack development, `hutch dev --local` additionally builds and
selects the sibling Hutch launcher, Hutch engine, and Cottontail binary without
changing the published version pins.

## Architecture Support

- **macOS**: ARM64 (Apple Silicon)
- **Windows**: x64 only (ARM Windows users run via automatic emulation)
- **Linux**: x64, ARM64

### Windows Architecture Notes

Windows builds are created on ARM VMs but target x64 architecture. Both x64 and ARM Windows users use the same x64 binary:
- **x64 Windows**: Runs natively
- **ARM Windows**: Runs via automatic Windows emulation layer

This approach simplifies distribution while maintaining compatibility across Windows architectures.

The build system automatically detects the host architecture and downloads appropriate dependencies.
