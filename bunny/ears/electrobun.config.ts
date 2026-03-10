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
      "carrot-charlie": {
        entrypoint: "../carrots/charlie/web/index.ts"
      },
      "carrot-forrager": {
        entrypoint: "../carrots/forrager/web/index.ts"
      }
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
      "../carrots/charlie/web/index.html": "views/carrot-charlie/index.html",
      "../carrots/charlie/web/index.css": "views/carrot-charlie/index.css",
      "../carrots/forrager/web/index.html": "views/carrot-forrager/index.html",
      "../carrots/forrager/web/index.css": "views/carrot-forrager/index.css",
      "../carrots/charlie/carrot.json": "carrots/charlie/carrot.json",
      "../carrots/charlie/worker.js": "carrots/charlie/worker.js",
      "../carrots/forrager/carrot.json": "carrots/forrager/carrot.json",
      "../carrots/forrager/worker.js": "carrots/forrager/worker.js"
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
