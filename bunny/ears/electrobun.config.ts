import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Bunny Ears",
    identifier: "dev.electrobun.bunny-ears",
    version: "0.0.1"
  },
  runtime: {
    exitOnLastWindowClosed: false
  },
  build: {
    wgpuVersion: "0.2.3",
    bun: {
      entrypoint: "src/bun/index.ts"
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts"
      },
      "carrot-sdk-view": {
        entrypoint: "src/carrot-runtime/view.ts"
      }
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
      "src/carrot-runtime/bun.ts": "carrot-runtime/bun.ts"
    },
    mac: {
      createDmg: false,
      bundleCEF: false,
      bundleWGPU: true
    },
    linux: {
      bundleCEF: false,
      bundleWGPU: true
    },
    win: {
      bundleCEF: false,
      bundleWGPU: true
    }
  }
} satisfies ElectrobunConfig;
