import "./globals.d.ts";
import { request } from "./internalRpc";

type InternalRequest = (type: string, payload: unknown) => Promise<unknown>;
type Scheduler = (callback: () => void) => unknown;

export function initExternalDropFocusRestoration(
	targetWindow: Window = window,
	platform: Window["__electrobunPlatform"] = window.__electrobunPlatform,
	requestFocus: InternalRequest = request,
	schedule: Scheduler = (callback) => setTimeout(callback),
) {
	if (platform !== "windows") return;

	targetWindow.addEventListener(
		"drop",
		(event) => {
			const types = Array.from((event as DragEvent).dataTransfer?.types ?? []);
			if (!types.includes("Files")) return;

			const previouslyFocusedElement = targetWindow.document.activeElement;
			schedule(() => {
				void requestFocus("restoreWindowFocusAfterExternalDrop", {
					windowId: targetWindow.__electrobunWindowId,
				})
					.catch(() => undefined)
					.then(() => {
						targetWindow.focus();
						if (
							previouslyFocusedElement &&
							"focus" in previouslyFocusedElement &&
							typeof previouslyFocusedElement.focus === "function"
						) {
							(previouslyFocusedElement as HTMLElement).focus();
						}
					});
			});
		},
		true,
	);
}
