// <electrobun-ui> Custom Element
// A layout-driven native surface, like <electrobun-wgpu>, whose content is a
// Cottontail UI tree mounted in the main process via registerUIRoot(name).
// The DOM element is only the anchor: nativeWrapper composites the Dawn
// layer, and the main process owns the reactive tree rendered into it.

import { send } from "./internalRpc";
import { ElectrobunWgpuTag } from "./wgpuTag";

export class ElectrobunUiTag extends ElectrobunWgpuTag {
	async initWgpuView() {
		await super.initWgpuView();
		if (this.wgpuViewId !== null) {
			// Tell the main process which named UI root should mount here.
			send("uiTagMount", {
				id: this.wgpuViewId,
				name: this.getAttribute("name") ?? "",
			});
		}
	}
}

export function initUiTag() {
	if (!customElements.get("electrobun-ui")) {
		customElements.define("electrobun-ui", ElectrobunUiTag);
	}

	const injectStyles = () => {
		const style = document.createElement("style");
		style.textContent = `
electrobun-ui {
	display: block;
	width: 400px;
	height: 300px;
}
`;
		document.head.appendChild(style);
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", injectStyles);
	} else {
		injectStyles();
	}
}
