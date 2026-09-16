import { describe, expect, test } from "bun:test";
import { WebviewTagNavigationQueue } from "./webviewTagNavigation";

describe("webview tag navigation initialization", () => {
	test("does not replay navigation already captured by the initialization request", () => {
		const queue = new WebviewTagNavigationQueue();
		queue.defer({ kind: "url", value: "https://initial.example" });

		queue.beginInitialization();

		expect(queue.take()).toBeNull();
	});

	test("replays the latest navigation requested while initialization is in flight", () => {
		const queue = new WebviewTagNavigationQueue();
		queue.beginInitialization();
		queue.defer({ kind: "url", value: "https://first.example" });
		queue.defer({ kind: "html", value: "<h1>latest</h1>" });

		expect(queue.take()).toEqual({ kind: "html", value: "<h1>latest</h1>" });
		expect(queue.take()).toBeNull();
	});
});
