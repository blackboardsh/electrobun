/**
 * Tracks which configured surface belongs to which queue and whether that
 * surface has an acquired texture waiting to be presented.
 *
 * Keeping this state keyed by surface prevents one window's submit,
 * unconfigure, or teardown from consuming another window's pending frame.
 */
export class WebgpuPresentationState<TQueue extends object, TSurface extends object> {
	private readonly queueBySurface = new Map<TSurface, TQueue>();
	private readonly surfacesByQueue = new Map<TQueue, Set<TSurface>>();
	private readonly pendingSurfaces = new Set<TSurface>();

	attach(queue: TQueue, surface: TSurface): void {
		const previousQueue = this.queueBySurface.get(surface);
		if (previousQueue === queue) return;
		if (previousQueue) this.detachSurface(surface);

		this.queueBySurface.set(surface, queue);
		let surfaces = this.surfacesByQueue.get(queue);
		if (!surfaces) {
			surfaces = new Set<TSurface>();
			this.surfacesByQueue.set(queue, surfaces);
		}
		surfaces.add(surface);
	}

	markPending(surface: TSurface): void {
		if (!this.queueBySurface.has(surface)) {
			throw new Error("WebGPU surface is not configured with a live queue");
		}
		this.pendingSurfaces.add(surface);
	}

	isPending(surface: TSurface): boolean {
		return this.pendingSurfaces.has(surface);
	}

	takePending(surface: TSurface): boolean {
		if (!this.pendingSurfaces.has(surface)) return false;
		this.pendingSurfaces.delete(surface);
		return true;
	}

	presentPending(queue: TQueue, present: (surface: TSurface) => void): number {
		const surfaces = this.surfacesByQueue.get(queue);
		if (!surfaces) return 0;

		let presented = 0;
		let firstError: unknown;
		for (const surface of surfaces) {
			if (!this.takePending(surface)) continue;
			try {
				present(surface);
				presented += 1;
			} catch (error) {
				firstError ??= error;
			}
		}
		if (firstError) throw firstError;
		return presented;
	}

	presentPendingSurface(
		queue: TQueue,
		surface: TSurface,
		present: (surface: TSurface) => void,
	): boolean {
		if (this.queueBySurface.get(surface) !== queue) return false;
		if (!this.takePending(surface)) return false;
		present(surface);
		return true;
	}

	detachSurface(surface: TSurface): void {
		this.pendingSurfaces.delete(surface);
		const queue = this.queueBySurface.get(surface);
		if (!queue) return;

		this.queueBySurface.delete(surface);
		const surfaces = this.surfacesByQueue.get(queue);
		if (!surfaces) return;
		surfaces.delete(surface);
		if (surfaces.size === 0) this.surfacesByQueue.delete(queue);
	}

	detachQueue(queue: TQueue): TSurface[] {
		const surfaces = [...(this.surfacesByQueue.get(queue) ?? [])];
		for (const surface of surfaces) this.detachSurface(surface);
		return surfaces;
	}
}
