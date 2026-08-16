import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const kitchenRoot = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(kitchenRoot, path), "utf8");

describe("native Kitchen AUTO_RUN contract", () => {
	for (const [backend, path, finish] of [
		["Zig", "src/zig/main.zig", "finishAutoRun"],
		["Rust", "src/rust/main.rs", "finish_auto_run"],
		["Go", "src/go/main.go", "finishAutoRun"],
		["Odin", "src/odin/main.odin", "finishAutoRun"],
	] as const) {
		it(`${backend} exits AUTO_RUN with the aggregate result`, () => {
			const source = read(path);
			expect(source).toContain(finish);
			expect(source).toContain("auto-run complete; exiting with code");
		});
	}

	it("gives the Windows Rust Kitchen host enough main-thread stack", () => {
		const buildScript = read("build.rs");
		expect(buildScript).toContain('CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")');
		expect(buildScript).toContain("/STACK:8388608");
	});
});
