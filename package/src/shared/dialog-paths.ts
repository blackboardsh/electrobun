export function decodeDialogPaths(payload: string): string[] {
	if (payload.length === 0) {
		return [];
	}

	const value: unknown = JSON.parse(payload);
	if (!Array.isArray(value) || !value.every((path) => typeof path === "string")) {
		throw new TypeError("Invalid file-dialog path payload");
	}

	return value;
}
