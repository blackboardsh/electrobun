import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const zig =
	process.env["ZIG_BINARY"] ??
	join(packageRoot, "vendors", "zig", `zig${executableSuffix}`);
const source = join(
	packageRoot,
	"src",
	"native",
	"shared",
	"wayland_screen_capture_frame_test.cpp",
);

if (!existsSync(zig)) {
	throw new Error(`Vendored Zig was not found at ${zig}`);
}

const temporaryDirectory = mkdtempSync(
	join(tmpdir(), "electrobun-wayland-screen-capture-frame-"),
);
const binary = join(
	temporaryDirectory,
	`wayland-screen-capture-frame-test${executableSuffix}`,
);
const cleanupWaiter = new Int32Array(new SharedArrayBuffer(4));

function removeTemporaryDirectory(directory) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			rmSync(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = error?.code;
			if (
				process.platform !== "win32" ||
				!["EACCES", "EPERM", "EBUSY", "ENOTEMPTY"].includes(code)
			) {
				throw error;
			}
			if (attempt === 19) throw error;
			Atomics.wait(cleanupWaiter, 0, 0, 50 * (attempt + 1));
		}
	}
}

try {
	const compile = spawnSync(
		zig,
		["c++", "-std=c++17", source, "-o", binary],
		{ stdio: "inherit" },
	);
	if (compile.error) throw compile.error;
	if (compile.status !== 0) {
		throw new Error(
			`Wayland screen capture frame native test compilation exited with ${compile.status ?? 1}`,
		);
	}

	const test = spawnSync(binary, [], { stdio: "inherit" });
	if (test.error) throw test.error;
	if (test.status !== 0) {
		throw new Error(
			`Wayland screen capture frame native test exited with ${test.status ?? 1}`,
		);
	}
} finally {
	removeTemporaryDirectory(temporaryDirectory);
}
