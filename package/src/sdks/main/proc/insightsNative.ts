import { CString, dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { dirname, join } from "node:path";

const descriptors = {
	insightsConfigure: { args: [FFIType.cstring], returns: FFIType.bool },
	insightsTrack: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.bool },
	insightsIdentify: { args: [FFIType.cstring], returns: FFIType.void },
	insightsReset: { args: [], returns: FFIType.void },
	insightsSetEnabled: { args: [FFIType.bool], returns: FFIType.void },
	insightsGetInstallationId: { args: [], returns: FFIType.ptr },
	insightsFlush: { args: [], returns: FFIType.void },
	insightsShutdown: { args: [], returns: FFIType.void },
	freeCoreString: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

let library: ReturnType<typeof dlopen<typeof descriptors>> | null | undefined;

function load() {
	if (library !== undefined) return library;
	const filename = process.platform === "win32" ? "ElectrobunCore.dll" : `libElectrobunCore.${suffix}`;
	const candidates = new Set([join(process.cwd(), filename)]);
	if (process.argv0) candidates.add(join(dirname(process.argv0), filename));
	for (const candidate of candidates) {
		try {
			library = dlopen(candidate, descriptors);
			return library;
		} catch {
			// Older cores and build-only environments do not provide Insights.
		}
	}
	library = null;
	return null;
}

function cstring(value: string) {
	return new TextEncoder().encode(`${value}\0`);
}

/** Native core owns persistence, sessions, timing, queueing and HTTP. */
export const insightsNative = {
	configure(json: string): boolean {
		const config = cstring(json);
		return load()?.symbols.insightsConfigure(ptr(config)) ?? false;
	},
	track(name: string, properties: string): boolean {
		const nameBytes = cstring(name);
		const propertiesBytes = cstring(properties);
		return load()?.symbols.insightsTrack(ptr(nameBytes), ptr(propertiesBytes)) ?? false;
	},
	identify(userId: string | null): void {
		const bytes = userId === null ? null : cstring(userId);
		load()?.symbols.insightsIdentify(bytes ? ptr(bytes) : null);
	},
	reset(): void { load()?.symbols.insightsReset(); },
	setEnabled(enabled: boolean): void { load()?.symbols.insightsSetEnabled(enabled); },
	getInstallationId(): string | null {
		const api = load();
		const value = api?.symbols.insightsGetInstallationId();
		if (!api || !value) return null;
		try {
			return new CString(value).toString();
		} finally {
			api.symbols.freeCoreString(value);
		}
	},
	flush(): void { load()?.symbols.insightsFlush(); },
	shutdown(): void { load()?.symbols.insightsShutdown(); },
};
