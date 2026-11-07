import { CString, dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { dirname, join } from "node:path";

const descriptors = {
	installationConfigure: { args: [FFIType.cstring], returns: FFIType.bool },
	getInstallationId: { args: [], returns: FFIType.ptr },
	freeCoreString: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

let library: ReturnType<typeof dlopen<typeof descriptors>> | null | undefined;
function load() {
	if (library !== undefined) return library;
	const filename = process.platform === "win32" ? "ElectrobunCore.dll" : `libElectrobunCore.${suffix}`;
	const candidates = new Set([join(process.cwd(), filename)]);
	if (process.argv0) candidates.add(join(dirname(process.argv0), filename));
	for (const candidate of candidates) {
		try { return library = dlopen(candidate, descriptors); } catch {}
	}
	return library = null;
}

/** The native core owns identity generation and persistence; no reporter is involved. */
export const installationNative = {
	configure(json: string): boolean {
		const bytes = new TextEncoder().encode(`${json}\0`);
		return load()?.symbols.installationConfigure(ptr(bytes)) ?? false;
	},
	getInstallationId(): string | null {
		const api = load();
		const value = api?.symbols.getInstallationId();
		if (!api || !value) return null;
		try { return new CString(value).toString(); }
		finally { api.symbols.freeCoreString(value); }
	},
};
