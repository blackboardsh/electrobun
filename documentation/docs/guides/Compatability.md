## Dependencies and Versions

| Dependency                 | Version         | Notes                                                      |
| -------------------------- | --------------- | ---------------------------------------------------------- |
| Bun                        | 1.2.2           |                           |
| Zig                        | 0.13.0             |                                   |
| CEF                        | 125.0.22           | optionally bundled                |

## Platform Support

### Development Platform
- **macOS**: Required for building Electrobun apps (Intel and Apple Silicon supported)
- **Windows**: Development support available
- **Linux**: Development support available

### Target Platforms
Apps built with Electrobun can be distributed to:

| Platform | Architecture | Status | Notes |
| -------- | ------------ | ------ | ----- |
| macOS    | ARM64 (Apple Silicon) | ✅ Stable | Full support with system WebKit |
| macOS    | x64 (Intel) | ✅ Stable | Full support with system WebKit |
| Windows  | x64 | ✅ Stable | WebView2 (Edge) or bundled CEF |
| Windows  | ARM64 | ✅ Via Emulation | Runs x64 binary through Windows emulation |
| Linux    | x64 | ✅ Stable | WebKitGTK or bundled CEF |
| Linux    | ARM64 | ✅ Stable | WebKitGTK or bundled CEF |

### Webview Engines
Electrobun supports both system webviews and bundled engines:

| Platform | System Webview | Bundled Option |
| -------- | -------------- | -------------- |
| macOS    | WebKit (WKWebView) | CEF (Chromium) - Optional |
| Windows  | WebView2 (Edge) | CEF (Chromium) - Optional |
| Linux    | WebKitGTK | CEF (Chromium) - Optional |
