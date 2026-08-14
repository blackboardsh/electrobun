import { join } from "node:path";
import { createDevCommands, parseDevArgs } from "./dev.ts";
import { createMatrixDevCommands } from "./dev-matrix.ts";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertArray(actual: string[], expected: string[], message: string) {
	assert(
		JSON.stringify(actual) === JSON.stringify(expected),
		`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
	);
}

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

console.log("Electrobun dev command plan passed");
