import { platform, arch } from "os";

export type SupportedOS = "macos" | "win" | "linux";
export type SupportedArch = "arm64" | "x64";

// Cache platform() result to avoid multiple system calls
const platformName = platform();
const archName = arch();

// Determine OS once
export const OS: SupportedOS = (() => {
	switch (platformName) {
		case "win32":
			return "win";
		case "darwin":
			return "macos";
		case "linux":
			return "linux";
		default:
			throw new Error(`Unsupported platform: ${platformName}`);
	}
})();

// Runtime architecture follows the executing binary, including under emulation.
export const ARCH: SupportedArch = (() => {
	switch (archName) {
		case "arm64":
			return "arm64";
		case "x64":
			return "x64";
		default:
			throw new Error(`Unsupported architecture: ${archName}`);
	}
})();

// Export functions for backwards compatibility if needed
export function getPlatformOS(): SupportedOS {
	return OS;
}

export function getPlatformArch(): SupportedArch {
	return ARCH;
}
