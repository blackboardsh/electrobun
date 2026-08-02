import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);

function balancedBlock(text: string, startNeedle: string, from = 0): string {
	const start = text.indexOf(startNeedle, from);
	if (start < 0) {
		throw new Error(`Missing source marker: ${startNeedle}`);
	}

	const openingBrace = text.indexOf("{", start);
	if (openingBrace < 0) {
		throw new Error(`Missing block after source marker: ${startNeedle}`);
	}

	let depth = 0;
	for (let index = openingBrace; index < text.length; index++) {
		if (text[index] === "{") depth++;
		if (text[index] === "}") depth--;
		if (depth === 0) return text.slice(start, index + 1);
	}

	throw new Error(`Unterminated block after source marker: ${startNeedle}`);
}

function definitionBlock(text: string, name: string): string {
	let start = text.indexOf(name);
	while (start >= 0) {
		const openingBrace = text.indexOf("{", start + name.length);
		const semicolon = text.indexOf(";", start + name.length);
		if (openingBrace >= 0 && (semicolon < 0 || openingBrace < semicolon)) {
			return balancedBlock(text, name, start);
		}
		start = text.indexOf(name, start + name.length);
	}

	throw new Error(`Missing function definition: ${name}`);
}

function conditionalBlock(text: string, condition: RegExp): string {
	const match = condition.exec(text);
	if (!match || match.index === undefined) {
		throw new Error(`Missing conditional: ${condition}`);
	}
	return balancedBlock(text, match[0], match.index);
}

function enclosingBraceBlock(
	text: string,
	position: number,
): [number, number] | undefined {
	const openings: number[] = [];
	for (let index = 0; index <= position; index++) {
		if (text[index] === "{") openings.push(index);
		if (text[index] === "}") openings.pop();
	}

	const openingBrace = openings.at(-1);
	if (openingBrace === undefined) return undefined;

	let depth = 0;
	for (let index = openingBrace; index < text.length; index++) {
		if (text[index] === "{") depth++;
		if (text[index] === "}") depth--;
		if (depth === 0) return [openingBrace, index];
	}

	return undefined;
}

function expectCallAfterLatestMutexScope(
	fragment: string,
	callNeedle: string,
	mutexNeedle: string,
) {
	const call = fragment.indexOf(callNeedle);
	expect(call).toBeGreaterThan(-1);

	// Match actual lock declarations, not comments documenting the mutex. The
	// teardown call must follow the last registry-lock block on its close path.
	const escapedMutex = mutexNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const lockDeclaration = new RegExp(
		`(?:lock_guard|unique_lock)[^;\\n]*${escapedMutex}`,
		"g",
	);
	let latestScope: [number, number] | undefined;
	for (const match of fragment.matchAll(lockDeclaration)) {
		if (match.index >= call) break;
		const scope = enclosingBraceBlock(fragment, match.index);
		if (scope) latestScope = scope;
	}

	expect(latestScope).toBeDefined();
	expect(call).toBeGreaterThan(latestScope![1]);
}

describe("Linux X11 geometry integration", () => {
	test("enables Xlib threading before GTK or any display connection", () => {
		const initializeGTK = definitionBlock(source, "initializeGTK");
		const ensureXlibThreads = definitionBlock(
			source,
			"ensureXlibThreadSupport",
		);
		const libraryLoad = balancedBlock(source, "void on_library_load()");
		const ensureCall = initializeGTK.indexOf("ensureXlibThreadSupport()");
		const gtkInit = initializeGTK.indexOf("gtk_init(");

		expect(ensureCall).toBeGreaterThan(-1);
		expect(ensureCall).toBeLessThan(gtkInit);
		expect(libraryLoad).toContain("ensureXlibThreadSupport()");
		expect(ensureXlibThreads).toContain("XInitThreads()");
		expect(ensureXlibThreads).toMatch(
			/g_xlibThreadsInitialized\.store\s*\(\s*XInitThreads\s*\(\s*\)\s*!=\s*0\s*\)/,
		);
		expect(ensureXlibThreads).toMatch(
			/if\s*\(\s*!\s*g_xlibThreadsInitialized\.load\s*\(\s*\)\s*\)/,
		);
		expect(ensureXlibThreads).toContain("abort()");
		expect(source.indexOf("XInitThreads()")).toBeLessThan(
			source.indexOf("XOpenDisplay("),
		);

		let xOpenDisplay = source.indexOf("XOpenDisplay(");
		while (xOpenDisplay >= 0) {
			expect(
				source.slice(Math.max(0, xOpenDisplay - 400), xOpenDisplay),
			).toContain("ensureXlibThreadSupport()");
			xOpenDisplay = source.indexOf("XOpenDisplay(", xOpenDisplay + 1);
		}

		// Keep the threading policy next to initialization so future Xlib calls do
		// not accidentally mix an unprotected Display with CEF's UI thread.
		const contract = initializeGTK.toLowerCase();
		expect(contract).toMatch(/shar(?:e|ed)[\s\S]{0,40}display/);
		expect(contract).toMatch(/main[-\s]+context/);
		expect(contract).toContain("xlib");
		expect(contract).toMatch(/lock|thread/);
	});

	test("coalesces configure events and separates moves from resizes", () => {
		const processEvents = balancedBlock(source, "gboolean process_x11_events");

		expect(source).toContain('#include "../shared/linux_x11_geometry.h"');
		expect(processEvents).toContain("LinuxX11GeometryReducer geometryReducer");
		const configureCase = processEvents.slice(
			processEvents.indexOf("case ConfigureNotify:"),
			processEvents.indexOf("case Expose:"),
		);
		expect(configureCase).toContain("geometryReducer.observe(");
		expect(configureCase).toContain("event.xconfigure.x");
		expect(configureCase).toContain("event.xconfigure.y");
		expect(configureCase).toContain("event.xconfigure.width");
		expect(configureCase).toContain("event.xconfigure.height");
		expect(configureCase).not.toContain("moveCallback");
		expect(configureCase).not.toContain("resizeCallback");
		expect(configureCase).not.toContain(
			"resizeAutoSizingWebviewsInWindow",
		);

		expect(processEvents).toContain(
			"LinuxX11GeometryChange geometryChange = geometryReducer.result()",
		);
		const reducedGeometryBranch = conditionalBlock(
			processEvents,
			/if\s*\(\s*geometryChange\.hasConfigure\b/,
		);
		const movedBranch = conditionalBlock(
			reducedGeometryBranch,
			/if\s*\(\s*moved\s*&&[^)]*moveCallback[^)]*\)/,
		);
		const resizeCallbackBranch = conditionalBlock(
			reducedGeometryBranch,
			/if\s*\(\s*resized\s*&&[^)]*resizeCallback[^)]*\)/,
		);
		const parentGeometryBranch = conditionalBlock(
			reducedGeometryBranch,
			/if\s*\(\s*moved\s*\|\|\s*resized\s*\)/,
		);
		const autoResizeBranch = conditionalBlock(
			reducedGeometryBranch,
			/if\s*\(\s*resized\s*\)/,
		);

		expect(processEvents.indexOf("geometryReducer.result()")).toBeGreaterThan(
			processEvents.indexOf("geometryReducer.observe("),
		);
		expect(reducedGeometryBranch).toContain(
			"const bool moved = geometryChange.moved",
		);
		expect(reducedGeometryBranch).toContain(
			"const bool resized = geometryChange.resized",
		);
		expect(movedBranch).toContain("moveCallback");
		expect(movedBranch).not.toContain("resizeCallback");
		expect(movedBranch).not.toContain("resizeAutoSizingWebviewsInWindow");
		expect(resizeCallbackBranch).toContain("resizeCallback");
		expect(autoResizeBranch).toContain("resizeAutoSizingWebviewsInWindow");

		// Parent movement matters even when its logical size is unchanged: it can
		// select a monitor with a different scale factor.
		expect(parentGeometryBranch).toContain(
			"syncCEFViewsForParentGeometry",
		);
		expect(parentGeometryBranch).not.toContain("resizeCallback");
	});

	test("keeps CEF children on their parent's Display and actual bounds", () => {
		const cefClass = source.slice(
			source.indexOf("class CEFWebViewImpl : public AbstractView"),
			source.indexOf("static void removeCEFViewsForParentWindow"),
		);
		const constructor = cefClass.slice(
			cefClass.indexOf("CEFWebViewImpl("),
			cefClass.indexOf("~CEFWebViewImpl()"),
		);
		const createBrowser = balancedBlock(cefClass, "void createCEFBrowser");
		const browserCreated = balancedBlock(
			createBrowser,
			"SetBrowserCreatedCallback",
		);
		const syncPosition = balancedBlock(
			cefClass,
			"void syncCEFPositionWithFrame",
		);
		const queryParentBounds = definitionBlock(
			cefClass,
			"queryParentPhysicalBounds",
		);
		const clientClass = source.slice(
			source.indexOf("class ElectrobunClient"),
			source.indexOf("class CEFWebViewImpl : public AbstractView"),
		);

		expect(cefClass).toMatch(/Display\s*\*\s*parentXDisplay/);
		expect(createBrowser).toMatch(
			/parentXDisplay\s*=\s*x11win->display/,
		);
		expect(syncPosition).toContain("parentXDisplay");
		expect(cefClass).not.toContain("gdk_x11_get_default_xdisplay");
		expect(clientClass).not.toContain("gdk_x11_get_default_xdisplay");
		expect(createBrowser).toMatch(
			/SetParentWindowHandle\s*\(\s*x11win->window\s*,\s*x11win->display\s*\)/,
		);

		const fullSizeAssignment = constructor.search(
			/(?:this->)?fullSize\s*=\s*autoResize/,
		);
		expect(fullSizeAssignment).toBeGreaterThan(-1);
		expect(fullSizeAssignment).toBeLessThan(
			constructor.indexOf("createCEFBrowser("),
		);
		expect(queryParentBounds).toMatch(
			/XGetWindowAttributes\s*\(\s*parentXDisplay\s*,\s*(?:\(Window\)\s*)?parentXWindow/,
		);
		const initialFullSizeBranch = conditionalBlock(
			createBrowser,
			/if\s*\(\s*(?:this->)?fullSize\s*\)/,
		);
		const createdFullSizeBranch = conditionalBlock(
			browserCreated,
			/if\s*\(\s*(?:this->)?fullSize\s*\)/,
		);
		expect(initialFullSizeBranch).toContain("queryParentPhysicalBounds");
		expect(createdFullSizeBranch).toContain("queryParentPhysicalBounds");
	});

	test("removes children before destroying either parent-window close path", () => {
		const processEvents = balancedBlock(source, "gboolean process_x11_events");
		const deferredClose = processEvents.slice(
			processEvents.indexOf("for (uint32_t windowId : windows_to_close)"),
		);
		const closeWindow = balancedBlock(
			source,
			"ELECTROBUN_EXPORT void closeWindow",
		);

		for (const closePath of [deferredClose, closeWindow]) {
			const removeChildren = closePath.indexOf(
				"removeCEFViewsForParentWindow",
			);
			const destroyParent = closePath.indexOf("XDestroyWindow");

			expect(removeChildren).toBeGreaterThan(-1);
			expect(destroyParent).toBeGreaterThan(removeChildren);
			expectCallAfterLatestMutexScope(
				closePath,
				"removeCEFViewsForParentWindow",
				"g_x11WindowsMutex",
			);
			expectCallAfterLatestMutexScope(
				closePath,
				"XDestroyWindow",
				"g_x11WindowsMutex",
			);
		}
	});
});
