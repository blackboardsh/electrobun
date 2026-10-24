//! Typed CSS values and the low-level parsers shared by every property.
const std = @import("std");
const tok = @import("tokenizer.zig");
const geom = @import("../geom.zig");
const Color = geom.Color;
const Token = tok.Token;

/// Every CSS length is kept as a linear combination of units, which makes
/// calc(100% - 2em + 4px) exact without an expression tree.
pub const Length = struct {
    px: f32 = 0,
    pct: f32 = 0, // fraction (50% => 0.5)
    em: f32 = 0,
    rem: f32 = 0,
    vw: f32 = 0, // fraction of viewport width
    vh: f32 = 0,

    pub fn fromPx(v: f32) Length {
        return .{ .px = v };
    }
    pub fn fromPct(v: f32) Length {
        return .{ .pct = v };
    }
    pub fn add(a: Length, b: Length) Length {
        return .{ .px = a.px + b.px, .pct = a.pct + b.pct, .em = a.em + b.em, .rem = a.rem + b.rem, .vw = a.vw + b.vw, .vh = a.vh + b.vh };
    }
    pub fn scale(a: Length, s: f32) Length {
        return .{ .px = a.px * s, .pct = a.pct * s, .em = a.em * s, .rem = a.rem * s, .vw = a.vw * s, .vh = a.vh * s };
    }
    pub fn isPureNumberLike(a: Length) bool {
        return a.pct == 0 and a.em == 0 and a.rem == 0 and a.vw == 0 and a.vh == 0;
    }
};

pub const Ctx = struct {
    em: f32 = 16,
    rem: f32 = 16,
    vw: f32 = 800,
    vh: f32 = 600,
};

/// A computed length: absolute pixels plus a percentage resolved at layout.
pub const LengthPct = struct {
    px: f32 = 0,
    pct: f32 = 0,

    pub fn resolve(l: LengthPct, basis: f32) f32 {
        return l.px + l.pct * basis;
    }
    pub fn isZero(l: LengthPct) bool {
        return l.px == 0 and l.pct == 0;
    }
    pub fn hasPct(l: LengthPct) bool {
        return l.pct != 0;
    }
    pub fn lerp(a: LengthPct, b: LengthPct, t: f32) LengthPct {
        return .{ .px = a.px + (b.px - a.px) * t, .pct = a.pct + (b.pct - a.pct) * t };
    }
};

pub fn computeLength(l: Length, c: Ctx) LengthPct {
    return .{ .px = l.px + l.em * c.em + l.rem * c.rem + l.vw * c.vw + l.vh * c.vh, .pct = l.pct };
}

// ---------------------------------------------------------------------------
// Token stream helper
// ---------------------------------------------------------------------------

pub const Stream = struct {
    toks: []const Token,
    i: usize = 0,

    pub fn init(toks: []const Token) Stream {
        return .{ .toks = toks };
    }
    pub fn skipWs(s: *Stream) void {
        while (s.i < s.toks.len and s.toks[s.i].tag == .whitespace) s.i += 1;
    }
    pub fn peek(s: *Stream) Token {
        s.skipWs();
        if (s.i >= s.toks.len) return .{ .tag = .eof };
        return s.toks[s.i];
    }
    pub fn next(s: *Stream) Token {
        const t = s.peek();
        if (s.i < s.toks.len) s.i += 1;
        return t;
    }
    pub fn atEnd(s: *Stream) bool {
        const t = s.peek();
        return t.tag == .eof;
    }
    pub fn eatComma(s: *Stream) bool {
        if (s.peek().tag == .comma) {
            s.i += 1;
            return true;
        }
        return false;
    }
    pub fn eatIdent(s: *Stream, name: []const u8) bool {
        const t = s.peek();
        if (t.tag == .ident and std.ascii.eqlIgnoreCase(t.text, name)) {
            s.i += 1;
            return true;
        }
        return false;
    }
    pub fn eatDelim(s: *Stream, d: u8) bool {
        const t = s.peek();
        if (t.tag == .delim and t.delim == d) {
            s.i += 1;
            return true;
        }
        return false;
    }
    /// Consume a function's arguments: returns the inner token slice and
    /// leaves the stream after the matching ')'. Call after consuming the
    /// .function token.
    pub fn functionBody(s: *Stream) []const Token {
        const start = s.i;
        var depth: usize = 1;
        while (s.i < s.toks.len) : (s.i += 1) {
            switch (s.toks[s.i].tag) {
                .function, .lparen => depth += 1,
                .rparen => {
                    depth -= 1;
                    if (depth == 0) {
                        const body = s.toks[start..s.i];
                        s.i += 1;
                        return body;
                    }
                },
                .eof => break,
                else => {},
            }
        }
        return s.toks[start..s.i];
    }
    /// Split into top-level comma-separated groups; caller provides buffer.
    pub fn splitCommas(toks: []const Token, out: [][]const Token) usize {
        var n: usize = 0;
        var depth: usize = 0;
        var start: usize = 0;
        for (toks, 0..) |t, i| {
            switch (t.tag) {
                .function, .lparen, .lbracket => depth += 1,
                .rparen, .rbracket => depth -|= 1,
                .comma => if (depth == 0) {
                    if (n < out.len) out[n] = toks[start..i];
                    n += 1;
                    start = i + 1;
                },
                else => {},
            }
        }
        if (n < out.len) out[n] = toks[start..];
        return n + 1;
    }
};

// ---------------------------------------------------------------------------
// Lengths
// ---------------------------------------------------------------------------

pub fn unitLength(v: f32, unit: []const u8) ?Length {
    const u = unit;
    if (std.ascii.eqlIgnoreCase(u, "px")) return .{ .px = v };
    if (std.ascii.eqlIgnoreCase(u, "em")) return .{ .em = v };
    if (std.ascii.eqlIgnoreCase(u, "rem")) return .{ .rem = v };
    if (std.ascii.eqlIgnoreCase(u, "vw")) return .{ .vw = v / 100 };
    if (std.ascii.eqlIgnoreCase(u, "vh")) return .{ .vh = v / 100 };
    if (std.ascii.eqlIgnoreCase(u, "dvh") or std.ascii.eqlIgnoreCase(u, "svh") or std.ascii.eqlIgnoreCase(u, "lvh")) return .{ .vh = v / 100 };
    if (std.ascii.eqlIgnoreCase(u, "dvw") or std.ascii.eqlIgnoreCase(u, "svw") or std.ascii.eqlIgnoreCase(u, "lvw")) return .{ .vw = v / 100 };
    if (std.ascii.eqlIgnoreCase(u, "pt")) return .{ .px = v * 4.0 / 3.0 };
    if (std.ascii.eqlIgnoreCase(u, "pc")) return .{ .px = v * 16 };
    if (std.ascii.eqlIgnoreCase(u, "in")) return .{ .px = v * 96 };
    if (std.ascii.eqlIgnoreCase(u, "cm")) return .{ .px = v * 96 / 2.54 };
    if (std.ascii.eqlIgnoreCase(u, "mm")) return .{ .px = v * 96 / 25.4 };
    if (std.ascii.eqlIgnoreCase(u, "ch")) return .{ .em = v * 0.5 };
    if (std.ascii.eqlIgnoreCase(u, "ex")) return .{ .em = v * 0.5 };
    return null;
}

/// Parse a <length-percentage> (allowing unitless 0 and, if `quirky`, unitless numbers as px).
pub fn parseLength(s: *Stream, allow_unitless: bool) ?Length {
    const save = s.i;
    const t = s.next();
    switch (t.tag) {
        .dimension => if (unitLength(t.num, t.text)) |l| return l,
        .percentage => return .{ .pct = t.num / 100 },
        .number => if (t.num == 0 or allow_unitless) return .{ .px = t.num },
        .function => {
            if (isMathFn(t.text)) {
                const body = s.functionBody();
                if (evalMath(t.text, body)) |l| return l;
            }
        },
        else => {},
    }
    s.i = save;
    return null;
}

fn isMathFn(name: []const u8) bool {
    return std.ascii.eqlIgnoreCase(name, "calc") or std.ascii.eqlIgnoreCase(name, "min") or
        std.ascii.eqlIgnoreCase(name, "max") or std.ascii.eqlIgnoreCase(name, "clamp");
}

const CalcVal = struct {
    len: Length = .{},
    is_number: bool = false, // pure number (no unit)
    num: f32 = 0,
};

fn evalMath(name: []const u8, body: []const Token) ?Length {
    if (std.ascii.eqlIgnoreCase(name, "calc")) {
        var cs = Stream.init(body);
        const v = calcSum(&cs) orelse return null;
        if (!cs.atEnd()) return null;
        return if (v.is_number) Length{ .px = v.num } else v.len;
    }
    // min/max/clamp: exact when every argument is the same single unit kind,
    // otherwise approximate with the preferred (middle/first) argument.
    var parts: [8][]const Token = undefined;
    const n = Stream.splitCommas(body, &parts);
    if (n == 0 or n > parts.len) return null;
    var vals: [8]Length = undefined;
    for (parts[0..n], 0..) |p, i| {
        var ps = Stream.init(p);
        const v = calcSum(&ps) orelse return null;
        vals[i] = if (v.is_number) Length{ .px = v.num } else v.len;
    }
    const is_clamp = std.ascii.eqlIgnoreCase(name, "clamp");
    if (is_clamp and n != 3) return null;
    var all_px = true;
    for (vals[0..n]) |v| all_px = all_px and v.isPureNumberLike();
    if (all_px) {
        if (is_clamp) return .{ .px = @max(vals[0].px, @min(vals[1].px, vals[2].px)) };
        var r = vals[0].px;
        for (vals[1..n]) |v| r = if (std.ascii.eqlIgnoreCase(name, "min")) @min(r, v.px) else @max(r, v.px);
        return .{ .px = r };
    }
    return if (is_clamp) vals[1] else vals[0];
}

fn calcSum(s: *Stream) ?CalcVal {
    var acc = calcProduct(s) orelse return null;
    while (true) {
        const t = s.peek();
        const sign: f32 = if (t.tag == .delim and t.delim == '+') 1 else if (t.tag == .delim and t.delim == '-') -1 else {
            // "100% -10px" tokenizes as percentage + dimension(-10): treat as subtraction
            if (t.tag == .dimension or t.tag == .number or t.tag == .percentage) {
                if (t.num < 0) {
                    const rhs = calcProduct(s) orelse return null;
                    acc = addCalc(acc, rhs, 1) orelse return null;
                    continue;
                }
            }
            break;
        };
        _ = s.next();
        const rhs = calcProduct(s) orelse return null;
        acc = addCalc(acc, rhs, sign) orelse return null;
    }
    return acc;
}

fn addCalc(a: CalcVal, b: CalcVal, sign: f32) ?CalcVal {
    if (a.is_number and b.is_number) return .{ .is_number = true, .num = a.num + sign * b.num };
    if (a.is_number != b.is_number) {
        // tolerate 0
        if (a.is_number and a.num == 0) return .{ .len = b.len.scale(sign) };
        if (b.is_number and b.num == 0) return a;
        return null;
    }
    return .{ .len = a.len.add(b.len.scale(sign)) };
}

fn calcProduct(s: *Stream) ?CalcVal {
    var acc = calcValue(s) orelse return null;
    while (true) {
        const t = s.peek();
        if (t.tag != .delim or (t.delim != '*' and t.delim != '/')) break;
        _ = s.next();
        const rhs = calcValue(s) orelse return null;
        if (t.delim == '*') {
            if (acc.is_number and rhs.is_number) {
                acc.num *= rhs.num;
            } else if (acc.is_number) {
                acc = .{ .len = rhs.len.scale(acc.num) };
            } else if (rhs.is_number) {
                acc.len = acc.len.scale(rhs.num);
            } else return null;
        } else {
            if (!rhs.is_number or rhs.num == 0) return null;
            if (acc.is_number) acc.num /= rhs.num else acc.len = acc.len.scale(1 / rhs.num);
        }
    }
    return acc;
}

fn calcValue(s: *Stream) ?CalcVal {
    const t = s.next();
    switch (t.tag) {
        .number => return .{ .is_number = true, .num = t.num },
        .dimension => return .{ .len = unitLength(t.num, t.text) orelse return null },
        .percentage => return .{ .len = .{ .pct = t.num / 100 } },
        .lparen => {
            var depth: usize = 1;
            const start = s.i;
            while (s.i < s.toks.len) : (s.i += 1) {
                switch (s.toks[s.i].tag) {
                    .lparen, .function => depth += 1,
                    .rparen => {
                        depth -= 1;
                        if (depth == 0) break;
                    },
                    else => {},
                }
            }
            var inner = Stream.init(s.toks[start..s.i]);
            if (s.i < s.toks.len) s.i += 1;
            return calcSum(&inner);
        },
        .function => {
            const body = s.functionBody();
            if (std.ascii.eqlIgnoreCase(t.text, "calc")) {
                var inner = Stream.init(body);
                return calcSum(&inner);
            }
            if (isMathFn(t.text)) {
                const l = evalMath(t.text, body) orelse return null;
                return .{ .len = l };
            }
            return null;
        },
        else => return null,
    }
}

// ---------------------------------------------------------------------------
// Numbers, angles, times
// ---------------------------------------------------------------------------

pub fn parseNumber(s: *Stream) ?f32 {
    const save = s.i;
    const t = s.next();
    if (t.tag == .number) return t.num;
    if (t.tag == .function and std.ascii.eqlIgnoreCase(t.text, "calc")) {
        const body = s.functionBody();
        var cs = Stream.init(body);
        if (calcSum(&cs)) |v| if (v.is_number) return v.num;
    }
    s.i = save;
    return null;
}

/// Angle in radians.
pub fn parseAngle(s: *Stream) ?f32 {
    const save = s.i;
    const t = s.next();
    if (t.tag == .dimension) {
        if (std.ascii.eqlIgnoreCase(t.text, "deg")) return t.num * std.math.pi / 180.0;
        if (std.ascii.eqlIgnoreCase(t.text, "rad")) return t.num;
        if (std.ascii.eqlIgnoreCase(t.text, "turn")) return t.num * 2 * std.math.pi;
        if (std.ascii.eqlIgnoreCase(t.text, "grad")) return t.num * std.math.pi / 200.0;
    }
    if (t.tag == .number and t.num == 0) return 0;
    s.i = save;
    return null;
}

/// Time in seconds.
pub fn parseTime(s: *Stream) ?f32 {
    const save = s.i;
    const t = s.next();
    if (t.tag == .dimension) {
        if (std.ascii.eqlIgnoreCase(t.text, "s")) return t.num;
        if (std.ascii.eqlIgnoreCase(t.text, "ms")) return t.num / 1000.0;
    }
    if (t.tag == .number and t.num == 0) return 0;
    s.i = save;
    return null;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

pub const ColorValue = union(enum) {
    rgba: Color,
    current_color,
};

pub fn parseColor(s: *Stream) ?ColorValue {
    const save = s.i;
    const t = s.next();
    switch (t.tag) {
        .hash => if (parseHex(t.text)) |c| return .{ .rgba = c },
        .ident => {
            if (std.ascii.eqlIgnoreCase(t.text, "currentcolor")) return .current_color;
            if (namedColor(t.text)) |c| return .{ .rgba = c };
        },
        .function => {
            const body = s.functionBody();
            if (colorFunction(t.text, body)) |c| return .{ .rgba = c };
        },
        else => {},
    }
    s.i = save;
    return null;
}

pub fn parseHex(h: []const u8) ?Color {
    var v: [8]u8 = undefined;
    for (h, 0..) |c, i| {
        if (i >= 8) return null;
        v[i] = std.fmt.charToDigit(c, 16) catch return null;
    }
    return switch (h.len) {
        3 => Color.rgba(v[0] * 17, v[1] * 17, v[2] * 17, 255),
        4 => Color.rgba(v[0] * 17, v[1] * 17, v[2] * 17, v[3] * 17),
        6 => Color.rgba(v[0] * 16 + v[1], v[2] * 16 + v[3], v[4] * 16 + v[5], 255),
        8 => Color.rgba(v[0] * 16 + v[1], v[2] * 16 + v[3], v[4] * 16 + v[5], v[6] * 16 + v[7]),
        else => null,
    };
}

fn byte(v: f32) u8 {
    return @intFromFloat(std.math.clamp(@round(v), 0, 255));
}

/// Collect up to 4 numeric channel tokens, accepting comma or space syntax and "/ alpha".
fn colorArgs(body: []const Token, out: *[4]Token) ?usize {
    var n: usize = 0;
    for (body) |t| {
        switch (t.tag) {
            .whitespace, .comma => {},
            .delim => if (t.delim != '/') return null,
            .number, .percentage, .dimension, .ident => {
                if (n >= 4) return null;
                out[n] = t;
                n += 1;
            },
            else => return null,
        }
    }
    return n;
}

fn alphaOf(t: Token) f32 {
    return switch (t.tag) {
        .percentage => t.num / 100,
        .number => t.num,
        else => 1,
    };
}

fn hueOf(t: Token) f32 {
    if (t.tag == .dimension) {
        if (std.ascii.eqlIgnoreCase(t.text, "rad")) return t.num * 180 / std.math.pi;
        if (std.ascii.eqlIgnoreCase(t.text, "turn")) return t.num * 360;
        if (std.ascii.eqlIgnoreCase(t.text, "grad")) return t.num * 0.9;
    }
    if (t.tag == .ident) return 0; // "none"
    return t.num;
}

fn colorFunction(name: []const u8, body: []const Token) ?Color {
    var a: [4]Token = undefined;
    const n = colorArgs(body, &a) orelse return null;
    if (n < 3) return null;
    const alpha: f32 = if (n == 4) alphaOf(a[3]) else 1;
    const ab = byte(std.math.clamp(alpha, 0, 1) * 255);
    if (std.ascii.eqlIgnoreCase(name, "rgb") or std.ascii.eqlIgnoreCase(name, "rgba")) {
        var ch: [3]u8 = undefined;
        for (0..3) |i| {
            ch[i] = switch (a[i].tag) {
                .percentage => byte(a[i].num * 2.55),
                .number => byte(a[i].num),
                else => 0,
            };
        }
        return Color.rgba(ch[0], ch[1], ch[2], ab);
    }
    if (std.ascii.eqlIgnoreCase(name, "hsl") or std.ascii.eqlIgnoreCase(name, "hsla")) {
        const h = hueOf(a[0]);
        const sat = a[1].num / 100;
        const l = a[2].num / 100;
        const rgb = hslToRgb(h, sat, l);
        return Color.rgba(byte(rgb[0] * 255), byte(rgb[1] * 255), byte(rgb[2] * 255), ab);
    }
    if (std.ascii.eqlIgnoreCase(name, "oklch") or std.ascii.eqlIgnoreCase(name, "oklab") or
        std.ascii.eqlIgnoreCase(name, "lch") or std.ascii.eqlIgnoreCase(name, "lab"))
    {
        const is_ok = std.ascii.startsWithIgnoreCase(name, "ok");
        const is_lch = std.ascii.endsWithIgnoreCase(name, "lch");
        var L: f32 = if (a[0].tag == .percentage) a[0].num / 100 else a[0].num;
        if (!is_ok) L = if (a[0].tag == .percentage) a[0].num else a[0].num; // lab L is 0..100
        var A: f32 = undefined;
        var B: f32 = undefined;
        if (is_lch) {
            var C: f32 = a[1].num;
            if (a[1].tag == .percentage) C = a[1].num / 100 * (if (is_ok) @as(f32, 0.4) else 150);
            const h = hueOf(a[2]) * std.math.pi / 180;
            A = C * @cos(h);
            B = C * @sin(h);
        } else {
            A = if (a[1].tag == .percentage) a[1].num / 100 * (if (is_ok) @as(f32, 0.4) else 125) else a[1].num;
            B = if (a[2].tag == .percentage) a[2].num / 100 * (if (is_ok) @as(f32, 0.4) else 125) else a[2].num;
        }
        const rgb = if (is_ok) oklabToSrgb(L, A, B) else labToSrgb(L, A, B);
        return Color.rgba(byte(rgb[0] * 255), byte(rgb[1] * 255), byte(rgb[2] * 255), ab);
    }
    return null;
}

fn hslToRgb(h_deg: f32, s: f32, l: f32) [3]f32 {
    const h = @mod(h_deg, 360) / 360;
    const f = struct {
        fn hue(p: f32, q: f32, t0: f32) f32 {
            var t = t0;
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1.0 / 6.0) return p + (q - p) * 6 * t;
            if (t < 0.5) return q;
            if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6;
            return p;
        }
    };
    if (s == 0) return .{ l, l, l };
    const q = if (l < 0.5) l * (1 + s) else l + s - l * s;
    const p = 2 * l - q;
    return .{ f.hue(p, q, h + 1.0 / 3.0), f.hue(p, q, h), f.hue(p, q, h - 1.0 / 3.0) };
}

fn linearToSrgb(x: f32) f32 {
    const v = std.math.clamp(x, 0, 1);
    return if (v <= 0.0031308) 12.92 * v else 1.055 * std.math.pow(f32, v, 1.0 / 2.4) - 0.055;
}

pub fn oklabToSrgb(L: f32, a: f32, b: f32) [3]f32 {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    return .{
        linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    };
}

fn labToSrgb(L: f32, a: f32, b: f32) [3]f32 {
    // CIE Lab (D50) -> XYZ -> linear sRGB (Bradford-adapted to D65)
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const eps: f32 = 216.0 / 24389.0;
    const k: f32 = 24389.0 / 27.0;
    const xr = if (fx * fx * fx > eps) fx * fx * fx else (116 * fx - 16) / k;
    const yr = if (L > k * eps) fy * fy * fy else L / k;
    const zr = if (fz * fz * fz > eps) fz * fz * fz else (116 * fz - 16) / k;
    const X = xr * 0.96422;
    const Y = yr;
    const Z = zr * 0.82521;
    const r = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
    const g = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z;
    const bl = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
    return .{ linearToSrgb(r), linearToSrgb(g), linearToSrgb(bl) };
}

const named_colors = std.StaticStringMap(u32).initComptime(.{
    .{ "aliceblue", 0xf0f8ff },       .{ "antiquewhite", 0xfaebd7 },    .{ "aqua", 0x00ffff },
    .{ "aquamarine", 0x7fffd4 },      .{ "azure", 0xf0ffff },           .{ "beige", 0xf5f5dc },
    .{ "bisque", 0xffe4c4 },          .{ "black", 0x000000 },           .{ "blanchedalmond", 0xffebcd },
    .{ "blue", 0x0000ff },            .{ "blueviolet", 0x8a2be2 },      .{ "brown", 0xa52a2a },
    .{ "burlywood", 0xdeb887 },       .{ "cadetblue", 0x5f9ea0 },       .{ "chartreuse", 0x7fff00 },
    .{ "chocolate", 0xd2691e },       .{ "coral", 0xff7f50 },           .{ "cornflowerblue", 0x6495ed },
    .{ "cornsilk", 0xfff8dc },        .{ "crimson", 0xdc143c },         .{ "cyan", 0x00ffff },
    .{ "darkblue", 0x00008b },        .{ "darkcyan", 0x008b8b },        .{ "darkgoldenrod", 0xb8860b },
    .{ "darkgray", 0xa9a9a9 },        .{ "darkgreen", 0x006400 },       .{ "darkgrey", 0xa9a9a9 },
    .{ "darkkhaki", 0xbdb76b },       .{ "darkmagenta", 0x8b008b },     .{ "darkolivegreen", 0x556b2f },
    .{ "darkorange", 0xff8c00 },      .{ "darkorchid", 0x9932cc },      .{ "darkred", 0x8b0000 },
    .{ "darksalmon", 0xe9967a },      .{ "darkseagreen", 0x8fbc8f },    .{ "darkslateblue", 0x483d8b },
    .{ "darkslategray", 0x2f4f4f },   .{ "darkslategrey", 0x2f4f4f },   .{ "darkturquoise", 0x00ced1 },
    .{ "darkviolet", 0x9400d3 },      .{ "deeppink", 0xff1493 },        .{ "deepskyblue", 0x00bfff },
    .{ "dimgray", 0x696969 },         .{ "dimgrey", 0x696969 },         .{ "dodgerblue", 0x1e90ff },
    .{ "firebrick", 0xb22222 },       .{ "floralwhite", 0xfffaf0 },     .{ "forestgreen", 0x228b22 },
    .{ "fuchsia", 0xff00ff },         .{ "gainsboro", 0xdcdcdc },       .{ "ghostwhite", 0xf8f8ff },
    .{ "gold", 0xffd700 },            .{ "goldenrod", 0xdaa520 },       .{ "gray", 0x808080 },
    .{ "green", 0x008000 },           .{ "greenyellow", 0xadff2f },     .{ "grey", 0x808080 },
    .{ "honeydew", 0xf0fff0 },        .{ "hotpink", 0xff69b4 },         .{ "indianred", 0xcd5c5c },
    .{ "indigo", 0x4b0082 },          .{ "ivory", 0xfffff0 },           .{ "khaki", 0xf0e68c },
    .{ "lavender", 0xe6e6fa },        .{ "lavenderblush", 0xfff0f5 },   .{ "lawngreen", 0x7cfc00 },
    .{ "lemonchiffon", 0xfffacd },    .{ "lightblue", 0xadd8e6 },       .{ "lightcoral", 0xf08080 },
    .{ "lightcyan", 0xe0ffff },       .{ "lightgoldenrodyellow", 0xfafad2 }, .{ "lightgray", 0xd3d3d3 },
    .{ "lightgreen", 0x90ee90 },      .{ "lightgrey", 0xd3d3d3 },       .{ "lightpink", 0xffb6c1 },
    .{ "lightsalmon", 0xffa07a },     .{ "lightseagreen", 0x20b2aa },   .{ "lightskyblue", 0x87cefa },
    .{ "lightslategray", 0x778899 },  .{ "lightslategrey", 0x778899 },  .{ "lightsteelblue", 0xb0c4de },
    .{ "lightyellow", 0xffffe0 },     .{ "lime", 0x00ff00 },            .{ "limegreen", 0x32cd32 },
    .{ "linen", 0xfaf0e6 },           .{ "magenta", 0xff00ff },         .{ "maroon", 0x800000 },
    .{ "mediumaquamarine", 0x66cdaa }, .{ "mediumblue", 0x0000cd },     .{ "mediumorchid", 0xba55d3 },
    .{ "mediumpurple", 0x9370db },    .{ "mediumseagreen", 0x3cb371 },  .{ "mediumslateblue", 0x7b68ee },
    .{ "mediumspringgreen", 0x00fa9a }, .{ "mediumturquoise", 0x48d1cc }, .{ "mediumvioletred", 0xc71585 },
    .{ "midnightblue", 0x191970 },    .{ "mintcream", 0xf5fffa },       .{ "mistyrose", 0xffe4e1 },
    .{ "moccasin", 0xffe4b5 },        .{ "navajowhite", 0xffdead },     .{ "navy", 0x000080 },
    .{ "oldlace", 0xfdf5e6 },         .{ "olive", 0x808000 },           .{ "olivedrab", 0x6b8e23 },
    .{ "orange", 0xffa500 },          .{ "orangered", 0xff4500 },       .{ "orchid", 0xda70d6 },
    .{ "palegoldenrod", 0xeee8aa },   .{ "palegreen", 0x98fb98 },       .{ "paleturquoise", 0xafeeee },
    .{ "palevioletred", 0xdb7093 },   .{ "papayawhip", 0xffefd5 },      .{ "peachpuff", 0xffdab9 },
    .{ "peru", 0xcd853f },            .{ "pink", 0xffc0cb },            .{ "plum", 0xdda0dd },
    .{ "powderblue", 0xb0e0e6 },      .{ "purple", 0x800080 },          .{ "rebeccapurple", 0x663399 },
    .{ "red", 0xff0000 },             .{ "rosybrown", 0xbc8f8f },       .{ "royalblue", 0x4169e1 },
    .{ "saddlebrown", 0x8b4513 },     .{ "salmon", 0xfa8072 },          .{ "sandybrown", 0xf4a460 },
    .{ "seagreen", 0x2e8b57 },        .{ "seashell", 0xfff5ee },        .{ "sienna", 0xa0522d },
    .{ "silver", 0xc0c0c0 },          .{ "skyblue", 0x87ceeb },         .{ "slateblue", 0x6a5acd },
    .{ "slategray", 0x708090 },       .{ "slategrey", 0x708090 },       .{ "snow", 0xfffafa },
    .{ "springgreen", 0x00ff7f },     .{ "steelblue", 0x4682b4 },       .{ "tan", 0xd2b48c },
    .{ "teal", 0x008080 },            .{ "thistle", 0xd8bfd8 },         .{ "tomato", 0xff6347 },
    .{ "turquoise", 0x40e0d0 },       .{ "violet", 0xee82ee },          .{ "wheat", 0xf5deb3 },
    .{ "white", 0xffffff },           .{ "whitesmoke", 0xf5f5f5 },      .{ "yellow", 0xffff00 },
    .{ "yellowgreen", 0x9acd32 },
});

pub fn namedColor(name: []const u8) ?Color {
    var buf: [32]u8 = undefined;
    if (name.len > buf.len) return null;
    const lower = std.ascii.lowerString(&buf, name);
    if (std.mem.eql(u8, lower, "transparent")) return Color.transparent;
    if (named_colors.get(lower)) |v| return Color.hex(v);
    return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

fn parseStr(comptime f: anytype, src: []const u8) @typeInfo(@TypeOf(f)).@"fn".return_type.? {
    var list = tok.tokenizeAll(std.testing.allocator, src) catch unreachable;
    defer list.deinit(std.testing.allocator);
    var s = Stream.init(list.items);
    return f(&s);
}

fn parseLen(s: *Stream) ?Length {
    return parseLength(s, false);
}

test "lengths and calc" {
    try std.testing.expectEqual(@as(f32, 12), parseStr(parseLen, "12px").?.px);
    try std.testing.expectEqual(@as(f32, 0.5), parseStr(parseLen, "50%").?.pct);
    const c = parseStr(parseLen, "calc(100% - 2em + 4px)").?;
    try std.testing.expectEqual(@as(f32, 1), c.pct);
    try std.testing.expectEqual(@as(f32, -2), c.em);
    try std.testing.expectEqual(@as(f32, 4), c.px);
    const d = parseStr(parseLen, "calc((10px + 5px) * 2)").?;
    try std.testing.expectEqual(@as(f32, 30), d.px);
    try std.testing.expectEqual(@as(f32, 20), parseStr(parseLen, "max(10px, 20px)").?.px);
    try std.testing.expectEqual(@as(f32, 15), parseStr(parseLen, "clamp(10px, 15px, 20px)").?.px);
    try std.testing.expect(parseStr(parseLen, "12") == null);
}

test "colors" {
    try std.testing.expect(parseStr(parseColor, "#f00").?.rgba.eql(Color.rgb(255, 0, 0)));
    try std.testing.expect(parseStr(parseColor, "rgb(10 20 30 / 50%)").?.rgba.eql(Color.rgba(10, 20, 30, 128)));
    try std.testing.expect(parseStr(parseColor, "rgba(10, 20, 30, 0.5)").?.rgba.eql(Color.rgba(10, 20, 30, 128)));
    try std.testing.expect(parseStr(parseColor, "hsl(120, 100%, 50%)").?.rgba.eql(Color.rgb(0, 255, 0)));
    try std.testing.expect(parseStr(parseColor, "rebeccapurple").?.rgba.eql(Color.rgb(0x66, 0x33, 0x99)));
    // tailwind v4 blue-500: oklch(62.3% 0.214 259.815) -> sRGB #2b7fff
    const blue = parseStr(parseColor, "oklch(62.3% 0.214 259.815)").?.rgba;
    try std.testing.expect(@abs(@as(i32, blue.r) - 0x2b) <= 2 and @abs(@as(i32, blue.g) - 0x7f) <= 2 and @abs(@as(i32, blue.b) - 0xff) <= 3);
    try std.testing.expect(parseStr(parseColor, "currentColor").? == .current_color);
}
