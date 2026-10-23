import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kitchen = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const override = process.env.ELECTROBUN_GO;
if (override && !isAbsolute(override)) throw new Error("ELECTROBUN_GO must be an absolute compiler path");
const go = override || join(kitchen, "..", "package", "vendors", "go", "bin", process.platform === "win32" ? "go.exe" : "go");
if (!existsSync(go)) throw new Error(`Go compiler is missing: ${go}. Run the Electrobun package build first.`);

// These pure tests run on the compiler's host, independently of app target
// overrides or user Go configuration. They do not link the native Go SDK.
const env = { ...process.env };
for (const name of Object.keys(env)) {
    if (/^(?:GOROOT|GOTOOLDIR|GOFLAGS|GOOS|GOARCH|GOARM|GOARM64|GOAMD64|GOENV|GOWORK|GOTOOLCHAIN|CGO_ENABLED)$/i.test(name)) delete env[name];
}
Object.assign(env, { GOENV: "off", GOWORK: "off", GOTOOLCHAIN: "local", CGO_ENABLED: "0" });
const hostReport = spawnSync(go, ["env", "-json", "GOHOSTOS", "GOHOSTARCH"], { env, encoding: "utf8", windowsHide: true });
if (hostReport.error || hostReport.status !== 0) throw new Error(`Could not identify Go compiler: ${hostReport.error?.message || hostReport.stderr}`);
const { GOHOSTOS, GOHOSTARCH } = JSON.parse(hostReport.stdout);
if (!GOHOSTOS || !GOHOSTARCH) throw new Error("Go compiler did not report its host target");
Object.assign(env, { GOOS: GOHOSTOS, GOARCH: GOHOSTARCH });

const scratch = mkdtempSync(join(realpathSync(tmpdir()), "electrobun-go-observations-"));
console.log(`[go-observations] Compiler target: ${GOHOSTOS}/${GOHOSTARCH}`);
console.log(`[go-observations] Working directory: ${scratch}`);
const result = spawnSync(go, ["test", "-count=1", "-v",
    join(kitchen, "src", "go", "webview_observations.go"),
    join(kitchen, "src", "go", "webview_observations_test.go"),
    join(kitchen, "src", "go", "window_size_observation.go"),
    join(kitchen, "src", "go", "window_size_observation_test.go"),
], { env, cwd: scratch, stdio: "inherit", windowsHide: true });
if (result.error || result.status !== 0) throw new Error(`Go callback and window observation tests failed (${result.error?.message || result.status})`);
