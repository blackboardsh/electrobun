// Host side of <electrobun-ui>: a webview places the tag; nativeWrapper
// composites a Dawn view over it; and the app mounts a named reactive UI
// tree into that view from the trusted main process.

import electrobunEventEmitter from "../events/eventEmitter";
import { WGPUView } from "../core/WGPUView";
import { createUIView, type UIApp, type UIMountOptions, type UIView } from "./uiwindow";

export interface UIRootRegistration {
	/** Stop accepting new mounts and dispose all live ones. */
	dispose(): void;
}

/**
 * Mount `app` into every <electrobun-ui name="..."> tag with this name.
 * Each tag instance gets its own tree (the builder runs per mount). Views
 * removed by the tag (element disconnected) are detected and disposed.
 */
export function registerUIRoot(
	name: string,
	options: UIMountOptions,
	app: UIApp,
): UIRootRegistration {
	const live = new Set<{ mounted: UIView; watch: ReturnType<typeof setInterval> }>();

	const onMount = async (params: { id: number; name: string }) => {
		if ((params?.name ?? "") !== name) return;
		const view = WGPUView.getById(params.id);
		if (!view || view.isRemoved) return;
		const mounted = await createUIView(view, options, app);
		const entry = {
			mounted,
			watch: setInterval(() => {
				if (view.isRemoved) {
					clearInterval(entry.watch);
					live.delete(entry);
					mounted.dispose();
				}
			}, 250),
		};
		live.add(entry);
	};

	electrobunEventEmitter.on("ui-tag-mount", onMount);

	return {
		dispose() {
			electrobunEventEmitter.off("ui-tag-mount", onMount);
			for (const entry of live) {
				clearInterval(entry.watch);
				entry.mounted.dispose();
			}
			live.clear();
		},
	};
}
