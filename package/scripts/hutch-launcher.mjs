// Keep nested commands on the launcher which selected this Hutch runtime. On
// Windows ARM64, `hutch` on PATH may still be x64 while `hutch-canary` is ARM64.
// An explicit local-toolchain override always takes precedence.
export function selectHutchBinary(environment = process.env) {
	return environment.HUTCH_BINARY || environment.HUTCH_LAUNCHER_PATH || "hutch";
}
