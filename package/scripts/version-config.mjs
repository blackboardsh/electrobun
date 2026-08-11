function replaceBlockVersion(source, blockName, version) {
	const pattern = new RegExp(
		`(${blockName}:\\s*\\{[\\s\\S]*?\\bversion:\\s*)["'][^"']+["']`,
	);
	if (!pattern.test(source)) {
		throw new Error(`Could not find ${blockName}.version in Electrobun config`);
	}
	return source.replace(pattern, `$1"${version}"`);
}

export function updateKitchenVersions(source, version) {
	let updated = replaceBlockVersion(source, "electrobun", version);
	updated = replaceBlockVersion(updated, "app", version);
	return updated;
}
