//! macOS/iOS text backend on CoreText (system fonts, fallback cascade,
//! shaping, color emoji). Bound directly from Zig; no Objective-C needed.
const std = @import("std");
const font = @import("font.zig");

const Allocator = std.mem.Allocator;

// ---------------------------------------------------------------------------
// CoreFoundation / CoreGraphics / CoreText bindings
// ---------------------------------------------------------------------------

const CFTypeRef = *const anyopaque;
const CFStringRef = *const anyopaque;
const CFDictionaryRef = *const anyopaque;
const CFArrayRef = *const anyopaque;
const CFNumberRef = *const anyopaque;
const CFAttributedStringRef = *const anyopaque;
const CFDataRef = *const anyopaque;
const CTFontRef = *const anyopaque;
const CTFontDescriptorRef = *const anyopaque;
const CTLineRef = *const anyopaque;
const CTRunRef = *const anyopaque;
const CGContextRef = *anyopaque;
const CGColorSpaceRef = *anyopaque;
const CGFontRef = *const anyopaque;
const CGDataProviderRef = *const anyopaque;
const CFIndex = isize;
const CGFloat = f64;
const CGGlyph = u16;

const CFRange = extern struct { location: CFIndex, length: CFIndex };
const CGPoint = extern struct { x: CGFloat, y: CGFloat };
const CGSize = extern struct { width: CGFloat, height: CGFloat };
const CGRect = extern struct { origin: CGPoint, size: CGSize };

const CFDictionaryKeyCallBacks = extern struct { v: [6]usize };
const CFDictionaryValueCallBacks = extern struct { v: [5]usize };

extern "c" var kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
extern "c" var kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;
extern "c" const kCTFontAttributeName: CFStringRef;
extern "c" const kCTFontFamilyNameAttribute: CFStringRef;
extern "c" const kCTFontTraitsAttribute: CFStringRef;
extern "c" const kCTFontWeightTrait: CFStringRef;
extern "c" const kCTFontSymbolicTrait: CFStringRef;
extern "c" const kCTFontCascadeListAttribute: CFStringRef;

extern "c" fn CFRelease(cf: CFTypeRef) void;
extern "c" fn CFRetain(cf: CFTypeRef) CFTypeRef;
extern "c" fn CFStringCreateWithBytes(alloc: ?*anyopaque, bytes: [*]const u8, num: CFIndex, encoding: u32, external: u8) ?CFStringRef;
extern "c" fn CFStringGetLength(s: CFStringRef) CFIndex;
extern "c" fn CFStringGetCString(s: CFStringRef, buf: [*]u8, size: CFIndex, encoding: u32) u8;
extern "c" fn CFDictionaryCreate(alloc: ?*anyopaque, keys: [*]const ?*const anyopaque, vals: [*]const ?*const anyopaque, n: CFIndex, kcb: *const CFDictionaryKeyCallBacks, vcb: *const CFDictionaryValueCallBacks) ?CFDictionaryRef;
extern "c" fn CFDictionaryGetValue(d: CFDictionaryRef, key: *const anyopaque) ?*const anyopaque;
extern "c" fn CFNumberCreate(alloc: ?*anyopaque, the_type: CFIndex, value: *const anyopaque) ?CFNumberRef;
extern "c" fn CFArrayGetCount(a: CFArrayRef) CFIndex;
extern "c" fn CFArrayGetValueAtIndex(a: CFArrayRef, i: CFIndex) *const anyopaque;
extern "c" fn CFAttributedStringCreate(alloc: ?*anyopaque, s: CFStringRef, attrs: CFDictionaryRef) ?CFAttributedStringRef;
extern "c" fn CFDataCreate(alloc: ?*anyopaque, bytes: [*]const u8, len: CFIndex) ?CFDataRef;
extern "c" fn CFEqual(a: CFTypeRef, b: CFTypeRef) u8;

extern "c" fn CTFontCreateWithName(name: CFStringRef, size: CGFloat, matrix: ?*const anyopaque) ?CTFontRef;
extern "c" fn CTFontCreateUIFontForLanguage(ui_type: u32, size: CGFloat, lang: ?CFStringRef) ?CTFontRef;
extern "c" fn CTFontCopyFontDescriptor(f: CTFontRef) CTFontDescriptorRef;
extern "c" fn CTFontDescriptorCreateWithAttributes(attrs: CFDictionaryRef) ?CTFontDescriptorRef;
extern "c" fn CTFontDescriptorCreateCopyWithAttributes(d: CTFontDescriptorRef, attrs: CFDictionaryRef) ?CTFontDescriptorRef;
extern "c" fn CTFontCreateWithFontDescriptor(d: CTFontDescriptorRef, size: CGFloat, matrix: ?*const anyopaque) ?CTFontRef;
extern "c" fn CTFontCreateCopyWithSymbolicTraits(f: CTFontRef, size: CGFloat, matrix: ?*const anyopaque, value: u32, mask: u32) ?CTFontRef;
extern "c" fn CTFontCreateCopyWithAttributes(f: CTFontRef, size: CGFloat, matrix: ?*const anyopaque, attrs: ?CTFontDescriptorRef) ?CTFontRef;
extern "c" fn CTFontCopyFamilyName(f: CTFontRef) CFStringRef;
extern "c" fn CTFontGetSize(f: CTFontRef) CGFloat;
extern "c" fn CTFontGetAscent(f: CTFontRef) CGFloat;
extern "c" fn CTFontGetDescent(f: CTFontRef) CGFloat;
extern "c" fn CTFontGetLeading(f: CTFontRef) CGFloat;
extern "c" fn CTFontGetXHeight(f: CTFontRef) CGFloat;
extern "c" fn CTFontGetCapHeight(f: CTFontRef) CGFloat;
extern "c" fn CTFontGetUnderlinePosition(f: CTFontRef) CGFloat;
extern "c" fn CTFontGetUnderlineThickness(f: CTFontRef) CGFloat;
extern "c" fn CTFontGetSymbolicTraits(f: CTFontRef) u32;
extern "c" fn CTFontGetBoundingRectsForGlyphs(f: CTFontRef, orientation: u32, glyphs: [*]const CGGlyph, rects: ?[*]CGRect, count: CFIndex) CGRect;
extern "c" fn CTFontDrawGlyphs(f: CTFontRef, glyphs: [*]const CGGlyph, positions: [*]const CGPoint, count: usize, ctx: CGContextRef) void;
extern "c" fn CTFontManagerCreateFontDescriptorFromData(data: CFDataRef) ?CTFontDescriptorRef;

extern "c" fn CTLineCreateWithAttributedString(s: CFAttributedStringRef) ?CTLineRef;
extern "c" fn CTLineGetGlyphRuns(l: CTLineRef) CFArrayRef;
extern "c" fn CTRunGetGlyphCount(r: CTRunRef) CFIndex;
extern "c" fn CTRunGetGlyphs(r: CTRunRef, range: CFRange, buf: [*]CGGlyph) void;
extern "c" fn CTRunGetPositions(r: CTRunRef, range: CFRange, buf: [*]CGPoint) void;
extern "c" fn CTRunGetAdvances(r: CTRunRef, range: CFRange, buf: [*]CGSize) void;
extern "c" fn CTRunGetStringIndices(r: CTRunRef, range: CFRange, buf: [*]CFIndex) void;
extern "c" fn CTRunGetAttributes(r: CTRunRef) CFDictionaryRef;
extern "c" fn CTRunGetStatus(r: CTRunRef) u32;

extern "c" fn CGColorSpaceCreateDeviceGray() ?CGColorSpaceRef;
extern "c" fn CGColorSpaceCreateDeviceRGB() ?CGColorSpaceRef;
extern "c" fn CGColorSpaceRelease(cs: CGColorSpaceRef) void;
extern "c" fn CGBitmapContextCreate(data: ?*anyopaque, w: usize, h: usize, bpc: usize, bpr: usize, cs: CGColorSpaceRef, info: u32) ?CGContextRef;
extern "c" fn CGContextRelease(c: CGContextRef) void;
extern "c" fn CGContextSetGrayFillColor(c: CGContextRef, gray: CGFloat, alpha: CGFloat) void;
extern "c" fn CGContextSetRGBFillColor(c: CGContextRef, r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) void;
extern "c" fn CGContextSetShouldAntialias(c: CGContextRef, v: bool) void;
extern "c" fn CGContextSetAllowsFontSmoothing(c: CGContextRef, v: bool) void;
extern "c" fn CGContextSetShouldSmoothFonts(c: CGContextRef, v: bool) void;
extern "c" fn CGContextSetAllowsFontSubpixelPositioning(c: CGContextRef, v: bool) void;
extern "c" fn CGContextSetShouldSubpixelPositionFonts(c: CGContextRef, v: bool) void;
extern "c" fn CGContextSetAllowsFontSubpixelQuantization(c: CGContextRef, v: bool) void;
extern "c" fn CGContextSetShouldSubpixelQuantizeFonts(c: CGContextRef, v: bool) void;
extern "c" fn CGContextScaleCTM(c: CGContextRef, sx: CGFloat, sy: CGFloat) void;

const kCFStringEncodingUTF8: u32 = 0x08000100;
const kCFNumberFloat64Type: CFIndex = 13;
const kCFNumberSInt32Type: CFIndex = 3;
const kCTFontUIFontSystem: u32 = 2;
const kCTFontUIFontUser: u32 = 0;
const kCTFontUIFontUserFixedPitch: u32 = 1;
const kCTFontTraitItalic: u32 = 1 << 0;
const kCTFontTraitBold: u32 = 1 << 1;
const kCTFontTraitColorGlyphs: u32 = 1 << 13;
const kCGImageAlphaOnly: u32 = 7;
const kCGImageAlphaPremultipliedFirst: u32 = 2;
const kCGBitmapByteOrder32Little: u32 = 2 << 12;

fn cfstr(s: []const u8) ?CFStringRef {
    return CFStringCreateWithBytes(null, s.ptr, @intCast(s.len), kCFStringEncodingUTF8, 0);
}

fn cfnum(v: f64) ?CFNumberRef {
    return CFNumberCreate(null, kCFNumberFloat64Type, &v);
}

fn dict(keys: []const ?*const anyopaque, vals: []const ?*const anyopaque) ?CFDictionaryRef {
    return CFDictionaryCreate(null, keys.ptr, vals.ptr, @intCast(keys.len), &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}

/// CSS weight (100..900) -> CoreText weight trait (-1..1), matching NSFontWeight constants.
fn weightTrait(w: f32) f64 {
    const table = [_][2]f64{ .{ 100, -0.80 }, .{ 200, -0.60 }, .{ 300, -0.40 }, .{ 400, 0.0 }, .{ 500, 0.23 }, .{ 600, 0.30 }, .{ 700, 0.40 }, .{ 800, 0.56 }, .{ 900, 0.62 } };
    const x: f64 = std.math.clamp(w, 100, 900);
    for (table[0 .. table.len - 1], table[1..]) |a, b| {
        if (x <= b[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
    }
    return 0.62;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

const FontEntry = struct {
    ct: CTFontRef,
    size: f32,
    /// for resolve() cache hits
    key: u64,
    color: bool,
};

const Registered = struct {
    family: []const u8,
    weight: f32,
    italic: bool,
    desc: CTFontDescriptorRef,
};

pub const CoreTextBackend = struct {
    gpa: Allocator,
    fonts: std.ArrayList(FontEntry) = .empty,
    by_key: std.AutoHashMapUnmanaged(u64, font.FontId) = .empty,
    registered: std.ArrayList(Registered) = .empty,
    bitmap: std.ArrayList(u8) = .empty,
    utf16_to_utf8: std.ArrayList(u32) = .empty,
    gray: CGColorSpaceRef,
    rgb: CGColorSpaceRef,

    pub fn create(gpa: Allocator) !font.Backend {
        const self = try gpa.create(CoreTextBackend);
        self.* = .{
            .gpa = gpa,
            .gray = CGColorSpaceCreateDeviceGray() orelse return error.CoreGraphics,
            .rgb = CGColorSpaceCreateDeviceRGB() orelse return error.CoreGraphics,
        };
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: font.Backend.VTable = .{
        .resolve = resolve,
        .metrics = metrics,
        .shape = shape,
        .rasterize = rasterize,
        .isColor = isColor,
        .deinit = deinit,
        .registerFont = registerFont,
    };

    fn me(p: *anyopaque) *CoreTextBackend {
        return @ptrCast(@alignCast(p));
    }

    fn deinit(p: *anyopaque) void {
        const s = me(p);
        for (s.fonts.items) |f| CFRelease(f.ct);
        for (s.registered.items) |r| {
            CFRelease(r.desc);
            s.gpa.free(r.family);
        }
        s.fonts.deinit(s.gpa);
        s.by_key.deinit(s.gpa);
        s.registered.deinit(s.gpa);
        s.bitmap.deinit(s.gpa);
        s.utf16_to_utf8.deinit(s.gpa);
        CGColorSpaceRelease(s.gray);
        CGColorSpaceRelease(s.rgb);
        s.gpa.destroy(s);
    }

    fn specKey(spec: font.FontSpec) u64 {
        var h = std.hash.Wyhash.init(0);
        for (spec.families) |f| {
            h.update(f);
            h.update("\x00");
        }
        h.update(std.mem.asBytes(&spec.size));
        h.update(std.mem.asBytes(&spec.weight));
        h.update(&.{@intFromBool(spec.italic)});
        return h.final();
    }

    fn addFont(s: *CoreTextBackend, ct: CTFontRef, key: u64) font.FontId {
        const traits = CTFontGetSymbolicTraits(ct);
        s.fonts.append(s.gpa, .{ .ct = ct, .size = @floatCast(CTFontGetSize(ct)), .key = key, .color = traits & kCTFontTraitColorGlyphs != 0 }) catch {
            CFRelease(ct);
            return 0;
        };
        const id: font.FontId = @intCast(s.fonts.items.len - 1);
        if (key != 0) s.by_key.put(s.gpa, key, id) catch {};
        return id;
    }

    fn resolve(p: *anyopaque, spec: font.FontSpec) font.FontId {
        const s = me(p);
        const key = specKey(spec);
        if (s.by_key.get(key)) |id| return id;
        const ct = s.createFont(spec) orelse (CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, spec.size, null) orelse return 0);
        return s.addFont(ct, key);
    }

    fn createFont(s: *CoreTextBackend, spec: font.FontSpec) ?CTFontRef {
        for (spec.families) |fam| {
            if (s.createFamily(fam, spec)) |f| return f;
        }
        return s.createFamily("system-ui", spec);
    }

    fn createFamily(s: *CoreTextBackend, family: []const u8, spec: font.FontSpec) ?CTFontRef {
        const size: CGFloat = spec.size;
        // registered @font-face fonts: closest weight, matching style
        var best: ?*Registered = null;
        var best_d: f32 = std.math.inf(f32);
        for (s.registered.items) |*r| {
            if (!std.ascii.eqlIgnoreCase(r.family, family)) continue;
            const d = @abs(r.weight - spec.weight) + (if (r.italic != spec.italic) @as(f32, 1000) else 0);
            if (d < best_d) {
                best_d = d;
                best = r;
            }
        }
        if (best) |r| return CTFontCreateWithFontDescriptor(r.desc, size, null);

        var base: ?CTFontRef = null;
        const generic = genericKind(family);
        switch (generic) {
            .system => base = CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, size, null),
            .mono => {
                base = createNamed("SF Mono", size);
                if (base) |b| {
                    if (!familyIs(b, "SF Mono")) {
                        CFRelease(b);
                        base = createNamed("Menlo", size);
                    }
                }
            },
            .serif => base = createNamed("Times", size),
            .sans => base = createNamed("Helvetica", size),
            .cursive => base = createNamed("Apple Chancery", size),
            .fantasy => base = createNamed("Papyrus", size),
            .emoji => base = createNamed("Apple Color Emoji", size),
            .named => {
                const name = cfstr(family) orelse return null;
                defer CFRelease(name);
                const f = CTFontCreateWithName(name, size, null) orelse return null;
                // CoreText silently substitutes unknown names; reject those
                if (!familyMatches(f, family)) {
                    CFRelease(f);
                    return null;
                }
                base = f;
            },
        }
        const b = base orelse return null;
        return applyTraits(b, spec);
    }

    fn metrics(p: *anyopaque, id: font.FontId) font.Metrics {
        const s = me(p);
        if (id >= s.fonts.items.len) return .{ .ascent = 12, .descent = 4 };
        const f = s.fonts.items[id].ct;
        return .{
            .ascent = @floatCast(CTFontGetAscent(f)),
            .descent = @floatCast(CTFontGetDescent(f)),
            .line_gap = @floatCast(CTFontGetLeading(f)),
            .x_height = @floatCast(CTFontGetXHeight(f)),
            .cap_height = @floatCast(CTFontGetCapHeight(f)),
            .underline_pos = @floatCast(-CTFontGetUnderlinePosition(f)),
            .underline_thickness = @floatCast(@max(1, CTFontGetUnderlineThickness(f))),
        };
    }

    fn isColor(p: *anyopaque, id: font.FontId) bool {
        const s = me(p);
        return id < s.fonts.items.len and s.fonts.items[id].color;
    }

    fn fontIdFor(s: *CoreTextBackend, ct: CTFontRef, primary: font.FontId) font.FontId {
        if (primary < s.fonts.items.len and CFEqual(s.fonts.items[primary].ct, ct) != 0) return primary;
        // fallback fonts: look up by identity, else register (retained)
        for (s.fonts.items, 0..) |f, i| {
            if (f.key == 0 and CFEqual(f.ct, ct) != 0) return @intCast(i);
        }
        _ = CFRetain(ct);
        return s.addFont(ct, 0);
    }

    fn shape(p: *anyopaque, id: font.FontId, text: []const u8, out: *std.ArrayList(font.Glyph), gpa: Allocator) Allocator.Error!void {
        const s = me(p);
        if (text.len == 0) return;
        if (id >= s.fonts.items.len) return;
        const str = cfstr(text) orelse return;
        defer CFRelease(str);
        // utf16 index -> utf8 byte offset
        s.utf16_to_utf8.clearRetainingCapacity();
        {
            var i: usize = 0;
            while (i < text.len) {
                const len = std.unicode.utf8ByteSequenceLength(text[i]) catch 1;
                const cp = std.unicode.utf8Decode(text[i..@min(text.len, i + len)]) catch 0xfffd;
                try s.utf16_to_utf8.append(s.gpa, @intCast(i));
                if (cp >= 0x10000) try s.utf16_to_utf8.append(s.gpa, @intCast(i));
                i += len;
            }
            try s.utf16_to_utf8.append(s.gpa, @intCast(text.len));
        }
        const keys = [_]?*const anyopaque{kCTFontAttributeName};
        const vals = [_]?*const anyopaque{s.fonts.items[id].ct};
        const attrs = dict(&keys, &vals) orelse return;
        defer CFRelease(attrs);
        const astr = CFAttributedStringCreate(null, str, attrs) orelse return;
        defer CFRelease(astr);
        const line = CTLineCreateWithAttributedString(astr) orelse return;
        defer CFRelease(line);
        const runs = CTLineGetGlyphRuns(line);
        const nruns = CFArrayGetCount(runs);
        var glyphs: std.ArrayList(CGGlyph) = .empty;
        defer glyphs.deinit(gpa);
        var positions: std.ArrayList(CGPoint) = .empty;
        defer positions.deinit(gpa);
        var advances: std.ArrayList(CGSize) = .empty;
        defer advances.deinit(gpa);
        var indices: std.ArrayList(CFIndex) = .empty;
        defer indices.deinit(gpa);
        var r: CFIndex = 0;
        while (r < nruns) : (r += 1) {
            const run: CTRunRef = CFArrayGetValueAtIndex(runs, r);
            const n: usize = @intCast(CTRunGetGlyphCount(run));
            if (n == 0) continue;
            try glyphs.resize(gpa, n);
            try positions.resize(gpa, n);
            try advances.resize(gpa, n);
            try indices.resize(gpa, n);
            const all: CFRange = .{ .location = 0, .length = 0 };
            CTRunGetGlyphs(run, all, glyphs.items.ptr);
            CTRunGetPositions(run, all, positions.items.ptr);
            CTRunGetAdvances(run, all, advances.items.ptr);
            CTRunGetStringIndices(run, all, indices.items.ptr);
            const run_attrs = CTRunGetAttributes(run);
            const run_font: CTFontRef = @ptrCast(CFDictionaryGetValue(run_attrs, kCTFontAttributeName) orelse s.fonts.items[id].ct);
            const fid = s.fontIdFor(run_font, id);
            const base_x = positions.items[0].x;
            var pen: f64 = base_x;
            for (0..n) |i| {
                const ui: usize = @intCast(@max(0, indices.items[i]));
                const cluster = if (ui < s.utf16_to_utf8.items.len) s.utf16_to_utf8.items[ui] else @as(u32, @intCast(text.len));
                try out.append(gpa, .{
                    .id = glyphs.items[i],
                    .font = fid,
                    .advance = @floatCast(advances.items[i].width),
                    .x_offset = @floatCast(positions.items[i].x - pen),
                    .y_offset = @floatCast(-positions.items[i].y),
                    .cluster = cluster,
                });
                pen += advances.items[i].width;
            }
        }
    }

    fn rasterize(p: *anyopaque, id: font.FontId, glyph: u32, scale: f32, subpixel: f32) ?font.GlyphBitmap {
        const s = me(p);
        if (id >= s.fonts.items.len) return null;
        const entry = s.fonts.items[id];
        const g: CGGlyph = @intCast(glyph & 0xffff);
        var rect: CGRect = undefined;
        _ = CTFontGetBoundingRectsForGlyphs(entry.ct, 0, @ptrCast(&g), @ptrCast(&rect), 1);
        if (rect.size.width <= 0 or rect.size.height <= 0) return null;
        const sc: f64 = scale;
        const pad: f64 = 2;
        const x0 = @floor(rect.origin.x * sc + subpixel) - pad;
        const y0 = @floor(rect.origin.y * sc) - pad;
        const x1 = @ceil((rect.origin.x + rect.size.width) * sc + subpixel) + pad;
        const y1 = @ceil((rect.origin.y + rect.size.height) * sc) + pad;
        const w: usize = @intFromFloat(@max(1, x1 - x0));
        const h: usize = @intFromFloat(@max(1, y1 - y0));
        if (w > 2048 or h > 2048) return null;
        const channels: usize = if (entry.color) 4 else 1;
        const stride = w * channels;
        s.bitmap.resize(s.gpa, stride * h) catch return null;
        @memset(s.bitmap.items, 0);
        const ctx = if (entry.color)
            CGBitmapContextCreate(s.bitmap.items.ptr, w, h, 8, stride, s.rgb, kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little)
        else
            CGBitmapContextCreate(s.bitmap.items.ptr, w, h, 8, stride, s.gray, kCGImageAlphaOnly);
        const c = ctx orelse return null;
        defer CGContextRelease(c);
        CGContextSetShouldAntialias(c, true);
        CGContextSetAllowsFontSmoothing(c, false);
        CGContextSetShouldSmoothFonts(c, false);
        CGContextSetAllowsFontSubpixelPositioning(c, true);
        CGContextSetShouldSubpixelPositionFonts(c, true);
        CGContextSetAllowsFontSubpixelQuantization(c, false);
        CGContextSetShouldSubpixelQuantizeFonts(c, false);
        if (entry.color) CGContextSetRGBFillColor(c, 1, 1, 1, 1) else CGContextSetGrayFillColor(c, 1, 1);
        CGContextScaleCTM(c, sc, sc);
        const pos = CGPoint{ .x = (-x0 + subpixel) / sc, .y = -y0 / sc };
        CTFontDrawGlyphs(entry.ct, @ptrCast(&g), @ptrCast(&pos), 1, c);
        // CG bitmaps are bottom-up relative to our top-left convention: the
        // memory layout is already top row first, with y0 at the bottom row.
        return .{
            .width = @intCast(w),
            .height = @intCast(h),
            .left = @intFromFloat(x0),
            .top = @intFromFloat(y1),
            .channels = @intCast(channels),
            .pixels = s.bitmap.items,
        };
    }

    fn registerFont(p: *anyopaque, family: []const u8, data: []const u8, weight: f32, italic: bool) bool {
        const s = me(p);
        const cfdata = CFDataCreate(null, data.ptr, @intCast(data.len)) orelse return false;
        defer CFRelease(cfdata);
        const desc = CTFontManagerCreateFontDescriptorFromData(cfdata) orelse return false;
        const fam = s.gpa.dupe(u8, family) catch {
            CFRelease(desc);
            return false;
        };
        s.registered.append(s.gpa, .{ .family = fam, .weight = weight, .italic = italic, .desc = desc }) catch {
            CFRelease(desc);
            s.gpa.free(fam);
            return false;
        };
        // invalidate resolve cache for this family
        s.by_key.clearRetainingCapacity();
        return true;
    }
};

const Generic = enum { system, mono, serif, sans, cursive, fantasy, emoji, named };

fn genericKind(family: []const u8) Generic {
    const map = std.StaticStringMap(Generic).initComptime(.{
        .{ "system-ui", .system },         .{ "-apple-system", .system }, .{ "blinkmacsystemfont", .system },
        .{ "ui-sans-serif", .system },     .{ "sans-serif", .system },    .{ "ui-monospace", .mono },
        .{ "monospace", .mono },           .{ "sfmono-regular", .mono },  .{ "serif", .serif },
        .{ "ui-serif", .serif },           .{ "cursive", .cursive },      .{ "fantasy", .fantasy },
        .{ "emoji", .emoji },              .{ "apple color emoji", .emoji }, .{ "segoe ui emoji", .emoji },
        .{ "noto color emoji", .emoji },   .{ "math", .serif },           .{ "ui-rounded", .system },
        .{ "segoe ui", .system },          .{ "roboto", .system },        .{ "helvetica neue", .named },
    });
    var buf: [64]u8 = undefined;
    if (family.len > buf.len) return .named;
    return map.get(std.ascii.lowerString(&buf, family)) orelse .named;
}

fn createNamed(name: []const u8, size: CGFloat) ?CTFontRef {
    const n = cfstr(name) orelse return null;
    defer CFRelease(n);
    return CTFontCreateWithName(n, size, null);
}

fn familyName(f: CTFontRef, buf: []u8) []const u8 {
    const name = CTFontCopyFamilyName(f);
    defer CFRelease(name);
    if (CFStringGetCString(name, buf.ptr, @intCast(buf.len), kCFStringEncodingUTF8) == 0) return "";
    return std.mem.sliceTo(buf, 0);
}

fn familyIs(f: CTFontRef, want: []const u8) bool {
    var buf: [128]u8 = undefined;
    return std.ascii.eqlIgnoreCase(familyName(f, &buf), want);
}

fn familyMatches(f: CTFontRef, want: []const u8) bool {
    var buf: [128]u8 = undefined;
    const got = familyName(f, &buf);
    if (std.ascii.eqlIgnoreCase(got, want)) return true;
    // "Helvetica Neue" requested may resolve to "Helvetica Neue" family; a
    // PostScript name like "Menlo-Regular" resolves to "Menlo"
    return std.ascii.startsWithIgnoreCase(want, got) and got.len > 0;
}

fn applyTraits(base: CTFontRef, spec: font.FontSpec) ?CTFontRef {
    if (spec.weight == 400 and !spec.italic) return base;
    defer CFRelease(base);
    const desc = CTFontCopyFontDescriptor(base);
    defer CFRelease(desc);
    const w = cfnum(weightTrait(spec.weight)) orelse return null;
    defer CFRelease(w);
    var sym: i32 = if (spec.italic) @intCast(kCTFontTraitItalic) else 0;
    if (spec.weight >= 600) sym |= @intCast(kCTFontTraitBold);
    const symn = CFNumberCreate(null, kCFNumberSInt32Type, &sym) orelse return null;
    defer CFRelease(symn);
    const tkeys = [_]?*const anyopaque{ kCTFontWeightTrait, kCTFontSymbolicTrait };
    const tvals = [_]?*const anyopaque{ w, symn };
    const traits = dict(&tkeys, &tvals) orelse return null;
    defer CFRelease(traits);
    // Match within the family by family name + traits. A copy of the base
    // descriptor keeps the face's own name, which pins that face and makes
    // CoreText ignore the requested weight/style for named families.
    const family = CTFontCopyFamilyName(base);
    defer CFRelease(family);
    const fkeys = [_]?*const anyopaque{ kCTFontFamilyNameAttribute, kCTFontTraitsAttribute };
    const fvals = [_]?*const anyopaque{ family, traits };
    if (dict(&fkeys, &fvals)) |fattrs| {
        defer CFRelease(fattrs);
        if (CTFontDescriptorCreateWithAttributes(fattrs)) |fd| {
            defer CFRelease(fd);
            if (CTFontCreateWithFontDescriptor(fd, spec.size, null)) |f| {
                const got = CTFontCopyFamilyName(f);
                defer CFRelease(got);
                if (CFEqual(got, family) != 0) return f;
                CFRelease(f);
            }
        }
    }
    const akeys = [_]?*const anyopaque{kCTFontTraitsAttribute};
    const avals = [_]?*const anyopaque{traits};
    const attrs = dict(&akeys, &avals) orelse return null;
    defer CFRelease(attrs);
    const nd = CTFontDescriptorCreateCopyWithAttributes(desc, attrs) orelse return null;
    defer CFRelease(nd);
    const f = CTFontCreateWithFontDescriptor(nd, spec.size, null) orelse return null;
    if (spec.italic and CTFontGetSymbolicTraits(f) & kCTFontTraitItalic == 0) {
        // no italic face in the family: CoreText will not synthesize; keep upright
    }
    return f;
}

test "named families honor weight and italic" {
    const b = try CoreTextBackend.create(std.testing.allocator);
    defer b.deinit();
    const s: *CoreTextBackend = @ptrCast(@alignCast(b.ptr));
    const regular = b.resolve(.{ .families = &.{"Helvetica Neue"}, .size = 16 });
    const bold = b.resolve(.{ .families = &.{"Helvetica Neue"}, .size = 16, .weight = 700 });
    const italic = b.resolve(.{ .families = &.{"Helvetica Neue"}, .size = 16, .italic = true });
    try std.testing.expect(CTFontGetSymbolicTraits(s.fonts.items[regular].ct) & kCTFontTraitBold == 0);
    try std.testing.expect(CTFontGetSymbolicTraits(s.fonts.items[bold].ct) & kCTFontTraitBold != 0);
    try std.testing.expect(CTFontGetSymbolicTraits(s.fonts.items[italic].ct) & kCTFontTraitItalic != 0);
}

test "coretext shaping and raster" {
    const b = try CoreTextBackend.create(std.testing.allocator);
    defer b.deinit();
    const f = b.resolve(.{ .families = &.{"system-ui"}, .size = 16 });
    const m = b.metrics(f);
    try std.testing.expect(m.ascent > 10 and m.ascent < 20);
    var glyphs: std.ArrayList(font.Glyph) = .empty;
    defer glyphs.deinit(std.testing.allocator);
    try b.shape(f, "Hello, wörld 👋", &glyphs, std.testing.allocator);
    try std.testing.expect(glyphs.items.len >= 13);
    var total: f32 = 0;
    for (glyphs.items) |g| total += g.advance;
    try std.testing.expect(total > 80 and total < 160);
    // the emoji comes from a fallback color font
    const last = glyphs.items[glyphs.items.len - 1];
    try std.testing.expect(b.isColor(last.font));
    try std.testing.expectEqual(@as(u32, "Hello, wörld ".len), last.cluster);
    const bm = b.rasterize(f, glyphs.items[0].id, 2, 0).?;
    try std.testing.expect(bm.width > 4 and bm.height > 10);
    var sum: u64 = 0;
    for (bm.pixels[0 .. bm.width * bm.height]) |px| sum += px;
    try std.testing.expect(sum > 1000);
    const bold = b.resolve(.{ .families = &.{"system-ui"}, .size = 16, .weight = 700 });
    try std.testing.expect(bold != f);
    const mono = b.resolve(.{ .families = &.{ "Nonexistent Font", "monospace" }, .size = 13 });
    glyphs.clearRetainingCapacity();
    try b.shape(mono, "iiii", &glyphs, std.testing.allocator);
    glyphs.items.len = 4;
    var w2: std.ArrayList(font.Glyph) = .empty;
    defer w2.deinit(std.testing.allocator);
    try b.shape(mono, "MMMM", &w2, std.testing.allocator);
    try std.testing.expectApproxEqAbs(glyphs.items[0].advance, w2.items[0].advance, 0.01);
}
