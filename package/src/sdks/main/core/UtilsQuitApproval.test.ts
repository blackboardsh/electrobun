import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("quit approval handoff", () => {
	test("reserves one before-quit approval and consumes it without re-emitting", () => {
		const source = readFileSync(join(import.meta.dirname, "Utils.ts"), "utf8");
		const requestStart = source.indexOf("export const requestQuitApproval");
		const consumeStart = source.indexOf("export const quitAfterApproval");
		const quitStart = source.indexOf("export const quit =");
		const requestBody = source.slice(requestStart, consumeStart);
		const consumeBody = source.slice(consumeStart, quitStart);

		expect(requestBody).toContain("events.app.beforeQuit");
		expect(requestBody).toContain("response?.allow === false");
		expect(consumeBody).not.toContain("events.app.beforeQuit");
		expect(consumeBody).toContain("activeQuitApproval !== approval");
		expect(source.slice(quitStart)).toContain("requestQuitApproval()");
		expect(source.slice(quitStart)).toContain(
			"quitAfterApproval(approval, code)",
		);
	});
});
