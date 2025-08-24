---
sidebar_position: 3
title: Build Configuration
---

# Build Configuration

This guide covers all configuration options available in `electrobun.config` for building and distributing your Electrobun applications.

## Configuration File

Electrobun uses `electrobun.config.ts` in your project root to control how your application is built and packaged. The config file uses TypeScript with ESM syntax, providing type safety and modern JavaScript features.


### Basic Structure

```typescript title="electrobun.config.ts"
import { type ElectrobunConfig } from "electrobun";

const config: ElectrobunConfig = {
  app: {
    name: "MyApp",
    identifier: "com.example.myapp",
    version: "1.0.0",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
  },
};

export default config;
```

### Dynamic Configuration

TypeScript config files support dynamic configuration with full type safety:

```typescript title="electrobun.config.ts"
import { type ElectrobunConfig } from "electrobun";
import { readFileSync } from 'fs';

// Read version from package.json
const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));

const config: ElectrobunConfig = {
  app: {
    name: "MyApp",
    identifier: process.env.APP_ID || "com.example.myapp",
    version: packageJson.version,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      external: [],
    },
  },
  release: {
    bucketUrl: process.env.RELEASE_BUCKET_URL || "",
  },
};

export default config;
```

### Full example from the Electrobun Playground app

```typescript title="electrobun.config.ts"
import { type ElectrobunConfig } from "electrobun";

const config: ElectrobunConfig = {
    app: {
        name: "Electrobun (Playground)",
        identifier: "dev.electrobun.playground",
        version: "0.0.1",
    },
    build: {
        bun: {
            entrypoint: "src/bun/index.ts",
            external: [],
        },       
        views: {
            mainview: {
                entrypoint: "src/mainview/index.ts",
                external: [],
            },
            myextension: {
                entrypoint: "src/myextension/preload.ts",
                external: [],
            },
            webviewtag: {
                entrypoint: "src/webviewtag/index.ts",
                external: [],
            },
        },
        copy: {
            "src/mainview/index.html": "views/mainview/index.html",
            "src/mainview/index.css": "views/mainview/index.css",
            "src/webviewtag/index.html": "views/webviewtag/index.html",
            "src/webviewtag/electrobun.png": "views/webviewtag/electrobun.png",
            "assets/electrobun-logo-32-template.png": "views/assets/electrobun-logo-32-template.png",
        },
        mac: {
            codesign: true,
            notarize: true,
            bundleCEF: true,
            entitlements: {},
        },
        linux: {
            bundleCEF: true,
        },
        win: {
            bundleCEF: true,
        },
    },
    scripts: {
        postBuild: "./buildScript.ts",
    },
    release: {
        bucketUrl: "https://static.electrobun.dev/playground/",
    },
};

export default config;
```