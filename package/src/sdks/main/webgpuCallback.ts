type CallbackArgument = "u32" | "ptr" | "u64";

/** WGPUStringView is indirect on Windows x64, and two words on ARM64/SysV. */
export function stringViewCallbackAbi(
	platform: string,
	architecture: string,
): { indirect: boolean; args: CallbackArgument[] } {
	const indirect = platform === "win32" && architecture === "x64";
	return {
		indirect,
		args: indirect
			? ["u32", "ptr", "ptr", "ptr"]
			: ["u32", "ptr", "u64", "ptr", "ptr"],
	};
}
