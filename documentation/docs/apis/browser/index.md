---
sidebar_position: 2
title: "Browser API"
---

These are apis you can use in the BrowserView browser context. If you're just starting to look around take a look at the [Getting Started Guide](/docs/guides/Getting%20Started/) first to learn how to set up your first project.

The Electrobun Browser api is not injected into browser contexts automatically. Instead you'll configure your `electrobun.config` file to use bun to build browser typescript code where you can write typescript. The cli will bundle the transpiled code with your app, and then you can use the `views://` scheme to load html and that bundled javascript or load it as `preload` script in a BrowserView.

While there's no need to use the Browser API at all in your BrowserViews if you want to establish rpc between browserview and bun or use other Electrobun apis in the browser you'll need to use it.

You should explicitly import the `electrobun/view` api in browser processes:

```typescript
import Electrobun from "electrobun/view";

// or

import {
  Electroview,
  // other specified imports
} from "electrobun/view";

const electrobun = new Electroview(/*...*/);
```
