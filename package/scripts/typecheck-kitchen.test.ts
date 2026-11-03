import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkKitchenTypes } from "./typecheck-kitchen";

test("Kitchen preflight checks included test files against source exports without a built devkit", () => {
	const root = mkdtempSync(join(tmpdir(), "kitchen-typecheck-"));
	const write = (path: string, source: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, source);
	};
	try {
		write(join(root, "kitchen/tsconfig.json"), JSON.stringify({
			extends: "./.hutch/devkit/tsconfig.json",
			compilerOptions: {
				target: "ESNext", module: "ESNext", moduleResolution: "bundler",
				strict: true, noEmit: true, skipLibCheck: true, types: [],
			},
			include: ["src/**/*"], exclude: ["src/tests"],
		}));
		write(join(root, "package/src/sdks/main/entries/updater.ts"), "export const version = 'current';\n");
		const fixture = join(root, "kitchen/src/test-framework/timer.test.ts");
		write(fixture, "import { version } from 'electrobun/main/updater';\nconst text: string = version;\nvoid text;\n");
		write(join(root, "kitchen/src/tests/excluded.ts"), "const broken: number = 'excluded';\n");
		expect(checkKitchenTypes(root)).toEqual([]);

		// Test files are part of Kitchen's actual compilation, even when Bun's
		// runtime tests pass. An SDK-source type change must also be observed.
		write(join(root, "package/src/sdks/main/entries/updater.ts"), "export const version = 12;\n");
		const errors = checkKitchenTypes(root);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.code).toBe(2322);
		expect(errors[0]?.file?.fileName).toBe(fixture.replaceAll("\\", "/"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
