import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("native render bundles preserve ABI data, reuse recordings, and release handles", () => {
	const fixture = fileURLToPath(new URL("./__fixtures__/webgpuRenderBundle.ts", import.meta.url));
	const result = Bun.spawnSync([process.execPath, fixture], { env: process.env });
	expect(result.stderr.toString()).toBe("");
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toContain("native render-bundle adapter contract: PASS");
});
