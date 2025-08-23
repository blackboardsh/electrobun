---
sidebar_position: 1
title: "Bun API"
---

These are apis you can use in the main bun process. Electrobun is just an npm dependency in your bun project. If you're just starting to look around take a look at the [Getting Started Guide](/docs/guides/getting-started) first to learn how to set up your first project.

In Electrobun you simply write Typescript for the main process, when your app is all bundled up it will ship with a version of the bun runtime and it'll execute your main bun process with it, so any bun-compatible typescript is valid.

You should explicitely import the `electrobun/bun` api for the main process:

```typescript
import Electrobun from "electrobun/bun";

const win = new Electrobun.BrowserWindow(/*...*/);

// or

import {
  BrowserWindow,
  ApplicationMenu,
  // other specified imports
} from "electrobun/bun";

const win = new BrowserWindow(/*...*/);
```
