export interface WebgpuContextEntry<T> {
	instance: number;
	surface: number;
	context: T;
	teardown(): void;
}

/** Owns context entries and their "last created" fallback as one lifecycle. */
export class WebgpuContextRegistry<T> {
	private readonly contexts = new Map<number, WebgpuContextEntry<T>>();
	lastCreatedContext: T | null = null;

	get size(): number {
		return this.contexts.size;
	}

	get(key: number): WebgpuContextEntry<T> | undefined {
		return this.contexts.get(key);
	}

	set(key: number, entry: WebgpuContextEntry<T>): void {
		if (this.contexts.has(key)) {
			throw new Error(`WebGPU context ${key} is already registered`);
		}
		this.contexts.set(key, entry);
		this.lastCreatedContext = entry.context;
	}

	release(key: number): boolean {
		const entry = this.contexts.get(key);
		if (!entry) return false;

		// Clear JS reachability before native teardown so failures cannot leave a
		// stale context available through get() or requestAdapter's fallback.
		this.contexts.delete(key);
		if (this.lastCreatedContext === entry.context) {
			this.lastCreatedContext = null;
			for (const remaining of this.contexts.values()) {
				this.lastCreatedContext = remaining.context;
			}
		}
		entry.teardown();
		return true;
	}
}

export interface WebgpuNativeCreateOps {
	createInstance(): number;
	createSurface(instance: number): number;
	unconfigureSurface(surface: number): void;
	releaseSurface(surface: number): void;
	releaseInstance(instance: number): void;
}

/**
 * Creates the instance/surface pair and rolls both handles back when surface
 * creation or any pre-registration initialization fails.
 */
export function createNativeWebgpuContext<T>(
	ops: WebgpuNativeCreateOps,
	initialize: (handles: { instance: number; surface: number }) => T,
): T {
	const instance = Number(ops.createInstance());
	if (!instance) throw new Error("Failed to create WGPU instance");

	let surface = 0;
	try {
		surface = Number(ops.createSurface(instance));
		if (!surface) throw new Error("Failed to create WGPU surface");
		return initialize({ instance, surface });
	} catch (error) {
		releaseNativeWebgpuContext({ instance, surface }, ops);
		throw error;
	}
}

export interface WebgpuNativeReleaseOps {
	unconfigureSurface(surface: number): void;
	releaseSurface(surface: number): void;
	releaseInstance(instance: number): void;
}

/** Release every native handle even if an earlier teardown operation fails. */
export function releaseNativeWebgpuContext(
	entry: { instance: number; surface: number },
	ops: WebgpuNativeReleaseOps,
): void {
	if (entry.surface) {
		try {
			ops.unconfigureSurface(entry.surface);
		} catch {}
		try {
			ops.releaseSurface(entry.surface);
		} catch {}
	}
	if (entry.instance) {
		try {
			ops.releaseInstance(entry.instance);
		} catch {}
	}
}

// WGPUView is intentionally independent of webgpuAdapter to avoid a module
// cycle. Context creation registers a one-shot release here; view/window
// teardown triggers it by WGPU-view ID.
const contextReleaseHandlers = new Map<number, () => void>();

export function registerWebgpuContextRelease(
	key: number,
	release: () => void,
): void {
	contextReleaseHandlers.set(key, release);
}

export function releaseWebgpuContext(key: number): boolean {
	const release = contextReleaseHandlers.get(key);
	if (!release) return false;
	contextReleaseHandlers.delete(key);
	release();
	return true;
}
