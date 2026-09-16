import { describe, expect, test } from "bun:test";
import { initExternalDropFocusRestoration } from "./externalDropFocus";

type DropListener = (event: { dataTransfer?: { types: string[] } }) => void;

function createWindowStub() {
	let listener: DropListener | null = null;
	let capture = false;
	let windowFocusCount = 0;
	let elementFocusCount = 0;
	const target = {
		__electrobunWindowId: 42,
		document: {
			activeElement: {
				focus() {
					elementFocusCount += 1;
				},
			},
		},
		addEventListener(type: string, nextListener: DropListener, options?: boolean) {
			if (type === "drop") {
				listener = nextListener;
				capture = options === true;
			}
		},
		focus() {
			windowFocusCount += 1;
		},
	} as unknown as Window;

	return {
		target,
		drop(types: string[]) {
			if (!listener) throw new Error("drop listener was not installed");
			listener({ dataTransfer: { types } });
		},
		counts: () => ({ windowFocusCount, elementFocusCount, capture }),
	};
}

describe("Windows external drop focus restoration", () => {
	test("is not installed on non-Windows renderers", () => {
		const stub = createWindowStub();
		initExternalDropFocusRestoration(
			stub.target,
			"linux",
			async () => true,
			(callback) => callback(),
		);

		expect(() => stub.drop(["Files"])).toThrow("drop listener was not installed");
	});

	test("reactivates the host and restores the focused control after a file drop", async () => {
		const stub = createWindowStub();
		const requests: Array<{ type: string; payload: unknown }> = [];
		initExternalDropFocusRestoration(
			stub.target,
			"windows",
			async (type, payload) => {
				requests.push({ type, payload });
				return true;
			},
			(callback) => callback(),
		);

		stub.drop(["text/plain"]);
		expect(requests).toEqual([]);

		stub.drop(["Files"]);
		await Promise.resolve();
		await Promise.resolve();

		expect(requests).toEqual([
			{
				type: "restoreWindowFocusAfterExternalDrop",
				payload: { windowId: 42 },
			},
		]);
		expect(stub.counts()).toEqual({
			windowFocusCount: 1,
			elementFocusCount: 1,
			capture: true,
		});
	});
});
