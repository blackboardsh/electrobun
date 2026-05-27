---
title: "BuildConfig"
---

Access build-time configuration at runtime. This API provides information about how the application was built, including renderer settings.

```ts
// Or via the default export
const config = await Electrobun.BuildConfig.get();

```

## Overview
The `BuildConfig` API gives your Bun process access to configuration values that were set at build time in your `electrobun.config.ts`. This is useful for:

- Knowing which renderers are available in the current build

- Checking the default renderer configuration

- Conditional logic based on build settings

- Debugging and logging build information

## BuildConfig.get()
Asynchronously loads and returns the build configuration. The result is cached after the first call.

### Returns
`Promise<BuildConfigType>`

### BuildConfigType

<table>
<thead>
<tr>
<th>Property</th>
<th>Type</th>
<th>Description</th>
</tr>
</thead>
<tbody>
<tr>
<td>`defaultRenderer`</td>
<td>`'native' | 'cef'`</td>
<td>The default renderer for BrowserWindow and BrowserView when not explicitly specified</td>
</tr>
<tr>
<td>`availableRenderers`</td>
<td>`('native' | 'cef')[]`</td>
<td>List of renderers available in this build. Always includes `'native'`. Includes `'cef'` only if CEF was bundled.</td>
</tr>
<tr>
<td>`cefVersion`</td>
<td>`string | undefined`</td>
<td>The CEF version string used in this build (e.g., `"144.0.11+ge135be2+chromium-144.0.7559.97"`). Present only when CEF is bundled. Either the custom override from `electrobun.config.ts` or the default version shipped with the Electrobun release.</td>
</tr>
<tr>
<td>`bunVersion`</td>
<td>`string | undefined`</td>
<td>The Bun runtime version used in this build (e.g., `"1.3.8"`). Either the custom override from `electrobun.config.ts` or the default version shipped with the Electrobun release.</td>
</tr>
<tr>
<td>`runtime`</td>
<td>`object`</td>
<td>Runtime configuration from the `runtime` section of `electrobun.config.ts`. Includes `exitOnLastWindowClosed` and any custom keys you define.</td>
</tr>
</tbody>
</table>

### Example


```ts
const config = await BuildConfig.get();

console.log("Default renderer:", config.defaultRenderer);
// Output: "cef" or "native"

console.log("Available renderers:", config.availableRenderers);
// Output: ["native", "cef"] or ["native"]

// Check if CEF is available
if (config.availableRenderers.includes('cef')) {
  console.log("CEF is bundled with this app");
}

```

## BuildConfig.getCached()
Synchronously returns the cached build configuration, or `null` if it hasn't been loaded yet.

### Returns
`BuildConfigType | null`

### Example


```ts
// First, load the config (usually done at app startup)
await BuildConfig.get();

// Later, access it synchronously
const cached = BuildConfig.getCached();
if (cached) {
  console.log("Using renderer:", cached.defaultRenderer);
}

```

::: tip
**Note:** `getCached()` returns `null` if `get()` hasn't been called yet. In most cases, you should use `get()` which handles loading automatically.
:::


## How It Works
When you build your Electrobun app, the CLI reads your `electrobun.config.ts` and generates a `build.json` file in the app's Resources folder. This file contains the runtime-relevant build settings.The `BuildConfig` API reads this file and caches the result. The configuration includes:

- **defaultRenderer** - From the platform-specific `defaultRenderer` setting in your config

- **availableRenderers** - Determined by whether `bundleCEF` was enabled for the target platform

- **runtime** - The entire `runtime` section from your `electrobun.config.ts`, including `exitOnLastWindowClosed` and any custom keys

## Relationship with BrowserWindow/BrowserView
The `defaultRenderer` setting affects the default behavior of `BrowserWindow` and `BrowserView`:

```ts
// If defaultRenderer is 'cef' in your config:

// This window will use CEF (the configured default)
const window1 = new BrowserWindow({
  url: "views://main/index.html"
});

// This window explicitly uses native renderer
const window2 = new BrowserWindow({
  url: "views://settings/index.html",
  renderer: 'native'
});

```

See the [Build Configuration](/api/build-configuration) documentation for how to configure these settings.

## Complete Example


```ts
// Load and log build configuration at startup
const buildConfig = await BuildConfig.get();

console.log("Build Configuration:");
console.log("  Default Renderer:", buildConfig.defaultRenderer);
console.log("  Available Renderers:", buildConfig.availableRenderers.join(", "));

// Create windows - they'll use the configured default renderer
const mainWindow = new BrowserWindow({
  title: "My App",
  url: "views://main/index.html",
});

// If you need CEF-specific features, check availability first
if (buildConfig.availableRenderers.includes('cef')) {
  const cefWindow = new BrowserWindow({
    title: "CEF Window",
    url: "views://special/index.html",
    renderer: 'cef',
  });
}

```

