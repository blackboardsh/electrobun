# Build System

This document describes Electrobun's build system and cross-platform compilation approach.

## Overview

Electrobun uses a custom build system (`build.ts`) that handles:
- Vendoring dependencies (Bun, Zig, CEF, WebView2)
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

```bash
# Full build with all platforms
bun build.ts

# Development build with playground
bun dev:playground

# Release build  
bun build.ts --release

# CI build
bun build.ts --ci
```

## Architecture Support

- **macOS**: ARM64 (Apple Silicon), x64 (Intel) 
- **Windows**: x64 only (ARM Windows users run via automatic emulation)
- **Linux**: x64, ARM64

### Windows Architecture Notes

Windows builds are created on ARM VMs but target x64 architecture. Both x64 and ARM Windows users use the same x64 binary:
- **x64 Windows**: Runs natively
- **ARM Windows**: Runs via automatic Windows emulation layer

This approach simplifies distribution while maintaining compatibility across Windows architectures.

The build system automatically detects the host architecture and downloads appropriate dependencies.