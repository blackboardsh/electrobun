import { writeFileSync } from "node:fs";
import { join } from "node:path";

const fixtures = Object.freeze({
	bun: { directory: "updater-lifecycle", control: "control.ts" },
	zig: { directory: "updater-lifecycle-native", control: "control.json" },
});

function fixtureFor(backend) {
	if (!Object.hasOwn(fixtures, backend)) {
		throw new Error(`unsupported updater lifecycle backend: ${backend}; expected bun or zig`);
	}
	return fixtures[backend];
}

/** Remove only the fixture selector, preserving the existing focus parser. */
export function parseUpdaterLifecycleBackend(args) {
	let backend = "bun";
	let selected = false;
	const remaining = [];
	for (const arg of args) {
		if (arg === "--backend") {
			throw new Error("updater lifecycle backend requires --backend=bun|zig");
		}
		if (!arg.startsWith("--backend=")) {
			remaining.push(arg);
			continue;
		}
		if (selected) throw new Error("updater lifecycle backend must be selected only once");
		backend = arg.slice("--backend=".length);
		fixtureFor(backend);
		selected = true;
	}
	return { backend, args: remaining };
}

export function updaterLifecycleFixturePath(packageRoot, backend) {
	return join(packageRoot, "test-apps", fixtureFor(backend).directory);
}

/** Controls are generated only inside the runner's private fixture copy. */
export function writeUpdaterLifecycleControl(projectRoot, backend, control) {
	const path = join(projectRoot, "src", fixtureFor(backend).control);
	const json = JSON.stringify(control, null, 2);
	writeFileSync(path, backend === "bun" ? `export const control = ${json} as const;\n` : `${json}\n`, "utf8");
	return path;
}
