import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import {
	availableTemplateNames,
	createTemplateDevPlan,
	executeTemplateDevPlan,
	hostDevkitTarget,
	parseTemplateName,
	readPackageHutchPins,
	readPackageVersion,
	resolvedHutchEnginePath,
	resolveTemplateDirectory,
	validateBuiltDevkitVersion,
	verifySelectedHutchVersion,
} from "./dev-template.ts";

const scratch = mkdtempSync(join(tmpdir(), "electrobun-dev-template-"));

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function createTemplate(templatesDir: string, name: string): string {
	const directory = join(templatesDir, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "hutch.config.ts"), "export default {};\n");
	writeFileSync(join(directory, "electrobun.config.ts"), "export default {};\n");
	return directory;
}

type DevkitFixture = {
	product: { version: string; name: string };
	target: { os: string; arch: string };
	layout: {
		runtime: Record<string, string | string[]>;
		sdks: {
			javascript: Record<string, string | Record<string, string>>;
			zig: Record<string, string>;
			rust: Record<string, string>;
			go: Record<string, string>;
			odin: Record<string, string>;
		};
	};
	[key: string]: unknown;
};

function devkitFixture(): DevkitFixture {
	return JSON.parse(
		readFileSync(
			resolve(import.meta.dirname, "fixtures", "native-devkit.macos-arm64.json"),
			"utf8",
		),
	) as DevkitFixture;
}

function declaredDevkitPaths(manifest: DevkitFixture): Set<string> {
	const sdks = manifest.layout.sdks;
	const { wgpuAuxiliaryLibraries = [], ...runtime } = manifest.layout.runtime;
	return new Set([
		...(Object.values(runtime) as string[]),
		...(wgpuAuxiliaryLibraries as string[]),
		...(Object.values(sdks.javascript).filter(
			(value): value is string => typeof value === "string",
		) as string[]),
		...Object.values(
			sdks.javascript.exports as Record<string, string>,
		),
		...Object.values(sdks.zig),
		...Object.values(sdks.rust),
		...Object.values(sdks.go).filter((value) => value.includes("/")),
		...Object.values(sdks.odin).filter((value) => value.includes("/")),
	]);
}

function writeDevkit(packageDir: string): DevkitFixture {
	const manifest = devkitFixture();
	manifest.product.version = "2.0.1-beta.31";
	const directories = new Set([
		manifest.layout.sdks.javascript.root as string,
		manifest.layout.sdks.zig.root,
		manifest.layout.sdks.rust.root,
		manifest.layout.sdks.go.root,
		manifest.layout.sdks.odin.root,
		manifest.layout.sdks.odin.collection,
	]);
	const root = join(packageDir, "dist");
	for (const path of declaredDevkitPaths(manifest)) {
		const destination = join(root, path);
		if (directories.has(path)) {
			mkdirSync(destination, { recursive: true });
		} else {
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, "fixture\n");
		}
	}
	writeFileSync(
		join(root, manifest.layout.sdks.go.manifest),
		`module ${manifest.layout.sdks.go.module}\n\ngo 1.26.0\n`,
	);
	writeJson(join(root, "native-devkit.json"), manifest);
	return manifest;
}

try {
	assert.match(
		readFileSync(resolve(import.meta.dirname, "..", "hutch.config.ts"), "utf8"),
		/"dev:template": \["hutch", "scripts\/dev-template\.ts"\]/,
	);

	const packageDir = join(scratch, "work tree", "electrobun", "package");
	const templatesDir = join(scratch, "work tree", "electrobun", "templates");
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	const hutchEngineBinary = join(packageDir, "tools", "hutch-engine");
	mkdirSync(dirname(hutchEngineBinary), { recursive: true });
	writeFileSync(hutchEngineBinary, "fixture\n");
	mkdirSync(templatesDir, { recursive: true });
	const validTemplate = createTemplate(templatesDir, "hello-world");
	createTemplate(templatesDir, "angular");
	mkdirSync(join(templatesDir, "missing-config"));
	writeFileSync(
		join(templatesDir, "not-a-template"),
		"a file must never become a template\n",
	);

	assert.equal(parseTemplateName(["hello-world"]), "hello-world");
	assert.throws(() => parseTemplateName([]), /Usage: hutch dev:template/);
	assert.throws(
		() => parseTemplateName(["hello-world", "extra"]),
		/Usage: hutch dev:template/,
	);
	assert.deepEqual(availableTemplateNames(templatesDir), ["angular", "hello-world"]);
	assert.equal(
		resolveTemplateDirectory(templatesDir, "hello-world"),
		resolve(validTemplate),
	);
	for (const invalidName of [
		"",
		".",
		"..",
		"../hello-world",
		"hello-world/child",
		"hello-world\\child",
		resolve(validTemplate),
		" hello-world",
		"hello-world ",
		"HELLO-WORLD",
		"missing-config",
		"not-a-template",
	]) {
		assert.throws(
			() => resolveTemplateDirectory(templatesDir, invalidName),
			/Unknown Electrobun template/,
			invalidName,
		);
	}
	assert.throws(
		() => availableTemplateNames(join(scratch, "missing-templates")),
		/Could not read templates directory/,
	);

	writeJson(join(packageDir, "package.json"), {
		name: "electrobun",
		version: "2.0.1-beta.31",
	});
	writeFileSync(
		join(packageDir, "hutch.config.ts"),
		"// @hutch cli=0.24.3 cottontail=0.5.0\nexport default {};\n",
	);
	assert.equal(readPackageVersion(packageDir), "2.0.1-beta.31");
	assert.deepEqual(readPackageHutchPins(packageDir), {
		cli: "0.24.3",
		cottontail: "0.5.0",
	});
	assert.deepEqual(hostDevkitTarget("darwin", "arm64"), {
		os: "macos",
		arch: "arm64",
	});
	assert.deepEqual(hostDevkitTarget("linux", "x64"), {
		os: "linux",
		arch: "x64",
	});
	assert.deepEqual(hostDevkitTarget("win32", "arm64"), {
		os: "win",
		arch: "x64",
	});
	assert.throws(
		() => hostDevkitTarget("aix", "x64"),
		/Unsupported host platform/,
	);
	assert.throws(
		() => hostDevkitTarget("linux", "riscv64"),
		/Unsupported host architecture/,
	);
	writeDevkit(packageDir);
	assert.equal(
		validateBuiltDevkitVersion(
			packageDir,
			"2.0.1-beta.31",
			"darwin",
			"arm64",
		),
		"2.0.1-beta.31",
	);

	const plan = createTemplateDevPlan({
		hutchBinary: "/tools/hutch",
		hutchEngineBinary,
		packageDir,
		templateDir: validTemplate,
		version: "2.0.1-beta.31",
		hutchPins: { cli: "0.24.3", cottontail: "0.5.0" },
	});
	assert.deepEqual(plan.build, {
		label: "Build Electrobun package",
		command: "/tools/hutch",
		args: [join(resolve(packageDir), "build.ts")],
		cwd: resolve(packageDir),
	});
	for (const command of [
		plan.verifyCli,
		plan.verifyCottontail,
		plan.install,
		plan.dev,
	]) {
		assert.equal(command.command, "/tools/hutch");
		assert.equal(command.cwd, resolve(validTemplate));
		assert.deepEqual(command.env, {
			HUTCH_ELECTROBUN_DEVKIT_ROOT: join(resolve(packageDir), "dist"),
			HUTCH_DEFAULT_ELECTROBUN: "2.0.1-beta.31",
			HUTCH_DEFAULT_CLI: "0.24.3",
			HUTCH_ENGINE_BINARY: hutchEngineBinary,
		});
	}
	assert.deepEqual(plan.expectedHutch, {
		cli: "0.24.3",
		cottontail: "0.5.0",
	});
	assert.deepEqual(plan.verifyCli.args, ["--version"]);
	assert.deepEqual(plan.verifyCottontail.args, [
		"-e",
		'process.stdout.write(process.versions.cottontail ?? "")',
	]);
	assert.deepEqual(plan.install.args, ["run", "--if-configured", "install"]);
	assert.deepEqual(plan.dev.args, ["run", "dev"]);
	const conflictingInheritedEnvironment = {
		HUTCH_ACTIVE_CHANNEL: "canary",
		HUTCH_DEFAULT_CLI: "0.5.0-canary.14",
	};
	assert.deepEqual(
		{ ...conflictingInheritedEnvironment, ...plan.install.env },
		{
			HUTCH_ACTIVE_CHANNEL: "canary",
			HUTCH_DEFAULT_CLI: "0.24.3",
			HUTCH_ELECTROBUN_DEVKIT_ROOT: join(resolve(packageDir), "dist"),
			HUTCH_DEFAULT_ELECTROBUN: "2.0.1-beta.31",
			HUTCH_ENGINE_BINARY: hutchEngineBinary,
		},
	);
	assert.equal(
		resolvedHutchEnginePath(`${hutchEngineBinary}\n`),
		hutchEngineBinary,
	);
	assert.throws(
		() => resolvedHutchEnginePath("relative/hutch-engine\n"),
		/did not resolve an absolute engine executable/,
	);
	assert.throws(
		() => resolvedHutchEnginePath(join(packageDir, "missing-engine")),
		/did not resolve an absolute engine executable/,
	);
	assert.equal(verifySelectedHutchVersion("0.24.3\n", "0.24.3", "CLI"), "0.24.3");
	assert.equal(
		verifySelectedHutchVersion("0.5.0", "0.5.0", "Cottontail"),
		"0.5.0",
	);
	assert.throws(
		() => verifySelectedHutchVersion("0.5.1\n", "0.5.0", "Cottontail"),
		/Selected Hutch Cottontail "0\.5\.1" does not match package pin "0\.5\.0"/,
	);

	const events: string[] = [];
	await executeTemplateDevPlan(plan, packageDir, "2.0.1-beta.31", {
		validateBuiltDevkit(directory, version) {
			events.push(`Validate ${directory} ${version}`);
			return version;
		},
		async runAndCaptureWithSignalForwarding(command) {
			events.push(command.label);
			return command === plan.verifyCli ? "0.24.3\n" : "0.5.0";
		},
		async runWithSignalForwarding(command) {
			events.push(command.label);
		},
	});
	assert.deepEqual(events, [
		"Build Electrobun package",
		`Validate ${packageDir} 2.0.1-beta.31`,
		"Verify template Hutch CLI",
		"Verify template Cottontail",
		"Install template dependencies",
		"Launch template development app",
	]);

	for (const failAt of [
		"build",
		"manifest",
		"cli",
		"cottontail",
		"install",
		"dev",
	] as const) {
		const attempted: string[] = [];
		await assert.rejects(
			executeTemplateDevPlan(plan, packageDir, "2.0.1-beta.31", {
				validateBuiltDevkit() {
					attempted.push("manifest");
					if (failAt === "manifest") throw new Error("manifest failed");
					return "2.0.1-beta.31";
				},
				async runAndCaptureWithSignalForwarding(command) {
					const phase = command === plan.verifyCli ? "cli" : "cottontail";
					attempted.push(phase);
					if (phase === failAt) throw new Error(`${phase} failed`);
					return phase === "cli" ? "0.24.3" : "0.5.0";
				},
				async runWithSignalForwarding(command) {
					const phase =
						command === plan.build
							? "build"
							: command === plan.install
								? "install"
								: "dev";
					attempted.push(phase);
					if (phase === failAt) throw new Error(`${phase} failed`);
				},
			}),
			new RegExp(`${failAt} failed`),
		);
		const expectedAttempts = {
			build: ["build"],
			manifest: ["build", "manifest"],
			cli: ["build", "manifest", "cli"],
			cottontail: ["build", "manifest", "cli", "cottontail"],
			install: ["build", "manifest", "cli", "cottontail", "install"],
			dev: [
				"build",
				"manifest",
				"cli",
				"cottontail",
				"install",
				"dev",
			],
		}[failAt];
		assert.deepEqual(attempted, expectedAttempts, failAt);
	}

	const canaryAttempts: string[] = [];
	await assert.rejects(
		executeTemplateDevPlan(plan, packageDir, "2.0.1-beta.31", {
			validateBuiltDevkit() {
				canaryAttempts.push("manifest");
				return "2.0.1-beta.31";
			},
			async runAndCaptureWithSignalForwarding(command) {
				canaryAttempts.push(command === plan.verifyCli ? "cli" : "cottontail");
				return command === plan.verifyCli ? "0.5.0-canary.14\n" : "0.5.0";
			},
			async runWithSignalForwarding(command) {
				canaryAttempts.push(command === plan.build ? "build" : "unexpected");
			},
		}),
		/Selected Hutch CLI "0\.5\.0-canary\.14" does not match package pin "0\.24\.3"/,
	);
	assert.deepEqual(canaryAttempts, ["build", "manifest", "cli"]);

	const manifest = devkitFixture();
	manifest.product.version = "2.0.1-beta.30";
	writeJson(join(packageDir, "dist", "native-devkit.json"), manifest);
	assert.throws(
		() =>
			validateBuiltDevkitVersion(
				packageDir,
				"2.0.1-beta.31",
				"darwin",
				"arm64",
			),
		/product\.version .* does not match package version/,
	);
	manifest.product.version = "latest";
	writeJson(join(packageDir, "dist", "native-devkit.json"), manifest);
	assert.throws(
		() =>
			validateBuiltDevkitVersion(
				packageDir,
				"2.0.1-beta.31",
				"darwin",
				"arm64",
			),
		/must be an exact version using strict SemVer 2\.0\.0/,
	);
	manifest.product.version = "2.0.1-beta.31";
	manifest.schemaVersion = 2;
	writeJson(join(packageDir, "dist", "native-devkit.json"), manifest);
	assert.throws(
		() =>
			validateBuiltDevkitVersion(
				packageDir,
				"2.0.1-beta.31",
				"darwin",
				"arm64",
			),
		/schemaVersion must be 1/,
	);
	manifest.schemaVersion = 1;
	manifest.product.name = "other";
	writeJson(join(packageDir, "dist", "native-devkit.json"), manifest);
	assert.throws(
		() =>
			validateBuiltDevkitVersion(
				packageDir,
				"2.0.1-beta.31",
				"darwin",
				"arm64",
			),
		/product\.name must be "electrobun"/,
	);
	manifest.product.name = "electrobun";
	manifest.target = { os: "linux", arch: "arm64" };
	writeJson(join(packageDir, "dist", "native-devkit.json"), manifest);
	assert.throws(
		() =>
			validateBuiltDevkitVersion(
				packageDir,
				"2.0.1-beta.31",
				"darwin",
				"arm64",
			),
		/target .* does not match/,
	);
	writeFileSync(join(packageDir, "dist", "native-devkit.json"), "not json\n");
	assert.throws(
		() =>
			validateBuiltDevkitVersion(
				packageDir,
				"2.0.1-beta.31",
				"darwin",
				"arm64",
			),
		/could not parse/,
	);
	rmSync(join(packageDir, "dist", "native-devkit.json"));
	assert.throws(
		() =>
			validateBuiltDevkitVersion(
				packageDir,
				"2.0.1-beta.31",
				"darwin",
				"arm64",
			),
		/missing from core root/,
	);

	writeJson(join(packageDir, "package.json"), {
		name: "electrobun",
		version: "latest",
	});
	assert.throws(
		() => readPackageVersion(packageDir),
		/must be an exact SemVer 2\.0\.0 version/,
	);
	writeFileSync(join(packageDir, "package.json"), "not json\n");
	assert.throws(() => readPackageVersion(packageDir), /Could not parse package manifest/);
	rmSync(join(packageDir, "package.json"));
	assert.throws(() => readPackageVersion(packageDir), /Could not read package manifest/);

	writeFileSync(
		join(packageDir, "hutch.config.ts"),
		"// @hutch cottontail=0.5.0 cli=0.24.3\r\nexport default {};\r\n",
	);
	assert.deepEqual(readPackageHutchPins(packageDir), {
		cli: "0.24.3",
		cottontail: "0.5.0",
	});
	for (const invalidPragma of [
		"export default {};\n",
		"// @hutch cli=canary cottontail=0.5.0\n",
		"// @hutch cli=0.24.3 cottontail=latest\n",
		"// @hutch cli=0.24.3\n",
		"// @hutch cli=0.24.3 cli=0.24.4 cottontail=0.5.0\n",
		"// @hutch cli=0.24.3 cottontail=0.5.0 unknown=1.0.0\n",
	]) {
		writeFileSync(join(packageDir, "hutch.config.ts"), invalidPragma);
		assert.throws(() => readPackageHutchPins(packageDir), undefined, invalidPragma);
	}
	rmSync(join(packageDir, "hutch.config.ts"));
	assert.throws(
		() => readPackageHutchPins(packageDir),
		/Could not read package Hutch config/,
	);

	console.log("Electrobun template dev command contract passed");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
