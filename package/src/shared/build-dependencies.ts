export const BUILD_DEPENDENCIES_PUBLIC_BASE_URL =
	"https://electrobun-artifacts.blackboard.sh";

export const ZIG_VERSION = "0.16.0";

export const OWNED_BUILD_DEPENDENCY_VERSIONS = {
	"zig-bsdiff": "0.1.22",
	"zig-zstd": "0.1.7",
	"zig-asar": "0.2.7",
	"electrobun-dawn": "0.2.5",
} as const;

export type OwnedBuildDependency =
	keyof typeof OWNED_BUILD_DEPENDENCY_VERSIONS;

export type BuildDependencyPlatform = "macos" | "linux" | "win";
export type BuildDependencyArch = "arm64" | "x64";

const artifactPlatform = (
	platform: BuildDependencyPlatform,
): "darwin" | "linux" | "win32" => {
	if (platform === "macos") return "darwin";
	if (platform === "win") return "win32";
	return "linux";
};

export const ownedBuildDependencyArtifact = (
	product: OwnedBuildDependency,
	platform: BuildDependencyPlatform,
	arch: BuildDependencyArch,
	publicBaseUrl = BUILD_DEPENDENCIES_PUBLIC_BASE_URL,
) => {
	const version = OWNED_BUILD_DEPENDENCY_VERSIONS[product];
	const filename = `${product}-${artifactPlatform(platform)}-${arch}.tar.gz`;
	const key = `${product}/releases/${version}/${filename}`;
	const baseUrl = publicBaseUrl.replace(/\/+$/, "");

	return {
		product,
		version,
		filename,
		key,
		url: `${baseUrl}/${key}`,
		checksumUrl: `${baseUrl}/${key}.sha256`,
	};
};
