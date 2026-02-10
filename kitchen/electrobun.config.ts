import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Electrobun Kitchen Sink",
		identifier: "sh.blackboard.electrobun-kitchen",
		version: "1.12.3",
		urlSchemes: ["electrobun-playground"],
	},
	runtime: {
		// exitOnLastWindowClosed: false,
	},
	build: {
		useAsar: true,
		// cefVersion: "144.0.12+g1a1008c+chromium-144.0.7559.110",
		// bunVersion: "1.3.7",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			"test-runner": {
				entrypoint: "src/test-runner/index.ts",
				minify: true,
			},
			"test-harness": {
				entrypoint: "src/test-harness/index.ts",
			},
			"playgrounds/file-dialog": {
				entrypoint: "src/playgrounds/file-dialog/index.ts",
			},
			"playgrounds/tray": {
				entrypoint: "src/playgrounds/tray/index.ts",
			},
			"playgrounds/shortcuts": {
				entrypoint: "src/playgrounds/shortcuts/index.ts",
			},
			"playgrounds/clipboard": {
				entrypoint: "src/playgrounds/clipboard/index.ts",
			},
			"playgrounds/host-message": {
				entrypoint: "src/playgrounds/host-message/index.ts",
			},
			"playgrounds/session": {
				entrypoint: "src/playgrounds/session/index.ts",
			},
			"playgrounds/draggable": {
				entrypoint: "src/playgrounds/draggable/index.ts",
			},
			"playgrounds/application-menu": {
				entrypoint: "src/playgrounds/application-menu/index.ts",
			},
			"playgrounds/context-menu": {
				entrypoint: "src/playgrounds/context-menu/index.ts",
			},
			"playgrounds/webviewtag": {
				entrypoint: "src/playgrounds/webviewtag/index.ts",
			},
			"playgrounds/window-events": {
				entrypoint: "src/playgrounds/window-events/index.ts",
			},
			"playgrounds/custom-titlebar": {
				entrypoint: "src/playgrounds/custom-titlebar/index.ts",
			},
			"playgrounds/transparent-window": {
				entrypoint: "src/playgrounds/transparent-window/index.ts",
			},
			"playgrounds/multiwindow-cef": {
				entrypoint: "src/playgrounds/multiwindow-cef/index.ts",
			},
			"playgrounds/quit-test": {
				entrypoint: "src/playgrounds/quit-test/index.ts",
			},
		},
		copy: {
			"src/test-runner/index.html": "views/test-runner/index.html",
			"src/test-runner/index.css": "views/test-runner/index.css",
			"src/test-harness/index.html": "views/test-harness/index.html",
			"src/test-oopif/index.html": "views/test-oopif/index.html",
			"src/playgrounds/file-dialog/index.html":
				"views/playgrounds/file-dialog/index.html",
			"src/playgrounds/file-dialog/index.css":
				"views/playgrounds/file-dialog/index.css",
			"src/playgrounds/tray/index.html": "views/playgrounds/tray/index.html",
			"src/playgrounds/tray/index.css": "views/playgrounds/tray/index.css",
			"src/playgrounds/shortcuts/index.html":
				"views/playgrounds/shortcuts/index.html",
			"src/playgrounds/shortcuts/index.css":
				"views/playgrounds/shortcuts/index.css",
			"src/playgrounds/clipboard/index.html":
				"views/playgrounds/clipboard/index.html",
			"src/playgrounds/clipboard/index.css":
				"views/playgrounds/clipboard/index.css",
			"src/playgrounds/host-message/index.html":
				"views/playgrounds/host-message/index.html",
			"src/playgrounds/session/index.html":
				"views/playgrounds/session/index.html",
			"src/playgrounds/session/counter.html":
				"views/playgrounds/session/counter.html",
			"src/playgrounds/draggable/index.html":
				"views/playgrounds/draggable/index.html",
			"src/playgrounds/application-menu/index.html":
				"views/playgrounds/application-menu/index.html",
			"src/playgrounds/application-menu/index.css":
				"views/playgrounds/application-menu/index.css",
			"src/playgrounds/context-menu/index.html":
				"views/playgrounds/context-menu/index.html",
			"src/playgrounds/context-menu/index.css":
				"views/playgrounds/context-menu/index.css",
			"src/playgrounds/webviewtag/index.html":
				"views/playgrounds/webviewtag/index.html",
			"src/playgrounds/webviewtag/host-message-test.html":
				"views/playgrounds/webviewtag/host-message-test.html",
			"src/playgrounds/webviewtag/electrobun.png":
				"views/playgrounds/webviewtag/electrobun.png",
			"assets/electrobun-logo-32-template.png":
				"views/assets/electrobun-logo-32-template.png",
			"src/playgrounds/window-events/index.html":
				"views/playgrounds/window-events/index.html",
			"src/playgrounds/custom-titlebar/index.html":
				"views/playgrounds/custom-titlebar/index.html",
			"src/playgrounds/transparent-window/index.html":
				"views/playgrounds/transparent-window/index.html",
			"src/playgrounds/multiwindow-cef/index.html":
				"views/playgrounds/multiwindow-cef/index.html",
			"src/playgrounds/quit-test/index.html":
				"views/playgrounds/quit-test/index.html",
			"src/playgrounds/quit-test/index.css":
				"views/playgrounds/quit-test/index.css",
		},
		mac: {
			codesign: true,
			notarize: true,
			bundleCEF: true,
			entitlements: {},
			chromiumFlags: {
				// "show-paint-rects": true,
				// "show-composited-layer-borders": true,
				"user-agent": "BarkusAurelius/1.0 (Macintosh; powered by bunnies)",
			},
		},
		linux: {
			bundleCEF: true,
			icon: "icon.iconset/icon_256x256.png",
			chromiumFlags: {
				// "show-paint-rects": true,
				// "show-composited-layer-borders": true,
				"user-agent": "BarkusAurelius/1.0 (Macintosh; powered by bunnies)",
			},
		},
		win: {
			bundleCEF: true,
			icon: "icon.iconset/icon_256x256.png",
			chromiumFlags: {
				// "show-paint-rects": true,
				// "show-composited-layer-borders": true,
				"user-agent": "BarkusAurelius/1.0 (Macintosh; powered by bunnies)",
			},
		},
	},
	scripts: {
		postBuild: "./buildScript.ts",
	},
	release: {
		baseUrl: "https://electrobun-kitchen.blackboard.sh/",
		generatePatch: true,
	},
} satisfies ElectrobunConfig;
