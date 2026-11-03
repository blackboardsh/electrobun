import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

// Released Hutch versions do not publish tar-integrity metadata. Compute the
// fixture expectation independently without retaining another complete tar.
export async function readCompressedTarIdentity(archivePath) {
	const hash = createHash("sha256");
	let size = 0;
	await pipeline(createReadStream(archivePath), createZstdDecompress(), async (source) => {
		for await (const bytes of source) {
			hash.update(bytes);
			size += bytes.length;
		}
	});
	return { sha256: hash.digest("hex"), size };
}

// Independently replay the recipe in the platform lifecycle tests. Comparing
// against the CI tar's digest catches serialization changes that merely reading
// version.json or checking the installed files would miss.
export function assertRecipeMatchesInstalled(recipePath, appRoot, expected = {}) {
	const recipe = JSON.parse(readFileSync(recipePath, "utf8"));
	assert.equal(recipe.schema_version, 1, "archive recipe schema");
	assert.match(recipe.archive_sha256, /^[0-9a-f]{64}$/, "archive recipe digest");
	assert.equal(Number.isSafeInteger(recipe.archive_size), true, "archive recipe size");
	const entries = new Map(recipe.entries.map((entry) => [entry.path, entry]));
	const hash = createHash("sha256");
	const buffer = Buffer.alloc(64 * 1024);
	let size = 0;
	for (const span of recipe.spans) {
		assert.equal(Number.isSafeInteger(span.size) && span.size >= 0, true, "recipe span size");
		if (span.literal_hex != null) {
			assert.equal(span.path == null, true, "literal span must not reference a file");
			assert.match(span.literal_hex, /^(?:[0-9a-f]{2})*$/, "recipe literal encoding");
			const bytes = Buffer.from(span.literal_hex, "hex");
			assert.equal(bytes.length, span.size, "recipe literal size");
			hash.update(bytes);
		} else {
			assert.equal(typeof span.path, "string", "recipe file path");
			const path = resolve(appRoot, ...span.path.split("/"));
			const child = relative(resolve(appRoot), path);
			assert.equal(isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`), false, "recipe file escapes the app");
			const stat = lstatSync(path);
			assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, `recipe source is not a regular file: ${span.path}`);
			assert.equal(stat.size, span.size, `recipe source size: ${span.path}`);
			const fileHash = createHash("sha256");
			const fd = openSync(path, "r");
			try {
				let offset = 0;
				while (offset < span.size) {
					const count = readSync(fd, buffer, 0, Math.min(buffer.length, span.size - offset), offset);
					assert.ok(count > 0, `recipe source truncated: ${span.path}`);
					hash.update(buffer.subarray(0, count));
					fileHash.update(buffer.subarray(0, count));
					offset += count;
				}
			} finally {
				closeSync(fd);
			}
			assert.equal(fileHash.digest("hex"), entries.get(span.path)?.sha256, `recipe source digest: ${span.path}`);
		}
		size += span.size;
	}
	assert.equal(size, recipe.archive_size, "reconstructed tar size differs from recipe");
	assert.equal(hash.digest("hex"), recipe.archive_sha256, "reconstructed tar differs from recipe");
	if (expected.sha256 !== undefined) assert.equal(recipe.archive_sha256, expected.sha256, "reconstructed tar differs from CI archive");
	if (expected.size !== undefined) assert.equal(recipe.archive_size, expected.size, "reconstructed tar size differs from CI archive");
	return recipe;
}
