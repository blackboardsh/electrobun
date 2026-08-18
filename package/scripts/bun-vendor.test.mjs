import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	acceptExistingBunVendor,
	readBunExecutableVersion,
	verifyAndRecordBunVendor,
	verifyBunExecutableVersion,
} from "./bun-vendor.mjs";

const expectedVersion = "1.3.13";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "electrobun-bun-vendor-"));
	const executable = join(root, process.platform === "win32" ? "bun.exe" : "bun");
	const marker = join(root, ".bun-version");
	writeFileSync(executable, "placeholder executable");
	return { root, executable, marker };
}

test("executes an exact existing Bun before creating a missing marker", () => {
	const paths = fixture();
	const calls = [];
	try {
		assert.equal(
			acceptExistingBunVendor({
				...paths,
				expectedVersion,
				runVersion(executable) {
					calls.push(executable);
					return expectedVersion;
				},
			}),
			true,
		);
		assert.deepEqual(calls, [paths.executable]);
		assert.equal(readFileSync(paths.marker, "utf8"), expectedVersion);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("rejects a wrong binary even when its marker is missing or exact", () => {
	for (const marker of [undefined, expectedVersion]) {
		const paths = fixture();
		if (marker) writeFileSync(paths.marker, marker);
		try {
			assert.equal(
				acceptExistingBunVendor({
					...paths,
					expectedVersion,
					runVersion: () => "1.3.12",
				}),
				false,
			);
			assert.equal(existsSync(paths.executable), false);
			assert.equal(existsSync(paths.marker), false);
		} finally {
			rmSync(paths.root, { recursive: true, force: true });
		}
	}
});

test("repairs a stale marker only after executing the exact binary", () => {
	const paths = fixture();
	writeFileSync(paths.marker, "stale");
	let executions = 0;
	try {
		assert.equal(
			acceptExistingBunVendor({
				...paths,
				expectedVersion,
				runVersion: () => {
					executions += 1;
					return expectedVersion;
				},
			}),
			true,
		);
		assert.equal(executions, 1);
		assert.equal(readFileSync(paths.marker, "utf8"), expectedVersion);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("does not publish a marker for a mismatched downloaded executable", () => {
	const paths = fixture();
	try {
		assert.throws(
			() =>
				verifyAndRecordBunVendor({
					...paths,
					expectedVersion,
					runVersion: () => "0.0.0",
				}),
			/Vendored Bun version mismatch/,
		);
		assert.equal(existsSync(paths.marker), false);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("runs --version without a shell and preserves executable paths", () => {
	const executable = join(tmpdir(), "Bun Runtime With Spaces", "bun");
	let invocation;
	const version = readBunExecutableVersion(executable, (command, args, options) => {
		invocation = { command, args, options };
		return { status: 0, stdout: `${expectedVersion}\n`, stderr: "" };
	});

	assert.equal(version, expectedVersion);
	assert.equal(invocation.command, executable);
	assert.deepEqual(invocation.args, ["--version"]);
	assert.equal(invocation.options.windowsHide, true);
	assert.equal(invocation.options.shell, false);
});

test("rejects a Bun executable when --version exits unsuccessfully", () => {
	assert.throws(
		() =>
			verifyBunExecutableVersion("bun", expectedVersion, (executable) =>
				readBunExecutableVersion(executable, () => ({
					status: 7,
					stdout: "",
					stderr: "could not start Bun",
				})),
			),
		/exit status 7: could not start Bun/,
	);
});

test("executes the selected binary on every supported host", () => {
	assert.equal(readBunExecutableVersion(process.execPath), process.version);
});

test("build verifies the downloaded and staged Bun before manifest emission", () => {
	const buildSource = readFileSync(new URL("../build.ts", import.meta.url), "utf8");
	const vendorStart = buildSource.indexOf("async function vendorBun()");
	const vendorEnd = buildSource.indexOf("function verifyVendoredZig()", vendorStart);
	const manifestStart = buildSource.indexOf(
		"const nativeDevkitManifest = createNativeDevkitManifest",
	);
	assert.notEqual(vendorStart, -1);
	assert.notEqual(vendorEnd, -1);
	assert.notEqual(manifestStart, -1);
	assert.match(
		buildSource.slice(vendorStart, vendorEnd),
		/verifyAndRecordBunVendor\(\{/,
	);
	const vendorSource = buildSource.slice(vendorStart, vendorEnd);
	const downloadedVerification = vendorSource.indexOf(
		"verifyBunExecutableVersion(extractedBinary, BUN_VERSION)",
	);
	const atomicInstall = vendorSource.indexOf(
		"renameSync(extractedBinary, PATH.bun.RUNTIME)",
	);
	const markerPublication = vendorSource.lastIndexOf(
		"verifyAndRecordBunVendor({",
	);
	assert.match(vendorSource, /mkdtempSync\(join\(bunDir, "\.bun-download-"\)\)/);
	assert.ok(downloadedVerification !== -1);
	assert.ok(downloadedVerification < atomicInstall);
	assert.ok(atomicInstall < markerPublication);
	const stagedVerification = buildSource.indexOf(
		"verifyBunExecutableVersion(PATH.bun.DIST, BUN_VERSION)",
	);
	assert.ok(stagedVerification !== -1 && stagedVerification < manifestStart);
});

test("Windows uninstaller integration exercises the native update-refresh worker", () => {
	const integrationSource = readFileSync(
		new URL("./test-windows-uninstaller.mjs", import.meta.url),
		"utf8",
	);

	assert.match(integrationSource, /const refreshStage = join\(/);
	assert.match(
		integrationSource,
		/"electrobun-uninstall-refresh-" \+ randomBytes\(16\)\.toString\("hex"\) \+ "\.exe"/,
	);
	assert.match(integrationSource, /copyFileSync\(extractor, refreshStage\)/);
	assert.match(
		integrationSource,
		/\["--refresh-registration-from-update", paths\.root, "--quiet"\]/,
	);
	assert.match(integrationSource, /"temporary update-refresh manager cleanup"/);
	assert.doesNotMatch(integrationSource, /createWindowsRegistrationRefreshBatch/);
});
