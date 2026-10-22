// A release must be usable on every Electrobun target. The CDN does not
// guarantee version ordering and sometimes publishes platforms at different times.
export const CEF_PLATFORMS = [
	"macosx64", "macosarm64", "linux64", "linuxarm64", "windows64", "windowsarm64",
];

function compareVersion(a, b) {
	const left = a.split("+", 1)[0].split(".").map(Number);
	const right = b.split("+", 1)[0].split(".").map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference) return difference;
	}
	return a.localeCompare(b);
}

export function latestCommonStableCEF(index) {
	const releases = CEF_PLATFORMS.map((platform) => new Map(
		(index[platform]?.versions ?? [])
			.filter((version) => version.channel === "stable" &&
				/^\d+\.\d+\.\d+\+g[a-f0-9]+\+chromium-\d+\.\d+\.\d+\.\d+$/.test(version.cef_version) &&
				version.files?.some((file) => file.type === "minimal" &&
					file.name === `cef_binary_${version.cef_version}_${platform}_minimal.tar.bz2` &&
					/^[a-f0-9]{40}$/.test(file.sha1) && Number.isSafeInteger(file.size) && file.size > 0))
			.map((version) => [version.cef_version, version]),
	));
	const common = [...releases[0].keys()].filter((version) => releases.every((platform) =>
		platform.has(version) && platform.get(version).chromium_version === version.split("+chromium-")[1],
	));
	common.sort(compareVersion);
	const version = common.at(-1);
	if (!version) throw new Error("No stable CEF minimal release is available for all six Electrobun platforms");
	return {
		cef_version: version.replace(/\+chromium-.*$/, ""),
		chromium_version: releases[0].get(version).chromium_version,
	};
}
