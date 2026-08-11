import { describe, expect, it } from "bun:test";
import {
	assertExactOdinRelease,
	assertStrictSemVer,
	isExactOdinRelease,
	isSemVerPrerelease,
	isStrictSemVer,
	parseStrictSemVer,
} from "./strict-semver.js";

const valid = [
	"0.0.0",
	"1.2.3",
	"10.20.30",
	"1.0.0-0",
	"1.0.0-alpha",
	"1.0.0-alpha.1",
	"1.0.0-0.3.7",
	"1.0.0-x.7.z.92",
	"1.0.0-x-y-z.--",
	"1.0.0--",
	"1.0.0-01a",
	"1.0.0-00a",
	"1.0.0+001",
	"1.0.0+build.1848",
	"1.0.0-alpha+build.001",
	"999999999999999999999999999.0.0",
];

const invalid = [
	"",
	"1",
	"1.2",
	"01.2.3",
	"1.02.3",
	"1.2.03",
	"1.0.0-01",
	"1.0.0-alpha.01",
	"1.0.0-1.002",
	"1.0.0-012345678901234567890",
	"1.0.0-",
	"1.0.0-.alpha",
	"1.0.0-alpha.",
	"1.0.0-alpha..1",
	"1.0.0+",
	"1.0.0+build..1",
	"1.0.0-alpha+build+again",
	"1.0.0-alpha_beta",
	"1.0.0+build_meta",
	"v1.2.3",
	"=1.2.3",
	"^1.2.3",
	"~1.2.3",
	">=1.2.3",
	"1.2.x",
	"1.2.3 - 2.0.0",
	"1.2.3 || 2.0.0",
	"latest",
	"stable",
	"workspace:*",
	"npm:alias@1.2.3",
	"file:../release",
	"../1.2.3",
	"1.2.3/path",
	" 1.2.3",
	"1.2.3 ",
	"1.2.3\n",
	"1.2.3\r\n",
	"1.2.3-α",
];

describe("strict SemVer 2.0.0", () => {
	it.each(valid)("accepts %s", (version) => {
		expect(isStrictSemVer(version)).toBe(true);
		expect(assertStrictSemVer(version)).toBe(version);
	});

	it.each(invalid)("rejects %s", (version) => {
		expect(isStrictSemVer(version)).toBe(false);
		expect(() => assertStrictSemVer(version, "release version")).toThrow(
			"release version must be an exact SemVer 2.0.0 version",
		);
	});

	for (const value of [null, undefined, 123, {}, []]) {
		it(`rejects non-string value ${JSON.stringify(value)}`, () => {
			expect(isStrictSemVer(value)).toBe(false);
			expect(() => assertStrictSemVer(value)).toThrow(
				"must be an exact SemVer 2.0.0 version",
			);
		});
	}

	it("preserves prerelease and build identity without numeric coercion", () => {
		expect(parseStrictSemVer("2.0.0-beta.7+ci.001")).toEqual({
			major: "2",
			minor: "0",
			patch: "0",
			prerelease: "beta.7",
			build: "ci.001",
		});
		expect(isSemVerPrerelease("2.0.0-beta.7+ci.001")).toBe(true);
		expect(isSemVerPrerelease("2.0.0+build-with-hyphen")).toBe(false);
	});
});

describe("exact Odin releases", () => {
	it.each(["dev-2026-07", "dev-2026-07a", "1.2.3", "1.2.3-beta.1"])(
		"accepts %s",
		(version) => {
			expect(isExactOdinRelease(version)).toBe(true);
			expect(assertExactOdinRelease(version)).toBe(version);
		},
	);

	it.each([
		"dev-latest",
		"dev-2026-00",
		"dev-2026-13",
		"dev-2026-7",
		"dev-2026-07aa",
		"../dev-2026-07a",
		"^dev-2026-07a",
		"1.2.3-01",
	])("rejects %s", (version) => {
		expect(isExactOdinRelease(version)).toBe(false);
		expect(() => assertExactOdinRelease(version)).toThrow(
			"must be an exact SemVer 2.0.0 or Odin",
		);
	});
});
