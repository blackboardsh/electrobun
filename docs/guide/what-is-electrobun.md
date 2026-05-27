---
title: "What is Electrobun?"
---

Electrobun is a desktop application framework that lets you build ultra fast, tiny, and cross-platform applications using TypeScript. It combines the best of native performance with web development simplicity.

## The Problem
Traditional desktop app frameworks force you to choose between developer experience and app performance:

- **Electron:** Great DX but huge bundle sizes (150MB+), slow startup times (2-5s), and massive update downloads

- **Native development:** Great performance but complex setup, platform-specific code, and limited web technology integration

- **Tauri:** Better than Electron but still large updates and you have to learn Rust

## The Solution
Electrobun provides a third option that doesn't compromise:

- **Ultra-small bundles:** ~14MB compressed (90%+ smaller than Electron)

- **Lightning-fast startup:** &lt;50ms cold start vs 2-5s for Electron

- **Tiny updates:** 14KB patches using custom binary diff vs 100MB+ with Electron

- **Pure TypeScript:** Write TypeScript for both main process and UI

- **Web technologies:** HTML, CSS, JavaScript - use any frontend framework

- **Native performance:** Zig bindings with Bun runtime for maximum speed

- **Optional CEF:** bundle CEF (Chromium) when cross-platform consistency matters most.

## Performance Comparison
  <table class="comparison-table">
    <thead>
      <tr>
<th>Metric</th>
<th>Electron</th>
<th>Tauri</th>
<th>Electrobun</th>
      </tr>
    </thead>
    <tbody>
      <tr>
<td>Bundle Size</td>
<td>150MB+</td>
<td>25MB</td>
<td class="metric">14MB</td>
      </tr>
      <tr>
<td>Update Size</td>
<td>100MB+</td>
<td>10MB</td>
<td class="metric">14KB</td>
      </tr>
      <tr>
<td>Startup Time</td>
<td>2-5s</td>
<td>500ms</td>
<td class="metric">&lt;50ms</td>
      </tr>
      <tr>
<td>Memory Usage</td>
<td>100-200MB</td>
<td>30-50MB</td>
<td class="metric">15-30MB</td>
      </tr>
    </tbody>
  </table>

## Technical Architecture
Electrobun achieves its performance through a carefully designed architecture:

### Zig, and Native Bindings
Native functionality like window management, system trays, and app menus writtin in C++ and Objc

### Bun Runtime
The main process runs on Bun, providing lightning-fast Typescript execution and built-in bundling without the overhead of Node.js and V8.

### System WebView
Instead of distributing Chromium, By default Electrobun uses your system's native WebView (WebKit on macOS, Edge WebView2 on Windows, WebKitGTK on Linux).

### Custom Update System
Binary diff updates using a SIMD optimized BSDIFF implementation written in zig to allow for incredibly small update patches - often just kilobytes instead of megabytes.

### ZSTD self-extracting distributables
The Electrobun cli bundles your app, then compresses it with state of the art compression making initial downloads as small as possible.

### Custom OOPIF Implementation
Use OOPIFs (super iframes) in your html for secure, isolated, webviews across browser engines and platforms.

## Key Benefits

### 🚀 Faster Development

- Fast build times - Electrobun cli uses pre-built binaries for your target platform

- Use any web framework (React, SolidJS, Vue, Svelte, etc.)

- TypeScript throughout - no context switching

- Built-in bundling and optimization

### 📦 Better Distribution

- 14MB bundles vs 150MB+ with Electron

- Kilobyte updates instead of megabyte downloads

- Built-in code signing and notarization

- Cross-platform builds from any OS

- Built-in ZSTD self-extractor

### ⚡ Superior Performance

- Sub-50ms startup times

- Minimal memory footprint

- Native-feeling UI responsiveness

- Battery-efficient operation

### 🔐 Security First

- Process isolation by default

- Secure, encrypted, and typed RPC between processes

- custom views:// schema for loading bundled assets in webviews

- Minimal attack surface

## When to Use Electrobun
Electrobun is perfect for:

- **Startup MVPs:** Ship fast, iterate quickly with small updates

- **Developer tools:** IDEs, terminals, productivity apps that need native performance

- **Cross-platform apps:** One codebase, native feel everywhere

- **High-performance apps:** When Electron is too slow but native development is too complex

- **Bandwidth-conscious apps:** Frequent updates without user friction

- **Multi-tab web browsers**Build multi-tab experiences and mix CEF and Webkit webviews

## Getting Started
Ready to build your first Electrobun app? Follow our [Hello World guide](/guide/hello-world) to create a new project in minutes.