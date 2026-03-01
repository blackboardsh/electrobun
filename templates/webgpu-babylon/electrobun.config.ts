import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "webgpu-babylon",
    identifier: "webgpu-babylon.electrobun.dev",
    version: "0.0.1",
  },
  build: {
    useAsar: false,
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "src/assets": "assets",
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
