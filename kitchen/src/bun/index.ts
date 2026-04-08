// Electrobun Kitchen Sink - Integration Test Runner
// Run with: cd /electrobun/package && bun dev

import Electrobun, {
	BrowserWindow,
	BrowserView,
	ApplicationMenu,
	Utils,
	BuildConfig,
	Updater,
	Protocol,
} from "electrobun/bun";
import { executor } from "../test-framework/executor";
import { allTests } from "../tests";
import type { TestRunnerRPC, UpdateInfo } from "../test-runner/rpc";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

const encoder = new TextEncoder();

await Protocol.handle("electrobun-test", async (request) => {
	const url = new URL(request.url);

	if (url.pathname === "/index.html") {
		return new Response(
			'<!doctype html><html><head><title>Electrobun Protocol</title></head><body><h1>Electrobun Protocol</h1><script type="module" src="views://test-harness/index.js"></script></body></html>',
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		);
	}
	if (url.pathname === "/text") {
		return new Response("hello from electrobun protocol", {
			headers: { "content-type": "text/plain; charset=utf-8", "x-electrobun-protocol": "ok" },
		});
	}
	if (url.pathname === "/stream") {
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("stream-"));
					controller.enqueue(encoder.encode("response"));
					controller.close();
				},
			}),
			{ headers: { "content-type": "text/plain; charset=utf-8" } },
		);
	}
	if (url.pathname === "/echo") {
		return new Response(await request.text(), { headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	if (url.pathname === "/stream-request-order") {
		const chunks: string[] = [];
		const reader = request.body?.getReader();
		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(new TextDecoder().decode(value));
			}
		}
		return new Response(JSON.stringify({ chunkCount: chunks.length, chunks, joined: chunks.join("") }), {
			headers: { "content-type": "application/json; charset=utf-8" },
		});
	}
	if (url.pathname === "/status/204") return new Response(null, { status: 204 });
	if (url.pathname === "/status/201") {
		return new Response("created", { status: 201, statusText: "Created", headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	if (url.pathname === "/status/400") {
		return new Response("bad request body", { status: 400, statusText: "Bad Request", headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	if (url.pathname === "/status/500") {
		return new Response("internal error detail", { status: 500, statusText: "Internal Server Error", headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	if (url.pathname === "/echo-method") {
		const body = request.method !== "HEAD" && request.method !== "GET" ? await request.text() : "";
		return new Response(JSON.stringify({ method: request.method, body }), { headers: { "content-type": "application/json; charset=utf-8" } });
	}
	if (url.pathname === "/head-resource") {
		return new Response(request.method === "HEAD" ? null : "head-resource-body", {
			headers: { "content-type": "text/plain; charset=utf-8", "content-length": "18", "x-resource-id": "head-test" },
		});
	}
	if (url.pathname === "/headers/multi") {
		const res = new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
		res.headers.append("x-multi", "first");
		res.headers.append("x-multi", "second");
		return res;
	}
	if (url.pathname === "/headers/echo-request") {
		const echoed: Record<string, string> = {};
		request.headers.forEach((value, name) => { echoed[name.toLowerCase()] = value; });
		return new Response(JSON.stringify(echoed), { headers: { "content-type": "application/json; charset=utf-8" } });
	}
	if (url.pathname === "/body/binary") {
		const bytes = new Uint8Array(256);
		for (let i = 0; i < 256; i++) bytes[i] = i;
		return new Response(bytes.buffer, { headers: { "content-type": "application/octet-stream" } });
	}
	if (url.pathname === "/body/echo-binary") {
		return new Response(await request.arrayBuffer(), { headers: { "content-type": "application/octet-stream" } });
	}
	if (url.pathname === "/body/urlencoded") {
		return new Response("key=value&foo=bar", { headers: { "content-type": "application/x-www-form-urlencoded" } });
	}
	if (url.pathname === "/body/formdata") {
		const boundary = "boundary123";
		const body = `--${boundary}\r\nContent-Disposition: form-data; name="field1"\r\n\r\nhello\r\n--${boundary}\r\nContent-Disposition: form-data; name="field2"\r\n\r\nworld\r\n--${boundary}--\r\n`;
		return new Response(body, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
	}
	if (url.pathname === "/body/slow-stream") {
		let cancelled = false;
		const stream = new ReadableStream({
			async start(controller) {
				for (let i = 0; i < 10; i++) {
					if (cancelled) break;
					controller.enqueue(encoder.encode(`chunk-${i} `));
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
				if (!cancelled) controller.close();
			},
			cancel() { cancelled = true; },
		});
		return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
});

console.log("\n");
console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║       Electrobun Integration Test Runner                   ║");
console.log("╠════════════════════════════════════════════════════════════╣");
console.log("║  Run automated tests: Click 'Run All Automated' button    ║");
console.log("║  Run interactive tests: Click 'Run Interactive Tests'     ║");
console.log("║                                                            ║");
console.log("║  Auto-run tests: AUTO_RUN=1 electrobun dev                 ║");
console.log("║                                                            ║");
console.log("║  Results will appear both in the UI and in this terminal  ║");
console.log("╚════════════════════════════════════════════════════════════╝");
console.log("\n");

// Log build configuration
const buildConfig = await BuildConfig.get();
console.log("Build Configuration:");
console.log(`   Default Renderer: ${buildConfig.defaultRenderer}`);
console.log(
	`   Available Renderers: ${buildConfig.availableRenderers.join(", ")}`,
);
console.log("");

type TestRunnerPreferences = {
	searchQuery: string;
};

const testRunnerPreferencesPath = join(
	Utils.paths.userData,
	"test-runner-preferences.json",
);

const loadTestRunnerPreferences = async (): Promise<TestRunnerPreferences> => {
	try {
		const raw = await readFile(testRunnerPreferencesPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<TestRunnerPreferences>;
		return {
			searchQuery:
				typeof parsed.searchQuery === "string" ? parsed.searchQuery : "",
		};
	} catch {
		return { searchQuery: "" };
	}
};

let testRunnerPreferences: TestRunnerPreferences =
	await loadTestRunnerPreferences();

const saveTestRunnerPreferences = async (
	next: Partial<TestRunnerPreferences>,
): Promise<void> => {
	testRunnerPreferences = {
		...testRunnerPreferences,
		...next,
	};
	await mkdir(dirname(testRunnerPreferencesPath), { recursive: true });
	await writeFile(
		testRunnerPreferencesPath,
		JSON.stringify(testRunnerPreferences, null, 2),
		"utf-8",
	);
};

// Update state
const localInfo = await Updater.getLocallocalInfo();
let updateState: UpdateInfo = {
	status: "checking",
	currentVersion: localInfo.version,
};

console.log(`Current version: ${localInfo.version} (${localInfo.channel})`);

// Register for granular update status changes
Updater.onStatusChange((entry) => {
	testRunnerWindow?.webview.rpc?.send.updateStatusEntry(entry);
});

// Check for updates
const checkForUpdate = async () => {
	try {
		updateState.status = "checking";
		broadcastUpdateStatus();

		const updateInfo = await Updater.checkForUpdate();

		if (updateInfo.error) {
			console.log(`Update check error: ${updateInfo.error}`);
			updateState.status = "error";
			updateState.error = updateInfo.error;
			broadcastUpdateStatus();
			return;
		}

		if (updateInfo.updateAvailable) {
			console.log(`Update available: ${updateInfo.version}`);
			updateState.status = "update-available";
			updateState.newVersion = updateInfo.version;
			broadcastUpdateStatus();

			// Start downloading
			updateState.status = "downloading";
			broadcastUpdateStatus();

			await Updater.downloadUpdate();

			if (Updater.updateInfo().updateReady) {
				console.log("Update downloaded and ready to install");
				updateState.status = "update-ready";
				broadcastUpdateStatus();
			} else {
				console.log("Update download failed");
				updateState.status = "error";
				updateState.error = "Download failed";
				broadcastUpdateStatus();
			}
		} else {
			console.log("No update available");
			updateState.status = "no-update";
			broadcastUpdateStatus();
		}
	} catch (err: any) {
		console.log(`Update check failed: ${err.message}`);
		updateState.status = "error";
		updateState.error = err.message;
		broadcastUpdateStatus();
	}
};

// Broadcast update status to all windows
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let testRunnerWindow: BrowserWindow<any> | null = null;
const broadcastUpdateStatus = () => {
	testRunnerWindow?.webview.rpc?.send.updateStatus(updateState);
};

// Register all tests
executor.registerTests(allTests);

// Log test registration
const automated = executor.getAutomatedTests();
const interactive = executor.getInteractiveTests();
console.log(`Registered ${allTests.length} tests:`);
console.log(`  - ${automated.length} automated tests`);
console.log(`  - ${interactive.length} interactive tests`);
console.log("");

// Set up the application menu
ApplicationMenu.setApplicationMenu([
	{
		submenu: [{ label: "Quit", role: "quit", accelerator: "q" }],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
		],
	},
	{
		label: "Tests",
		submenu: [
			{
				label: "Run All Automated",
				action: "run-all-automated",
				accelerator: "CommandOrControl+R",
			},
			{
				label: "Run Interactive Tests",
				action: "run-interactive",
				accelerator: "CommandOrControl+Shift+R",
			},
		],
	},
]);

Electrobun.events.on("application-menu-clicked", async (e) => {
	if (e.data.action === "run-all-automated") {
		await executor.runAllAutomated();
	} else if (e.data.action === "run-interactive") {
		await executor.runInteractiveTests();
	}
});

// Create the RPC for the test runner window
const testRunnerRPC = BrowserView.defineRPC<TestRunnerRPC>({
	maxRequestTime: 300000, // 5 minutes for long test runs
	handlers: {
		requests: {
			getTests: () => {
				return executor.getTests().map((t) => ({
					id: t.id,
					name: t.name,
					category: t.category,
					description: t.description,
					interactive: t.interactive,
				}));
			},

			runTest: async ({ testId }) => {
				const test = executor.getTests().find((t) => t.id === testId);
				if (!test) {
					throw new Error(`Test not found: ${testId}`);
				}
				return await executor.runTest(test);
			},

			runAllAutomated: async () => {
				return await executor.runAllAutomated();
			},

			runInteractiveTests: async () => {
				return await executor.runInteractiveTests();
			},

			submitInteractiveResult: ({ testId, passed, notes }) => {
				executor.submitInteractiveResult(testId, passed, notes);
			},

			submitReady: ({ testId }) => {
				executor.submitReady(testId);
			},

			submitVerification: ({ testId, action, notes }) => {
				executor.submitVerification(testId, action, notes);
			},

			applyUpdate: () => {
				console.log("Applying update...");
				Updater.applyUpdate();
			},

			getUpdateStatusHistory: () => {
				return Updater.getStatusHistory();
			},

			clearUpdateStatusHistory: () => {
				Updater.clearStatusHistory();
			},

			getTestRunnerPreferences: () => {
				return testRunnerPreferences;
			},

			setTestRunnerPreferences: async ({ searchQuery }) => {
				await saveTestRunnerPreferences({ searchQuery });
			},
		},
		messages: {
			logToBun: ({ msg }) => {
				console.log("[UI]", msg);
			},
		},
	},
});

// Create the test runner window
testRunnerWindow = new BrowserWindow({
	title: "Electrobun Integration Tests",
	url: "views://test-runner/index.html",
	renderer: "cef",
	frame: {
		width: 1200,
		height: 800,
		x: 100,
		y: 100,
	},
	rpc: testRunnerRPC,
});

// Keep test runner on top so results are visible while tests run
testRunnerWindow.setAlwaysOnTop(true);

// Send build config and update status to the UI when ready
testRunnerWindow.webview.on("dom-ready", () => {
	testRunnerWindow!.webview.rpc?.send.buildConfig({
		defaultRenderer: buildConfig.defaultRenderer,
		availableRenderers: buildConfig.availableRenderers,
		cefVersion: buildConfig.cefVersion,
		bunVersion: buildConfig.bunVersion,
	});
	// Send current update status
	testRunnerWindow!.webview.rpc?.send.updateStatus(updateState);
});

// Check for updates on startup
checkForUpdate();

// Forward test events to the UI
executor.onEvent((event) => {
	switch (event.type) {
		case "test-started":
			testRunnerWindow.webview.rpc?.send.testStarted({
				testId: event.testId!,
				name: event.name!,
			});
			break;

		case "test-completed":
			testRunnerWindow.webview.rpc?.send.testCompleted({
				testId: event.testId!,
				result: event.result!,
			});
			break;

		case "test-log":
			testRunnerWindow.webview.rpc?.send.testLog({
				testId: event.testId!,
				message: event.message!,
			});
			break;

		case "all-completed":
			testRunnerWindow.webview.rpc?.send.allCompleted({
				results: event.results!,
			});
			break;

		case "interactive-waiting":
			testRunnerWindow.webview.rpc?.send.interactiveWaiting({
				testId: event.testId!,
				instructions: event.instructions!,
			});
			break;

		case "interactive-ready":
			testRunnerWindow.webview.rpc?.send.interactiveReady({
				testId: event.testId!,
				instructions: event.instructions!,
			});
			break;

		case "interactive-verify":
			testRunnerWindow.webview.rpc?.send.interactiveVerify({
				testId: event.testId!,
			});
			break;
	}
});

// Handle window close
// testRunnerWindow.on("close", () => {
//   console.log("\nTest runner closed. Exiting...\n");
//   Utils.quit();
// });

// Print instructions
console.log("Test Runner window opened.");
console.log(
	"Press Cmd+R to run all automated tests, or use the buttons in the UI.\n",
);

// Auto-run tests if AUTO_RUN environment variable is set
// Usage: AUTO_RUN=1 electrobun dev
console.log(`DEBUG: AUTO_RUN env var = "${process.env["AUTO_RUN"]}"`);
const autoRun = !!process.env["AUTO_RUN"];
console.log(`DEBUG: autoRun = ${autoRun}`);
if (autoRun) {
	console.log("Auto-running automated tests in 3 seconds...\n");
	setTimeout(async () => {
		const results = await executor.runAllAutomated();

		// Exit with appropriate code when auto-run is complete
		const failedCount = results.filter((r) => r.status === "failed").length;
		const exitCode = failedCount > 0 ? 1 : 0;
		console.log(`\nAuto-run complete. Exiting with code ${exitCode}...`);

		// Give a moment for final logs to flush
		setTimeout(() => {
			// Use Utils.quit() for graceful shutdown with proper CEF cleanup
			Utils.quit();
		}, 500);
	}, 3000);
}

const autoRunTestName = process.env["AUTO_RUN_TEST_NAME"];
if (autoRunTestName) {
	console.log(`Auto-running test "${autoRunTestName}" in 2 seconds...\n`);
	setTimeout(async () => {
		const test = executor
			.getTests()
			.find((candidate) => candidate.name === autoRunTestName);
		if (!test) {
			console.error(`Failed to find test "${autoRunTestName}"`);
			return;
		}
		await executor.runTest(test);
	}, 2000);
}

const autoRunWgpu = !!process.env["AUTO_RUN_WGPU"];
if (autoRunWgpu && !autoRunTestName) {
	console.log("Auto-running WGPU native cube playground in 2 seconds...\n");
	setTimeout(async () => {
		const test = executor
			.getTests()
			.find((candidate) => candidate.name === "WGPUView native cube");
		if (!test) {
			console.error('Failed to find "WGPUView native cube" test');
			return;
		}
		await executor.runTest(test);
	}, 2000);
}
