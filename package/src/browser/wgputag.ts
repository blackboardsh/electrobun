import "./global.d.ts";

type WgpuEventTypes = "ready";

/**
 * Interface representing an <electrobun-wgpu> custom element.
 * Use this to properly type wgpu elements obtained via querySelector.
 *
 * @example
 * const wgpu = document.querySelector('electrobun-wgpu') as WgpuTagElement;
 * wgpu.toggleTransparent(true);
 */
interface WgpuTagElement extends HTMLElement {
	// Properties
	wgpuViewId?: number;
	transparent: boolean;
	passthroughEnabled: boolean;
	hidden: boolean;

	// Visibility and interaction
	toggleTransparent(transparent?: boolean): void;
	togglePassthrough(enablePassthrough?: boolean): void;
	toggleHidden(hidden?: boolean): void;

	// Dimension sync
	syncDimensions(force?: boolean): void;

	// Debug helper
	runTest(): void;

	// Mask management
	addMaskSelector(selector: string): void;
	removeMaskSelector(selector: string): void;

	// Events - listener receives a CustomEvent with detail property
	on(event: WgpuEventTypes, listener: (event: CustomEvent) => void): void;
	off(event: WgpuEventTypes, listener: (event: CustomEvent) => void): void;
	emit(event: WgpuEventTypes, detail: unknown): void;
}

// Augment global types so querySelector('electrobun-wgpu') returns WgpuTagElement
declare global {
	interface HTMLElementTagNameMap {
		"electrobun-wgpu": WgpuTagElement;
	}
}

export { type WgpuTagElement, type WgpuEventTypes };
