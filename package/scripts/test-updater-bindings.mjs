import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const suffix = process.platform === "win32" ? ".exe" : "";
const vendors = join(packageRoot, "vendors");
const zig = join(vendors, "zig", `zig${suffix}`);
const rustBin = join(vendors, "rust", "bin");
const goBin = join(vendors, "go", "bin");
const executionRoot = mkdtempSync(join(tmpdir(), "electrobun-updater-bindings-"));
const env = {
  ...process.env,
  PATH: [rustBin, goBin, process.env.PATH ?? ""].join(delimiter),
  RUSTC: join(rustBin, `rustc${suffix}`),
  ELECTROBUN_TEST_ZIG: zig,
};

function run(label, binary, args, cwd, childEnv = env) {
  if (!existsSync(binary)) throw new Error(`Missing vendored compiler: ${binary}. Build the package first.`);
  console.log(`Testing ${label}...`);
  const result = spawnSync(binary, args, {
    cwd, env: childEnv, stdio: "inherit", timeout: 300_000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.signal ?? result.status})`);
}

try {
  run("Zig SDK", zig, ["test", "electrobun.zig", "-lc"], join(packageRoot, "src", "sdks", "zig"));
  const goEnv = {
    ...env, CGO_ENABLED: "1", GOENV: "off", GOWORK: "off", GOTOOLCHAIN: "local",
    GOROOT: join(vendors, "go"),
    GOOS: process.platform === "win32" ? "windows" : process.platform,
    GOARCH: process.arch === "arm64" ? "arm64" : "amd64",
  };
  if (process.platform === "win32") {
    if (/["\r\n]/.test(zig)) throw new Error("Invalid Go compiler path");
    const target = process.arch === "arm64" ? "aarch64-windows-gnu" : "x86_64-windows-gnu";
    goEnv.CC = `"${zig}" cc -target ${target}`;
    goEnv.CXX = `"${zig}" c++ -target ${target}`;
  }
  run("Go SDK", join(goBin, `go${suffix}`), ["test", "./..."], join(packageRoot, "src", "sdks", "go"), goEnv);
  run("Rust SDK", join(rustBin, `cargo${suffix}`), ["test", "--locked"], join(packageRoot, "src", "sdks", "rust"));
  // Odin has no Windows ARM64 toolchain; this matches the package build and
  // existing template matrix. Every supported Odin target runs these tests.
  if (process.platform === "win32" && process.arch === "arm64") {
    console.log("Odin SDK tests skipped: Windows ARM64 is unsupported.");
  } else {
    run("Odin SDK", join(vendors, "odin", `odin${suffix}`), [
      "test", join(packageRoot, "src", "sdks", "odin"),
      `-out:${join(executionRoot, `odin-sdk-tests${suffix}`)}`,
    ], executionRoot);
  }
} finally {
  rmSync(executionRoot, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
}
