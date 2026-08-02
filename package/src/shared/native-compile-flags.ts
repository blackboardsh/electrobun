export type NativeCompilePlatform = "macos" | "linux" | "win";

function validateFlag(flag: string): void {
	if (!flag) {
		throw new Error("Native compile flags must not contain empty arguments");
	}
	if (/[\r\n\0]/.test(flag)) {
		throw new Error("Native compile flags must not contain newlines or NUL bytes");
	}
}

export function serializeNativeCompileFlags(
	platform: NativeCompilePlatform,
	compileFlags: readonly string[],
): string {
	if (compileFlags.length === 0) {
		throw new Error("At least one native compile flag is required");
	}

	const clangdFlags =
		platform === "win"
			? ["--driver-mode=cl", ...compileFlags]
			: [...compileFlags];
	clangdFlags.forEach(validateFlag);

	return `${clangdFlags.join("\n")}\n`;
}

function quoteWindowsBatchArgument(argument: string): string {
	if (argument.length === 0) return '\"\"';
	if (!/[\s\"&|<>^()%!]/.test(argument)) return argument;
	return `\"${argument.replaceAll('\"', '\"\"')}\"`;
}

export function formatWindowsBatchCommand(arguments_: readonly string[]): string {
	if (arguments_.length === 0) {
		throw new Error("A Windows batch command requires at least one argument");
	}
	arguments_.forEach(validateFlag);
	return arguments_.map(quoteWindowsBatchArgument).join(" ");
}
