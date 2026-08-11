import type { ElectrobunConfig } from "electrobun";

export default {
	electrobun: {
		version: "2.0.0",
	},
	app: {
		name: "ui-wgpu",
		identifier: "ui-wgpu.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/main.tsx",
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
