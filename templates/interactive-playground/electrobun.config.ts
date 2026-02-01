import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Electrobun Interactive Playground",
		identifier: "dev.electrobun.interactive-playground",
		version: "0.0.1",
	},
	build: {
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "src/mainview/index.ts",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
			"assets/tray-icon.png": "views/assets/tray-icon.png",
		},
		mac: {
			codesign: true,
			notarize: false,
			bundleCEF: true,
			entitlements: {},
		},
		linux: {
			bundleCEF: true,
		},
		win: {
			bundleCEF: true,
		},
	},
} satisfies ElectrobunConfig;
