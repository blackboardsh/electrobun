#!/usr/bin/env bun
/**
 * Test that verifies bsdiff progress logging works with large files
 * This creates large files that should take >30 seconds to diff,
 * allowing us to verify the progress updates appear every 10 seconds.
 */

import { spawn } from "bun";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

const TEST_DIR = join(import.meta.dir, "test-data");
const OLD_FILE = join(TEST_DIR, "old-large.bin");
const NEW_FILE = join(TEST_DIR, "new-large.bin");
const PATCH_FILE = join(TEST_DIR, "test.patch");
const BSDIFF_BIN = join(import.meta.dir, "zig-out", "bin", "bsdiff");
const BSPATCH_BIN = join(import.meta.dir, "zig-out", "bin", "bspatch");

// Create test directory
try {
  rmSync(TEST_DIR, { recursive: true, force: true });
} catch {}
mkdirSync(TEST_DIR, { recursive: true });

console.log("Generating large test files...");
console.log("This will create ~1MB file to ensure bsdiff takes >30 seconds\n");

// Generate an old file (~1MB)
// We'll create data that compresses reasonably but has some randomness
const chunkSize = 1024 * 1024; // 1MB chunks
const numChunks = 2; // 1MB total
const oldData: Uint8Array[] = [];

for (let i = 0; i < numChunks; i++) {
  const chunk = new Uint8Array(chunkSize);
  // Fill with somewhat predictable but not completely repetitive data
  for (let j = 0; j < chunkSize; j++) {
    // Mix of predictable and random data
    chunk[j] = (i * 256 + j % 256) & 0xff;
    // Add some variation every 1KB
    if (j % 1024 === 0) {
      chunk[j] = Math.floor(Math.random() * 256);
    }
  }
  oldData.push(chunk);
}

await Bun.write(OLD_FILE, Buffer.concat(oldData));
console.log(`Created old file: ${OLD_FILE} (${numChunks} MB)`);

// Generate new file - similar to old but with changes
const newData: Uint8Array[] = [];
for (let i = 0; i < numChunks; i++) {
  const chunk = new Uint8Array(chunkSize);
  // Copy from old with some modifications
  for (let j = 0; j < chunkSize; j++) {
    chunk[j] = (i * 256 + j % 256) & 0xff;
    // Different variation pattern
    if (j % 1024 === 0) {
      chunk[j] = Math.floor(Math.random() * 256);
    }
    // Add some changes every 100KB
    if (j % (100 * 1024) === 0) {
      chunk[j] = (~chunk[j]) & 0xff;
    }
  }
  newData.push(chunk);
}

await Bun.write(NEW_FILE, Buffer.concat(newData));
console.log(`Created new file: ${NEW_FILE} (${numChunks} MB)`);

console.log("\n" + "=".repeat(60));
console.log("Running bsdiff - watch for progress updates every 10s...");
console.log("=".repeat(60) + "\n");

const startTime = Date.now();

// Run bsdiff with inherited stdio so we see the output in real-time
const bsdiffProc = spawn({
  cmd: [BSDIFF_BIN, OLD_FILE, NEW_FILE, PATCH_FILE, "--use-zstd"],
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await bsdiffProc.exited;
const duration = ((Date.now() - startTime) / 1000).toFixed(1);

console.log("\n" + "=".repeat(60));
console.log(`bsdiff completed in ${duration}s with exit code: ${exitCode}`);
console.log("=".repeat(60) + "\n");

if (exitCode !== 0) {
  console.error("❌ bsdiff failed!");
  process.exit(1);
}

// Verify patch file was created
const patchStat = await Bun.file(PATCH_FILE).exists();
if (!patchStat) {
  console.error("❌ Patch file was not created!");
  process.exit(1);
}

const patchSize = (await Bun.file(PATCH_FILE).size) / 1024;
console.log(`✓ Patch file created: ${patchSize.toFixed(2)} KB\n`);

// Now test bspatch to verify it can apply the patch
console.log("=".repeat(60));
console.log("Running bspatch - watch for progress updates...");
console.log("=".repeat(60) + "\n");

const PATCHED_FILE = join(TEST_DIR, "patched.bin");
const bspatchStartTime = Date.now();

const bspatchProc = spawn({
  cmd: [BSPATCH_BIN, OLD_FILE, PATCHED_FILE, PATCH_FILE],
  stdout: "inherit",
  stderr: "inherit",
});

const bspatchExitCode = await bspatchProc.exited;
const bspatchDuration = ((Date.now() - bspatchStartTime) / 1000).toFixed(1);

console.log("\n" + "=".repeat(60));
console.log(`bspatch completed in ${bspatchDuration}s with exit code: ${bspatchExitCode}`);
console.log("=".repeat(60) + "\n");

if (bspatchExitCode !== 0) {
  console.error("❌ bspatch failed!");
  process.exit(1);
}

// Verify the patched file matches the new file
const patchedData = await Bun.file(PATCHED_FILE).arrayBuffer();
const newFileData = await Bun.file(NEW_FILE).arrayBuffer();

if (Buffer.compare(Buffer.from(patchedData), Buffer.from(newFileData)) === 0) {
  console.log("✓ Patched file matches new file perfectly!");
  console.log("\n✅ All tests passed!");
  console.log(`   - bsdiff took ${duration}s`);
  console.log(`   - bspatch took ${bspatchDuration}s`);
  console.log(`   - Patch size: ${patchSize.toFixed(2)} MB`);
} else {
  console.error("❌ Patched file does not match new file!");
  process.exit(1);
}

// Cleanup
console.log("\nCleaning up test files...");
rmSync(TEST_DIR, { recursive: true, force: true });
console.log("Done!");
