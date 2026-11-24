import "./globals.d.ts";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type MaskRect = Rect;

export type OverlaySyncOptions = {
	onSync: (rect: Rect, masksJson: string) => void;
	getMasks?: () => MaskRect[];
	burstIntervalMs?: number;
	baseIntervalMs?: number;
	burstDurationMs?: number;
};

export class OverlaySyncController {
	private element: HTMLElement;
	private options: Required<OverlaySyncOptions>;
	private lastRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
	private resizeObserver: ResizeObserver | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private positionLoop: ReturnType<typeof setTimeout> | null = null;
	private resizeHandler: (() => void) | null = null;
	private scrollHandler: (() => void) | null = null;
	private burstUntil = 0;

	constructor(element: HTMLElement, options: OverlaySyncOptions) {
		this.element = element;
		this.options = {
			onSync: options.onSync,
			getMasks: options.getMasks ?? (() => []),
			burstIntervalMs: options.burstIntervalMs ?? 50,
			baseIntervalMs: options.baseIntervalMs ?? 1000,
			burstDurationMs: options.burstDurationMs ?? 500,
		};
	}

	start() {
		this.resizeObserver = new ResizeObserver(() => this.sync());
		this.resizeObserver.observe(this.element);

		// Visibility/position changes against the viewport (layout shifts that
		// move the element across a threshold).
		this.intersectionObserver = new IntersectionObserver(() => this.sync(), {
			threshold: [0, 0.25, 0.5, 0.75, 1],
		});
		this.intersectionObserver.observe(this.element);

		// Any ancestor scrolling moves the element: capture phase sees them all.
		this.scrollHandler = () => {
			this.sync();
			this.burst();
		};
		window.addEventListener("scroll", this.scrollHandler, {
			capture: true,
			passive: true,
		});

		// Polling is only the safety net for moves no observer sees — each
		// poll calls getBoundingClientRect(), which forces a layout of the
		// host page. Fast for a short burst after a change, else once a second.
		this.schedule(this.options.baseIntervalMs);

		this.resizeHandler = () => {
			this.sync(true);
			this.burst();
		};
		window.addEventListener("resize", this.resizeHandler);
	}

	private loop = () => {
		this.positionLoop = null;
		this.sync();
		this.schedule(
			performance.now() < this.burstUntil
				? this.options.burstIntervalMs
				: this.options.baseIntervalMs,
		);
	};

	private schedule(ms: number) {
		if (this.positionLoop) clearTimeout(this.positionLoop);
		this.positionLoop = setTimeout(this.loop, ms);
	}

	/** Poll at burst cadence for a while: right after a move or an
	 *  interaction, follow-up moves come fast. */
	private burst() {
		const wasIdle = performance.now() >= this.burstUntil;
		this.burstUntil = performance.now() + this.options.burstDurationMs;
		if (wasIdle && this.resizeObserver) {
			this.schedule(this.options.burstIntervalMs);
		}
	}

	stop() {
		if (this.resizeObserver) this.resizeObserver.disconnect();
		if (this.intersectionObserver) this.intersectionObserver.disconnect();
		if (this.positionLoop) clearTimeout(this.positionLoop);
		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
		}
		if (this.scrollHandler) {
			window.removeEventListener("scroll", this.scrollHandler, {
				capture: true,
			});
		}
		this.resizeObserver = null;
		this.intersectionObserver = null;
		this.positionLoop = null;
		this.resizeHandler = null;
		this.scrollHandler = null;
	}

	forceSync() {
		this.sync(true);
	}

	setLastRect(rect: Rect) {
		this.lastRect = rect;
	}

	private sync(force = false) {
		const rect = this.element.getBoundingClientRect();
		const newRect: Rect = {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		};

		if (newRect.width === 0 && newRect.height === 0) {
			return;
		}

		if (
			!force &&
			newRect.x === this.lastRect.x &&
			newRect.y === this.lastRect.y &&
			newRect.width === this.lastRect.width &&
			newRect.height === this.lastRect.height
		) {
			return;
		}

		this.burst();
		this.lastRect = newRect;

		// DOM CSS pixels are Electrobun DIPs. Native wrappers own the single
		// DIP-to-physical-pixel conversion at the platform boundary.
		const masks = this.options.getMasks();
		this.options.onSync(newRect, JSON.stringify(masks));
	}
}
