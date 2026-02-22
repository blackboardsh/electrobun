import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "tray-app",
		identifier: "trayapp.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				src: "src/mainview",
			},
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
