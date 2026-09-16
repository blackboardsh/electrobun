import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import {
	hutchPlatformForHost,
	resolveElectrobunDevkitRootFromHutchStatusOutput,
} from "./orchestrator";
import { isMatchingElectrobunDevkitRoot } from "./project-inspection";

export const TEMPLATE_QA_IDENTIFIER = "template-qa.electrobun.dev";

export function resolveTemplateQaHutchExecutable(
	environment: Record<string, string | undefined> = process.env,
): string {
	return (
		environment.HUTCH_TEMPLATE_QA_EXECUTABLE ??
		environment.HUTCH_LAUNCHER_PATH ??
		"hutch"
	);
}

export function resolveTemplateQaElectrobunDevkitRoot(options: {
	version: string;
	platform: string;
	arch: string;
	inheritedRoot?: string;
	loadHutchStatus: () => string;
}): string {
	const expectedPlatform = hutchPlatformForHost(options.platform, options.arch);
	const expectedTarget = {
		os: expectedPlatform.slice(0, expectedPlatform.lastIndexOf("-")),
		arch: options.arch,
	};
	if (
		options.inheritedRoot &&
		isMatchingElectrobunDevkitRoot(
			options.inheritedRoot,
			options.version,
			expectedTarget,
		)
	) {
		return options.inheritedRoot;
	}

	const root = resolveElectrobunDevkitRootFromHutchStatusOutput(
		options.loadHutchStatus(),
		options.version,
		expectedPlatform,
	);
	if (!isMatchingElectrobunDevkitRoot(root, options.version, expectedTarget)) {
		throw new Error(
			`Hutch reported an invalid Electrobun ${options.version} devkit root at ${root}`,
		);
	}
	return root;
}

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
