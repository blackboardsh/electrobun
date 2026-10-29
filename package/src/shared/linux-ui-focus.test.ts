import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// The VM suite installs Xvfb; use a separate display so this test neither
// changes the user's focus nor depends on the desktop's window manager.
const hasXvfb = process.platform === "linux" && spawnSync("which", ["xvfb-run"]).status === 0;
test.skipIf(!hasXvfb)("Linux native UI ignores stale focus events from another toplevel (Xvfb)", () => {
	const scratch = mkdtempSync(join(tmpdir(), "electrobun-ui-focus-"));
	try {
		const binary = join(scratch, "ui-focus-test");
		const fixture = join(import.meta.dirname, "../native/linux/ui_focus_test.cpp");
		const compile = spawnSync(process.env["CXX"] || "c++", [
			"-std=c++17", "-Wall", "-Wextra", "-Werror", fixture, "-lX11", "-o", binary,
		], { encoding: "utf8", timeout: 30_000 });
		expect(compile.status, `${compile.error?.message ?? ""}\n${compile.stderr}`).toBe(0);
		const run = spawnSync("xvfb-run", ["-a", binary], { encoding: "utf8", timeout: 10_000 });
		expect(run.status, `${run.error?.message ?? ""}\n${run.stderr}`).toBe(0);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 45_000);
