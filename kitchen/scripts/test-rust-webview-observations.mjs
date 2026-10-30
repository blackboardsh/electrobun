import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { msvcEnvironment } from "../../package/scripts/windows-msvc-environment.mjs";

const kitchen = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rustc = process.env.ELECTROBUN_RUSTC || join(kitchen, "..", "package", "vendors", "rust", "bin", process.platform === "win32" ? "rustc.exe" : "rustc");
if (!existsSync(rustc)) throw new Error(`Rust compiler is missing: ${rustc}. Run the Electrobun package build first.`);
const cargo = process.env.ELECTROBUN_CARGO || join(dirname(rustc), process.platform === "win32" ? "cargo.exe" : "cargo");
if (!existsSync(cargo)) throw new Error(`Cargo is missing: ${cargo}. Run the Electrobun package build first.`);
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
// Compile only the observation helpers, without the app or native SDK. Use the
// app's exact serde_json and transitive package versions/checksums, even when
// CI has not built Kitchen or populated its Cargo cache yet.
const packageBlocks = readFileSync(join(kitchen, "Cargo.lock"), "utf8").split("[[package]]").slice(1);
const registryBlocks = packageBlocks.filter((block) => /^source = "registry\+/m.test(block));
const serdeJson = registryBlocks.find((block) => /^name = "serde_json"$/m.test(block));
const serdeVersion = serdeJson?.match(/^version = "([^"]+)"$/m)?.[1];
if (!serdeVersion) throw new Error("Kitchen Cargo.lock does not pin serde_json");
const packageName = "electrobun-webview-observation-tests";
const manifest = join(scratch, "Cargo.toml");
writeFileSync(join(scratch, "lib.rs"), ["webview_observations", "window_size_observation", "fullscreen_observation"].map((module) =>
    `#[path = ${JSON.stringify(join(kitchen, "src", "rust", `${module}.rs`))}]\npub mod ${module};\n`
).join("\n"));
writeFileSync(manifest, `[package]
name = "${packageName}"
version = "0.0.0"
edition = "2021"

[lib]
path = "lib.rs"

[dependencies]
serde_json = "=${serdeVersion}"
`);
writeFileSync(join(scratch, "Cargo.lock"), `# Uses the dependency pins from Kitchen Cargo.lock.
version = 4

[[package]]
name = "${packageName}"
version = "0.0.0"
dependencies = ["serde_json"]

${registryBlocks.map((block) => `[[package]]${block}`).join("")}`);
env = { ...env, RUSTC: rustc, CARGO_TARGET_DIR: join(scratch, "target") };
function run(command, args) {
    const result = spawnSync(command, args, { env, cwd: scratch, stdio: "inherit", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Rust callback isolation tests failed (${result.error?.message || result.status})`);
}

try {
    console.log(`[rust-observations] Compiler target: ${host}`);
    console.log(`[rust-observations] Standalone test project: ${scratch}`);
    run(cargo, ["test", "--locked", "--manifest-path", manifest, "--lib", "--target", host]);
} catch (error) {
    console.error(`[rust-observations] Retained failed test files: ${scratch}`);
    throw error;
}
