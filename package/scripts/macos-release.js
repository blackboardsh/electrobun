export const MACOS_DEPLOYMENT_TARGET = "14.0";

export function macosZigTarget(arch) {
	if (arch === "arm64") return `aarch64-macos.${MACOS_DEPLOYMENT_TARGET}`;
	if (arch === "x64") return `x86_64-macos.${MACOS_DEPLOYMENT_TARGET}`;
	throw new Error(`Unsupported macOS architecture: ${arch}`);
}
