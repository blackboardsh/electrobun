import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "photo-booth",
		identifier: "photobooth.electrobun.dev",
		version: "0.0.1",
	},
	build: {
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
			codesign: true,
			entitlements: {
				"com.apple.security.device.camera":
					"This app needs camera access to take photos for your photo booth",
			},
		},
		linux: {
			bundleCEF: true,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
