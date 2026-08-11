import type { ElectrobunConfig } from "electrobun";

export default {
	electrobun: {
		version: "2.0.0",
	},
	app: {
		name: "zig-wgpu",
		identifier: "zigwgpu.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "zig",
		zig: {
			version: "0.16.0",
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
