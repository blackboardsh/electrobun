#!/usr/bin/env node

import assert from "node:assert/strict";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "linux") {
	console.log("Linux adjacent extractor integration: skipped on non-Linux host");
	process.exit(0);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extractorRoot = join(packageRoot, "src", "extractor");
const zig = join(packageRoot, "vendors", "zig", "zig");
const zigZstd = join(packageRoot, "vendors", "zig-zstd", "zig-zstd");
const temporaryRoot = mkdtempSync(join(tmpdir(), "electrobun-extractor-e2e-"));

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
			{ cause: result.error },
		);
	}
	return result;
};

const identifier = "com.example.extractor-integration";
const home = join(temporaryRoot, "home");
const dataHome = join(temporaryRoot, "data");
mkdirSync(join(home, "Desktop"), { recursive: true });
mkdirSync(dataHome, { recursive: true });

try {
	run(zig, ["build"], { cwd: extractorRoot });
	const extractor = join(extractorRoot, "zig-out", "bin", "extractor");
	assert.equal(existsSync(extractor), true, "extractor build output is missing");

	for (const fixture of [
		{ channel: "production", artifact: "ArchiveApp", icon: true },
		{ channel: "canary", artifact: "ArchiveApp-canary", icon: false },
	]) {
		const fixtureRoot = join(temporaryRoot, `fixture-${fixture.channel}`);
		const innerRoot = join(fixtureRoot, "inner", fixture.artifact);
		const outerRoot = join(fixtureRoot, "outer", fixture.artifact);
		const innerBin = join(innerRoot, "bin");
		const innerResources = join(innerRoot, "Resources");
		const outerBin = join(outerRoot, "bin");
		const outerResources = join(outerRoot, "Resources");
		mkdirSync(innerBin, { recursive: true });
		mkdirSync(innerResources, { recursive: true });
		mkdirSync(outerBin, { recursive: true });
		mkdirSync(outerResources, { recursive: true });

		const installedLauncher = join(innerBin, "launcher");
		writeFileSync(
			installedLauncher,
			`#!/bin/sh\nprintf '%s\\n' '${fixture.channel}' > "$HOME/${fixture.channel}-launched"\n`,
		);
		chmodSync(installedLauncher, 0o755);

		writeFileSync(
			join(innerRoot, `${fixture.artifact}.desktop`),
			[
				"[Desktop Entry]",
				"Version=1.0",
				"Type=Application",
				`Name=Archive App${fixture.channel === "canary" ? " (Canary)" : ""}`,
				"Comment=Adjacent extractor integration fixture",
				"Exec=launcher",
				...(fixture.icon ? ["Icon=appIcon"] : []),
				"Terminal=false",
				`StartupWMClass=${fixture.artifact}`,
				"Categories=Utility;",
				"",
			].join("\n"),
		);
		if (fixture.icon) {
			writeFileSync(join(innerResources, "appIcon.png"), "fixture-icon");
		}

		const tarPath = join(fixtureRoot, `${fixture.channel}.tar`);
		const hash = `${fixture.channel}-hash`;
		const archivePath = join(outerResources, `${hash}.tar.zst`);
		run("tar", ["-cf", tarPath, "-C", join(fixtureRoot, "inner"), fixture.artifact]);
		run(zigZstd, [
			"compress",
			"-i",
			tarPath,
			"-o",
			archivePath,
			"--no-timing",
		]);
		writeFileSync(
			join(outerResources, "metadata.json"),
			JSON.stringify({
				identifier,
				name: "Archive App",
				channel: fixture.channel,
				hash,
			}),
		);
		copyFileSync(extractor, join(outerBin, "launcher"));
		chmodSync(join(outerBin, "launcher"), 0o755);

		run(join(outerBin, "launcher"), [], {
			cwd: temporaryRoot,
			env: {
				...process.env,
				HOME: home,
				XDG_DATA_HOME: dataHome,
				PATH: "/electrobun-test-no-helper-programs",
			},
		});
	}

	for (const fixture of [
		{ channel: "production", artifact: "ArchiveApp", icon: true },
		{ channel: "canary", artifact: "ArchiveApp-canary", icon: false },
	]) {
		const appRoot = join(dataHome, identifier, fixture.channel, "app");
		const launcher = join(appRoot, "bin", "launcher");
		const desktop = join(dataHome, "applications", `${fixture.artifact}.desktop`);
		assert.equal(existsSync(launcher), true);
		assert.equal(existsSync(desktop), true);
		const contents = readFileSync(desktop, "utf8");
		assert.equal(contents.includes(`Exec="${launcher}"`), true);
		assert.equal(contents.includes(`StartupWMClass=${fixture.artifact}`), true);
		if (fixture.icon) {
			const icon = join(appRoot, "Resources", "appIcon.png");
			assert.equal(contents.includes(`Icon=${icon}`), true);
			assert.equal(existsSync(icon), true);
		} else {
			assert.doesNotMatch(contents, /^Icon=/m);
		}

		const validation = spawnSync("desktop-file-validate", [desktop], {
			encoding: "utf8",
		});
		if (!validation.error) {
			assert.equal(validation.status, 0, validation.stderr || validation.stdout);
		}

		run(launcher, [], {
			env: { ...process.env, HOME: home },
		});
		assert.equal(
			readFileSync(join(home, `${fixture.channel}-launched`), "utf8").trim(),
			fixture.channel,
		);
	}

	console.log(
		"Linux adjacent extractor integration passed (production + canary, icon + no-icon)",
	);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
