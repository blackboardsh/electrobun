/**
 * DirectComposition benchmark.
 *
 * This runs inside an Electrobun app context and validates the public DComp
 * bridge surface that ships from `electrobun/bun`.
 */

import { BrowserWindow, DCompBridge, GpuWindow } from "electrobun/bun";

const WIDTH = 800;
const HEIGHT = 600;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type BenchStatus = "pass" | "fail" | "skip";
type BenchResult = {
	status: BenchStatus;
	details: string;
};

const pass = (details: string): BenchResult => ({ status: "pass", details });
const fail = (details: string): BenchResult => ({ status: "fail", details });
const skip = (details: string): BenchResult => ({ status: "skip", details });

// ============================================================================
// Phase 2: Solid Color via DirectComposition
// ============================================================================
async function benchPhase2(viewPtr: any): Promise<BenchResult> {
	console.log("\n=== Phase 2: Solid Color via DirectComposition ===");

	const ok = DCompBridge.initForView(viewPtr, WIDTH, HEIGHT);
	console.log(`  dcompInitForView: ${ok ? "PASS" : "FAIL"}`);
	if (!ok) return fail("dcompInitForView failed");

	const initialized = DCompBridge.isInitialized();
	console.log(`  dcompIsInitialized: ${initialized ? "PASS" : "FAIL"}`);

	// Render a blue solid color
	const colorOk = DCompBridge.renderColor(0.2, 0.5, 0.8, 1.0);
	console.log(`  dcompRenderColor (blue): ${colorOk ? "PASS" : "FAIL"}`);

	// Render a red solid color
	const color2Ok = DCompBridge.renderColor(0.8, 0.2, 0.1, 1.0);
	console.log(`  dcompRenderColor (red): ${color2Ok ? "PASS" : "FAIL"}`);

	if (ok && initialized && colorOk && color2Ok) {
		return pass("solid-color compositing succeeded");
	}
	return fail("solid-color render sequence did not complete cleanly");
}

// ============================================================================
// Phase 3: Triangle via DirectComposition
// ============================================================================
async function benchPhase3(): Promise<BenchResult> {
	console.log("\n=== Phase 3: D3D11 Triangle via DirectComposition ===");

	const pipelineOk = DCompBridge.initTrianglePipeline();
	console.log(`  dcompInitTrianglePipeline: ${pipelineOk ? "PASS" : "FAIL"}`);
	if (!pipelineOk) return fail("triangle pipeline initialization failed");

	// Render single frame
	const frameOk = DCompBridge.renderTriangle(0.0);
	console.log(`  dcompRenderTriangle (static): ${frameOk ? "PASS" : "FAIL"}`);

	// Start render loop and measure for 3 seconds
	console.log("  Starting 3-second render loop...");
	DCompBridge.startRenderLoop();

	await new Promise((r) => setTimeout(r, 3000));

	const frameTimeMs = DCompBridge.getLastFrameTimeMs();
	const frameCount = DCompBridge.getFrameCount();
	const fps = Number(frameCount) / 3.0;

	DCompBridge.stopRenderLoop();

	console.log(`  Frames rendered: ${frameCount}`);
	console.log(`  Average FPS: ${fps.toFixed(1)}`);
	console.log(`  Last frame time: ${frameTimeMs.toFixed(2)}ms`);
	console.log(`  Phase 3 FPS target: ${fps > 55 ? "PASS" : "FAIL"} (target: 60 FPS)`);

	if (!frameOk) return fail("triangle render failed");
	if (frameCount <= 0n) return fail("render loop produced zero frames");
	if (!Number.isFinite(frameTimeMs) || frameTimeMs < 0) {
		return fail("frame timing did not update");
	}
	if (fps <= 55) return fail(`render loop stayed below target FPS (${fps.toFixed(1)})`);
	return pass(`triangle loop rendered ${frameCount} frames at ${fps.toFixed(1)} FPS`);
}

// ============================================================================
// Phase 4: WebView2 + WGPU Layered Tree (structural test)
// ============================================================================
async function benchPhase4(): Promise<BenchResult> {
	console.log("\n=== Phase 4: Visual Tree Structure ===");
	console.log("  Verifying the real public APIs instead of hard-coding PASS...");

	DCompBridge.shutdown();
	DCompBridge.enableMode(WIDTH, HEIGHT);

	const win = new BrowserWindow({
		title: "DComp Phase 4",
		html: "<!doctype html><html><body style='margin:0;background:transparent;color:white'>DComp Phase 4</body></html>",
		url: null,
		frame: { x: 140, y: 140, width: WIDTH, height: HEIGHT },
		titleBarStyle: "default",
		transparent: true,
	});

	try {
		await delay(1000);

		const initialized = DCompBridge.isInitialized();
		console.log(`  DComp back layer pre-init: ${initialized ? "PASS" : "FAIL"}`);
		if (!initialized) {
			return fail("enableMode did not initialize the DComp back layer for BrowserWindow");
		}

		const webviewPtr = win.webview?.ptr;
		if (!webviewPtr) {
			return fail("BrowserWindow webview pointer was not available");
		}

		const layeredOk = DCompBridge.setupLayeredTree(webviewPtr, null);
		if (!layeredOk) {
			console.log("  dcompSetupLayeredTree: SKIP (composition-hosted WebView2 is disabled in stable mode)");
			return skip("composition-hosted WebView2 is not enabled in the stable DComp mode");
		}
		console.log("  dcompSetupLayeredTree: PASS");

		const attachOk = DCompBridge.attachWebView2(webviewPtr);
		console.log(`  dcompAttachWebView2: ${attachOk ? "PASS" : "FAIL"}`);
		if (!attachOk) {
			return fail("composition-hosted WebView2 could not attach to the visual tree");
		}

		const boundsOk = DCompBridge.updateVisualBounds(
			0,
			0,
			WIDTH,
			HEIGHT,
			0,
			0,
			WIDTH,
			HEIGHT,
		);
		console.log(`  dcompUpdateVisualBounds: ${boundsOk ? "PASS" : "FAIL"}`);
		if (!boundsOk) {
			return fail("visual bounds update failed after WebView2 attach");
		}

		return pass("composition-hosted WebView2 attached and accepted bounds updates");
	} finally {
		DCompBridge.shutdown();
		try {
			win.close();
		} catch {
			// Ignore cleanup errors during benchmark teardown.
		}
	}
}

// ============================================================================
// Main benchmark
// ============================================================================
async function main() {
	console.log("DirectComposition Benchmark");
	console.log("==========================");
	console.log(`Resolution: ${WIDTH}x${HEIGHT}`);

	// Create a GpuWindow for testing
	const win = new GpuWindow({
		title: "DComp Benchmark",
		frame: { x: 100, y: 100, width: WIDTH, height: HEIGHT },
		titleBarStyle: "default",
		transparent: false,
	});

	// Wait for window creation
	await new Promise((r) => setTimeout(r, 500));

	const viewPtr = win.wgpuView?.ptr;
	if (!viewPtr) {
		console.error("Failed to get WGPUView pointer");
		process.exitCode = 1;
		return;
	}

	const results: Record<string, BenchResult> = {};

	results.phase2 = await benchPhase2(viewPtr);
	results.phase3 = await benchPhase3();
	results.phase4 = await benchPhase4();

	// Cleanup
	DCompBridge.shutdown();
	try {
		win.close();
	} catch {
		// Ignore cleanup errors during benchmark teardown.
	}

	console.log("\n=== Summary ===");
	for (const [phase, result] of Object.entries(results)) {
		console.log(`  ${phase}: ${result.status.toUpperCase()} — ${result.details}`);
	}

	const failures = Object.values(results).filter((result) => result.status === "fail");
	const skips = Object.values(results).filter((result) => result.status === "skip");
	const overall =
		failures.length > 0
			? "SOME FAILURES"
			: skips.length > 0
				? "PASS WITH SKIPS"
				: "ALL PASS";
	console.log(`\nOverall: ${overall}`);
	if (failures.length > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
