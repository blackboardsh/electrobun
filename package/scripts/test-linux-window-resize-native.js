import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// An explicit GTK integration smoke, separate from the display-free unit suite.
// Run under Xvfb/Xephyr or an existing X11 display; it owns only its test window.
if (process.platform !== "linux" || !process.env.DISPLAY) {
	throw new Error("Linux window resize tests require Linux and an X11 DISPLAY.");
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, options);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} exited with ${result.status ?? result.signal}`);
	}
	return result;
}

const packageRoot = resolve(import.meta.dirname, "..");
const flags = run("pkg-config", ["--cflags", "--libs", "gtk+-3.0", "x11", "xext"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
}).stdout.trim().split(/\s+/);
const directory = mkdtempSync(join(tmpdir(), "electrobun-linux-window-resize-"));

try {
	const binary = join(directory, "window-resize-test");
	run(process.env.CXX ?? "c++", [
		"-std=c++17", "-Wall", "-Wextra", "-Werror",
		join(packageRoot, "src/native/linux/tests/window_resize_handles_test.cpp"),
		"-o", binary, ...flags,
	], { stdio: "inherit", timeout: 120_000 });
	run(binary, [], {
		stdio: "inherit",
		timeout: 30_000,
		env: { ...process.env, GDK_BACKEND: "x11", G_DEBUG: "fatal-warnings" },
	});
} finally {
	rmSync(directory, { recursive: true, force: true });
}
