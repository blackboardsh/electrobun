# Build System

This document describes Electrobun's build system and cross-platform compilation approach.

## Overview

Electrobun uses a custom build system (`build.ts`) that handles:
- Vendoring dependencies (Dash CLI, Cottontail, Bun, Zig, CEF, WebView2)
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

#### CLI Binary Selection

The Electrobun CLI automatically copies the appropriate binary based on the `bundleCEF` setting:

```typescript
const useCEF = config.build.linux?.bundleCEF;
const nativeWrapperSource = useCEF 
  ? PATHS.NATIVE_WRAPPER_LINUX_CEF 
  : PATHS.NATIVE_WRAPPER_LINUX;
```

Both binaries are included in the distributed `electrobun` npm package, ensuring developers can toggle CEF support without recompilation.

## Build Commands

All commands are run from the `/package` directory:

```bash
cd electrobun/package
npm ci
npm run dash:vendor

# Full build with all platforms
./vendors/dash-cli/dash build.ts

# Development build with the kitchen sink test app
./vendors/dash-cli/dash dev

# Release build
./vendors/dash-cli/dash build.ts --release

# CI build
./vendors/dash-cli/dash build.ts --ci
```

## Dash CLI and Cottontail

`package/runtime-artifacts.lock.json` pins the complete Dash CLI and Cottontail
preview manifests used by Electrobun builds. A normal build downloads the Dash
archive, verifies its checksum and release metadata, and installs both Dash and
the matching Cottontail payload contained in that archive.

After publishing compatible Cottontail and Dash preview releases, update both
pins together:

```bash
cd electrobun/package
./vendors/dash-cli/dash scripts/update-runtime-artifacts.ts
```

For local runtime development, `DASH_CLI_ROOT` can point at a Dash checkout
with an existing `zig-out/bin` build, while `DASH_USE_LOCAL_COTTONTAIL=1`
selects the adjacent Cottontail checkout. `DASH_CLI_BINARY` and
`COTTONTAIL_BINARY` remain available for CI and one-off binary overrides.

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
