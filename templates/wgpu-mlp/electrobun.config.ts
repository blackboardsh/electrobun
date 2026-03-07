import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "wgpu-mlp",
    identifier: "wgpu-mlp.electrobun.dev",
    version: "0.0.1",
  },
  build: {
    useAsar: false,
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
    },
    mac: {
      bundleCEF: false,
      bundleWGPU: true,
    },
    linux: {
      bundleCEF: false,
      bundleWGPU: true,
    },
    win: {
      bundleCEF: false,
      bundleWGPU: true,
    },
  },
} satisfies ElectrobunConfig;
