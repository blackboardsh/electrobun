import type { ElectrobunConfig } from "electrobun";

export default {
	electrobun: {
		version: "2.0.0",
	},
	app: {
		name: "wgpu",
		identifier: "wgpu.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/bun/index.ts",
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
