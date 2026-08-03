import Electrobun, { app, BuildConfig } from "electrobun/main";
import { defineTest, expect } from "../test-framework/types";

export const runtimeTests = [
	defineTest({
		name: "App packaged mode reflects build channel",
		category: "Runtime",
		description:
			"Use packaged build metadata rather than NODE_ENV to identify development builds.",
		async run({ log }) {
			const config = await BuildConfig.get();
			expect(["dev", "canary", "production"].includes(config.channel)).toBe(
				true,
			);
			expect(config.isPackaged).toBe(config.channel !== "dev");
			expect(app.isPackaged).toBe(config.isPackaged);
			expect(Electrobun.app.isPackaged).toBe(config.isPackaged);
			log(
				`channel=${config.channel}, isPackaged=${String(config.isPackaged)}`,
			);
		},
	}),
];
