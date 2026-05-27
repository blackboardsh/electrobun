---
title: "Cross-Platform Development"
---

Electrobun enables you to build desktop applications that run on macOS, Windows, and Linux from a single codebase. This guide covers platform-specific considerations and best practices for cross-platform development.

## Platform-Specific Issues

### Window Management
Some window options like frameless windows work differently on different OSes.

### Webview Behavior
Webview hiding and passthrough behavior varies between platforms:

- **macOS**: Webviews can be set to hidden and passthrough separately. These are independent settings.

- **Windows &amp; Linux**: Setting a webview to hidden using also automatically enables passthrough behavior. There is no separate passthrough setting - clicks will pass through hidden webviews to underlying content.

```

// Hide a webview (behavior differs by platform)
webviewSetHidden(webviewId, true);

// On macOS: webview is hidden but still intercepts clicks (unless passthrough is also enabled)
// On Windows/Linux: webview is hidden AND clicks pass through automatically

// Enable click passthrough (macOS only - no effect on Windows/Linux)
webviewSetPassthrough(webviewId, true);

```

### Linux
By default on Linux we use GTK windows and GTKWebkit webviews. This is as close to a "system" webview on Linux that's managed/updated by the OS. Some distros don't have this installed by default so you will need to ask your end users to install those dependencies.In addition GTK and GTKWebkit have severe limitations and are unable to handle Electrobun's more advanced webview layering and masking functionality.So we strongly recommend bundling CEF (just set bundleCEF to true in your electrobun.config.ts file) for your app's linux distribution. And make sure you open `new BrowserWindow()`s and `<electrobun-webview>`s with `renderer="cef"` which uses pure x11 windows.

## Building for Multiple Platforms
Electrobun builds for the current host platform. To produce builds for all platforms, use a CI service like GitHub Actions with a runner for each OS/architecture. GitHub Actions provides free CI runners for open-source projects covering all supported platforms.

```

# On each CI runner, just run:
electrobun build --env=stable

```

Electrobun's [GitHub repository](https://github.com/blackboardsh/electrobun) includes a release workflow that builds natively on each platform using a build matrix. This is the recommended approach — each platform build runs on its native OS, avoiding cross-compilation complexity and ensuring platform-specific tools (code signing, icon utilities, etc.) work correctly.

### Architecture Considerations

<table class="docs-table">
<thead>
<tr>
<th>Platform</th>
<th>Architectures</th>
<th>Notes</th>
</tr>
</thead>
<tbody>
<tr>
<td>macOS</td>
<td>x64, ARM64</td>
<td>Universal binaries supported</td>
</tr>
<tr>
<td>Windows</td>
<td>x64</td>
<td>ARM64 runs via emulation</td>
</tr>
<tr>
<td>Linux</td>
<td>x64, ARM64</td>
<td>Native support for both</td>
</tr>
</tbody>
</table>

## Windows Console Output
On Windows, Electrobun builds your app as a GUI application (Windows subsystem) so that no console window appears when end users launch it. Dev builds automatically attach to the parent console so you can see `console.log` output and debug information in your terminal.When you need to inspect console output from a **canary** or **stable** build (for example to debug an issue that only reproduces in a production build), set the `ELECTROBUN_CONSOLE` environment variable:

```

# Launch a canary/stable build with console output visible
set ELECTROBUN_CONSOLE=1
.\MyApp.exe

```

When `ELECTROBUN_CONSOLE=1` is set, the launcher will attach to the parent console and inherit standard output/error streams, just like a dev build. This has no effect on macOS or Linux where console output is always available.