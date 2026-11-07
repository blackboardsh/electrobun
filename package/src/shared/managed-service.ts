/** Shared hosted service for Electrobun Managed Deploys and Insights. */
export const ELECTROBUN_API_URL = "https://api.electrobun.dev";

/** A verified managed hostname serves one app at its root. Paths remain part
 * of the ordinary self-hosted baseUrl contract, not custom managed origins. */
export function normalizeManagedCustomOrigin(value: unknown): string {
	// Validate the original shape before WHATWG URL parsing can erase dot
	// segments, backslashes, or whitespace that native configuration rejects.
	const parts = typeof value === "string" ? /^(https?):\/\/([a-z0-9.-]+|\[::1\])(?::[0-9]+)?\/?$/i.exec(value) : null;
	if (!parts) {
		throw new Error("Invalid managed custom origin");
	}
	const url = new URL(value as string);
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parts[2]!.toLowerCase());
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username || url.password ||
		url.pathname !== "/" || (url.protocol === "https:" && url.port !== "")) {
		throw new Error("Managed custom URL must be an HTTPS origin without a path, credentials, query, or fragment");
	}
	return url.origin;
}
