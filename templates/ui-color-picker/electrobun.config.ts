import type { ElectrobunConfig } from "electrobun";

export default {
	electrobun: {
		version: "1.18.4-beta.25",
	},
	app: {
		name: "ui-color-picker",
		identifier: "ui-color-picker.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/main.ts",
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
