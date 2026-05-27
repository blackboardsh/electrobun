---
title: "Bun API"
---

# Bun API

The Bun API is the main process API that manages your application's lifecycle, creates windows, handles system events, and provides the bridge between your UI and the operating system.Electrobun is just an npm dependency in your bun project. If you're just starting to look around take a look at the Getting Started Guide first to learn how to set up your first project.In Electrobun you simply write Typescript for the main process, when your app is all bundled up it will ship with a version of the bun runtime and it'll execute your main bun process with that, so any bun-compatible typescript is valid.You should explicitely import the `electrobun/bun` api for the main process:

```ts
const win = new Electrobun.BrowserWindow(/*...*/);

// or

const win = new BrowserWindow(/*...*/);

```
