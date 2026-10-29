import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The pinned Odin toolchain has no Windows ARM64 target, matching Kitchen.
if (process.platform === "win32" && process.arch === "arm64") {
	console.log("Odin resize observation tests skipped: Windows ARM64 is unsupported.");
	process.exit(0);
}
const kitchen = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const odin = join(kitchen, "..", "package", "vendors", "odin", process.platform === "win32" ? "odin.exe" : "odin");
if (!existsSync(odin)) throw new Error(`Vendored Odin compiler is missing: ${odin}. Run the package build first.`);
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "electrobun-odin-observations-"));
const result = spawnSync(odin, ["test", join(kitchen, "src", "odin", "window_size_observation")], { cwd: scratch, stdio: "inherit", windowsHide: true });
if (result.error || result.status !== 0) throw new Error(`Odin resize observation tests failed (${result.error?.message || result.status}); retained files: ${scratch}`);
