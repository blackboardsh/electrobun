import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = join(import.meta.dirname, "..");

function readSource(relativePath: string): string {
	return readFileSync(join(sourceRoot, relativePath), "utf8");
}

const sources = {
	typescript: readSource("sdks/main/proc/native.ts"),
	core: readSource("core/main.zig"),
	rust: readSource("sdks/rust/electrobun.rs"),
	zig: readSource("sdks/zig/electrobun.zig"),
	go: readSource("sdks/go/electrobun.go"),
	odin: readSource("sdks/odin/electrobun.odin"),
	wrappers: {
		darwin: readSource("native/macos/nativeWrapper.mm"),
		linux: readSource("native/linux/nativeWrapper.cpp"),
		win32: readSource("native/win/nativeWrapper.cpp"),
	},
};

function sourceSection(
	source: string,
	startMarker: string,
	endMarker: string,
	label: string,
): string {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	if (start === -1 || end === -1) {
		throw new Error(`Could not find ${label}`);
	}
	return source.slice(start, end);
}

function captures(source: string, pattern: RegExp): string[] {
	return Array.from(source.matchAll(pattern), (match) => match[1]!);
}

function uniqueSorted(symbols: readonly string[]): string[] {
	return [...new Set(symbols)].sort();
}

function requireContract(
	label: string,
	symbols: readonly string[],
	minimumSize: number,
): string[] {
	const result = uniqueSorted(symbols);
	if (result.length < minimumSize) {
		throw new Error(
			`${label} parser found ${result.length} symbols; expected at least ${minimumSize}`,
		);
	}
	return result;
}

function descriptorNamesAtIndent(source: string, tabs: number): string[] {
	return captures(
		source,
		new RegExp(`^\\t{${tabs}}([A-Za-z_$][\\w$]*): \\{$`, "gm"),
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The wrappers mix individually exported functions with functions inside an
// `extern "C"` block, so source-level ABI checking deliberately recognizes a
// definition rather than requiring the export marker on the same line.
function definesNativeFunction(source: string, symbol: string): boolean {
	const functionDefinition = new RegExp(
		`^[\\t ]*(?:(?:extern\\s+"C"|ELECTROBUN_EXPORT)\\s+)*` +
			`[A-Za-z_][A-Za-z0-9_:<>, \\t*&]*\\b${escapeRegExp(symbol)}` +
			"\\s*\\([^;]*?\\)\\s*\\{",
		"m",
	);
	return functionDefinition.test(source);
}

const typescriptCoreTable = sourceSection(
	sources.typescript,
	"return tryDlopenCandidates(coreFileName, {",
	"\n\t\t});",
	"TypeScript ElectrobunCore descriptor table",
);
const typescriptNativeTable = sourceSection(
	sources.typescript,
	"return tryDlopenCandidates(nativeWrapperFileName, {",
	"\n\t\t});",
	"TypeScript NativeWrapper descriptor table",
);
const darwinDescriptorBlock = sourceSection(
	typescriptNativeTable,
	'\t\t\t...(process.platform === "darwin"',
	"\n\t\t\t\t: {}),",
	"Darwin NativeWrapper descriptor block",
);

const directWrapperCommonSymbols = requireContract(
	"TypeScript NativeWrapper descriptor table",
	descriptorNamesAtIndent(typescriptNativeTable, 3),
	60,
);
const directWrapperDarwinSymbols = descriptorNamesAtIndent(
	darwinDescriptorBlock,
	5,
);
const expectedDirectWrapperDarwinSymbols = [
	"setWGPUKeyHandler",
	"setWGPUPointerHandler",
	"uiFreeTextBitmap",
	"uiMeasureText",
	"uiRasterizeText",
	"wgpuViewSetAlphaBlending",
].sort();

const coreBootstrapWrapperSymbols = requireContract(
	"ElectrobunCore NativeWrapper bootstrap",
	captures(
		sources.core,
		/native_wrapper\.lookup\(\s*[^,]+,\s*"([A-Za-z_$][\w$]*)"/gs,
	),
	2,
);
const coreLazyWrapperSymbols = requireContract(
	"ElectrobunCore NativeWrapper lookups",
	captures(
		sources.core,
		/lookupNativeSymbol\(\s*[^,]+,\s*"([A-Za-z_$][\w$]*)"/gs,
	),
	80,
);
const allCoreWrapperSymbols = uniqueSorted([
	...coreBootstrapWrapperSymbols,
	...coreLazyWrapperSymbols,
]);
const coreDarwinOnlyWrapperSymbols = ["runNativeEventLoopTick"];

const coreExports = requireContract(
	"ElectrobunCore exports",
	captures(sources.core, /^export fn ([A-Za-z_$][\w$]*)\s*\(/gm),
	100,
);

const rustCoreLoad = sourceSection(
	sources.rust,
	"let symbols = Symbols {",
	"\n        };",
	"Rust ElectrobunCore symbol table",
);
const zigCoreLoad = sourceSection(
	sources.zig,
	"pub fn load(allocator: std.mem.Allocator) !Core {",
	"pub fn close(self: *Core)",
	"Zig ElectrobunCore loader",
);
const goCoreTable = sourceSection(
	sources.go,
	"var requiredSymbols = []string{",
	"\n}",
	"Go ElectrobunCore symbol table",
);
const odinCoreTable = sourceSection(
	sources.odin,
	"\nSymbols :: struct {",
	"\n}",
	"Odin ElectrobunCore symbol table",
);

const eagerCoreDemands = {
	typescript: requireContract(
		"TypeScript ElectrobunCore descriptor table",
		descriptorNamesAtIndent(typescriptCoreTable, 3),
		100,
	),
	rust: requireContract(
		"Rust ElectrobunCore symbol table",
		captures(rustCoreLoad, /lib\s*\.symbol\("([A-Za-z_$][\w$]*)"\)/g),
		100,
	),
	zig: requireContract(
		"Zig ElectrobunCore symbol table",
		captures(
			zigCoreLoad,
			/lib\.lookup\(\s*[^,]+,\s*"([A-Za-z_$][\w$]*)"/gs,
		),
		100,
	),
	go: requireContract(
		"Go ElectrobunCore symbol table",
		captures(goCoreTable, /"([A-Za-z_$][\w$]*)"/g),
		100,
	),
	odin: requireContract(
		"Odin ElectrobunCore symbol table",
		captures(odinCoreTable, /^[\t ]+([A-Za-z_$][\w$]*)[\t ]*:(?!:)/gm).filter(
			(symbol) => symbol !== "__handle",
		),
		100,
	),
};

describe("TypeScript to NativeWrapper ABI", () => {
	test("keeps exactly the six macOS-only descriptors out of the common table", () => {
		expect(uniqueSorted(directWrapperDarwinSymbols)).toEqual(
			expectedDirectWrapperDarwinSymbols,
		);
		for (const symbol of expectedDirectWrapperDarwinSymbols) {
			expect(directWrapperCommonSymbols).not.toContain(symbol);
			expect(definesNativeFunction(sources.wrappers.darwin, symbol)).toBe(true);
			expect(definesNativeFunction(sources.wrappers.linux, symbol)).toBe(false);
			expect(definesNativeFunction(sources.wrappers.win32, symbol)).toBe(false);
		}
	});

	test.each([
		["darwin", uniqueSorted([...directWrapperCommonSymbols, ...directWrapperDarwinSymbols])],
		["linux", directWrapperCommonSymbols],
		["win32", directWrapperCommonSymbols],
	] as const)("every %s descriptor has a wrapper definition", (platform, symbols) => {
		const missing = symbols.filter(
			(symbol) => !definesNativeFunction(sources.wrappers[platform], symbol),
		);
		expect(missing).toEqual([]);
	});
});

describe("ElectrobunCore to NativeWrapper ABI", () => {
	test("requires the stable two-symbol wrapper bootstrap", () => {
		expect(coreBootstrapWrapperSymbols).toEqual(["forceExit", "startEventLoop"]);
	});

	test.each(["darwin", "linux", "win32"] as const)(
		"every %s Core lookup has a wrapper definition",
		(platform) => {
			const missing = allCoreWrapperSymbols.filter(
				(symbol) => !definesNativeFunction(sources.wrappers[platform], symbol),
			);
			expect(missing).toEqual(
				platform === "darwin" ? [] : coreDarwinOnlyWrapperSymbols,
			);
		},
	);
});

describe("SDK to ElectrobunCore ABI", () => {
	test.each(Object.entries(eagerCoreDemands))(
		"every eagerly loaded %s symbol is exported by ElectrobunCore",
		(_sdk, symbols) => {
			const missing = symbols.filter((symbol) => !coreExports.includes(symbol));
			expect(missing).toEqual([]);
		},
	);
});
