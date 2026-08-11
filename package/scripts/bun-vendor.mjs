import { existsSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function readBunExecutableVersion(executable, spawn = spawnSync) {
	const result = spawn(executable, ["--version"], {
		encoding: "utf8",
		stdio: "pipe",
		shell: false,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${JSON.stringify(executable)} --version failed with ${result.signal ? `signal ${result.signal}` : `exit status ${result.status ?? 1}`}: ${String(result.stderr ?? "").trim()}`,
		);
	}
	const version = String(result.stdout ?? "").trim();
	if (!version) {
		throw new Error(`${JSON.stringify(executable)} --version returned no version`);
	}
	return version;
}

export function verifyBunExecutableVersion(
	executable,
	expectedVersion,
	runVersion = readBunExecutableVersion,
) {
	const actualVersion = runVersion(executable);
	if (actualVersion !== expectedVersion) {
		throw new Error(
			`Vendored Bun version mismatch: expected ${expectedVersion}, got ${JSON.stringify(actualVersion)}`,
		);
	}
	return actualVersion;
}

export function verifyAndRecordBunVendor({
	executable,
	marker,
	expectedVersion,
	runVersion = readBunExecutableVersion,
}) {
	verifyBunExecutableVersion(executable, expectedVersion, runVersion);
	writeFileSync(marker, expectedVersion);
}

export function acceptExistingBunVendor({
	executable,
	marker,
	expectedVersion,
	runVersion = readBunExecutableVersion,
	onRejected = (_error) => {},
}) {
	if (!existsSync(executable)) {
		rmSync(marker, { force: true });
		return false;
	}

	try {
		// The executable is authoritative. A marker is never accepted or repaired
		// until the binary itself reports the exact pinned version.
		verifyAndRecordBunVendor({
			executable,
			marker,
			expectedVersion,
			runVersion,
		});
		return true;
	} catch (error) {
		rmSync(executable, { force: true });
		rmSync(marker, { force: true });
		onRejected(error);
		return false;
	}
}
