import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Utils.quit exit codes", () => {
	test("returns the requested status outside the native host", () => {
		const directory = mkdtempSync(join(tmpdir(), "electrobun-quit-test-"));
		temporaryDirectories.push(directory);
		const fixture = join(directory, "quit.mjs");
		const utilsUrl = pathToFileURL(
			join(import.meta.dirname, "../core/Utils.ts"),
		).href;
		writeFileSync(fixture, `import { quit } from ${JSON.stringify(utilsUrl)};\nquit(7);\n`);

		const result = spawnSync(process.execPath, [fixture], {
			cwd: directory,
			encoding: "utf8",
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(7);
	});

	test("forwards the requested status to native graceful shutdown", () => {
		const source = readFileSync(
			join(import.meta.dirname, "../core/Utils.ts"),
			"utf8",
		);
		expect(source).toContain(
			"ffi.request.quitGracefully({ code, timeoutMs: 5000 });",
		);
		expect(source).toContain("quit(code ?? 0);");
	});
});
