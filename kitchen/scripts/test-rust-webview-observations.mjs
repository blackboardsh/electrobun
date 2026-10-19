import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { msvcEnvironment } from "../../package/scripts/windows-msvc-environment.mjs";

const kitchen = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rustc = process.env.ELECTROBUN_RUSTC || join(kitchen, "..", "package", "vendors", "rust", "bin", process.platform === "win32" ? "rustc.exe" : "rustc");
if (!existsSync(rustc)) throw new Error(`Rust compiler is missing: ${rustc}. Run the Electrobun package build first.`);
const version = spawnSync(rustc, ["-vV"], { encoding: "utf8", windowsHide: true });
if (version.error || version.status !== 0) throw new Error(`Could not identify Rust compiler: ${version.error?.message || version.stderr}`);
const host = version.stdout.match(/^host: (.+)$/m)?.[1]?.trim();
if (!host) throw new Error("Rust compiler did not report its host target");
let env = process.env;
if (process.platform === "win32") {
    const arch = host === "aarch64-pc-windows-msvc" ? "arm64" : host === "x86_64-pc-windows-msvc" ? "x64" : null;
    if (!arch) throw new Error(`Unsupported Windows Rust host: ${host}`);
    // Node may be native ARM64 while vendored Rust targets x64 under emulation.
    env = msvcEnvironment({ arch });
}

const temporaryRoot = realpathSync(tmpdir());
const scratch = mkdtempSync(join(temporaryRoot, "electrobun-rust-observations-"));
const executable = join(scratch, process.platform === "win32" ? "observations.exe" : "observations");
function run(command, args) {
    const result = spawnSync(command, args, { env, cwd: scratch, stdio: "inherit", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Rust callback isolation tests failed (${result.error?.message || result.status})`);
}

try {
    console.log(`[rust-observations] Compiler target: ${host}`);
    console.log(`[rust-observations] Test executable: ${executable}`);
    run(rustc, ["--edition=2021", "--test", join(kitchen, "src", "rust", "webview_observations.rs"), "-o", executable]);
    run(executable, []);
} catch (error) {
    console.error(`[rust-observations] Retained failed test files: ${scratch}`);
    throw error;
}
