type ToolchainHost = {
	os: "win" | "macos" | "linux";
	arch: "x64" | "arm64";
};

export function rustHostTriple({ os, arch }: ToolchainHost): string {
	const cpu = arch === "arm64" ? "aarch64" : "x86_64";
	const platform = { win: "pc-windows-msvc", macos: "apple-darwin", linux: "unknown-linux-gnu" }[os];
	return `${cpu}-${platform}`;
}

export function goHostTuple({ os, arch }: ToolchainHost) {
	return {
		goOS: { win: "windows", macos: "darwin", linux: "linux" }[os],
		goArch: arch === "arm64" ? "arm64" : "amd64",
	};
}

// Version stamps alone cannot distinguish cached x64 compilers from native
// ARM64 compilers with the same release. Inspect the executable's own report.
export function verifyRustToolchain(output: string, version: string, host: ToolchainHost): void {
	const actualVersion = output.match(/^rustc (\S+) /m)?.[1];
	const actualHost = output.match(/^host: (\S+)\r?$/m)?.[1];
	const expectedHost = rustHostTriple(host);
	if (actualVersion !== version || actualHost !== expectedHost) {
		throw new Error(`Vendored Rust mismatch: expected rustc ${version} for ${expectedHost}, got ${actualVersion ?? "unknown version"} for ${actualHost ?? "unknown host"}`);
	}
}

export function verifyGoToolchain(output: string, version: string, host: ToolchainHost): void {
	const actual = output.trim().match(/^go version go(\S+) (\S+)$/);
	const { goOS, goArch } = goHostTuple(host);
	const expectedHost = `${goOS}/${goArch}`;
	if (actual?.[1] !== version || actual?.[2] !== expectedHost) {
		throw new Error(`Vendored Go mismatch: expected go${version} for ${expectedHost}, got ${actual?.[1] ?? "unknown version"} for ${actual?.[2] ?? "unknown host"}`);
	}
}
