import { join } from "node:path";
import { createDevCommands } from "./dev.ts";

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
const dashBinary = join(packageDir, "vendors", "dash-cli", "dash.exe");
const comSpec = "C:\\Windows\\System32\\cmd.exe";
const windowsCommands = createDevCommands({
	dashBinary,
	packageDir,
	kitchenDir,
	platform: "win32",
	comSpec,
	devArgs: ["--watch"],
});

assert(windowsCommands.length === 3, "Windows dev plan should have three commands");
assert(windowsCommands[0]?.command === dashBinary, "Package build should use resolved Dash");
assertArray(windowsCommands[0]?.args ?? [], [join(packageDir, "build.ts")], "Package build argv");
assert(windowsCommands[0]?.cwd === packageDir, "Package build cwd mismatch");
assert(windowsCommands[1]?.command === comSpec, "Windows npm install should use ComSpec");
assertArray(
	windowsCommands[1]?.args ?? [],
	["/D", "/S", "/C", "npm.cmd", "install"],
	"Windows npm install argv",
);
assert(windowsCommands[1]?.cwd === kitchenDir, "Kitchen npm install cwd mismatch");
assert(windowsCommands[2]?.command === dashBinary, "Kitchen launch should reuse resolved Dash");
assertArray(
	windowsCommands[2]?.args ?? [],
	["electrobun", "dev", "--watch"],
	"Kitchen launch argv",
);
assert(windowsCommands[2]?.cwd === kitchenDir, "Kitchen launch cwd mismatch");

const posixCommands = createDevCommands({
	dashBinary: "/tmp/electrobun/package/vendors/dash-cli/dash",
	packageDir: "/tmp/electrobun/package",
	kitchenDir: "/tmp/electrobun/kitchen",
	platform: "linux",
});
assert(posixCommands[1]?.command === "npm", "POSIX npm install should execute npm directly");
assertArray(posixCommands[1]?.args ?? [], ["install"], "POSIX npm install argv");

console.log("Electrobun dev command plan passed");
