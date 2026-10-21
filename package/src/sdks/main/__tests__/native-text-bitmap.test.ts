import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rasterizeNativeText } from "../proc/nativeTextBitmap";

(process.platform === "darwin" ? describe : describe.skip)("CoreText bitmap FFI", () => {
    const compileTimeoutMs = 60_000;
    let directory: string | undefined;
    let library: string;

    beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), "electrobun-text-"));
        // Cold SDK compilation on Intel can exceed the runtime test's five-second
        // deadline. Give only fixture setup its own bounded compilation window.
        const source = readFileSync(new URL("../../../native/macos/nativeWrapper.mm", import.meta.url), "utf8");
        const start = source.indexOf("static CTFontRef uiCreateFont");
        const end = source.indexOf("@interface WGPUInputView", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const fixture = join(directory, "text.mm");
        library = join(directory, "text.dylib");
        writeFileSync(fixture, '#import <Cocoa/Cocoa.h>\n#import <CoreText/CoreText.h>\n' + source.slice(start, end));
        execFileSync("clang++", ["-dynamiclib", fixture, "-framework", "Cocoa", "-framework", "CoreText", "-o", library], { timeout: compileTimeoutMs });
    }, compileTimeoutMs + 5_000);

    afterAll(() => {
        if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it("preserves dimensions and visible pixels across repeated rasterization", () => {
        const native = dlopen(library, {
            uiRasterizeText: { args: [FFIType.ptr, FFIType.ptr, FFIType.f64, FFIType.f64, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
            uiFreeTextBitmap: { args: [FFIType.ptr], returns: FFIType.void },
        } as const);
        try {
            for (const text of ["Reset", "+ 1", "0", "Reset"]) {
                const bitmap = rasterizeNativeText({ rasterizeText: (...args) => native.symbols.uiRasterizeText(...args) as Pointer | null, freeTextBitmap: native.symbols.uiFreeTextBitmap }, text, "", 18, 2)!;
                expect(bitmap.width).toBeGreaterThan(0);
                expect(bitmap.height).toBeGreaterThan(0);
                expect(bitmap.data.length).toBe(bitmap.width * bitmap.height * 4);
                expect(bitmap.data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
            }
        } finally { native.close(); }
    });
});
