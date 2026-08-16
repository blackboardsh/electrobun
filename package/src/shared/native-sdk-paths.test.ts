import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(packageRoot, path), "utf8");

describe("native SDK path parity", () => {
	it("uses the Windows local app-data root for application data", () => {
		const rust = read("sdks/rust/electrobun.rs");
		const go = read("sdks/go/electrobun.go");

		expect(rust).toContain('std::env::var("LOCALAPPDATA")');
		expect(rust).toContain('join_path(home, "AppData/Local")');
		expect(go).toContain('os.Getenv("LOCALAPPDATA")');
		expect(go).toContain('filepath.Join(home, "AppData", "Local")');
	});

	it("scopes Rust and Go app directories by identifier and channel", () => {
		const rust = read("sdks/rust/electrobun.rs");
		const go = read("sdks/go/electrobun.go");

		expect(rust).toContain(
			'join_path(&join_path(base, &app_info.identifier), &app_info.channel)',
		);
		expect(go).toContain(
			"filepath.Join(base, appInfo.Identifier, appInfo.Channel)",
		);
	});
});
