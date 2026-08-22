import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatedDirectories = new Set([
	".cottontail-tmp",
	".hutch",
	"artifacts",
	"build",
	"dist",
	"node_modules",
	"templates",
]);

export function cleanTemplateArtifacts(templatesRoot) {
	const root = resolve(templatesRoot);
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		throw new Error(`Templates directory does not exist: ${root}`);
	}

	let removed = 0;
	for (const template of readdirSync(root, { withFileTypes: true })) {
		if (!template.isDirectory()) continue;
		const templateRoot = join(root, template.name);
		if (!existsSync(join(templateRoot, "hutch.config.ts"))) continue;

		for (const entry of readdirSync(templateRoot, { withFileTypes: true })) {
			const generated =
				(entry.isDirectory() && generatedDirectories.has(entry.name)) ||
				(entry.isFile() &&
					(entry.name === ".DS_Store" || entry.name.endsWith(".tsbuildinfo")));
			if (!generated) continue;
			rmSync(join(templateRoot, entry.name), { recursive: true, force: true });
			removed += 1;
		}
	}
	return removed;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	const templatesRoot = resolve(import.meta.dirname, "..", "..", "templates");
	const removed = cleanTemplateArtifacts(templatesRoot);
	console.log(`Cleaned ${removed} generated template artifact${removed === 1 ? "" : "s"}.`);
}
