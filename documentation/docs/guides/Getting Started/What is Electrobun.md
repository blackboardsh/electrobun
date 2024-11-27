---
sidebar_position: 1
title: What is Electrobun
sidebar_label: 1. What is Electrobun
---

Electrobun aims to be a battery-included framework for building desktop apps with Typescript.

## Priorities

What makes electrobun different, aside from our approach to architecture are our project goals:

### Batteries included

- Write typescript without wasting time on devops
- Everything needed to build, test, codesign, update

### Iteration speed

- Building your app as fast as possible so you can iterate on features and fixes as fast as possible
- Enabling you to ship small, cost-effective updates (as small as 14KB) so you can ship new features and fixes to your end users and get feedback as fast and often as possible

### Affordable to maintain

- MIT open source
- Ship updates to your users that are tiny
- All you need is a file server (eg: S3) to distribute your app

### Flexible

- Use any modern framework for UI (from plain HTML, to Preact, SolidJS, and more)
- Use the built-in system Webview (or bundle a 3rd party webview like Chromium: _coming soon..._)

### Security and Performance

- Bun and Zig under the hood
- The main process and browser processes are isolated from each other
- Opt-in to enable fast, typed, and easy-to-extend RPC between main and browser processes
- A custom webview tag implementation for OOPIFs so you can build a web browser
