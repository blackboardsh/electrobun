const STRICT_SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const EXACT_ODIN_RELEASE = /^dev-\d{4}-(?:0[1-9]|1[0-2])[a-z]?$/;

/**
 * Parse only the exact SemVer 2.0.0 grammar. This deliberately excludes npm
 * ranges, channels, `v` prefixes, aliases, paths, and loose/coerced versions.
 *
 * @param {unknown} value
 * @returns {{ major: string, minor: string, patch: string, prerelease: string | null, build: string | null } | null}
 */
export function parseStrictSemVer(value) {
	if (typeof value !== "string") return null;
	const match = STRICT_SEMVER.exec(value);
	// JavaScript's `$` can match immediately before a final line terminator.
	// Requiring the full match prevents accepting a version with a trailing one.
	if (!match || match[0].length !== value.length) return null;
	return {
		major: /** @type {string} */ (match[1]),
		minor: /** @type {string} */ (match[2]),
		patch: /** @type {string} */ (match[3]),
		prerelease: match[4] ?? null,
		build: match[5] ?? null,
	};
}

/** @param {unknown} value */
export function isStrictSemVer(value) {
	return parseStrictSemVer(value) !== null;
}

/**
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function assertStrictSemVer(value, label = "version") {
	if (!isStrictSemVer(value)) {
		throw new Error(
			`${label} must be an exact SemVer 2.0.0 version, got ${JSON.stringify(value)}. Ranges, channels, prefixes, aliases, and paths are not supported.`,
		);
	}
	return /** @type {string} */ (value);
}

/** @param {unknown} value */
export function isSemVerPrerelease(value) {
	const parsed = parseStrictSemVer(value);
	if (!parsed) {
		throw new Error(
			`version must be an exact SemVer 2.0.0 version, got ${JSON.stringify(value)}.`,
		);
	}
	return parsed.prerelease !== null;
}

/**
 * Odin also publishes dated compiler releases outside SemVer. Keep that one
 * explicit exception narrow and independently exact.
 *
 * @param {unknown} value
 */
export function isExactOdinRelease(value) {
	return (
		isStrictSemVer(value) ||
		(typeof value === "string" && EXACT_ODIN_RELEASE.test(value))
	);
}

/**
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function assertExactOdinRelease(value, label = "Odin version") {
	if (!isExactOdinRelease(value)) {
		throw new Error(
			`${label} must be an exact SemVer 2.0.0 or Odin dev-YYYY-MM[a-z] release, got ${JSON.stringify(value)}.`,
		);
	}
	return /** @type {string} */ (value);
}
