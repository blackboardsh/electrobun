import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const nativeRoot = join(import.meta.dirname, "../native");
const sharedRoot = join(nativeRoot, "shared");
const windowsSource = readFileSync(join(nativeRoot, "win/nativeWrapper.cpp"), "utf8");
const linuxSource = readFileSync(join(nativeRoot, "linux/nativeWrapper.cpp"), "utf8");
const behaviorSourcePath = join(sharedRoot, "cef_find_session_test.cpp");

function removeTemporaryDirectory(directory: string) {
	const delay = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			rmSync(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (process.platform !== "win32" || (code !== "EACCES" && code !== "EPERM")) {
				throw error;
			}
			Atomics.wait(delay, 0, 0, 100);
		}
	}
	rmSync(directory, { recursive: true, force: true });
}

function compileAndRunBehaviorProgram() {
	const directory = mkdtempSync(join(tmpdir(), "electrobun-cef-find-"));
	const executablePath = join(
		directory,
		process.platform === "win32" ? "cef_find_session_test.exe" : "cef_find_session_test",
	);

	try {
		const vendoredZig = join(import.meta.dirname, "../../vendors/zig/zig.exe");
		const compiler =
			process.env["CXX"] ||
			(process.platform === "win32" && existsSync(vendoredZig)
				? vendoredZig
				: process.platform === "win32"
					? "cl.exe"
					: "c++");
		const usesMsvc = basename(compiler).toLowerCase() === "cl.exe";
		const args = usesMsvc
			? [
						"/nologo",
						"/std:c++17",
						"/EHsc",
						`/I${sharedRoot}`,
						behaviorSourcePath,
						`/Fe${executablePath}`,
					]
			: [
						...(compiler === vendoredZig ? ["c++"] : []),
						"-std=c++17",
						"-Wall",
						"-Wextra",
						`-I${sharedRoot}`,
						behaviorSourcePath,
						"-o",
						executablePath,
					];
		const compileResult = spawnSync(compiler, args, {
			cwd: directory,
			encoding: "utf8",
		});
		expect(
			compileResult.status,
			`${compiler} failed:\n${compileResult.stdout}\n${compileResult.stderr}`,
		).toBe(0);

		const runCommand =
			process.platform === "win32"
				? process.env["ComSpec"] || "C:\\Windows\\System32\\cmd.exe"
				: executablePath;
		const runArgs =
			process.platform === "win32"
				? ["/d", "/c", executablePath]
				: [];
		const runResult = spawnSync(runCommand, runArgs, { encoding: "utf8" });
		expect(
			runResult.status,
			`CEF find session test failed:\n${runResult.stdout}\n${runResult.stderr}`,
		).toBe(0);
	} finally {
		removeTemporaryDirectory(directory);
	}
}

describe("CEF find session", () => {
	it("advances repeated searches and resets changed or stopped searches", () => {
		compileAndRunBehaviorProgram();
	});

	it("is used by the Windows and Linux CEF views", () => {
		for (const source of [windowsSource, linuxSource]) {
			expect(source).toContain('#include "../shared/cef_find_session.h"');
			expect(source).toContain("CefFindSession findSession;");
			expect(source).toContain(
				"const bool findNext = findSession.begin(searchText, matchCase);",
			);
			expect(source).toContain(
				"host->Find(CefString(searchText), forward, matchCase, findNext);",
			);
			expect(source).toContain("if (!findNext) {");
			expect(
				source.match(/findSession\.reset\(\);/g)?.length ?? 0,
			).toBeGreaterThanOrEqual(2);
			expect(source).not.toContain(
				"host->Find(CefString(searchText), forward, matchCase, false);",
			);
		}
	});
});
