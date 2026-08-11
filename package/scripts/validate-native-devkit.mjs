import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
	isExactOdinRelease,
	isStrictSemVer,
} from "../src/shared/strict-semver.js";

export const NATIVE_DEVKIT_MANIFEST_FILENAME = "native-devkit.json";
export const ELECTROBUN_GO_SDK_MODULE = "electrobun";

const runtimePathKeys = [
	"main",
	"preloadFull",
	"preloadSandboxed",
	"bun",
	"launcher",
	"extractor",
	"coreLibrary",
	"nativeWrapper",
	"nativeWrapperCef",
	"asarLibrary",
	"wgpuLibrary",
	"processHelper",
	"bsdiff",
	"bspatch",
	"zigAsar",
	"zigZstd",
];
function fail(message) {
	throw new Error(`Invalid ${NATIVE_DEVKIT_MANIFEST_FILENAME}: ${message}`);
}

function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	return value;
}

function string(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		fail(`${label} must be a non-empty string`);
	}
	return value;
}

function positiveInteger(value, label) {
	if (!Number.isInteger(value) || value < 1) {
		fail(`${label} must be a positive integer`);
	}
	return value;
}

function exactVersion(value, label, isValid = isStrictSemVer) {
	const version = string(value, label);
	if (!isValid(version)) {
		fail(`${label} must be an exact version using strict SemVer 2.0.0`);
	}
	return version;
}

function relativePath(value, label) {
	const path = string(value, label);
	if (
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		fail(`${label} must be a normalized POSIX path relative to the core root`);
	}
	return path;
}

function validateAbi(value, label, expectedName) {
	const abi = object(value, label);
	if (abi.name !== expectedName) {
		fail(`${label}.name must be ${JSON.stringify(expectedName)}`);
	}
	positiveInteger(abi.version, `${label}.version`);
}

function collectSdkPaths(sdks) {
	const javascript = object(sdks.javascript, "layout.sdks.javascript");
	const exports = object(
		javascript.exports,
		"layout.sdks.javascript.exports",
	);
	if (Object.keys(exports).length === 0) {
		fail("layout.sdks.javascript.exports must not be empty");
	}

	const paths = [
		relativePath(javascript.root, "layout.sdks.javascript.root"),
		relativePath(javascript.main, "layout.sdks.javascript.main"),
		relativePath(javascript.browser, "layout.sdks.javascript.browser"),
		relativePath(javascript.config, "layout.sdks.javascript.config"),
		relativePath(javascript.preload, "layout.sdks.javascript.preload"),
	];

	for (const [specifier, path] of Object.entries(exports)) {
		if (specifier !== "." && !specifier.startsWith("./")) {
			fail(
				`layout.sdks.javascript.exports key ${JSON.stringify(specifier)} must be "." or start with "./"`,
			);
		}
		paths.push(
			relativePath(path, `layout.sdks.javascript.exports[${JSON.stringify(specifier)}]`),
		);
	}

	for (const language of ["zig"]) {
		const sdk = object(sdks[language], `layout.sdks.${language}`);
		paths.push(relativePath(sdk.root, `layout.sdks.${language}.root`));
		paths.push(
			relativePath(sdk.entrypoint, `layout.sdks.${language}.entrypoint`),
		);
	}

	const go = object(sdks.go, "layout.sdks.go");
	const goRoot = relativePath(go.root, "layout.sdks.go.root");
	const goManifest = relativePath(go.manifest, "layout.sdks.go.manifest");
	if (goManifest !== `${goRoot}/go.mod`) {
		fail("layout.sdks.go.manifest must be go.mod at layout.sdks.go.root");
	}
	paths.push(goRoot, goManifest);
	const goModule = string(go.module, "layout.sdks.go.module");
	if (goModule.trim() !== goModule || /\s/.test(goModule)) {
		fail("layout.sdks.go.module must be a Go module import path");
	}
	if (goModule !== ELECTROBUN_GO_SDK_MODULE) {
		fail(
			`layout.sdks.go.module must be ${JSON.stringify(ELECTROBUN_GO_SDK_MODULE)}`,
		);
	}

	const rust = object(sdks.rust, "layout.sdks.rust");
	const rustRoot = relativePath(rust.root, "layout.sdks.rust.root");
	const rustManifest = relativePath(
		rust.manifest,
		"layout.sdks.rust.manifest",
	);
	if (rustManifest !== `${rustRoot}/Cargo.toml`) {
		fail("layout.sdks.rust.manifest must be Cargo.toml at layout.sdks.rust.root");
	}
	paths.push(rustRoot, rustManifest);

	const odin = object(sdks.odin, "layout.sdks.odin");
	paths.push(relativePath(odin.root, "layout.sdks.odin.root"));
	paths.push(relativePath(odin.entrypoint, "layout.sdks.odin.entrypoint"));
	paths.push(relativePath(odin.collection, "layout.sdks.odin.collection"));
	string(odin.collectionName, "layout.sdks.odin.collectionName");

	return paths;
}

export function validateNativeDevkitManifest(options) {
	const manifestPath = resolve(
		options.coreRoot,
		NATIVE_DEVKIT_MANIFEST_FILENAME,
	);
	if (!existsSync(manifestPath)) {
		fail(`missing from core root ${options.coreRoot}`);
	}

	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		fail(`could not parse ${manifestPath}: ${error.message}`);
	}
	object(manifest, "manifest");

	if (manifest.schemaVersion !== 1) {
		fail(`schemaVersion must be 1, got ${JSON.stringify(manifest.schemaVersion)}`);
	}

	const product = object(manifest.product, "product");
	if (product.name !== "electrobun") fail('product.name must be "electrobun"');
	const productVersion = exactVersion(product.version, "product.version");
	const expectedVersion = exactVersion(
		options.expectedVersion,
		"expected product version",
	);
	if (productVersion !== expectedVersion) {
		fail(
			`product.version ${JSON.stringify(productVersion)} does not match package version ${JSON.stringify(expectedVersion)}`,
		);
	}

	const target = object(manifest.target, "target");
	if (
		target.os !== options.expectedTarget.os ||
		target.arch !== options.expectedTarget.arch
	) {
		fail(
			`target ${JSON.stringify(target)} does not match ${JSON.stringify(options.expectedTarget)}`,
		);
	}

	const abi = object(manifest.abi, "abi");
	validateAbi(abi.core, "abi.core", "electrobun-core");
	validateAbi(abi.sdk, "abi.sdk", "electrobun-sdk");

	const toolchains = object(manifest.toolchains, "toolchains");
	for (const language of ["zig", "rust", "go"]) {
		const toolchain = object(toolchains[language], `toolchains.${language}`);
		exactVersion(
			toolchain.defaultVersion,
			`toolchains.${language}.defaultVersion`,
		);
	}
	const odinToolchain = object(toolchains.odin, "toolchains.odin");
	exactVersion(
		odinToolchain.defaultVersion,
		"toolchains.odin.defaultVersion",
		isExactOdinRelease,
	);
	const runtimes = object(manifest.runtimes, "runtimes");
	const bunRuntime = object(runtimes.bun, "runtimes.bun");
	exactVersion(bunRuntime.version, "runtimes.bun.version");

	const layout = object(manifest.layout, "layout");
	const runtime = object(layout.runtime, "layout.runtime");
	const declaredPaths = runtimePathKeys.map((key) =>
		relativePath(runtime[key], `layout.runtime.${key}`),
	);
	declaredPaths.push(...collectSdkPaths(object(layout.sdks, "layout.sdks")));

	const coreRoot = resolve(options.coreRoot);
	for (const path of new Set(declaredPaths)) {
		const absolutePath = resolve(coreRoot, path);
		if (!absolutePath.startsWith(`${coreRoot}${sep}`)) {
			fail(`declared path escapes core root: ${JSON.stringify(path)}`);
		}
		if (!existsSync(absolutePath)) {
			fail(`declared path does not exist: ${JSON.stringify(path)}`);
		}
	}

	const go = object(object(layout.sdks, "layout.sdks").go, "layout.sdks.go");
	const goManifest = resolve(
		coreRoot,
		relativePath(go.manifest, "layout.sdks.go.manifest"),
	);
	const moduleDirective = readFileSync(goManifest, "utf8").match(
		/^[\t ]*module[\t ]+([^\s]+)[\t ]*(?:\/\/.*)?$/m,
	)?.[1];
	if (moduleDirective !== go.module) {
		fail(
			`layout.sdks.go.module ${JSON.stringify(go.module)} does not match ${JSON.stringify(moduleDirective)} in ${JSON.stringify(go.manifest)}`,
		);
	}
	const goSource = readFileSync(goManifest, "utf8");
	const languageDirective = goSource.match(
		/^[\t ]*go[\t ]+(\d+)\.(\d+)(?:\.(\d+))?[\t ]*(?:\/\/.*)?$/m,
	);
	if (!languageDirective) {
		fail(`${JSON.stringify(go.manifest)} must declare a valid Go language version`);
	}
	const languageVersion = languageDirective
		.slice(1)
		.map((part) => Number(part ?? "0"));
	const compilerVersion = toolchains.go.defaultVersion
		.match(/^(\d+)\.(\d+)\.(\d+)/)
		.slice(1)
		.map(Number);
	for (let index = 0; index < languageVersion.length; index++) {
		if (languageVersion[index] < compilerVersion[index]) break;
		if (languageVersion[index] > compilerVersion[index]) {
			fail(
				`${JSON.stringify(go.manifest)} requires Go ${languageDirective[0].trim().slice(3)}, newer than toolchains.go.defaultVersion ${toolchains.go.defaultVersion}`,
			);
		}
	}

	return manifest;
}
