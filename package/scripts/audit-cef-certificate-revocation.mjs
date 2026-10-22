import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Public compromised SPKIs, including the two code-signing keys, as distrusted
// by Node/Bun and Go in October 2026. Names/issuers alone are not sufficient:
// the same keys occur in certificates signed by multiple roots.
// https://github.com/nodejs/node/pull/66871
// https://github.com/oven-sh/bun/pull/46300
export const EMSIGN_COMPROMISED_SPKIS = Object.freeze([
	"49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f",
	"5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0",
	"63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8",
	"92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30",
	"ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105",
	"ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6",
	"43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b",
	"e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41",
]);

export const CHROMIUM_AUDIT_FILES = Object.freeze([
	"net/cert/crl_set.cc",
	"net/cert/cert_verify_proc_blocklist.inc",
]);

function withoutComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

export function parseBuiltinSpkis(source) {
	const code = withoutComments(source);
	const declaration = /\bkSPKIBlockList\s*\[[^;=]*=\s*\{([\s\S]*?)\n\s*\};/.exec(code);
	if (!declaration) throw new Error("Unsupported Chromium static SPKI blocklist format");
	const entries = [...declaration[1].matchAll(/\{([^{}]+)\}/g)];
	if (entries.length === 0) throw new Error("Chromium static SPKI blocklist is empty");
	const hashes = entries.map(([, entry]) => {
		const bytes = entry.trim().replace(/,\s*$/, "").split(",").map(value => value.trim());
		if (bytes.length !== 32 || bytes.some(value => !/^0x[\da-f]{2}$/i.test(value))) {
			throw new Error("Malformed SHA-256 entry in Chromium static SPKI blocklist");
		}
		return bytes.map(value => value.slice(2).toLowerCase()).join("");
	});
	if (new Set(hashes).size !== hashes.length) throw new Error("Duplicate static SPKI blocklist entries");
	return new Set(hashes);
}

export function auditChromiumSources(chromiumVersion, sources) {
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(chromiumVersion)) throw new Error("Expected an exact Chromium version");
	const blocklist = parseBuiltinSpkis(sources[CHROMIUM_AUDIT_FILES[1]]);
	const crlSource = withoutComments(sources[CHROMIUM_AUDIT_FILES[0]]);
	// Fail closed on upstream refactors: a list present in the tree does not by
	// itself prove the built-in CRLSet actually incorporates it.
	if (!/#include\s+"net\/cert\/cert_verify_proc_blocklist\.inc"/.test(crlSource) ||
		!/for\s*\(const auto& hash : kSPKIBlockList\)\s*\{\s*crl_set->blocked_spkis_\.emplace_back\(/.test(crlSource) ||
		!/CRLSet::BuiltinCRLSet\(\)\s*\{[^}]*CRLSet::Parse\(/.test(crlSource.replace(/"(?:\\.|[^"\\])*"/g, '""'))) {
		throw new Error("Chromium CRLSet integration changed; inspect its static distrust implementation manually");
	}
	const missingSpkis = EMSIGN_COMPROMISED_SPKIS.filter(hash => !blocklist.has(hash));
	return {
		scope: "Exact Chromium source audit; this is not a renderer or binary acceptance test",
		chromiumVersion,
		status: missingSpkis.length ? "missing-static-key-distrust" : "static-key-distrust-present",
		builtinSpkiCount: blocklist.size,
		requiredSpkiCount: EMSIGN_COMPROMISED_SPKIS.length,
		missingSpkis,
		sources: CHROMIUM_AUDIT_FILES.map(path => ({
			path,
			url: `https://github.com/chromium/chromium/blob/${chromiumVersion}/${path}`,
			sha256: createHash("sha256").update(sources[path]).digest("hex"),
		})),
		notes: [
			"Google's dynamic CRLSet and root-store updates are separate from this compiled blocklist.",
			"A missing entry does not establish that every default-root chain is accepted; it means static SPKI distrust is unproven, including alternate or explicitly trusted chains.",
			"CEF's asynchronous CefLoadCRLSetsFile call has no completion callback. Calling it before creating a browser does not establish first-request protection.",
			"Renderer acceptance must distinguish ERR_CERT_REVOKED from untrusted, expired, hostname, connection, and Certificate Transparency failures, and include a valid control.",
		],
	};
}

export async function main(argv = process.argv.slice(2)) {
	let sourceDir;
	let chromiumVersion;
	let requireRevocation = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--require-emsign-revocation") requireRevocation = true;
		else if (argument === "--source-dir") sourceDir = argv[++index];
		else if (argument === "--chromium-version") chromiumVersion = argv[++index];
		else throw new Error(`Unknown argument: ${argument}`);
		if ((argument === "--source-dir" || argument === "--chromium-version") && !argv[index]) {
			throw new Error(`Missing value for ${argument}`);
		}
	}
	if (!chromiumVersion) {
		const pin = readFileSync(new URL("../src/shared/cef-version.ts", import.meta.url), "utf8");
		chromiumVersion = /export const CHROMIUM_VERSION = [`'"](\d+\.\d+\.\d+\.\d+)[`'"]/.exec(pin)?.[1];
	}
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(chromiumVersion ?? "")) throw new Error("Cannot resolve an exact Chromium version");
	const sources = Object.fromEntries(await Promise.all(CHROMIUM_AUDIT_FILES.map(async path => {
		if (sourceDir) return [path, readFileSync(resolve(sourceDir, path), "utf8")];
		const response = await fetch(`https://raw.githubusercontent.com/chromium/chromium/${chromiumVersion}/${path}`, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Failed to fetch ${path}: HTTP ${response.status}`);
		return [path, await response.text()];
	})));
	const report = auditChromiumSources(chromiumVersion, sources);
	console.log(JSON.stringify(report, null, 2));
	return requireRevocation && report.missingSpkis.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then(code => { process.exitCode = code; }).catch(error => {
		console.error(error.stack || String(error));
		process.exitCode = 1;
	});
}
