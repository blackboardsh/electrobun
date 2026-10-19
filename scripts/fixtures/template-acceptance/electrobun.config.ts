import type { ElectrobunConfig } from "electrobun";

export default {
	app: { name: "template-acceptance", identifier: "dev.electrobun.template-acceptance", version: "0.0.1" },
	build: {
		mainProcess: "cottontail",
		cottontail: { entrypoint: "src/bun/index.ts", capabilities: ["hashing"] },
		views: { mainview: { entrypoint: "src/mainview/index.ts" } },
		copy: { "src/mainview/index.html": "views/mainview/index.html" },
		mac: { bundleCEF: false, bundleWGPU: false, codesign: false, notarize: false },
		win: { bundleCEF: false, bundleWGPU: false },
		linux: { bundleCEF: false, bundleWGPU: false },
	},
} satisfies ElectrobunConfig;
