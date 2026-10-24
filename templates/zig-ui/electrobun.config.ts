import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "zig-ui",
		identifier: "zigui.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "zig",
		zig: {
			version: "0.17.0",
		},
		// bundleWGPU ships Dawn and, on macOS, the Electrobun UI runtime files
		mac: {
			bundleCEF: false,
			bundleWGPU: true,
		},
	},
} satisfies ElectrobunConfig;
