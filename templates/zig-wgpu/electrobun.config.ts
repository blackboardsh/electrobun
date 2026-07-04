import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "zig-wgpu",
		identifier: "zigwgpu.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "zig",
		zig: {
			entrypoint: "src/zig/main.zig",
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
