#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { npmInvocation, validateRunnerPlatform } from "../npm/scripts/accept-published-bootstrap.mjs";
import { parseStrictSemVer } from "../package/src/shared/strict-semver.js";
import { systemTarBinary } from "../package/scripts/windows-tar.mjs";
import { parseHutchPragma, pinPublishedTemplateConfig, releaseChannel } from "./publish-templates.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicBase = "https://electrobun-artifacts.blackboard.sh/electrobun/templates";
export const requiredChecks = ["sql", "sqlite", "hashing-override", "rpc-request", "webview", "rpc-roundtrip"];

export function validateCatalog(catalog, version, pins) {
	assert.equal(catalog.schema, 1);
	assert.equal(catalog.kind, "electrobun-template-channel");
	assert.equal(catalog.version, version, "public template channel must match the release under test");
	assert.equal(catalog.channel, releaseChannel(version));
	assert.deepEqual(catalog.tools, pins);
	assert.ok(catalog.templates.some(t => t.id === "hello-world"), "published hello-world missing");
}

export function validateReport(report, token) {
	assert.equal(report.token, token, "stale or unrelated app report");
	assert.equal(report.ok, true, report.error ?? "app failed");
	for (const check of requiredChecks) assert.ok(report.checks?.includes(check), `missing ${check}`);
}

export function acceptanceEnvironment(base, work) {
	const env = Object.fromEntries(Object.entries(base).filter(([key]) =>
		!/^(HUTCH_|COTTONTAIL_|ELECTROBUN_|DASH_RELEASE_|NPM_CONFIG_|NPM_TOKEN$|NODE_AUTH_TOKEN$|NODE_PATH$|NODE_OPTIONS$)/i.test(key)));
	return { ...env, HUTCH_HOME: join(work, "hutch-home"), HUTCH_ACTIVE_CHANNEL: "production", HUTCH_NO_UPDATE_CHECK: "1",
		npm_config_cache: join(work, "npm-cache"), npm_config_userconfig: join(work, "empty.npmrc"),
		npm_config_registry: "https://registry.npmjs.org", CI: "1" };
}

const stoppedChildren = new WeakSet();
function stopTree(child) {
	if (!child.pid || stoppedChildren.has(child)) return;
	stoppedChildren.add(child);
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	else {
		try { process.kill(-child.pid, "SIGKILL"); }
		catch (error) {
			// macOS can return EPERM for an already-reaped process group.
			if (error.code !== "ESRCH" && !(error.code === "EPERM" && (child.exitCode !== null || child.signalCode !== null))) throw error;
		}
	}
}

// Own each command's process tree, enforce a deadline, and retain per-stage logs.
// Hello-world is intentionally left unchanged: observe its startup marker and
// require it to remain alive briefly before stopping it. The fixture must exit 0.
export async function run(command, args, { cwd, env, log, timeout = 600_000, startupMarker } = {}) {
	let output = "", observed = false, expired = false;
	if (log) writeFileSync(log, "");
	const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
	let settled;
	const done = new Promise((resolveDone, reject) => {
		settled = resolveDone;
		child.once("error", reject);
		child.once("exit", (code, signal) => resolveDone({ code, signal }));
	});
	let readyTimer;
	const consume = chunk => {
		output = (output + chunk.toString()).slice(-2_000_000);
		if (log) appendFileSync(log, chunk);
		if (startupMarker && !readyTimer && output.includes(startupMarker)) {
			readyTimer = setTimeout(() => { observed = true; stopTree(child); }, 3000);
		}
	};
	child.stdout.on("data", consume);
	child.stderr.on("data", consume);
	const timer = setTimeout(() => { expired = true; stopTree(child); settled({ code: null, signal: "deadline" }); }, timeout);
	try {
		const result = await done;
		if (expired || (startupMarker ? !observed : result.code !== 0)) {
			throw new Error(`${command} ${args.join(" ")} ${expired ? "timed out" : `failed (${result.code}/${result.signal})`}\n${output.slice(-6000)}`);
		}
		return output;
	} finally {
		clearTimeout(timer); clearTimeout(readyTimer); stopTree(child);
	}
}

function verifyProject(project, version, pins) {
	const config = readFileSync(join(project, "hutch.config.ts"), "utf8");
	assert.deepEqual(parseHutchPragma(config), pins);
	assert.ok(config.includes(`version: "${version}"`), "generated project has wrong Electrobun pin");
	const projection = JSON.parse(readFileSync(join(project, ".hutch/devkit/projection.json"), "utf8"));
	assert.equal(projection.product.version, version);
}

async function fixtureCatalog(work, version, pins, revision) {
	const id = "template-acceptance";
	const staging = join(work, "fixture-source");
	const project = join(staging, id);
	cpSync(join(root, "scripts/fixtures", id), project, { recursive: true });
	const config = join(project, "hutch.config.ts");
	writeFileSync(config, pinPublishedTemplateConfig(id, readFileSync(config, "utf8"), version));
	const archive = join(work, "fixture.tar.gz");
	await run(systemTarBinary(), ["-czf", archive, "-C", staging, id], { timeout: 60_000 });
	const bytes = readFileSync(archive);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const artifactPath = `/artifacts/${sha256}.tar.gz`;
	let catalog;
	const server = createServer((request, response) => {
		if (request.url === `/channels/${releaseChannel(version)}.json`) {
			response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(catalog));
		} else if (request.url === artifactPath) response.end(bytes);
		else { response.statusCode = 404; response.end(); }
	});
	await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
	const base = `http://127.0.0.1:${server.address().port}`;
	catalog = { schema: 1, kind: "electrobun-template-channel", channel: releaseChannel(version), version, revision,
		tools: pins, templates: [{ id, name: "CI acceptance", description: "Private CI fixture", mainProcess: "cottontail",
			archive: { url: `${base}${artifactPath}`, size: bytes.length, sha256 } }] };
	return { base, close: () => new Promise(done => server.close(done)) };
}

export async function acceptPublishedTemplate({ version, platform, output }) {
	assert.ok(parseStrictSemVer(version), "expected exact release version");
	validateRunnerPlatform(platform);
	const work = resolve(output);
	mkdirSync(work, { recursive: true });
	const scratch = join(work, `run-${randomUUID()}`);
	mkdirSync(scratch);
	writeFileSync(join(scratch, "empty.npmrc"), "");
	const env = acceptanceEnvironment(process.env, scratch);
	const pins = parseHutchPragma(readFileSync(join(root, "package/hutch.config.ts"), "utf8"));
	const response = await fetch(`${publicBase}/channels/${releaseChannel(version)}.json`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
	assert.equal(response.ok, true, `catalog HTTP ${response.status}`);
	const catalog = await response.json(); validateCatalog(catalog, version, pins);
	writeFileSync(join(work, "catalog.json"), JSON.stringify(catalog, null, 2));
	const bootstrap = join(scratch, "bootstrap"); mkdirSync(bootstrap);
	writeFileSync(join(bootstrap, "package.json"), JSON.stringify({ private: true }));
	const npm = npmInvocation(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `electrobun@${version}`]);
	await run(npm.command, npm.args, { cwd: bootstrap, env, log: join(work, "npm-install.log") });
	const resolver = createRequire(import.meta.url)(join(bootstrap, "node_modules/electrobun/bin/resolve-hutch.cjs"));
	assert.equal(resolver.ELECTROBUN_VERSION, version);
	assert.equal(resolver.PAIRED_HUTCH_VERSION, pins.hutch);
	const hutch = await resolver.resolveHutchBinary({ environment: env });
	// Install tasks invoke `hutch` by name; only the downloaded release goes first.
	const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path") ?? "PATH";
	env[pathKey] = `${dirname(hutch)}${delimiter}${env[pathKey] ?? ""}`;
	const invoke = (label, args, cwd = scratch, extra = {}, options = {}) => {
		console.log(`[template-acceptance] ${label}`);
		return run(hutch, args, { cwd, env: { ...env, ...extra }, log: join(work, `${label}.log`), ...options });
	};
	assert.equal((await invoke("hutch-version", ["--version"])).trim(), pins.hutch);
	const channelArgs = releaseChannel(version) === "beta" ? ["--beta"] : [];
	await invoke("public-init", ["electrobun", "init", "public-app", "--template=hello-world", ...channelArgs]);
	const publicProject = join(scratch, "public-app"); verifyProject(publicProject, version, pins);
	assert.ok(existsSync(join(publicProject, "node_modules/@types/bun/package.json")), "public template install task did not install dependencies");
	await invoke("public-build", ["electrobun", "build"], publicProject);
	await invoke("public-launch", ["electrobun", "run"], publicProject, {}, { timeout: 90_000, startupMarker: "Hello Electrobun app started!" });
	const fixture = await fixtureCatalog(scratch, version, pins, catalog.revision);
	const token = randomUUID();
	const reportPath = join(work, "app-report.json");
	const fixtureEnv = { ELECTROBUN_ACCEPTANCE_TOKEN: token, ELECTROBUN_ACCEPTANCE_REPORT: reportPath, ELECTROBUN_ACCEPTANCE_API: "CryptoHasher" };
	try {
		await invoke("fixture-init", ["electrobun", "init", "fixture-app", "--template=template-acceptance", ...channelArgs], scratch,
			{ ...fixtureEnv, ELECTROBUN_TEMPLATES_BASE_URL: fixture.base });
	} finally { await fixture.close(); }
	const project = join(scratch, "fixture-app"); verifyProject(project, version, pins);
	assert.equal(JSON.parse(readFileSync(join(project, "install-result.json"), "utf8")).token, token);
	await invoke("fixture-build", ["electrobun", "build"], project, fixtureEnv);
	await invoke("fixture-launch", ["electrobun", "run"], project, fixtureEnv, { timeout: 90_000 });
	const report = JSON.parse(readFileSync(reportPath, "utf8")); validateReport(report, token);
	const result = { version, platform, tools: pins, publicTemplate: "hello-world", checks: report.checks };
	writeFileSync(join(work, "result.json"), JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
	return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const options = {};
	for (let i = 0; i < args.length; i += 2) {
		assert.ok(["--version", "--platform", "--output"].includes(args[i]) && args[i + 1], "usage: --version X.Y.Z --platform PLATFORM --output DIRECTORY");
		options[args[i].slice(2)] = args[i + 1];
	}
	await acceptPublishedTemplate(options);
}
