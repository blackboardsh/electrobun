//! Shared value rules for painted and interactive range inputs.
const std = @import("std");
const dom = @import("dom.zig");

pub fn number(text: []const u8) ?f64 {
    const value = std.fmt.parseFloat(f64, text) catch return null;
    return if (std.math.isFinite(value)) value else null;
}

pub fn isRange(doc: *const dom.Document, id: dom.NodeId) bool {
    const n = doc.get(id) orelse return false;
    return n.kind == .element and n.tag == doc.atoms.input and
        std.ascii.eqlIgnoreCase(n.getAttr(doc.atoms.type) orelse "", "range");
}

pub const Range = struct {
    min: f64 = 0,
    max: f64 = 100,
    step: ?f64 = 1,
    value: f64 = 50,

    pub fn fromNode(doc: *const dom.Document, id: dom.NodeId) Range {
        const n = doc.node(id);
        const w = &doc.atoms;
        var r = Range{};
        r.min = number(n.getAttr(w.min) orelse "") orelse 0;
        r.max = @max(r.min, number(n.getAttr(w.max) orelse "") orelse 100);
        const step = n.getAttr(w.step) orelse "";
        if (std.ascii.eqlIgnoreCase(step, "any")) {
            r.step = null;
        } else if (number(step)) |s| {
            if (s > 0) r.step = s;
        }
        r.value = r.sanitize(number(n.getAttr(w.value) orelse "") orelse r.midpoint());
        return r;
    }

    pub fn midpoint(r: Range) f64 {
        return r.min / 2 + r.max / 2;
    }

    pub fn sanitize(r: Range, value: f64) f64 {
        var v = std.math.clamp(value, r.min, r.max);
        if (r.step) |step| {
            const steps = (v - r.min) / step;
            if (std.math.isFinite(steps)) {
                v = r.min + @round(steps) * step;
                if (v > r.max) v = r.min + @floor((r.max - r.min) / step) * step;
            }
        }
        return std.math.clamp(v, r.min, r.max);
    }

    pub fn fraction(r: Range) f32 {
        if (r.max <= r.min) return 0;
        // Halve first to keep opposite large finite bounds from overflowing.
        return @floatCast(std.math.clamp((r.value / 2 - r.min / 2) / (r.max / 2 - r.min / 2), 0, 1));
    }

    pub fn atFraction(r: Range, fraction_in: f32) f64 {
        const t: f64 = std.math.clamp(fraction_in, 0, 1);
        return r.sanitize(r.min * (1 - t) + r.max * t);
    }
};
