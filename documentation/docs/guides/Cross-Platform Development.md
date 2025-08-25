---
sidebar_position: 3
title: Cross-Platform Development
---

# Cross-Platform Development

Electrobun enables you to build desktop applications that run on macOS, Windows, and Linux from a single codebase. This guide covers platform-specific considerations and best practices for cross-platform development.

## Platform-Specific Issues

### Window Management
Some window options like frameless windows work differently on different OSes.

### Webview Behavior

Webview hiding and passthrough behavior varies between platforms:

- **macOS**: Webviews can be set to hidden and passthrough separately. These are independent settings.
- **Windows & Linux**: Setting a webview to hidden using also automatically enables passthrough behavior. There is no separate passthrough setting - clicks will pass through hidden webviews to underlying content.

```javascript
// Hide a webview (behavior differs by platform)
webviewSetHidden(webviewId, true);

// On macOS: webview is hidden but still intercepts clicks (unless passthrough is also enabled)
// On Windows/Linux: webview is hidden AND clicks pass through automatically

// Enable click passthrough (macOS only - no effect on Windows/Linux)
webviewSetPassthrough(webviewId, true);
```

### Linux
By defalt on Linux we use GTK windows and GTKWebkit webviews. This is as close to a "system" webview on Linux that's managed/updated by the OS. Some distros don't have this installed by default so you will need to ask your end users to install those dependencies. 

In addition GTK and GTKWebkit have severe limitations and are unable to handle Electrobun's more advanced webview layering and masking functionality.

So we strongly recommend bundling CEF (just st bundleCEF to true in your electrobun.config.ts file) for your app's linux distribution. And make sure you open `new BrowserWindow()`s and `<electrobun-webview>`s with `renderer="cef"` which uses pure x11 windows.

## Building for Multiple Platforms

### Build Matrix

When building your app, you can target different platforms using the electrobun cli:

```bash
# Build for current platform
`electrobun build`

# Platform-specific builds
electrobun build --targets=macos-x64
electrobun build --targets=macos-arm64
electrobun build --targets=win32-x64
electrobun build --targets=linux-x64
electrobun build --targets=linux-arm64

# cross compiling multiple targets
electrobun build --targets=macos-arm64,linux-arm64,win32-x64

# all targets
electrobun build --targets=all
```

:::info
Currently bundling for mac requires dmg and codesigning and notarization on mac requires other mac specific tools, so it's recommended to use a mac machine or ci vm as the OS to cross-compile for all targets. 
:::


### Architecture Considerations

| Platform | Architectures | Notes |
|----------|--------------|-------|
| macOS | x64, ARM64 | Universal binaries supported |
| Windows | x64 | ARM64 runs via emulation |
| Linux | x64, ARM64 | Native support for both |

