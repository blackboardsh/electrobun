import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDevCommands, parseDevArgs } from "./dev.ts";
import { createMatrixDevCommands } from "./dev-matrix.ts";
import {
	createVmTestCommands,
	runVmTestCommands,
	VM_MAIN_PROCESSES,
	VM_WEBVIEWS,
} from "./test-vm.ts";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertArray(actual: string[], expected: string[], message: string) {
	assert(
		JSON.stringify(actual) === JSON.stringify(expected),
		`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
	);
}

const hutchConfig = readFileSync(
	new URL("../hutch.config.ts", import.meta.url),
	"utf8",
);
assert(
	/"test:vm":\s*\["hutch", "scripts\/test-vm\.ts"\]/.test(hutchConfig),
	"test:vm should use the failure-collecting VM test runner",
);

const packageDir = join("C:\\work tree", "electrobun", "package");
const kitchenDir = join("C:\\work tree", "electrobun", "kitchen");
const hutchBinary = "hutch";
const comSpec = "C:\\Windows\\System32\\cmd.exe";
const windowsCommands = createDevCommands({
	hutchBinary,
	packageDir,
	kitchenDir,
	platform: "win32",
	comSpec,
	devArgs: ["--watch"],
});

assert(windowsCommands.length === 3, "Windows dev plan should have three commands");
assert(windowsCommands[0]?.command === hutchBinary, "Package build should use resolved Hutch");
assertArray(windowsCommands[0]?.args ?? [], [join(packageDir, "build.ts")], "Package build argv");
assert(windowsCommands[0]?.cwd === packageDir, "Package build cwd mismatch");
assert(windowsCommands[1]?.command === comSpec, "Windows npm install should use ComSpec");
assertArray(
	windowsCommands[1]?.args ?? [],
	["/D", "/S", "/C", "npm.cmd", "install"],
	"Windows npm install argv",
);
assert(windowsCommands[1]?.cwd === kitchenDir, "Kitchen npm install cwd mismatch");
assert(windowsCommands[2]?.command === hutchBinary, "Kitchen launch should reuse resolved Hutch");
assertArray(
	windowsCommands[2]?.args ?? [],
	["electrobun", "dev", "--watch"],
	"Kitchen launch argv",
);
assert(windowsCommands[2]?.cwd === kitchenDir, "Kitchen launch cwd mismatch");
assert(
	windowsCommands[2]?.env?.HUTCH_ELECTROBUN_DEVKIT_ROOT ===
		join(packageDir, "dist"),
	"Kitchen launch should use the freshly built Electrobun devkit",
);
assert(
	windowsCommands[0]?.env === undefined,
	"Package build should not receive the devkit override",
);
assert(
	windowsCommands[1]?.env === undefined,
	"Kitchen install should not receive the devkit override",
);

const posixCommands = createDevCommands({
	hutchBinary: "/tmp/hutch",
	packageDir: "/tmp/electrobun/package",
	kitchenDir: "/tmp/electrobun/kitchen",
	platform: "linux",
});
assert(posixCommands[1]?.command === "npm", "POSIX npm install should execute npm directly");
assertArray(posixCommands[1]?.args ?? [], ["install"], "POSIX npm install argv");

const localArgs = parseDevArgs(["--watch", "--local"]);
assert(localArgs.local, "Local dev args should enable local stack mode");
assertArray(localArgs.devArgs, ["--watch"], "Local flag should not reach Electrobun");

const localCommands = createDevCommands({
	hutchBinary: "/tmp/hutch",
	packageDir: "/tmp/electrobun/package",
	kitchenDir: "/tmp/electrobun/kitchen",
	platform: "linux",
	devArgs: localArgs.devArgs,
	skipPackageBuild: true,
});
assert(localCommands.length === 2, "Prepared local dev plan should skip package rebuild");
assert(localCommands[0]?.label === "Install Kitchen dependencies", "Local install step mismatch");
assert(localCommands[1]?.label === "Launch Kitchen development app", "Local launch step mismatch");
assertArray(
	localCommands[1]?.args ?? [],
	["electrobun", "dev", "--watch"],
	"Local launch argv",
);
assert(
	localCommands[1]?.env?.HUTCH_ELECTROBUN_DEVKIT_ROOT ===
		join("/tmp/electrobun/package", "dist"),
	"Local-stack Kitchen launch should use the freshly built Electrobun devkit",
);

const matrixCommands = createMatrixDevCommands({
	hutchBinary,
	packageDir,
	kitchenDir,
	platform: "win32",
	comSpec,
	matrixArgs: ["--full", "--jobs=2"],
});
assert(matrixCommands.length === 3, "Matrix dev plan should prepare package and Kitchen");
assert(matrixCommands[2]?.label === "Run Kitchen interactive matrix", "Matrix label mismatch");
assertArray(
	matrixCommands[2]?.args ?? [],
	["scripts/kitchen-matrix.ts", "--full", "--jobs=2"],
	"Matrix runner argv",
);

const localMatrixCommands = createMatrixDevCommands({
	hutchBinary,
	packageDir,
	kitchenDir,
	platform: "linux",
	matrixArgs: ["--launch-only"],
	skipPackageBuild: true,
});
assert(localMatrixCommands.length === 2, "Local matrix plan should skip package rebuild");
assertArray(
	localMatrixCommands[1]?.args ?? [],
	["scripts/kitchen-matrix.ts", "--launch-only"],
	"Local matrix runner argv",
);
assert(
	localMatrixCommands[1]?.env?.HUTCH_ELECTROBUN_DEVKIT_ROOT ===
		join(packageDir, "dist"),
	"Kitchen matrix should preserve the local Electrobun devkit override",
);

const vmTestCommands = createVmTestCommands({ hutchBinary, packageDir });
const mainProcesses = [...VM_MAIN_PROCESSES];
assertArray(
	mainProcesses,
	["cottontail", "bun", "zig", "rust", "go", "odin"],
	"VM tests should cover every main-process backend",
);
assertArray([...VM_WEBVIEWS], ["system", "cef"], "VM tests should cover both webviews");
const vmVariants = VM_WEBVIEWS.flatMap((webview) =>
	mainProcesses.map((main) => `${main}:${webview}`),
);
assert(
	vmTestCommands.length === 5 + vmVariants.length,
	"VM test plan should have build, per-variant Kitchen, unit, Kitchen tooling, updater, and release stages",
);
const kitchenBuild = vmTestCommands[0];
assertArray(
	kitchenBuild?.args ?? [],
	["dev:matrix", "--build-only", `--with=${vmVariants.join(",")}`],
	"Kitchen build argv",
);
assert(kitchenBuild?.cwd === packageDir, "Kitchen build should run dev:matrix from package");
assert(kitchenBuild?.env?.AUTO_RUN === undefined, "Builds should not auto-run");
vmVariants.forEach((variant, index) => {
	const command = vmTestCommands[1 + index];
	assertArray(
		command?.args ?? [],
		["scripts/kitchen-matrix.ts", "--launch-only", `--with=${variant}`, "--timeout=1200"],
		`Kitchen ${variant} launch argv`,
	);
	assert(command?.cwd === kitchenDir, `${variant} should launch from Kitchen`);
	assert(command?.env?.AUTO_RUN === "1", `${variant} should receive AUTO_RUN=1`);
	assert(
		command?.env?.HUTCH_ELECTROBUN_DEVKIT_ROOT === join(packageDir, "dist"),
		`${variant} should reuse the local Electrobun devkit`,
	);
	assert(
		command?.requires === kitchenBuild?.label,
		`${variant} should be skipped when the Kitchen build fails`,
	);
});
assert(
	vmTestCommands[1]?.label === "Kitchen automated tests (Cottontail + system webview)",
	"System-webview launches should be labeled by backend and renderer",
);
const unitStage = vmTestCommands[1 + vmVariants.length];
const kitchenToolingStage = vmTestCommands[2 + vmVariants.length];
const updaterStage = vmTestCommands[3 + vmVariants.length];
const releaseStage = vmTestCommands[4 + vmVariants.length];
assertArray(unitStage?.args ?? [], ["test:unit"], "Unit and native test argv");
assert(unitStage?.cwd === packageDir, "Unit tests should run from package");
assertArray(kitchenToolingStage?.args ?? [], ["test:tooling"], "Kitchen tooling test argv");
assert(kitchenToolingStage?.cwd === kitchenDir, "Kitchen tooling tests should run from Kitchen");
assertArray(updaterStage?.args ?? [], ["test:updater-lifecycle"], "Updater lifecycle argv");
assertArray(releaseStage?.args ?? [], ["check:release"], "Release check argv");

const attemptedVmStages: string[] = [];
const vmFailures = await runVmTestCommands(
	vmTestCommands,
	async (command) => {
		attemptedVmStages.push(command.label);
		if (command !== releaseStage) throw new Error(`${command.label} failed`);
	},
	() => {},
);
assertArray(
	attemptedVmStages,
	vmTestCommands
		.filter((command) => command.requires !== kitchenBuild?.label)
		.map((command) => command.label),
	"VM runner should attempt every independent stage after failures and skip dependents",
);
assert(
	vmFailures.length === vmTestCommands.length - 1,
	"VM runner should collect every stage failure, including skipped dependents",
);

const attemptedAfterBuild: string[] = [];
const failuresAfterBuild = await runVmTestCommands(
	vmTestCommands,
	async (command) => {
		attemptedAfterBuild.push(command.label);
		if (command.label.includes("Zig + CEF")) throw new Error("zig:cef hung");
	},
	() => {},
);
assertArray(
	attemptedAfterBuild,
	vmTestCommands.map((command) => command.label),
	"VM runner should launch every variant once the build succeeds",
);
assertArray(
	failuresAfterBuild.map((failure) => failure.command.label),
	["Kitchen automated tests (Zig + CEF)"],
	"VM runner should report the failing CEF backend by name",
);

console.log("Electrobun dev command plan passed");
