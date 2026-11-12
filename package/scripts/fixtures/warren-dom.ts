import { cleanup, inert, live, signal } from "../../src/shared/warren/reactive";
import { Show, jsx, render } from "../../src/browser/ui/dom";

const [release, setRelease] = signal({
	visible: true,
	command: "hutch electrobun publish --release=stable-1.2.0",
	platforms: 1,
	revision: 0,
});
const lifecycle = { mounted: 0, disposed: 0, fallbackMounted: 0 };
const container = document.querySelector("#app")!;

const dispose = render(() => jsx("main", {
	children: Show({
		when: live(() => release().visible),
		fallback: () => inert(() => {
			lifecycle.fallbackMounted++;
			return jsx("p", { id: "empty", children: "No release selected" });
		}),
		children: () => inert(() => {
			lifecycle.mounted++;
			cleanup(() => { lifecycle.disposed++; });
			return jsx("section", {
				id: "release",
				children: [
					jsx("input", { id: "draft", "aria-label": "Draft", value: "Initial draft" }),
					jsx("button", { id: "publish", type: "button", children: "Publish" }),
					jsx("p", { id: "platforms", children: live(() => `${release().platforms} platforms`) }),
					jsx("details", {
						id: "instructions",
						children: [
							jsx("summary", { children: "Publish from CI" }),
							jsx("pre", { children: jsx("code", { id: "command", children: live(() => release().command) }) }),
						],
					}),
				],
			});
		}),
	}),
}), container);

Object.assign(window, {
	warrenFixture: {
		// A network response is a fresh object even when all displayed fields agree.
		poll: () => setRelease(current => ({ ...current, revision: current.revision + 1 })),
		update: (patch: Partial<ReturnType<typeof release>>) => setRelease(current => ({ ...current, ...patch })),
		lifecycle,
		dispose,
	},
});
