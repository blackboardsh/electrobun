import { CString, dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { UpdaterConfiguration, UpdaterEvents, UpdaterNative, UpdaterResponse, UpdaterState } from "../core/UpdaterClient";

const descriptors = {
	updaterConfigure: { args: [FFIType.cstring], returns: FFIType.bool },
	updaterRequest: { args: [FFIType.cstring], returns: FFIType.ptr },
	updaterGetState: { args: [], returns: FFIType.ptr },
	updaterGetEvents: { args: [FFIType.u64, FFIType.u32], returns: FFIType.ptr },
	updaterShutdown: { args: [], returns: FFIType.void },
	freeCoreString: { args: [FFIType.ptr], returns: FFIType.void },
} as const;
type Library = ReturnType<typeof dlopen<typeof descriptors>>;
let library: Library | undefined;
let stopped = false;
const shutdownHooks = new Set<() => void>();
const filename = process.platform === "win32" ? "ElectrobunCore.dll" : `libElectrobunCore.${suffix}`;

/** A launched app can change cwd before importing the updater. Locate its
 * actual runtime bundle first; importing this module does no filesystem work. */
export function updaterConfiguration(): UpdaterConfiguration {
	const candidates = new Set<string>();
	if (process.execPath) candidates.add(dirname(resolve(process.execPath)));
	if (process.argv0) candidates.add(dirname(resolve(process.argv0)));
	candidates.add(process.cwd());
	const exeDir = [...candidates].find((candidate) => existsSync(join(candidate, filename)) && existsSync(join(candidate, "../Resources/version.json"))) ?? process.cwd();
	return { schemaVersion: 1, exeDir, resourcesDir: resolve(exeDir, "../Resources") };
}

function requireLibrary(): Library {
	if (stopped) throw new Error("The updater has been shut down");
	if (!library) throw new Error("The native core updater is unavailable; rebuild the app with an updater-enabled Electrobun core");
	return library;
}
function readOwned<T>(api: Library, pointer: ReturnType<Library["symbols"]["updaterGetState"]>): T {
	if (!pointer) throw new Error("The native core updater returned no response");
	try { return JSON.parse(new CString(pointer).toString()) as T; }
	finally { api.symbols.freeCoreString(pointer); }
}

/** Core returns owned strings. No worker thread enters the JS runtime. */
export const updaterNative: UpdaterNative = {
	configure(configuration): boolean {
		if (stopped) return false;
		if (!library) {
			try { library = dlopen(join(configuration.exeDir, filename), descriptors); }
			catch { return false; }
		}
		const bytes = new TextEncoder().encode(`${JSON.stringify(configuration)}\0`);
		return library.symbols.updaterConfigure(ptr(bytes));
	},
	request(request): UpdaterResponse {
		const api = requireLibrary();
		const bytes = new TextEncoder().encode(`${JSON.stringify(request)}\0`);
		return readOwned<UpdaterResponse>(api, api.symbols.updaterRequest(ptr(bytes)));
	},
	getState(): UpdaterState {
		const api = requireLibrary();
		const state = readOwned<UpdaterState>(api, api.symbols.updaterGetState());
		const { displayName, managed, ...local } = state.localInfo;
		const { baseUrl, ...managedFields } = managed ?? {};
		return { ...state, localInfo: {
			...local,
			...(displayName == null ? {} : { displayName }),
			...(managed == null ? {} : { managed: { ...managedFields, appId: managed.appId, ...(baseUrl == null ? {} : { baseUrl }) } }),
		} };
	},
	getEvents(afterSequence, limit): UpdaterEvents {
		const api = requireLibrary();
		const page = readOwned<UpdaterEvents>(api, api.symbols.updaterGetEvents(afterSequence, limit));
		return { ...page, entries: page.entries.map(({ details, ...event }) => ({
			...event,
			...(details == null ? {} : { details: Object.fromEntries(Object.entries(details).filter(([key, value]) => key === "exitCode" || value != null)) }),
		})) };
	},
};

export function registerUpdaterShutdown(hook: () => void): void {
	if (stopped) hook();
	else shutdownHooks.add(hook);
}

/** Stop JS polling before joining core's worker, then release our dlopen ref. */
export function shutdownUpdater(): void {
	if (stopped) return;
	stopped = true;
	for (const hook of shutdownHooks) {
		try { hook(); } catch (error) { console.error("[Updater] Shutdown cleanup failed:", error); }
	}
	shutdownHooks.clear();
	if (library) {
		try { library.symbols.updaterShutdown(); }
		finally { library.close(); library = undefined; }
	}
}

process.once("exit", shutdownUpdater);
