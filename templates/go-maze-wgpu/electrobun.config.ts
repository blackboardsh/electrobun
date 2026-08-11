import type { ElectrobunConfig } from "electrobun";

export default {
	electrobun: {
		version: "1.18.4-beta.25",
	},
	app: {
		name: "go-maze-wgpu",
		identifier: "gomazewgpu.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "go",
		go: {
			package: "./src/go",
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
