import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { electrobunViteAliases } from "../config/electrobun-vite";
import { ELECTROBUN_JAVASCRIPT_SDK_EXPORTS } from "./native-devkit-manifest";

describe("Electrobun Vite aliases", () => {
	test("map every public SDK export into the projected API", () => {
		const fixture = mkdtempSync(join(tmpdir(), "electrobun-vite-aliases-"));
		try {
			const devkitRoot = join(fixture, ".hutch", "devkit");
			mkdirSync(join(devkitRoot, "api"), { recursive: true });
			const exports = Object.fromEntries(
				Object.entries(ELECTROBUN_JAVASCRIPT_SDK_EXPORTS).map(
					([subpath, target]) => [subpath, `./${target}`],
				),
			);
			writeFileSync(
				join(devkitRoot, "package.json"),
				`${JSON.stringify({ exports })}\n`,
			);

			const aliases = electrobunViteAliases(devkitRoot);
			expect(aliases).toHaveLength(Object.keys(exports).length);
			for (const [subpath, target] of Object.entries(exports)) {
				const specifier =
					subpath === "." ? "electrobun" : `electrobun/${subpath.slice(2)}`;
				const alias = aliases.find(({ find }) => find.test(specifier));
				expect(alias?.replacement).toBe(join(devkitRoot, target));
				expect(alias?.replacement.startsWith(join(devkitRoot, "api"))).toBe(
					true,
				);
			}
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
});
