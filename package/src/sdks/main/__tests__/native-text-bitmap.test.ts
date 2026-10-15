import { describe, expect, it } from "bun:test";
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rasterizeNativeText } from "../proc/nativeTextBitmap";

(process.platform === "darwin" ? describe : describe.skip)("CoreText bitmap FFI", () => {
    it("preserves dimensions and visible pixels across repeated rasterization", () => {
        const directory = mkdtempSync(join(tmpdir(), "electrobun-text-"));
        try {
            // Compile the actual CoreText implementation without launching an app.
            const source = readFileSync(new URL("../../../native/macos/nativeWrapper.mm", import.meta.url), "utf8");
            const start = source.indexOf("static CTFontRef uiCreateFont");
            const end = source.indexOf("@interface WGPUInputView", start);
            expect(start).toBeGreaterThan(0);
            expect(end).toBeGreaterThan(start);
            const fixture = join(directory, "text.mm");
            const library = join(directory, "text.dylib");
            writeFileSync(fixture, '#import <Cocoa/Cocoa.h>\n#import <CoreText/CoreText.h>\n' + source.slice(start, end));
            execFileSync("clang++", ["-dynamiclib", fixture, "-framework", "Cocoa", "-framework", "CoreText", "-o", library]);
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
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
});
