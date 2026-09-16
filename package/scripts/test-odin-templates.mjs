#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, "..");
const templatesRoot = join(repositoryRoot, "templates");
const odinBinary = join(
	packageRoot,
	"vendors",
	"odin",
	process.platform === "win32" ? "odin.exe" : "odin",
);

if (!existsSync(odinBinary)) {
	throw new Error(
		`Vendored Odin compiler not found at ${odinBinary}. Run the package setup/build first.`,
	);
}

function templateTestPackages() {
	return readdirSync(templatesRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("odin-"))
		.map((entry) => ({
			name: entry.name,
			source: join(templatesRoot, entry.name, "src", "odin"),
		}))
		.filter(
			(template) =>
				existsSync(template.source) &&
				readdirSync(template.source).some((file) => file.endsWith("_test.odin")),
		)
		.sort((left, right) => left.name.localeCompare(right.name));
}

function resolveSdkCollection() {
	const builtCollection = join(packageRoot, "dist", "odin-sdk");
	if (
		existsSync(join(builtCollection, "electrobun", "electrobun.odin"))
	) {
		return { path: builtCollection, cleanup: null };
	}

	const sourceSdk = join(packageRoot, "src", "sdks", "odin", "electrobun.odin");
	if (!existsSync(sourceSdk)) {
		throw new Error(`Electrobun Odin SDK source not found at ${sourceSdk}`);
	}

	const stagingRoot = mkdtempSync(join(tmpdir(), "electrobun-odin-tests-"));
	const packageDirectory = join(stagingRoot, "electrobun");
	mkdirSync(packageDirectory, { recursive: true });
	copyFileSync(sourceSdk, join(packageDirectory, "electrobun.odin"));
	return { path: stagingRoot, cleanup: stagingRoot };
}

function removeTemporaryDirectory(path) {
	try {
		rmSync(path, {
			recursive: true,
			force: true,
			maxRetries: 40,
			retryDelay: 250,
		});
	} catch (error) {
		// Windows scanners can retain the generated test executable after Odin
		// exits. It lives under the OS temp directory, never in the worktree.
		if (process.platform === "win32" && error?.code === "EPERM") return;
		throw error;
	}
}

const tests = templateTestPackages();
if (tests.length === 0) {
	throw new Error("No Odin template test packages were found");
}

const sdkCollection = resolveSdkCollection();
const executionRoot = mkdtempSync(join(tmpdir(), "electrobun-odin-run-"));
try {
	for (const test of tests) {
		console.log(`Testing ${test.name}...`);
		const result = spawnSync(
			odinBinary,
			[
				"test",
				test.source,
				`-collection:electrobun_sdk=${sdkCollection.path}`,
			],
			{ cwd: executionRoot, stdio: "inherit" },
		);
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(
				`${test.name} Odin tests failed with exit code ${result.status ?? "unknown"}`,
			);
		}
	}
} finally {
	if (sdkCollection.cleanup) {
		removeTemporaryDirectory(sdkCollection.cleanup);
	}
	removeTemporaryDirectory(executionRoot);
}

console.log(`Odin template tests passed (${tests.length} packages).`);
