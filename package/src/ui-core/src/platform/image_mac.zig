//! ImageIO decoding and CoreGraphics SVG rasterization (macOS).
const std = @import("std");
const svg = @import("../svg.zig");
const images = @import("../images.zig");

const Allocator = std.mem.Allocator;
const CFTypeRef = *const anyopaque;
const CGContextRef = *anyopaque;
const CGPathRef = *anyopaque;
const CGFloat = f64;
const CGRect = extern struct { x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat };
const CGAffineTransform = extern struct { a: CGFloat, b: CGFloat, c: CGFloat, d: CGFloat, tx: CGFloat, ty: CGFloat };

extern "c" fn CFRelease(cf: CFTypeRef) void;
extern "c" fn CFDataCreate(alloc: ?*anyopaque, bytes: [*]const u8, len: isize) ?CFTypeRef;
extern "c" fn CGImageSourceCreateWithData(data: CFTypeRef, opts: ?CFTypeRef) ?CFTypeRef;
extern "c" fn CGImageSourceCreateImageAtIndex(src: CFTypeRef, index: usize, opts: ?CFTypeRef) ?*anyopaque;
extern "c" fn CGImageGetWidth(img: *anyopaque) usize;
extern "c" fn CGImageGetHeight(img: *anyopaque) usize;
extern "c" fn CGImageRelease(img: *anyopaque) void;
extern "c" fn CGColorSpaceCreateWithName(name: CFTypeRef) ?*anyopaque;
extern "c" fn CGColorSpaceRelease(cs: *anyopaque) void;
extern "c" const kCGColorSpaceSRGB: CFTypeRef;
extern "c" fn CGBitmapContextCreate(data: ?*anyopaque, w: usize, h: usize, bpc: usize, bpr: usize, cs: *anyopaque, info: u32) ?CGContextRef;
extern "c" fn CGContextRelease(c: CGContextRef) void;
extern "c" fn CGContextDrawImage(c: CGContextRef, r: CGRect, img: *anyopaque) void;
extern "c" fn CGContextTranslateCTM(c: CGContextRef, tx: CGFloat, ty: CGFloat) void;
extern "c" fn CGContextScaleCTM(c: CGContextRef, sx: CGFloat, sy: CGFloat) void;
extern "c" fn CGContextConcatCTM(c: CGContextRef, t: CGAffineTransform) void;
extern "c" fn CGContextSaveGState(c: CGContextRef) void;
extern "c" fn CGContextRestoreGState(c: CGContextRef) void;
extern "c" fn CGContextBeginPath(c: CGContextRef) void;
extern "c" fn CGContextMoveToPoint(c: CGContextRef, x: CGFloat, y: CGFloat) void;
extern "c" fn CGContextAddLineToPoint(c: CGContextRef, x: CGFloat, y: CGFloat) void;
extern "c" fn CGContextAddCurveToPoint(c: CGContextRef, x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat, x: CGFloat, y: CGFloat) void;
extern "c" fn CGContextClosePath(c: CGContextRef) void;
extern "c" fn CGContextFillPath(c: CGContextRef) void;
extern "c" fn CGContextEOFillPath(c: CGContextRef) void;
extern "c" fn CGContextStrokePath(c: CGContextRef) void;
extern "c" fn CGContextSetRGBFillColor(c: CGContextRef, r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) void;
extern "c" fn CGContextSetRGBStrokeColor(c: CGContextRef, r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) void;
extern "c" fn CGContextSetLineWidth(c: CGContextRef, w: CGFloat) void;
extern "c" fn CGContextSetLineCap(c: CGContextRef, cap: i32) void;
extern "c" fn CGContextSetLineJoin(c: CGContextRef, join: i32) void;
extern "c" fn CGContextSetShouldAntialias(c: CGContextRef, v: bool) void;

const premultipliedLast: u32 = 1; // kCGImageAlphaPremultipliedLast, byte order default (RGBA)

pub fn decode(gpa: Allocator, data: []const u8) ?images.Decoded {
    if (data.len == 0) return null;
    const cfdata = CFDataCreate(null, data.ptr, @intCast(data.len)) orelse return null;
    defer CFRelease(cfdata);
    const src = CGImageSourceCreateWithData(cfdata, null) orelse return null;
    defer CFRelease(src);
    const img = CGImageSourceCreateImageAtIndex(src, 0, null) orelse return null;
    defer CGImageRelease(img);
    const w = CGImageGetWidth(img);
    const h = CGImageGetHeight(img);
    if (w == 0 or h == 0 or w > 16384 or h > 16384) return null;
    const px = gpa.alloc(u8, w * h * 4) catch return null;
    @memset(px, 0);
    const cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB) orelse {
        gpa.free(px);
        return null;
    };
    defer CGColorSpaceRelease(cs);
    const ctx = CGBitmapContextCreate(px.ptr, w, h, 8, w * 4, cs, premultipliedLast) orelse {
        gpa.free(px);
        return null;
    };
    defer CGContextRelease(ctx);
    CGContextDrawImage(ctx, .{ .x = 0, .y = 0, .w = @floatFromInt(w), .h = @floatFromInt(h) }, img);
    return .{ .w = @intCast(w), .h = @intCast(h), .px = px };
}

pub fn rasterizeSvg(gpa: Allocator, pic: *const svg.Picture, w: u32, h: u32) ?[]u8 {
    const px = gpa.alloc(u8, @as(usize, w) * h * 4) catch return null;
    @memset(px, 0);
    const cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB) orelse {
        gpa.free(px);
        return null;
    };
    defer CGColorSpaceRelease(cs);
    const ctx = CGBitmapContextCreate(px.ptr, w, h, 8, @as(usize, w) * 4, cs, premultipliedLast) orelse {
        gpa.free(px);
        return null;
    };
    defer CGContextRelease(ctx);
    CGContextSetShouldAntialias(ctx, true);
    // flip to a top-left origin and map the viewBox to the bitmap
    CGContextTranslateCTM(ctx, 0, @floatFromInt(h));
    CGContextScaleCTM(ctx, 1, -1);
    const vb = pic.view_box;
    var sx: f64 = @as(f64, @floatFromInt(w)) / @max(0.0001, vb[2]);
    var sy: f64 = @as(f64, @floatFromInt(h)) / @max(0.0001, vb[3]);
    var ox: f64 = 0;
    var oy: f64 = 0;
    if (pic.preserve_aspect) {
        const s = @min(sx, sy);
        ox = (@as(f64, @floatFromInt(w)) - vb[2] * s) / 2;
        oy = (@as(f64, @floatFromInt(h)) - vb[3] * s) / 2;
        sx = s;
        sy = s;
    }
    CGContextTranslateCTM(ctx, ox, oy);
    CGContextScaleCTM(ctx, sx, sy);
    CGContextTranslateCTM(ctx, -vb[0], -vb[1]);
    for (pic.shapes) |shape| {
        CGContextSaveGState(ctx);
        const t = shape.transform;
        CGContextConcatCTM(ctx, .{ .a = t.a, .b = t.b, .c = t.c, .d = t.d, .tx = t.e, .ty = t.f });
        if (shape.fill) |f| {
            addPath(ctx, shape.segs);
            const c = f.toF32();
            CGContextSetRGBFillColor(ctx, c[0], c[1], c[2], c[3]);
            if (shape.even_odd) CGContextEOFillPath(ctx) else CGContextFillPath(ctx);
        }
        if (shape.stroke) |st| if (shape.stroke_width > 0) {
            addPath(ctx, shape.segs);
            const c = st.toF32();
            CGContextSetRGBStrokeColor(ctx, c[0], c[1], c[2], c[3]);
            CGContextSetLineWidth(ctx, shape.stroke_width);
            CGContextSetLineCap(ctx, @intFromEnum(shape.cap));
            CGContextSetLineJoin(ctx, @intFromEnum(shape.join));
            CGContextStrokePath(ctx);
        };
        CGContextRestoreGState(ctx);
    }
    return px;
}

fn addPath(ctx: CGContextRef, segs: []const svg.Seg) void {
    CGContextBeginPath(ctx);
    var open = false;
    for (segs) |s| switch (s) {
        .move => |p| {
            CGContextMoveToPoint(ctx, p[0], p[1]);
            open = true;
        },
        .line => |p| if (open) CGContextAddLineToPoint(ctx, p[0], p[1]),
        .cubic => |c| if (open) CGContextAddCurveToPoint(ctx, c[0], c[1], c[2], c[3], c[4], c[5]),
        .close => if (open) CGContextClosePath(ctx),
    };
}
