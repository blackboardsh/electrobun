import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

/** Keep the producer's canonical document readable by already-installed native
 * clients whose typed JSON parser rejects unrecognized fields. */
export function inspectLifecycleChecksum(root, prefix, metadata, tarIdentity, label) {
	assert.deepEqual(new Set(Object.keys(metadata)), new Set([
		"schemaVersion", "identifier", "channel", "version", "hash", "platform", "arch", "artifact",
	]), `${label} canonical metadata must preserve the legacy field set`);
	assert.deepEqual(new Set(Object.keys(metadata.artifact || {})), new Set(["file"]),
		`${label} canonical artifact metadata must preserve the legacy field set`);
	assert.match(metadata.hash, /^[a-z0-9]{1,13}$/, `${label} metadata hash`);
	const checksumPath = join(root, `${prefix}-${metadata.hash}-checksum.json`);
	assert.deepEqual(new Set(readdirSync(root).filter(name => name.endsWith("-checksum.json"))),
		new Set([basename(checksumPath)]), `${label} checksum sidecar names`);
	const checksum = JSON.parse(readFileSync(checksumPath, "utf8"));
	assert.deepEqual(new Set(Object.keys(checksum)), new Set(["tarSha256", "tarSize"]),
		`${label} checksum sidecar must not duplicate release metadata`);
	assert.match(checksum.tarSha256, /^[0-9a-f]{64}$/, `${label} exact tar digest`);
	assert.equal(Number.isSafeInteger(checksum.tarSize) && checksum.tarSize > 0, true, `${label} exact tar size`);
	assert.deepEqual({ sha256: checksum.tarSha256, size: checksum.tarSize }, tarIdentity,
		`${label} checksum integrity differs from CI archive`);
	return { checksumPath, checksum };
}

/** Payloads and their immutable checksum precede the mutable update pointer.
 * An older producer is represented by an absent checksum, not another schema. */
export function publishLifecycleReleaseFiles(release, serverRoot, options = {}) {
	mkdirSync(serverRoot, { recursive: true });
	copyFileSync(release.archivePath, join(serverRoot, basename(release.archivePath)));
	if (options.includePatch !== false && release.patchPath) {
		copyFileSync(release.patchPath, join(serverRoot, basename(release.patchPath)));
	}
	const checksumPath = join(serverRoot, basename(release.checksumPath));
	if (options.includeIntegrity === false) rmSync(checksumPath, { force: true });
	else copyFileSync(release.checksumPath, checksumPath);
	copyFileSync(release.updatePath, join(serverRoot, basename(release.updatePath)));
}
