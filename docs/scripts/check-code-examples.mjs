import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFragment } from "parse5";
import postcss from "postcss";
import { remark } from "remark";
import remarkMdx from "remark-mdx";
import { visit } from "unist-util-visit";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(docsRoot, "..");
const contentRoot = join(docsRoot, "src", "content", "docs");
const packageRoot = join(repoRoot, "package");
const packageSource = join(packageRoot, "src");

const errors = [];
const typecheckExamples = [];
const counts = {
	files: 0,
	blocks: 0,
	links: 0,
	typechecked: 0,
	historical: 0,
};

const languageAliases = new Map([
	["js", "javascript"],
	["javascript", "javascript"],
	["ts", "typescript"],
	["typescript", "typescript"],
	["tsx", "tsx"],
	["go", "go"],
	["odin", "odin"],
	["rust", "rust"],
	["toml", "toml"],
	["zig", "zig"],
	["sh", "bash"],
	["shell", "bash"],
	["bash", "bash"],
	["html", "html"],
	["css", "css"],
	["json", "json"],
	["jsonc", "jsonc"],
	["yaml", "yaml"],
	["yml", "yaml"],
	["powershell", "powershell"],
	["text", "text"],
]);

const validModes = new Set([
	"typecheck",
	"syntax",
	"fragment",
	"output",
	"historical",
]);

const contextPrelude = {
	"browser-window": `
import type { BrowserWindow as __BrowserWindow } from "electrobun/main";
declare const win: __BrowserWindow;
declare const mainWindow: __BrowserWindow;
declare const browserWindow: __BrowserWindow;
`,
	"browser-view": `
import type { BrowserView as __BrowserView } from "electrobun/main";
declare const view: __BrowserView;
declare const mainView: __BrowserView;
declare const browserView: __BrowserView;
`,
	tray: `
import type { Tray as __Tray } from "electrobun/main";
declare const tray: __Tray;
`,
	electrobun: `
declare const Electrobun: typeof import("electrobun/main").default;
`,
	"webview-element": `
import type { WebviewTagElement as __WebviewTagElement } from "electrobun/view";
declare const webview: __WebviewTagElement;
`,
	"webgpu-readback": `
declare const readbackBuffer: {
  mapAsync(mode?: number, offset?: number, size?: number): Promise<boolean>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
};
`,
};

function addError(file, line, message) {
	errors.push(`${relative(repoRoot, file)}:${line}: ${message}`);
}

function walk(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walk(path));
		else if ([".md", ".mdx"].includes(extname(entry.name))) files.push(path);
	}
	return files;
}

function routeForFile(file) {
	let route = relative(contentRoot, file)
		.replaceAll("\\", "/")
		.replace(/\.(?:md|mdx)$/, "");
	if (route.endsWith("/index")) route = route.slice(0, -"/index".length);
	return `/${route}`;
}

function validateInternalLink(file, node, url, routes) {
	if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) {
		return;
	}
	counts.links += 1;
	const pathname = url.split(/[?#]/, 1)[0];
	const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	if (!routes.has(normalized)) {
		addError(file, node.position?.start.line ?? 1, `internal link has no page: ${url}`);
	}
}

function validateLinks(file, tree, routes) {
	visit(tree, "link", (node) => validateInternalLink(file, node, node.url, routes));
	visit(tree, (node) => {
		if (
			(node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") ||
			node.name !== "a"
		) {
			return;
		}
		const href = node.attributes?.find(
			(attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === "href",
		)?.value;
		validateInternalLink(file, node, href, routes);
	});
}

function stripFrontmatter(source) {
	if (!source.startsWith("---\n")) return source;
	const end = source.indexOf("\n---\n", 4);
	if (end === -1) return source;
	const frontmatter = source.slice(0, end + 5);
	return "\n".repeat(frontmatter.split("\n").length - 1) + source.slice(end + 5);
}

function parseMeta(meta) {
	const result = {};
	for (const match of (meta ?? "").matchAll(/(?:^|\s)([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) {
		result[match[1]] = match[2] ?? match[3] ?? match[4];
	}
	return result;
}

function validateJavascriptSyntax(file, line, code, language, mode) {
	const scriptKind = language === "tsx"
		? ts.ScriptKind.TSX
		: language === "typescript"
			? ts.ScriptKind.TS
			: ts.ScriptKind.JS;
	const candidates = mode === "fragment"
		? [code, `const __value = (${code});`, `const __value = {${code}};`]
		: [code];
	let diagnostics = [];
	for (const candidate of candidates) {
		const source = ts.createSourceFile(
			`${file}.${language === "tsx" ? "tsx" : language === "typescript" ? "ts" : "js"}`,
			candidate,
			ts.ScriptTarget.Latest,
			true,
			scriptKind,
		);
		diagnostics = source.parseDiagnostics;
		if (diagnostics.length === 0) return;
	}
	for (const diagnostic of diagnostics) {
		addError(file, line, ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
	}
}

function validateBash(file, line, code) {
	const result = spawnSync("bash", ["-n"], { input: code, encoding: "utf8" });
	if (result.status !== 0) {
		addError(file, line, `invalid bash: ${(result.stderr || result.stdout).trim()}`);
	}
}

function validateBlock(file, node, historicalFile) {
	counts.blocks += 1;
	const line = node.position?.start.line ?? 1;
	if (historicalFile) {
		counts.historical += 1;
		return;
	}
	const rawLanguage = (node.lang ?? "").toLowerCase();
	const language = languageAliases.get(rawLanguage);
	const meta = parseMeta(node.meta);
	const mode = meta.docs ?? (
		["javascript", "typescript"].includes(language)
			? "typecheck"
			: language === "text"
				? "output"
				: "syntax"
	);

	if (!language) {
		addError(
			file,
			line,
			rawLanguage
				? `unknown code-block language "${rawLanguage}"`
				: "code block must declare a language (use text for non-executable output)",
		);
		return;
	}

	if (mode && !validModes.has(mode)) {
		addError(file, line, `unknown docs validation mode "${mode}"`);
		return;
	}
	if (mode === "typecheck" && !["javascript", "typescript"].includes(language)) {
		addError(file, line, "docs=typecheck is only valid for JavaScript and TypeScript blocks");
		return;
	}

	if (/[&](?:gt|lt|amp|quot|#39|#58);/.test(node.value)) {
		addError(file, line, "code contains an HTML entity; use the literal source character");
	}

	if (["javascript", "typescript", "tsx"].includes(language)) {
		validateJavascriptSyntax(file, line, node.value, language, mode);
		if (
			mode === "typecheck" &&
			/export\s+default\s+\{/.test(node.value) &&
			/(?:\bapp\s*:|\bbuild\s*:|\brelease\s*:)/.test(node.value) &&
			!node.value.includes("satisfies ElectrobunConfig")
		) {
			addError(
				file,
				line,
				"Electrobun config examples must use `satisfies ElectrobunConfig`",
			);
		}
		if (mode === "typecheck") {
			const context = meta.context;
			if (context && !contextPrelude[context]) {
				addError(file, line, `unknown typecheck context "${context}"`);
				return;
			}
			typecheckExamples.push({
				file,
				line,
				language,
				code: `${context ? contextPrelude[context] : ""}\n${node.value}\nexport {};`,
			});
		}
		return;
	}

	if (mode === "output" || mode === "historical") return;

	try {
		switch (language) {
			case "json":
				JSON.parse(node.value);
				break;
			case "yaml":
				parseYaml(node.value);
				break;
			case "html": {
				const parseErrors = [];
				parseFragment(node.value, { onParseError: (error) => parseErrors.push(error) });
				for (const error of parseErrors) {
					addError(file, line + (error.startLine ?? 1) - 1, `invalid HTML: ${error.code}`);
				}
				break;
			}
			case "css":
				postcss.parse(node.value, { from: undefined });
				break;
			case "bash":
				validateBash(file, line, node.value);
				break;
			case "powershell":
			case "text":
				break;
		}
	} catch (error) {
		addError(file, line, `${language} parse failed: ${error.message}`);
	}
}

function typecheck() {
	if (typecheckExamples.length === 0) return;
	if (!existsSync(packageSource)) {
		errors.push("package/src is missing; documentation examples cannot resolve Electrobun types");
		return;
	}

	const virtualSources = new Map();
	for (const [index, example] of typecheckExamples.entries()) {
		const path = join(docsRoot, ".doc-tests", `example-${index}.ts`);
		virtualSources.set(path, example);
	}

	const compilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
		strict: true,
		noImplicitAny: false,
		noEmit: true,
		skipLibCheck: true,
		allowJs: true,
		checkJs: true,
		allowImportingTsExtensions: true,
		baseUrl: repoRoot,
		paths: {
			electrobun: ["package/src/sdks/main/index.ts"],
			"electrobun/main": ["package/src/sdks/main/index.ts"],
			"electrobun/main/*": ["package/src/sdks/main/entries/*.ts"],
			"electrobun/bun": ["package/src/sdks/main/index.ts"],
			"electrobun/bun/*": ["package/src/sdks/main/entries/*.ts"],
			"electrobun/rpc": ["package/src/sdks/main/entries/rpc.ts"],
			"electrobun/view": ["package/src/browser/index.ts"],
		},
		types: ["bun"],
		typeRoots: [join(docsRoot, "node_modules", "@types")],
	};
	const host = ts.createCompilerHost(compilerOptions);
	const defaultGetSourceFile = host.getSourceFile.bind(host);
	host.fileExists = (path) => virtualSources.has(path) || ts.sys.fileExists(path);
	host.readFile = (path) => virtualSources.get(path)?.code ?? ts.sys.readFile(path);
	host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
		const example = virtualSources.get(path);
		if (example) {
			return ts.createSourceFile(path, example.code, languageVersion, true, ts.ScriptKind.TS);
		}
		return defaultGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
	};

	const program = ts.createProgram([...virtualSources.keys()], compilerOptions, host);
	for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
		if (!diagnostic.file || !virtualSources.has(diagnostic.file.fileName)) continue;
		const example = virtualSources.get(diagnostic.file.fileName);
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
		const offset = diagnostic.start === undefined
			? 0
			: diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line;
		addError(example.file, example.line + offset, `typecheck failed: ${message}`);
	}
	counts.typechecked = typecheckExamples.length;
}

const documentationFiles = walk(contentRoot).sort();
const routes = new Set(documentationFiles.map(routeForFile));

for (const file of documentationFiles) {
	counts.files += 1;
	const source = readFileSync(file, "utf8");
	const historicalFile = /\/guides\/changelog\/v1-[^/]+\.mdx$/.test(file);
	let tree;
	try {
		tree = remark().use(remarkMdx).parse(stripFrontmatter(source));
	} catch (error) {
		addError(file, 1, `MDX parse failed: ${error.message}`);
		continue;
	}
	validateLinks(file, tree, routes);
	visit(tree, "code", (node) => validateBlock(file, node, historicalFile));
}

typecheck();

if (errors.length > 0) {
	console.error(`Documentation example validation failed with ${errors.length} error(s):`);
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log(
	`Validated ${counts.blocks} code blocks across ${counts.files} docs files ` +
		`(${counts.typechecked} typechecked, ${counts.historical} historical) and ` +
		`${counts.links} internal links.`,
);
