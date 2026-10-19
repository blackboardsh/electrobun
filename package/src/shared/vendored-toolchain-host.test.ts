import { expect, test } from "bun:test";
import { goHostTuple, rustHostTriple, verifyGoToolchain, verifyRustToolchain } from "./vendored-toolchain-host";

const rustReport = (host: string, version = "1.88.0") =>
	`rustc ${version} (6b00bc388 2025-06-23)\r\nbinary: rustc\r\nhost: ${host}\r\nrelease: ${version}\r\nLLVM version: 20.1.5\r\n`;

test("same-version compiler caches are invalidated when the Windows host architecture changes", () => {
	for (const arch of ["x64", "arm64"] as const) {
		const host = { os: "win", arch } as const;
		const stale = { os: "win", arch: arch === "arm64" ? "x64" : "arm64" } as const;
		const staleGo = goHostTuple(stale);
		expect(() => verifyRustToolchain(rustReport(rustHostTriple(stale)), "1.88.0", host)).toThrow("Vendored Rust mismatch");
		expect(() => verifyGoToolchain(`go version go1.26.4 ${staleGo.goOS}/${staleGo.goArch}`, "1.26.4", host)).toThrow("Vendored Go mismatch");

		const currentGo = goHostTuple(host);
		expect(() => verifyRustToolchain(rustReport(rustHostTriple(host)), "1.88.0", host)).not.toThrow();
		expect(() => verifyGoToolchain(`go version go1.26.4 ${currentGo.goOS}/${currentGo.goArch}\r\n`, "1.26.4", host)).not.toThrow();
	}
});

test("compiler host validation rejects wrong operating systems, versions, and incomplete reports", () => {
	const host = { os: "win", arch: "arm64" } as const;
	for (const report of [rustReport("aarch64-apple-darwin"), rustReport("aarch64-pc-windows-msvc", "1.88.01"), "rustc 1.88.0 (same version without host)"]) {
		expect(() => verifyRustToolchain(report, "1.88.0", host)).toThrow();
	}
	for (const report of ["go version go1.26.4 linux/arm64", "go version go1.26.3 windows/arm64", "go version go1.26.4"]) {
		expect(() => verifyGoToolchain(report, "1.26.4", host)).toThrow();
	}
});

test("compiler downloads use the host architecture across supported operating systems", () => {
	for (const [os, rustPlatform, goOS] of [
		["win", "pc-windows-msvc", "windows"],
		["macos", "apple-darwin", "darwin"],
		["linux", "unknown-linux-gnu", "linux"],
	] as const) {
		for (const arch of ["x64", "arm64"] as const) {
			const host = { os, arch };
			expect(rustHostTriple(host)).toBe(`${arch === "arm64" ? "aarch64" : "x86_64"}-${rustPlatform}`);
			expect(goHostTuple(host)).toEqual({ goOS, goArch: arch === "arm64" ? "arm64" : "amd64" });
		}
	}
});
