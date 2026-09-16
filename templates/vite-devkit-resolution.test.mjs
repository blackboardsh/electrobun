import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const templatesRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(templatesRoot);
const hutch = process.env.HUTCH_BINARY
	? resolve(process.env.HUTCH_BINARY)
	: process.platform === "win32"
		? "hutch.exe"
		: "hutch";
const siblingHutchEngine = process.env.HUTCH_BINARY
	? join(
			dirname(hutch),
			process.platform === "win32" ? "hutch-engine.exe" : "hutch-engine",
		)
	: null;
const hutchEngine = process.env.HUTCH_ENGINE_BINARY
	? resolve(process.env.HUTCH_ENGINE_BINARY)
	: siblingHutchEngine && existsSync(siblingHutchEngine)
		? siblingHutchEngine
		: null;
const pathVariable =
	Object.keys(process.env).find((name) => name.toLowerCase() === "path") ||
	"PATH";
const hutchEnvironment = process.env.HUTCH_BINARY
	? {
			[pathVariable]: [
				dirname(hutch),
				process.env[pathVariable] || "",
			].join(delimiter),
			...(hutchEngine ? { HUTCH_ENGINE_BINARY: hutchEngine } : {}),
		}
	: {};

function run(command, args, cwd) {
	return spawnSync(command, args, {
		cwd,
		env: {
			...process.env,
			...hutchEnvironment,
			npm_config_audit: "false",
			npm_config_fund: "false",
			npm_config_update_notifier: "false",
		},
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
		timeout: 180_000,
	});
}

test(
	"a clean Vite template bundles electrobun/view from the projected devkit",
	{ timeout: 240_000 },
	() => {
		const fixture = mkdtempSync(join(tmpdir(), "electrobun-vite-devkit-"));
		const project = join(fixture, "app");
		try {
			cpSync(join(templatesRoot, "vanilla-vite"), project, {
				recursive: true,
			});
			assert.equal(existsSync(join(project, "node_modules")), false);
			assert.equal(
				existsSync(join(project, ".hutch")),
				false,
				"a clean scaffold must not rely on a pre-existing devkit projection",
			);

			// Stand in for the leading `hutch electrobun prepare` in every Vite task by
			// projecting the SDK from the release source into the clean scaffold.
			const devkitRoot = join(project, ".hutch", "devkit");
			const apiRoot = join(devkitRoot, "api");
			for (const [source, destination] of [
				["browser", "browser"],
				["config", "config"],
				["preload", "preload"],
				["shared", "shared"],
				["sdks/main", "sdks/main"],
			]) {
				cpSync(
					join(repositoryRoot, "package", "src", source),
					join(apiRoot, destination),
					{ recursive: true },
				);
			}

			const packageManifest = JSON.parse(
				readFileSync(join(repositoryRoot, "package", "package.json"), "utf8"),
			);
			const exports = Object.fromEntries(
				Object.entries(packageManifest.exports).map(([subpath, target]) => {
					assert.equal(typeof target, "string");
					assert.match(target, /^\.\/dist\/api\//);
					return [subpath, target.replace("./dist/api/", "./api/")];
				}),
			);
			mkdirSync(devkitRoot, { recursive: true });
			writeFileSync(
				join(devkitRoot, "package.json"),
				`${JSON.stringify({
					name: "electrobun",
					private: true,
					type: "module",
					exports,
				})}\n`,
			);
			writeFileSync(
				join(devkitRoot, "tsconfig.json"),
				`${JSON.stringify({ compilerOptions: { baseUrl: "." } })}\n`,
			);

			const entrypoint = join(project, "src", "mainview", "main.ts");
			writeFileSync(
				entrypoint,
				[
					'import { Electroview } from "electrobun/view";',
					readFileSync(entrypoint, "utf8"),
					"",
					"globalThis.__electrobunViewSdk = Electroview;",
					"",
				].join("\n"),
			);

			const hutchConfigPath = join(project, "hutch.config.ts");
			const hutchConfig = readFileSync(hutchConfigPath, "utf8");
			const releaseBuildTask =
				'build: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=stable",';
			assert.ok(
				hutchConfig.includes(releaseBuildTask),
				"the Vite template build task must prepare the devkit before Hutch's built-in pm exec",
			);
			const fixtureBuildTask = [
				'build: "hutch pm exec -- vite build && hutch run package:stub",',
				`"package:stub": ${JSON.stringify([
					"node",
					"-e",
					"require('node:fs').writeFileSync('.packaging-stub-ran', '')",
				])},`,
			].join("\n\t\t");
			writeFileSync(
				hutchConfigPath,
				hutchConfig.replace(releaseBuildTask, fixtureBuildTask),
			);

			const install = run(
				hutch,
				["run", "install"],
				project,
			);
			assert.equal(
				install.status,
				0,
				`hutch run install failed\n${install.error || ""}\n${install.stdout}\n${install.stderr}`,
			);
			assert.equal(
				existsSync(join(project, "node_modules", "electrobun")),
				false,
				"the package manager must not install an Electrobun shim",
			);

			const build = run(
				hutch,
				["run", "build"],
				project,
			);
			assert.equal(
				build.status,
				0,
				`hutch run build failed\n${build.error || ""}\n${build.stdout}\n${build.stderr}`,
			);
			assert.equal(
				existsSync(join(project, ".packaging-stub-ran")),
				true,
				"the configured build task must continue through its packaging boundary",
			);

			const assets = join(project, "dist", "assets");
			const javascript = readdirSync(assets)
				.filter((name) => name.endsWith(".js"))
				.map((name) => readFileSync(join(assets, name), "utf8"))
				.join("\n");
			assert.match(
				javascript,
				/__electrobunHostSocketPort/,
				"the output must contain code from the projected Electrobun view SDK",
			);
			assert.doesNotMatch(javascript, /from["']electrobun\/view["']/);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	},
);

test(
	"the dependency-free tray template accepts its configured frozen install without a lockfile",
	{ timeout: 60_000 },
	() => {
		const fixture = mkdtempSync(join(tmpdir(), "electrobun-tray-install-"));
		const project = join(fixture, "app");
		try {
			cpSync(join(templatesRoot, "tray-app"), project, { recursive: true });
			assert.equal(existsSync(join(project, "hutch.lock")), false);
			assert.equal(existsSync(join(project, "node_modules")), false);

			const install = run(hutch, ["run", "install"], project);
			assert.equal(
				install.status,
				0,
				`tray hutch run install failed\n${install.error || ""}\n${install.stdout}\n${install.stderr}`,
			);
			assert.equal(
				existsSync(join(project, "hutch.lock")),
				false,
				"an empty dependency graph must not create an empty lockfile",
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	},
);
