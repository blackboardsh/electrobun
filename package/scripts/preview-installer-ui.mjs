#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extractorRoot = join(packageRoot, "src", "extractor");
const zig =
	process.env.ELECTROBUN_ZIG ||
	join(
		packageRoot,
		"vendors",
		"zig",
		process.platform === "win32" ? "zig.exe" : "zig",
	);

if (process.argv.includes("--help")) {
	console.log(`Usage: hutch preview:installer-ui [--error]

Builds the real extractor and previews its native installer UI without reading,
installing, or deleting an application payload. The normal preview animates all
installer phases, shows success, then opens the platform uninstall chooser with
explicit preview-only copy. --error displays the terminal failure state instead.`);
	process.exit(0);
}

const unknown = process.argv.slice(2).filter((argument) => argument !== "--error");
if (unknown.length !== 0) {
	console.error("Unknown preview argument: " + unknown.join(" "));
	process.exit(2);
}
if (!existsSync(zig)) {
	console.error(
		"Vendored Zig is missing at " +
			zig +
			". Set ELECTROBUN_ZIG to an explicit Zig executable.",
	);
	process.exit(1);
}

const step = process.argv.includes("--error")
	? "installer-ui-preview-error"
	: "installer-ui-preview";
const result = spawnSync(zig, ["build", step], {
	cwd: extractorRoot,
	env: process.env,
	stdio: "inherit",
	windowsHide: false,
});
if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
