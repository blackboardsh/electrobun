---
title: Bundling CEF
sidebar_label: Bundling CEF
---

# Bundling CEF (Chromium Embedded Framework)

Electrobun supports bundling CEF with your application for cross-platform consistency and advanced features. While the default system webview provides smaller bundle sizes, CEF ensures near-identical rendering and behavior across all platforms.

## Configuration

To bundle CEF with your application, configure the `build` property in your `electrobun.config.ts` file:

```typescript title="electrobun.config.ts"
import { type ElectrobunConfig } from "electrobun";

export const config: ElectrobunConfig = {
  build: {
    macos: {
      bundleCEF: true
    },
    win: {
      bundleCEF: true
    },
    linux: {
      bundleCEF: true
    }
  },
  // ... other configuration
};
```

## Platform Considerations

### Windows
On Windows the system renderer is Webview2, which is essentially the inner renderer of Edge, which is Chromium based. So on Windows when using the system webview you get a Chromium-based renderer that the system manages updates for which is great for bundle size and security. But there may be differences between the version of Webview2 on the user's system vs. what Electrobun's binaries are built against, and there may be a difference in Chromium version between a given user's system and Chromium api's you need and so bundling CEF may be still be beneficial to pin the version of Chromium you distribute by including it in the bundle.

### Linux
**Bundling CEF is strongly recommended on Linux** as the default GTKWebKit renderer doesn't support Electrobun's advanced layer compositing features. This means features like the `<electrobun-webview>` tag and complex window layering may not work correctly without CEF.

### Bundle Size Impact
When bundling CEF, your application's initial self-extracting bundle will increase to approximately **100MB** compared to ~14MB with system webviews. However, incremental updates remain small (as little as 14KB) thanks to Electrobun's differential update system.

## Using CEF Renderer

When CEF is bundled, you need to specify `renderer="cef"` when creating windows or webviews:

### BrowserWindow API

```typescript title="src/bun/index.ts"
import { BrowserWindow } from "electrobun/bun";

// Create a window using CEF renderer
const cefWindow = new BrowserWindow({
  width: 1200,
  height: 800,
  renderer: "cef",  // Specify CEF renderer
  url: "views://main/index.html"
});

// You can also create a window with system renderer (except on Linux)
const systemWindow = new BrowserWindow({
  width: 800,
  height: 600,
  renderer: "system",  // Use system webview
  url: "views://secondary/index.html"
});
```

### Electrobun Webview Tag

```html title="src/main/index.html"
<!-- Use CEF renderer for the webview -->
<electrobun-webview 
  src="https://example.com"
  renderer="cef"
  style="width: 100%; height: 500px;">
</electrobun-webview>

<!-- On platforms other than Linux, you can mix renderers -->
<electrobun-webview 
  src="https://example.org"
  renderer="system"
  style="width: 100%; height: 300px;">
</electrobun-webview>
```

## Mixed Renderer Support

### macOS and Windows
On macOS and Windows, when CEF is bundled, you can **mix and match renderers** within the same application:
- Some windows can use the system webview for smaller memory footprint
- Others can use CEF for consistency or advanced features
- Individual `<electrobun-webview>` tags can specify their preferred renderer

### Linux Limitation
**On Linux, renderer mixing is not supported.** The build process creates two separate Electrobun binaries:
- One for system webview (GTKWebKit)
- One for CEF

This means all your webviews on Linux must use the same renderer - either all CEF or all system webview. You cannot mix them within a single application instance.

## When to Bundle CEF

Consider bundling CEF when you need:

- **Consistent rendering** across all platforms  
- **Advanced compositing features** (especially on Linux)  
- **Latest Chromium features** not available in system webviews  
- **Predictable behavior** for complex web applications  
- **Full support for modern web standards**  

Consider using system webviews when you want:

- **Smallest possible bundle size** (~14MB vs ~100MB)  
- **Native platform integration** and appearance  
- **Lower memory usage** for simple applications  
- **Faster initial download** for users  

## Example: Platform-Specific Configuration

You can selectively bundle CEF for specific platforms:

```typescript title="electrobun.config.ts"
import { type ElectrobunConfig } from "electrobun";

export const config: ElectrobunConfig = {
  build: {
    macos: {
      bundleCEF: false  // Use system WebKit on macOS
    },
    win: {
      bundleCEF: true   // Use CEF on Windows for consistency
    },
    linux: {
      bundleCEF: true   // Required for advanced features on Linux
    }
  }
};
```

This configuration provides the best balance between bundle size and functionality for each platform.