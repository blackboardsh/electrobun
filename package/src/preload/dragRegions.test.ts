import { describe, expect, test } from "bun:test";
import {
	DRAG_REGION_COMPATIBILITY_CSS,
	isAppRegionDragTarget,
	registerDragRegionListeners,
	rewriteAppRegionDeclarations,
} from "./dragRegions";

class TestElement {
	parentElement: TestElement | null;
	readonly classList: { contains: (name: string) => boolean };
	readonly computed: Record<string, string>;
	private readonly inlineStyle: string | null;

	constructor(options: {
		parent?: TestElement;
		classes?: string[];
		computed?: Record<string, string>;
		style?: string;
	} = {}) {
		this.parentElement = options.parent ?? null;
		const classes = new Set(options.classes ?? []);
		this.classList = { contains: (name) => classes.has(name) };
		this.computed = options.computed ?? {};
		this.inlineStyle = options.style ?? null;
	}

	getAttribute(name: string): string | null {
		return name === "style" ? this.inlineStyle : null;
	}
}

const readComputedStyle = (element: Element) => ({
	getPropertyValue: (propertyName: string) =>
		(element as unknown as TestElement).computed[propertyName] ?? "",
});

function asEventTarget(element: TestElement): EventTarget {
	return element as unknown as EventTarget;
}

describe("drag-region stylesheet mirroring", () => {
	test("maps legacy drag classes onto native app-region CSS", () => {
		expect(DRAG_REGION_COMPATIBILITY_CSS).toContain(
			".electrobun-webkit-app-region-drag",
		);
		expect(DRAG_REGION_COMPATIBILITY_CSS).toContain(
			"-webkit-app-region: drag",
		);
		expect(DRAG_REGION_COMPATIBILITY_CSS).toContain(
			"-webkit-app-region: no-drag",
		);
	});

	test("rewrites stylesheet declarations without touching comments, strings, or selectors", () => {
		const source = `
/* .ignored { -webkit-app-region: drag; } */
[data-value="app-region: drag"] { content: "-webkit-app-region: drag"; }
@media (min-width: 1px) {
  .drag-overlay { background: rgba(255, 255, 255, 0); -webkit-app-region: drag !important; }
  .controls { app-region: no-drag; }
}`;
		const rewritten = rewriteAppRegionDeclarations(source);

		expect(rewritten).toContain("/* .ignored { -webkit-app-region: drag; } */");
		expect(rewritten).toContain('content: "-webkit-app-region: drag"');
		expect(rewritten).toContain("--electrobun-app-region: drag !important");
		expect(rewritten).toContain("--electrobun-app-region: no-drag");
		expect(rewritten).toContain("background: rgba(255, 255, 255, 0)");
	});
});

describe("drag-region DOM targeting", () => {
	test("recognizes a stylesheet-declared transparent drag region", () => {
		const target = new TestElement({
			computed: { "--electrobun-app-region": "drag" },
		});

		expect(isAppRegionDragTarget(asEventTarget(target), readComputedStyle)).toBe(
			true,
		);
	});

	test("a stylesheet no-drag descendant overrides a drag ancestor", () => {
		const dragParent = new TestElement({
			computed: { "--electrobun-app-region": "drag" },
		});
		const noDragChild = new TestElement({
			parent: dragParent,
			computed: { "--electrobun-app-region": "no-drag" },
		});

		expect(
			isAppRegionDragTarget(asEventTarget(noDragChild), readComputedStyle),
		).toBe(false);
	});

	test("retains class and inline-style behavior", () => {
		const classTarget = new TestElement({
			classes: ["electrobun-webkit-app-region-drag"],
		});
		const inlineTarget = new TestElement({
			computed: { "--electrobun-app-region": "no-drag" },
			style: "color: red; -webkit-app-region: drag",
		});
		const excludedChild = new TestElement({
			parent: classTarget,
			classes: ["electrobun-webkit-app-region-no-drag"],
		});

		expect(
			isAppRegionDragTarget(asEventTarget(classTarget), readComputedStyle),
		).toBe(true);
		expect(
			isAppRegionDragTarget(asEventTarget(inlineTarget), readComputedStyle),
		).toBe(true);
		expect(
			isAppRegionDragTarget(asEventTarget(excludedChild), readComputedStyle),
		).toBe(false);
	});

	test("preload listeners send move messages only for drag targets", () => {
		const listeners = new Map<string, (event: { target: EventTarget }) => void>();
		const targetDocument = {
			addEventListener(
				type: string,
				listener: (event: { target: EventTarget }) => void,
			) {
				listeners.set(type, listener);
			},
		} as unknown as Document;
		const messages: Array<{ type: string; payload: unknown }> = [];
		const dragTarget = new TestElement({
			computed: { "--electrobun-app-region": "drag" },
		});
		const noDragTarget = new TestElement();

		registerDragRegionListeners(
			targetDocument,
			() => 42,
			(type, payload) => messages.push({ type, payload }),
			readComputedStyle,
		);
		listeners.get("mousedown")?.({ target: asEventTarget(dragTarget) });
		listeners.get("mouseup")?.({ target: asEventTarget(dragTarget) });
		listeners.get("mousedown")?.({ target: asEventTarget(noDragTarget) });

		expect(messages).toEqual([
			{ type: "startWindowMove", payload: { id: 42 } },
			{ type: "stopWindowMove", payload: { id: 42 } },
		]);
	});
});
