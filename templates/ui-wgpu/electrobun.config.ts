import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "ui-wgpu",
		identifier: "ui-wgpu.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "bun",
		bun: {
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
