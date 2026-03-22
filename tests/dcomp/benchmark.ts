/**
 * DirectComposition benchmark.
 *
 * Validates the public, stable DComp APIs that ship through `electrobun/bun`.
 * Composition-hosted WebView2 helpers remain experimental and are reported as
 * skipped until that runtime path is enabled.
 */

import { DCompBridge, GpuWindow } from "electrobun/bun";

const WIDTH = 800;
const HEIGHT = 600;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PhaseResult = {
	status: "PASS" | "FAIL" | "SKIP";
	details: string;
};

// ============================================================================
// Phase 2: Solid Color via DirectComposition
// ============================================================================
async function benchPhase2(viewPtr: any): Promise<PhaseResult> {
	console.log("\n=== Phase 2: Solid Color via DirectComposition ===");

	const ok = DCompBridge.initForView(viewPtr, WIDTH, HEIGHT);
	console.log(`  dcompInitForView: ${ok ? "PASS" : "FAIL"}`);
	if (!ok) {
		return { status: "FAIL", details: "dcompInitForView failed" };
	}

	const initialized = DCompBridge.isInitialized();
	console.log(`  dcompIsInitialized: ${initialized ? "PASS" : "FAIL"}`);

	// Render a blue solid color
	const colorOk = DCompBridge.renderColor(0.2, 0.5, 0.8, 1.0);
	console.log(`  dcompRenderColor (blue): ${colorOk ? "PASS" : "FAIL"}`);

	// Render a red solid color
	const color2Ok = DCompBridge.renderColor(0.8, 0.2, 0.1, 1.0);
	console.log(`  dcompRenderColor (red): ${color2Ok ? "PASS" : "FAIL"}`);

	if (ok && initialized && colorOk && color2Ok) {
		return { status: "PASS", details: "solid-color DComp compositing succeeded" };
	}
	return { status: "FAIL", details: "solid-color render sequence did not complete cleanly" };
}

// ============================================================================
// Phase 3: Triangle via DirectComposition
// ============================================================================
async function benchPhase3(): Promise<PhaseResult> {
	console.log("\n=== Phase 3: D3D11 Triangle via DirectComposition ===");

	const pipelineOk = DCompBridge.initTrianglePipeline();
	console.log(`  dcompInitTrianglePipeline: ${pipelineOk ? "PASS" : "FAIL"}`);
	if (!pipelineOk) {
		return { status: "FAIL", details: "triangle pipeline initialization failed" };
	}

	// Render single frame
	const frameOk = DCompBridge.renderTriangle(0.0);
	console.log(`  dcompRenderTriangle (static): ${frameOk ? "PASS" : "FAIL"}`);

	// Start render loop and measure for 3 seconds
	console.log("  Starting 3-second render loop...");
	DCompBridge.startRenderLoop();

	await wait(3000);

	const frameTimeMs = DCompBridge.getLastFrameTimeMs();
	const frameCount = DCompBridge.getFrameCount();
	const fps = Number(frameCount) / 3.0;

	DCompBridge.stopRenderLoop();

	console.log(`  Frames rendered: ${frameCount}`);
	console.log(`  Average FPS: ${fps.toFixed(1)}`);
	console.log(`  Last frame time: ${frameTimeMs.toFixed(2)}ms`);
	console.log(`  Phase 3 FPS target: ${fps > 55 ? "PASS" : "FAIL"} (target: 60 FPS)`);

	if (!frameOk) {
		return { status: "FAIL", details: "static triangle render failed" };
	}
	if (frameCount <= 0n) {
		return { status: "FAIL", details: "render loop produced zero frames" };
	}
	if (!Number.isFinite(frameTimeMs) || frameTimeMs < 0) {
		return { status: "FAIL", details: "frame timing was not updated" };
	}
	if (fps <= 55) {
		return { status: "FAIL", details: `render loop stayed below target FPS (${fps.toFixed(1)})` };
	}
	return {
		status: "PASS",
		details: `triangle loop rendered ${frameCount} frames at ${fps.toFixed(1)} FPS`,
	};
}

// ============================================================================
// Phase 4: WebView2 + WGPU Layered Tree (structural test)
// ============================================================================
async function benchPhase4(): Promise<PhaseResult> {
	console.log("\n=== Phase 4: Visual Tree Structure ===");
	console.log("  Composition-hosted WebView2 is experimental and disabled in the stable runtime.");
	return {
		status: "SKIP",
		details: "composition-hosted WebView2 helpers are intentionally disabled in stable mode",
	};
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
	await wait(500);

	const viewPtr = win.wgpuView?.ptr;
	if (!viewPtr) {
		console.error("Failed to get WGPUView pointer");
		return;
	}

	const results: Record<string, PhaseResult> = {};

	results.phase2 = await benchPhase2(viewPtr);
	results.phase3 = await benchPhase3();
	results.phase4 = await benchPhase4();

	// Cleanup
	DCompBridge.shutdown();

	console.log("\n=== Summary ===");
	for (const [phase, result] of Object.entries(results)) {
		console.log(`  ${phase}: ${result.status} — ${result.details}`);
	}

	const hasFailures = Object.values(results).some((result) => result.status === "FAIL");
	const hasSkips = Object.values(results).some((result) => result.status === "SKIP");
	const overall = hasFailures ? "SOME FAILURES" : hasSkips ? "PASS WITH SKIPS" : "ALL PASS";
	console.log(`\nOverall: ${overall}`);
	if (hasFailures) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
