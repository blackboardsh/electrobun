// Run unchanged Cottontail fixtures against local runtime distributions.
// node docs/scripts/benchmark-cottontail.mjs COTTONTAIL_REPO OUTPUT.json LABEL=EXECUTABLE ...
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [sourceArg, outputArg, ...runtimeArgs] = process.argv.slice(2);
if (!sourceArg || !outputArg || runtimeArgs.length < 2) {
  throw new Error("usage: benchmark-cottontail.mjs COTTONTAIL_REPO OUTPUT.json LABEL=EXECUTABLE ...");
}
const source = resolve(sourceArg);
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const runtimes = runtimeArgs.map(arg => {
  const index = arg.indexOf("=");
  if (index < 1) throw new Error("Runtime must be LABEL=EXECUTABLE");
  const executable = resolve(arg.slice(index + 1));
  return { label: arg.slice(0, index), executable, sha256: sha256(executable) };
});
const benches = [
  ["startup-empty", "empty.js", 20, false],
  ["startup-sql", "full-runtime.js", 12, false],
  ["module-resolve", "module-resolve.js", 8, true],
  ["loop", "loop.js", 12, true],
  ["json", "json.js", 8, true],
  ["async", "async.js", 8, true],
];
const root = mkdtempSync(join(tmpdir(), "cottontail-comparison-"));
const results = {
  generatedAt: new Date().toISOString(),
  host: { platform: platform(), arch: arch(), cpu: cpus()[0].model, osRelease: release(), node: process.version },
  methodology: "Unmodified scripts/bench.js fixtures and sample counts; one excluded warmup per fixture/runtime; runtime order rotated per sample; separate working directories and caches. p50 is the lower median. Wall includes process launch, bundling, runtime initialization, execution and exit; internal excludes startup. Warm-cache standalone CLI launches, not packaged Electrobun app startup.",
  runtimes: runtimes.map(({ label, sha256 }) => ({ label, sha256 })),
  benchmarks: [],
};
const median = values => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
try {
  for (const [index, runtime] of runtimes.entries()) {
    runtime.cwd = join(root, String(index));
    mkdirSync(join(runtime.cwd, "bench"), { recursive: true });
    writeFileSync(join(runtime.cwd, "package.json"), '{"type":"module"}');
    symlinkSync(join(source, "node_modules"), join(runtime.cwd, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    for (const [, file] of benches) copyFileSync(join(source, "bench", file), join(runtime.cwd, "bench", file));
  }
  for (const [name, file, count, internal] of benches) {
    const samples = runtimes.map(() => []);
    for (let sample = -1; sample < count; sample++) {
      for (let offset = 0; offset < runtimes.length; offset++) {
        const index = ((sample + 1) + offset) % runtimes.length;
        const runtime = runtimes[index];
        const env = { ...process.env, COTTONTAIL_TMP_DIR: join(runtime.cwd, "cache"), XDG_CACHE_HOME: join(runtime.cwd, "xdg-cache") };
        delete env.COTTONTAIL_RUNTIME_MODULES_DIR;
        const start = process.hrtime.bigint();
        const child = spawnSync(runtime.executable, [join(runtime.cwd, "bench", file)], { cwd: runtime.cwd, env, encoding: "utf8", timeout: 60_000 });
        const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
        if (child.error || child.status !== 0) throw new Error(`${runtime.label}/${name}: ${child.error || child.stderr || child.stdout}`);
        const metric = child.stdout.match(/__bench_internal_ns__=(\d+)/);
        if (internal && !metric) throw new Error(`${name}: missing internal metric`);
        if (sample >= 0) samples[index].push({ wallMs, ...(internal ? { internalMs: Number(metric[1]) / 1e6 } : {}) });
      }
    }
    const entry = { name, fixture: file, fixtureSha256: sha256(join(source, "bench", file)), samplesPerRuntime: count,
      results: runtimes.map((runtime, index) => ({ label: runtime.label, p50WallMs: median(samples[index].map(s => s.wallMs)), ...(internal ? { p50InternalMs: median(samples[index].map(s => s.internalMs)) } : {}), samples: samples[index] })) };
    results.benchmarks.push(entry);
    console.log(name, entry.results.map(r => `${r.label}: ${r.p50WallMs.toFixed(3)} ms`).join(" | "));
  }
  mkdirSync(dirname(resolve(outputArg)), { recursive: true });
  writeFileSync(outputArg, JSON.stringify(results, null, 2) + "\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
