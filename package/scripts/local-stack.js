import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function formatExitStatus(status) {
	const value = status ?? 1;
	return process.platform === "win32"
		? `0x${(value >>> 0).toString(16).padStart(8, "0").toUpperCase()}`
		: String(value);
}

export function prepareLocalStack(packageDir) {
	const electrobunRoot = resolve(packageDir, "..");
	const projectsRoot = resolve(
		process.env.DASH_LOCAL_PROJECTS_ROOT || resolve(electrobunRoot, ".."),
	);
	const dashCliRoot = resolve(
		process.env.DASH_CLI_ROOT || join(projectsRoot, "dash-cloud", "dash-cli"),
	);
	const cottontailRoot = resolve(
		process.env.DASH_LOCAL_COTTONTAIL_ROOT ||
			process.env.COTTONTAIL_ROOT ||
			join(projectsRoot, "cottontail"),
	);
	const localStackScript = resolve(
		process.env.DASH_LOCAL_STACK_SCRIPT ||
			join(dashCliRoot, "scripts", "local-stack.js"),
	);
	const binaryExtension = process.platform === "win32" ? ".exe" : "";
	const localDash = join(dashCliRoot, "zig-out", "bin", `dash${binaryExtension}`);
	const localCottontail = join(
		cottontailRoot,
		"zig-out",
		"bin",
		`cottontail${binaryExtension}`,
	);

	if (!existsSync(localStackScript)) {
		throw new Error(`[local-stack] Dash local stack script is missing: ${localStackScript}`);
	}
	const prepared = spawnSync(
		process.env.NODE_BINARY ?? "node",
		[localStackScript, "--through=electrobun"],
		{
			cwd: packageDir,
			env: {
				...process.env,
				DASH_LOCAL_PROJECTS_ROOT: projectsRoot,
				DASH_LOCAL_COTTONTAIL_ROOT: cottontailRoot,
				COTTONTAIL_ROOT: cottontailRoot,
				DASH_LOCAL_ELECTROBUN_ROOT: electrobunRoot,
			},
			stdio: "inherit",
		},
	);
	if (prepared.error) {
		throw new Error(`[local-stack] Failed to prepare local stack: ${prepared.error.message}`);
	}
	if (prepared.status !== 0) {
		throw new Error(
			`[local-stack] Preparation failed with exit status ${formatExitStatus(prepared.status)}`,
		);
	}

	Object.assign(process.env, {
		DASH_LOCAL_STACK_ACTIVE: "1",
		DASH_LOCAL_PROJECTS_ROOT: projectsRoot,
		DASH_USE_LOCAL_COTTONTAIL: "1",
		DASH_LOCAL_COTTONTAIL_ROOT: cottontailRoot,
		COTTONTAIL_ROOT: cottontailRoot,
		DASH_COTTONTAIL: localCottontail,
		COTTONTAIL_BINARY: localCottontail,
		DASH_CLI_ROOT: dashCliRoot,
		DASH_CLI_BINARY: localDash,
		DASH_BINARY: localDash,
		ELECTROBUN_BINARY: localDash,
		DASH_USE_LOCAL_ELECTROBUN: "1",
		DASH_LOCAL_ELECTROBUN_ROOT: electrobunRoot,
	});

	return {
		projectsRoot,
		cottontailRoot,
		cottontailBinary: localCottontail,
		dashCliRoot,
		dashBinary: localDash,
		electrobunRoot,
	};
}
