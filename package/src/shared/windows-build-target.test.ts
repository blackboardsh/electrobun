import { expect, test } from "bun:test";
import { resolveBuildArch, windowsBuildTarget } from "./windows-build-target";

test("an x64 build process can explicitly select ARM64 artifacts", () => {
	expect(resolveBuildArch("x64", "arm64")).toBe("arm64");
	expect(windowsBuildTarget("arm64")).toEqual({
		zig: "aarch64-windows-gnu",
		vcvars: "x64_arm64",
		vcComponent: "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
		cmake: "ARM64",
		cef: "windowsarm64",
		webview2: "arm64",
	});
});
test("the default build target follows the process architecture", () => {
	expect(resolveBuildArch("arm64")).toBe("arm64");
	expect(resolveBuildArch("x64")).toBe("x64");
	expect(windowsBuildTarget("x64").cef).toBe("windows64");
});
test("invalid architecture overrides fail before downloads or compilation", () => {
	expect(() => resolveBuildArch("x64", "ia32")).toThrow("Unsupported build architecture");
	expect(() => resolveBuildArch("riscv64")).toThrow("Unsupported build architecture");
});
