import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "bun-ui",
		identifier: "bunui.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.tsx",
		},
		// bundleWGPU ships Dawn and the Electrobun UI engine; no webview needed
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
