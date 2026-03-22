import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "dcomp-demo",
		identifier: "dcomp-demo.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		useAsar: false,
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"src/assets": "assets",
		},
		watchIgnore: ["dist/**"],
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
