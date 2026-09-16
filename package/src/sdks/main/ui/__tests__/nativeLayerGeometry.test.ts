import { describe, expect, test } from "bun:test";
import { NodeKind } from "../tree";
import { createUiContext } from "../ui";
import {
	collectWebviewAnchorMasks,
	pointerToViewLocal,
} from "../nativeLayerGeometry";

describe("native layer geometry", () => {
	test("uses the content origin instead of the decorated frame origin", () => {
		// The Linux WM frame begins at (1054, 670), while this client begins at
		// (1115, 762). A pointer 60x50 into the client must stay 60x50 locally.
		expect(
			pointerToViewLocal(
				{ x: 1175, y: 812 },
				{ x: 1115, y: 762 },
				{ x: 0, y: 0 },
			),
		).toEqual({ x: 60, y: 50 });

		expect(
			pointerToViewLocal(
				{ x: 1175, y: 812 },
				{ x: 1115, y: 762 },
				{ x: 20, y: 10 },
			),
		).toEqual({ x: 40, y: 40 });
	});

	test("collects only live, laid-out webview anchor rectangles", () => {
		const ctx = createUiContext();
		const webview = ctx.tree.createNode(NodeKind.Anchor);
		ctx.tree.append(ctx.tree.root, webview);
		Object.assign(ctx.tree.get(webview), { x: 508, y: 270, w: 339, h: 198 });
		ctx.webviewAnchors.add(webview);

		const zeroSized = ctx.tree.createNode(NodeKind.Anchor);
		ctx.tree.append(ctx.tree.root, zeroSized);
		ctx.webviewAnchors.add(zeroSized);

		expect(collectWebviewAnchorMasks(ctx)).toEqual([
			{ x: 508, y: 270, width: 339, height: 198 },
		]);

		ctx.tree.destroy(webview);
		expect(collectWebviewAnchorMasks(ctx)).toEqual([]);
	});
});
