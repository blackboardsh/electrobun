import { resolve } from "node:path";
import ts from "typescript";
import { ELECTROBUN_JAVASCRIPT_SDK_EXPORTS } from "../src/shared/native-devkit-manifest";

/** Check current Kitchen sources without requiring a matching native build. */
export function checkKitchenTypes(repositoryRoot = resolve(import.meta.dirname, "../..")): readonly ts.Diagnostic[] {
	const kitchenRoot = resolve(repositoryRoot, "kitchen");
	const configPath = resolve(kitchenRoot, "tsconfig.json");
	const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
	if (loaded.error) return [loaded.error];
	const { extends: generatedConfig, ...config } = loaded.config;
	if (generatedConfig !== "./.hutch/devkit/tsconfig.json") {
		throw new Error("Kitchen typecheck expects its generated devkit tsconfig parent");
	}
	// The prepared devkit maps these same exports to api/. Use their source
	// equivalents so a version bump cannot leave preflight checking an old SDK.
	const paths = Object.fromEntries(Object.entries(ELECTROBUN_JAVASCRIPT_SDK_EXPORTS).map(([name, target]) => [
		name === "." ? "electrobun" : `electrobun${name.slice(1)}`,
		[resolve(repositoryRoot, "package/src", target.slice("api/".length))],
	]));
	const parsed = ts.parseJsonConfigFileContent({
		...config,
		compilerOptions: { baseUrl: kitchenRoot, paths, ...config.compilerOptions },
	}, ts.sys, kitchenRoot, undefined, configPath);
	if (parsed.errors.length) return parsed.errors;
	return ts.getPreEmitDiagnostics(ts.createProgram({
		rootNames: parsed.fileNames,
		options: { ...parsed.options, noEmit: true },
		projectReferences: parsed.projectReferences,
	}));
}

if (import.meta.main) {
	const diagnostics = checkKitchenTypes();
	if (diagnostics.length) {
		console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCurrentDirectory: () => process.cwd(),
			getCanonicalFileName: path => path,
			getNewLine: () => ts.sys.newLine,
		}));
		process.exitCode = 1;
	} else {
		console.log("Kitchen typecheck passed against the current SDK sources.");
	}
}
