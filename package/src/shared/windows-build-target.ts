export type WindowsBuildArch = "x64" | "arm64";

export function resolveBuildArch(hostArch: string, requestedArch?: string): WindowsBuildArch {
	const value = requestedArch ?? hostArch;
	if (value !== "x64" && value !== "arm64") {
		throw new Error(`Unsupported build architecture: ${value}`);
	}
	return value;
}

export function windowsBuildTarget(arch: WindowsBuildArch) {
	return {
		zig: arch === "arm64" ? "aarch64-windows-gnu" : "x86_64-windows-gnu",
		vcvars: arch === "arm64" ? "x64_arm64" : "x64",
		vcComponent: arch === "arm64" ? "Microsoft.VisualStudio.Component.VC.Tools.ARM64" : "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
		cmake: arch === "arm64" ? "ARM64" : "x64",
		cef: arch === "arm64" ? "windowsarm64" : "windows64",
		webview2: arch,
	};
}
