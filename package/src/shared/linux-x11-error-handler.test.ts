import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const source = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);

describe("Linux X11 error handler", () => {
	test.skipIf(process.platform === "win32")("treats GLX's destroyed drawable errors like the core ones", () => {
		// Compile the actual helper without requiring X11/GTK/CEF development headers.
		const start = source.indexOf("static bool isDestroyedDrawableError(");
		const end = source.indexOf("\n}\n", start) + 2;
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const directory = mkdtempSync(join(tmpdir(), "electrobun-x11-error-"));
		try {
			const input = join(directory, "test.cpp");
			const binary = join(directory, "test");
			// BadWindow and BadDrawable as in X11/X.h.
			writeFileSync(input, `#include <cassert>\n#define BadWindow 3\n#define BadDrawable 9\n${source.slice(start, end)}
int main() {
    assert(isDestroyedDrawableError(BadWindow, 0));
    assert(isDestroyedDrawableError(BadDrawable, 156));
    // GLXBadWindow and GLXBadDrawable with the error bases of two servers.
    assert(isDestroyedDrawableError(168, 156));
    assert(isDestroyedDrawableError(170, 158));
    assert(isDestroyedDrawableError(158, 156));
    // The same numbers mean something else when the base differs or GLX is absent.
    assert(!isDestroyedDrawableError(168, 158));
    assert(!isDestroyedDrawableError(170, 0));
    assert(!isDestroyedDrawableError(12, 0));
    // Other GLX errors, such as GLXBadContext, are still reported.
    assert(!isDestroyedDrawableError(156, 156));
    // BadMatch is still reported.
    assert(!isDestroyedDrawableError(8, 156));
    return 0;
}
`);
			const compiler = process.env.CXX || "c++";
			const compiled = spawnSync(compiler, ["-std=c++17", input, "-o", binary], {
				encoding: "utf8",
			});
			expect(compiled.status, compiled.stderr).toBe(0);
			const ran = spawnSync(binary, [], { encoding: "utf8" });
			expect(ran.status, ran.stderr).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
