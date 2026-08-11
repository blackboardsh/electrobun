import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export const TEMPLATE_QA_IDENTIFIER = "template-qa.electrobun.dev";

export function findTemplateQaProjectRoot(
	start = process.cwd(),
	configured = process.env.ELECTROBUN_TEMPLATE_QA_ROOT,
): string {
	if (configured) return realpathSync(configured);

	let candidate = resolve(start);
	const filesystemRoot = parse(candidate).root;
	while (true) {
		const configPath = join(candidate, "electrobun.config.ts");
		if (existsSync(configPath)) {
			try {
				const source = readFileSync(configPath, "utf8");
				if (
					new RegExp(
						`\\bidentifier\\s*:\\s*["']${TEMPLATE_QA_IDENTIFIER.replaceAll(".", "\\.")}["']`,
					).test(source)
				) {
					return candidate;
				}
			} catch {
				// Continue walking; an unrelated ancestor may be unreadable.
			}
		}
		if (candidate === filesystemRoot) break;
		candidate = dirname(candidate);
	}
	throw new Error(
		"Could not find the Template QA project root. Set ELECTROBUN_TEMPLATE_QA_ROOT to the installed all-template directory.",
	);
}
