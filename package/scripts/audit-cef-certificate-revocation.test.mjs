import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	auditChromiumSources,
	CHROMIUM_AUDIT_FILES,
	EMSIGN_COMPROMISED_SPKIS,
	parseBuiltinSpkis,
} from "./audit-cef-certificate-revocation.mjs";

const crlSetFixture = `
#include "net/cert/cert_verify_proc_blocklist.inc"
for (const auto& hash : kSPKIBlockList) {
  crl_set->blocked_spkis_.emplace_back(reinterpret_cast<const char*>(hash), 32);
}
scoped_refptr<CRLSet> CRLSet::BuiltinCRLSet() {
  constexpr char kCRLSet[] = "\\x31\\x00{\\\"ContentType\\\":\\\"CRLSet\\\"}";
  scoped_refptr<CRLSet> ret;
  bool parsed = CRLSet::Parse(kCRLSet, &ret);
  return ret;
}
`;

function blocklistFixture(hashes) {
	return `static constexpr uint8_t kSPKIBlockList[][crypto::hash::kSha256Size] = {
${hashes.map(hash => `  {${hash.match(/../g).map(byte => `0x${byte}`).join(", ")}},`).join("\n")}
};
// This separate interception list must not count as a revocation.
static constexpr uint8_t kKnownInterceptionList[][32] = {
  {${"ff".repeat(32).match(/../g).map(byte => `0x${byte}`).join(", ")}}
};
`;
}

function sourceFixture(hashes) {
	return {
		[CHROMIUM_AUDIT_FILES[0]]: crlSetFixture,
		[CHROMIUM_AUDIT_FILES[1]]: blocklistFixture(hashes),
	};
}

test("distinguishes all eight blocked keys from unrelated and missing entries", () => {
	const blocked = parseBuiltinSpkis(blocklistFixture(EMSIGN_COMPROMISED_SPKIS));
	assert.equal(blocked.size, 8);
	assert.equal(blocked.has("ff".repeat(32)), false);
	const complete = auditChromiumSources("156.0.8078.17", sourceFixture(EMSIGN_COMPROMISED_SPKIS));
	assert.equal(complete.status, "static-key-distrust-present");
	assert.deepEqual(complete.missingSpkis, []);
	const incomplete = auditChromiumSources("156.0.8078.17", sourceFixture(EMSIGN_COMPROMISED_SPKIS.slice(1)));
	assert.equal(incomplete.status, "missing-static-key-distrust");
	assert.deepEqual(incomplete.missingSpkis, [EMSIGN_COMPROMISED_SPKIS[0]]);
});

test("fails closed when static entries or their CRLSet integration cannot be parsed", () => {
	assert.throws(() => parseBuiltinSpkis("// kSPKIBlockList contains every blocked key"), /Unsupported/);
	assert.throws(() => parseBuiltinSpkis(blocklistFixture(["00"])), /Malformed SHA-256/);
	assert.throws(() => parseBuiltinSpkis(blocklistFixture([EMSIGN_COMPROMISED_SPKIS[0], EMSIGN_COMPROMISED_SPKIS[0]])), /Duplicate/);
	const sources = sourceFixture(EMSIGN_COMPROMISED_SPKIS);
	sources[CHROMIUM_AUDIT_FILES[0]] = "// " + crlSetFixture.replaceAll("\n", "\n// ");
	assert.throws(() => auditChromiumSources("156.0.8078.17", sources), /integration changed/);
});

test("strict CLI fails for absent revocations and passes for the complete wired blocklist", () => {
	const root = mkdtempSync(join(tmpdir(), "cef-revocation-audit-"));
	try {
		mkdirSync(join(root, "net/cert"), { recursive: true });
		for (const [hashes, expectedStatus] of [
			[EMSIGN_COMPROMISED_SPKIS.slice(1), 1],
			[EMSIGN_COMPROMISED_SPKIS, 0],
		]) {
			for (const [path, source] of Object.entries(sourceFixture(hashes))) {
				writeFileSync(join(root, path), source);
			}
			const result = spawnSync(process.execPath, [
				fileURLToPath(new URL("./audit-cef-certificate-revocation.mjs", import.meta.url)),
				"--chromium-version", "156.0.8078.17", "--source-dir", root,
				"--require-emsign-revocation",
			], { encoding: "utf8" });
			assert.equal(result.status, expectedStatus, result.stderr);
			assert.equal(JSON.parse(result.stdout).missingSpkis.length, expectedStatus);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
