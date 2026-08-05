import { describe, expect, test } from "bun:test";
import {
	BUILD_DEPENDENCIES_PUBLIC_BASE_URL,
	OWNED_BUILD_DEPENDENCY_VERSIONS,
	ownedBuildDependencyArtifact,
} from "./build-dependencies";

describe("owned build dependency artifacts", () => {
	test.each([
		["zig-bsdiff", "macos", "arm64", "zig-bsdiff-darwin-arm64.tar.gz"],
		["zig-zstd", "linux", "x64", "zig-zstd-linux-x64.tar.gz"],
		["zig-asar", "win", "x64", "zig-asar-win32-x64.tar.gz"],
		[
			"electrobun-dawn",
			"linux",
			"arm64",
			"electrobun-dawn-linux-arm64.tar.gz",
		],
	] as const)(
		"maps %s on %s-%s to its immutable release key",
		(product, platform, arch, filename) => {
			const artifact = ownedBuildDependencyArtifact(product, platform, arch);
			const version = OWNED_BUILD_DEPENDENCY_VERSIONS[product];

			expect(artifact.filename).toBe(filename);
			expect(artifact.key).toBe(
				`${product}/releases/${version}/${filename}`,
			);
			expect(artifact.url).toBe(
				`${BUILD_DEPENDENCIES_PUBLIC_BASE_URL}/${artifact.key}`,
			);
			expect(artifact.checksumUrl).toBe(`${artifact.url}.sha256`);
		},
	);

	test("normalizes an overridden public base URL", () => {
		const artifact = ownedBuildDependencyArtifact(
			"zig-bsdiff",
			"linux",
			"x64",
			"https://artifacts.example.test///",
		);

		expect(artifact.url).toBe(
			"https://artifacts.example.test/zig-bsdiff/releases/0.1.22/zig-bsdiff-linux-x64.tar.gz",
		);
	});
});
