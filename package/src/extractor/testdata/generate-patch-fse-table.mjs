// Regenerate with the bundled zig-bsdiff 0.1.26 producer (Zstd level 19).
// A 64 KiB zero baseline becomes 300 deterministic sparse byte edits. Its
// compressed diff block uses a valid FSE table with more than 512 bytes left
// in the block, exercising the decoder's contiguous input-buffer requirement.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const temporary = mkdtempSync(join(tmpdir(), "electrobun-patch-fse-"));
try {
  const old = Buffer.alloc(65536);
  const target = Buffer.from(old);
  let state = 938481;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let index = 0; index < 300; index++) {
    const position = next() % target.length;
    target[position] = next() % 255 + 1;
  }
  const oldPath = join(temporary, "old");
  const targetPath = join(temporary, "target");
  const patchPath = join(temporary, "patch");
  writeFileSync(oldPath, old);
  writeFileSync(targetPath, target);
  const producer = process.argv[2] || fileURLToPath(new URL(
    `../../../vendors/zig-bsdiff/bsdiff${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ));
  const result = spawnSync(producer, [oldPath, targetPath, patchPath, "--use-zstd"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Patch generation failed: ${result.status}`);
  const patch = readFileSync(patchPath);
  writeFileSync(new URL("patch-fse-table.patch", import.meta.url), patch);
  console.log({
    targetSize: target.length,
    targetSha256: createHash("sha256").update(target).digest("hex"),
    patchSize: patch.length,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
