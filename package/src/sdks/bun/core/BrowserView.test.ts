import { beforeEach, expect, mock, test } from "bun:test";

type ResizeRequest = {
	id: number;
	frame: { x: number; y: number; width: number; height: number };
};

const resizeRequests: ResizeRequest[] = [];
let resizeFailure: Error | null = null;
const resizeWebview = mock((request: ResizeRequest) => {
	resizeRequests.push(request);
	if (resizeFailure) {
		throw resizeFailure;
	}
});

mock.module("../proc/native", () => ({
	ffi: {
		request: {
			resizeWebview,
		},
	},
}));

const { BrowserView } = await import("./BrowserView");

function createView(autoResize = false) {
	const view = Object.create(BrowserView.prototype) as InstanceType<
		typeof BrowserView
	>;
	view.id = 42;
	view.frame = { x: 0, y: 0, width: 800, height: 600 };
	view.autoResize = autoResize;
	view.isRemoved = false;
	Object.defineProperty(view, "ptr", {
		get() {
			throw new Error("ptr accessed");
		},
	});
	return view;
}

beforeEach(() => {
	resizeRequests.length = 0;
	resizeFailure = null;
	resizeWebview.mockClear();
});

test("setFrame resizes by ID, updates state, and copies input", () => {
	const view = createView();
	const frame = { x: 20, y: -10, width: 640, height: 480 };

	view.setFrame(frame);

	expect(resizeRequests).toEqual([
		{ id: 42, frame: { x: 20, y: -10, width: 640, height: 480 } },
	]);
	expect(view.frame).toEqual(frame);
	expect(view.frame).not.toBe(frame);

	frame.width = 1;
	expect(view.frame.width).toBe(640);
});

test("setFrame applies repeated updates and preserves autoResize", () => {
	for (const autoResize of [false, true]) {
		const view = createView(autoResize);
		view.setFrame({ x: 1, y: 2, width: 300, height: 200 });
		view.setFrame({ x: 3, y: 4, width: 500, height: 400 });

		expect(view.frame).toEqual({ x: 3, y: 4, width: 500, height: 400 });
		expect(view.autoResize).toBe(autoResize);
	}

	expect(resizeRequests.map(({ frame }) => frame)).toEqual([
		{ x: 1, y: 2, width: 300, height: 200 },
		{ x: 3, y: 4, width: 500, height: 400 },
		{ x: 1, y: 2, width: 300, height: 200 },
		{ x: 3, y: 4, width: 500, height: 400 },
	]);
});

test("setFrame rejects invalid values without resizing or mutating state", () => {
	const invalidFrames = [
		{ x: Number.NaN, y: 0, width: 100, height: 100 },
		{ x: Number.POSITIVE_INFINITY, y: 0, width: 100, height: 100 },
		{ x: 0, y: Number.NEGATIVE_INFINITY, width: 100, height: 100 },
		{ x: 0, y: 0, width: -1, height: 100 },
		{ x: 0, y: 0, width: 100, height: -1 },
	];

	for (const frame of invalidFrames) {
		const view = createView();
		const previousFrame = view.frame;
		expect(() => view.setFrame(frame)).toThrow();
		expect(view.frame).toBe(previousFrame);
	}

	expect(resizeRequests).toHaveLength(0);
});

test("setFrame leaves state unchanged when native resize fails", () => {
	const view = createView();
	const previousFrame = view.frame;
	resizeFailure = new Error("resize failed");

	expect(() =>
		view.setFrame({ x: 10, y: 20, width: 300, height: 200 }),
	).toThrow("resize failed");
	expect(view.frame).toBe(previousFrame);
});

test("setFrame is a no-op after remove", () => {
	const view = createView();
	const previousFrame = view.frame;
	view.isRemoved = true;

	view.setFrame({ x: 10, y: 20, width: 300, height: 200 });

	expect(resizeRequests).toHaveLength(0);
	expect(view.frame).toBe(previousFrame);
});
