import Electrobun, { app, BuildConfig } from "electrobun/main";
import { defineTest, expect } from "../test-framework/types";

export const runtimeTests = [
 defineTest({
   name: "Packaged JavaScript runtime matches the selected main process",
   category: "Runtime",
   description: "A Bun build must run real Bun, not a compatibility runtime.",
   async run({ log }) {
     const config = await BuildConfig.get();
     const cottontail = process.versions["cottontail"];
     if ((config.mainProcess ?? "bun") === "bun") {
       expect(typeof process.versions.bun).toBe("string");
       expect(cottontail === undefined).toBe(true);
     } else if (config.mainProcess === "cottontail") {
       expect(typeof cottontail).toBe("string");
     }
     log(`runtime: ${cottontail ? "cottontail " + cottontail : "bun " + process.versions.bun}`);
   },
 }),
	defineTest({
		name: "App packaged mode reflects build channel",
		category: "Runtime",
		description:
			"Use packaged build metadata rather than NODE_ENV to identify development builds.",
		async run({ log }) {
			const config = await BuildConfig.get();
			expect(["dev", "canary", "stable"].includes(config.channel)).toBe(
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
