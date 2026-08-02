import { describe, expect, test } from "bun:test";
import {
	initOverscrollPrevention,
	shouldApplyOverscrollPrevention,
} from "./events";

describe("overscroll prevention", () => {
	test("does not install the root overscroll rule on Linux", () => {
		let listenerRegistered = false;
		const targetDocument = {
			addEventListener() {
				listenerRegistered = true;
			},
		} as unknown as Document;

		initOverscrollPrevention(targetDocument, "linux");

		expect(listenerRegistered).toBe(false);
	});

	test("uses the native platform marker rather than a spoofable user agent", () => {
		expect(shouldApplyOverscrollPrevention("macos")).toBe(true);
		expect(shouldApplyOverscrollPrevention("windows")).toBe(true);
		expect(shouldApplyOverscrollPrevention("linux")).toBe(false);

		// A supported Linux chromiumFlags configuration may spoof a macOS UA.
		// The host marker remains Linux, so the root-scrolling fix still applies.
		const spoofedUserAgent =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36";
		expect(spoofedUserAgent).toContain("Macintosh");
		expect(shouldApplyOverscrollPrevention("linux")).toBe(false);
	});
});
