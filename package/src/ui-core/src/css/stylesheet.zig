//! Stylesheet parsing: rules, nesting, @media, @supports, @layer, @keyframes,
//! @font-face and @property. Everything is allocated from the sheet's arena.
const std = @import("std");
const tok = @import("tokenizer.zig");
const values = @import("values.zig");
const props = @import("properties.zig");
const selector = @import("selector.zig");
const atom_mod = @import("../atom.zig");

const Token = tok.Token;
const Allocator = std.mem.Allocator;
const Declaration = props.Declaration;
const Interner = atom_mod.Interner;

pub const MediaEnv = struct {
    width: f32 = 800,
    height: f32 = 600,
    dark: bool = false,
    reduced_motion: bool = false,
    resolution: f32 = 1,
};

pub const MediaFeature = struct {
    kind: enum { min_width, max_width, min_height, max_height, dark, light, reduced_motion, no_reduced_motion, hover, any, never, min_resolution, max_resolution, landscape, portrait },
    value: f32 = 0,
};

/// Disjunction of conjunctions.
pub const MediaQuery = struct {
    alternatives: []const []const MediaFeature,
    negated: []const bool,

    pub fn matches(m: MediaQuery, env: MediaEnv) bool {
        for (m.alternatives, m.negated) |conj, neg| {
            var ok = true;
            for (conj) |f| {
                if (!featureMatches(f, env)) {
                    ok = false;
                    break;
                }
            }
            if (ok != neg) return true;
        }
        return false;
    }
};

fn featureMatches(f: MediaFeature, env: MediaEnv) bool {
    return switch (f.kind) {
        .min_width => env.width >= f.value,
        .max_width => env.width <= f.value,
        .min_height => env.height >= f.value,
        .max_height => env.height <= f.value,
        .dark => env.dark,
        .light => !env.dark,
        .reduced_motion => env.reduced_motion,
        .no_reduced_motion => !env.reduced_motion,
        .hover, .any => true,
        .never => false,
        .min_resolution => env.resolution >= f.value,
        .max_resolution => env.resolution <= f.value,
        .landscape => env.width >= env.height,
        .portrait => env.height > env.width,
    };
}

pub const Rule = struct {
    selectors: []const selector.Selector,
    decls: []const Declaration,
    media: []const *const MediaQuery = &.{}, // all must match
    layer: u16 = unlayered,
    order: u32 = 0,
};

pub const unlayered: u16 = 0xffff;

pub const Keyframe = struct {
    offset: f32,
    decls: []const Declaration,
    timing: ?props.Timing = null,
};

pub const Keyframes = struct {
    name: []const u8,
    frames: []const Keyframe,
};

pub const FontFace = struct {
    family: []const u8,
    src: []const u8,
    weight_min: f32 = 400,
    weight_max: f32 = 400,
    italic: bool = false,
};

pub const PropertyRegistration = struct {
    name: []const u8,
    initial: ?[]const u8,
    inherits: bool,
};

pub const Stylesheet = struct {
    arena_state: std.heap.ArenaAllocator,
    rules: std.ArrayList(Rule) = .empty,
    keyframes: std.ArrayList(Keyframes) = .empty,
    font_faces: std.ArrayList(FontFace) = .empty,
    properties: std.ArrayList(PropertyRegistration) = .empty,
    layer_names: std.ArrayList([]const u8) = .empty,
    /// count of parse errors that were skipped (for diagnostics)
    errors: u32 = 0,

    pub fn deinit(self: *Stylesheet) void {
        self.arena_state.deinit();
    }

    pub fn arena(self: *Stylesheet) Allocator {
        return self.arena_state.allocator();
    }

    fn layerIndex(self: *Stylesheet, name: []const u8) !u16 {
        for (self.layer_names.items, 0..) |n, i| if (std.mem.eql(u8, n, name)) return @intCast(i);
        try self.layer_names.append(self.arena(), try self.arena().dupe(u8, name));
        return @intCast(self.layer_names.items.len - 1);
    }
};

pub fn parse(gpa: Allocator, interner: *Interner, src: []const u8) Allocator.Error!*Stylesheet {
    const sheet = try gpa.create(Stylesheet);
    sheet.* = .{ .arena_state = std.heap.ArenaAllocator.init(gpa) };
    errdefer {
        sheet.deinit();
        gpa.destroy(sheet);
    }
    const a = sheet.arena();
    // keep a private copy of the source: raw (var()) values borrow from it
    const owned = try a.dupe(u8, src);
    var toks = try tok.tokenizeAll(a, owned);
    var p = SheetParser{ .sheet = sheet, .interner = interner, .src = owned, .toks = toks.items };
    _ = &toks;
    try p.parseRuleList(0, toks.items.len, .{});
    return sheet;
}

const Context = struct {
    media: []const *const MediaQuery = &.{},
    layer: u16 = unlayered,
    parent_selector: ?[]const u8 = null,
};

const SheetParser = struct {
    sheet: *Stylesheet,
    interner: *Interner,
    src: []const u8,
    toks: []const Token,
    order: u32 = 0,

    fn arena(p: *SheetParser) Allocator {
        return p.sheet.arena();
    }

    fn srcOf(p: *SheetParser, from: usize, to: usize) []const u8 {
        if (from >= to) return "";
        const s = p.toks[from].start;
        const e = p.toks[to].start;
        return p.src[s..e];
    }

    /// Index of the token closing the block that starts at `open` (an lbrace).
    fn matchBlock(p: *SheetParser, open: usize, end: usize) usize {
        var depth: usize = 0;
        var i = open;
        while (i < end) : (i += 1) {
            switch (p.toks[i].tag) {
                .lbrace => depth += 1,
                .rbrace => {
                    depth -= 1;
                    if (depth == 0) return i;
                },
                else => {},
            }
        }
        return end;
    }

    fn parseRuleList(p: *SheetParser, start: usize, end: usize, ctx: Context) Allocator.Error!void {
        var i = start;
        while (i < end) {
            const t = p.toks[i];
            switch (t.tag) {
                .whitespace, .cdo, .cdc, .semicolon => i += 1,
                .eof => return,
                .at_keyword => i = try p.parseAtRule(i, end, ctx),
                else => {
                    // qualified rule: prelude up to '{'
                    var j = i;
                    while (j < end and p.toks[j].tag != .lbrace and p.toks[j].tag != .semicolon) : (j += 1) {}
                    if (j >= end or p.toks[j].tag == .semicolon) {
                        p.sheet.errors += 1;
                        i = j + 1;
                        continue;
                    }
                    const close = p.matchBlock(j, end);
                    try p.styleRule(i, j, j + 1, close, ctx);
                    i = close + 1;
                },
            }
        }
    }

    fn styleRule(p: *SheetParser, pre_start: usize, pre_end: usize, body_start: usize, body_end: usize, ctx: Context) Allocator.Error!void {
        const a = p.arena();
        var prelude_text = std.mem.trim(u8, p.srcOf(pre_start, pre_end), " \t\r\n");
        if (ctx.parent_selector) |parent| {
            prelude_text = try resolveNesting(a, parent, prelude_text);
        }
        const sel_toks = try tok.tokenizeAll(a, prelude_text);
        const sels = selector.parseList(a, p.interner, sel_toks.items[0 .. sel_toks.items.len - 1]) catch |e| switch (e) {
            error.OutOfMemory => return error.OutOfMemory,
            error.Invalid => {
                p.sheet.errors += 1;
                return;
            },
        };
        var decls: std.ArrayList(Declaration) = .empty;
        // Body: declarations, plus nested rules and at-rules
        var i = body_start;
        const rule_index = p.sheet.rules.items.len;
        try p.sheet.rules.append(a, .{ .selectors = sels, .decls = &.{}, .media = ctx.media, .layer = ctx.layer, .order = p.nextOrder() });
        var nested_ctx = ctx;
        nested_ctx.parent_selector = prelude_text;
        while (i < body_end) {
            const t = p.toks[i];
            switch (t.tag) {
                .whitespace, .semicolon => {
                    i += 1;
                    continue;
                },
                .at_keyword => {
                    i = try p.parseAtRule(i, body_end, nested_ctx);
                    continue;
                },
                else => {},
            }
            // find end of item: ';' or '{' at depth 0
            var j = i;
            var depth: usize = 0;
            var is_rule = false;
            while (j < body_end) : (j += 1) {
                switch (p.toks[j].tag) {
                    .function, .lparen, .lbracket => depth += 1,
                    .rparen, .rbracket => depth -|= 1,
                    .semicolon => if (depth == 0) break,
                    .lbrace => if (depth == 0) {
                        is_rule = true;
                        break;
                    },
                    else => {},
                }
            }
            if (is_rule and !p.looksLikeCustomPropBlock(i, j)) {
                const close = p.matchBlock(j, body_end);
                try p.styleRule(i, j, j + 1, close, nested_ctx);
                i = close + 1;
            } else {
                if (is_rule) {
                    // custom property with a {} block value: skip it
                    j = p.matchBlock(j, body_end);
                }
                p.declaration(i, j, &decls);
                i = j + 1;
            }
        }
        p.sheet.rules.items[rule_index].decls = decls.items;
    }

    fn looksLikeCustomPropBlock(p: *SheetParser, i: usize, j: usize) bool {
        _ = j;
        const t = p.toks[i];
        return t.tag == .ident and std.mem.startsWith(u8, t.text, "--");
    }

    fn nextOrder(p: *SheetParser) u32 {
        p.order += 1;
        return p.order;
    }

    fn declaration(p: *SheetParser, start: usize, end: usize, out: *std.ArrayList(Declaration)) void {
        p.declarationInner(start, end, out) catch {
            p.sheet.errors += 1;
        };
    }

    fn declarationInner(p: *SheetParser, start: usize, end: usize, out: *std.ArrayList(Declaration)) !void {
        var i = start;
        while (i < end and p.toks[i].tag == .whitespace) i += 1;
        if (i >= end or p.toks[i].tag != .ident) return error.Invalid;
        const name = p.toks[i].text;
        i += 1;
        while (i < end and p.toks[i].tag == .whitespace) i += 1;
        if (i >= end or p.toks[i].tag != .colon) return error.Invalid;
        i += 1;
        var vend = end;
        // trailing !important
        var important = false;
        {
            var k = vend;
            while (k > i and p.toks[k - 1].tag == .whitespace) k -= 1;
            if (k >= i + 2 and p.toks[k - 1].tag == .ident and std.ascii.eqlIgnoreCase(p.toks[k - 1].text, "important")) {
                var d = k - 2;
                while (d > i and p.toks[d].tag == .whitespace) d -= 1;
                if (p.toks[d].tag == .delim and p.toks[d].delim == '!') {
                    important = true;
                    vend = d;
                }
            }
        }
        try props.parseDeclaration(p.arena(), name, p.toks[i..vend], p.srcOf(i, vend), important, out);
    }

    fn parseAtRule(p: *SheetParser, at_i: usize, end: usize, ctx: Context) Allocator.Error!usize {
        const a = p.arena();
        const name = p.toks[at_i].text;
        var j = at_i + 1;
        while (j < end and p.toks[j].tag != .lbrace and p.toks[j].tag != .semicolon) : (j += 1) {}
        const pre_start = at_i + 1;
        const pre_end = j;
        if (j >= end or p.toks[j].tag == .semicolon) {
            // statement at-rule
            if (eq(name, "layer")) {
                var parts: [32][]const Token = undefined;
                const n = values.Stream.splitCommas(p.toks[pre_start..pre_end], &parts);
                for (parts[0..@min(n, parts.len)]) |part| {
                    var s = values.Stream.init(part);
                    const t = s.next();
                    if (t.tag == .ident) _ = try p.sheet.layerIndex(try p.layerName(ctx, t.text));
                }
            }
            return j + 1;
        }
        const close = p.matchBlock(j, end);
        if (eq(name, "media")) {
            const mq = try p.parseMedia(pre_start, pre_end);
            var list = try a.alloc(*const MediaQuery, ctx.media.len + 1);
            @memcpy(list[0..ctx.media.len], ctx.media);
            list[ctx.media.len] = mq;
            var c = ctx;
            c.media = list;
            try p.parseBlockContents(j + 1, close, c);
        } else if (eq(name, "supports")) {
            if (p.evalSupports(pre_start, pre_end)) try p.parseBlockContents(j + 1, close, ctx);
        } else if (eq(name, "layer")) {
            var c = ctx;
            var s = values.Stream.init(p.toks[pre_start..pre_end]);
            const t = s.next();
            const lname = if (t.tag == .ident) t.text else "";
            const full = try p.layerName(ctx, if (lname.len == 0) try std.fmt.allocPrint(a, "__anon{d}", .{p.order}) else lname);
            c.layer = try p.sheet.layerIndex(full);
            try p.parseBlockContents(j + 1, close, c);
        } else if (eq(name, "keyframes") or eq(name, "-webkit-keyframes")) {
            try p.parseKeyframes(pre_start, pre_end, j + 1, close);
        } else if (eq(name, "font-face")) {
            try p.parseFontFace(j + 1, close);
        } else if (eq(name, "property")) {
            try p.parseProperty(pre_start, pre_end, j + 1, close);
        } else if (eq(name, "container") or eq(name, "scope") or eq(name, "starting-style")) {
            // unsupported grouping rules: ignore contents
        } else if (eq(name, "theme") or eq(name, "utility") or eq(name, "custom-variant") or eq(name, "variant")) {
            // Tailwind source directives: not CSS; ignored
        } else {
            p.sheet.errors += 1;
        }
        return close + 1;
    }

    /// Contents of a grouping rule (media/supports/layer). Inside a style rule
    /// (nesting) they may hold bare declarations that apply to the parent.
    fn parseBlockContents(p: *SheetParser, start: usize, end: usize, ctx: Context) Allocator.Error!void {
        if (ctx.parent_selector) |parent| {
            // nested @media { color: red; .x { } }: wrap as `& { ... }`
            const a = p.arena();
            const sel_toks = try tok.tokenizeAll(a, parent);
            const sels = selector.parseList(a, p.interner, sel_toks.items[0 .. sel_toks.items.len - 1]) catch {
                p.sheet.errors += 1;
                return;
            };
            var decls: std.ArrayList(Declaration) = .empty;
            const rule_index = p.sheet.rules.items.len;
            try p.sheet.rules.append(a, .{ .selectors = sels, .decls = &.{}, .media = ctx.media, .layer = ctx.layer, .order = p.nextOrder() });
            var i = start;
            while (i < end) {
                const t = p.toks[i];
                if (t.tag == .whitespace or t.tag == .semicolon) {
                    i += 1;
                    continue;
                }
                if (t.tag == .at_keyword) {
                    i = try p.parseAtRule(i, end, ctx);
                    continue;
                }
                var j = i;
                var depth: usize = 0;
                var is_rule = false;
                while (j < end) : (j += 1) {
                    switch (p.toks[j].tag) {
                        .function, .lparen, .lbracket => depth += 1,
                        .rparen, .rbracket => depth -|= 1,
                        .semicolon => if (depth == 0) break,
                        .lbrace => if (depth == 0) {
                            is_rule = true;
                            break;
                        },
                        else => {},
                    }
                }
                if (is_rule) {
                    const close = p.matchBlock(j, end);
                    try p.styleRule(i, j, j + 1, close, ctx);
                    i = close + 1;
                } else {
                    p.declaration(i, j, &decls);
                    i = j + 1;
                }
            }
            p.sheet.rules.items[rule_index].decls = decls.items;
            return;
        }
        try p.parseRuleList(start, end, ctx);
    }

    fn layerName(p: *SheetParser, ctx: Context, name: []const u8) ![]const u8 {
        if (ctx.layer == unlayered) return name;
        return std.fmt.allocPrint(p.arena(), "{s}.{s}", .{ p.sheet.layer_names.items[ctx.layer], name });
    }

    fn parseMedia(p: *SheetParser, start: usize, end: usize) !*const MediaQuery {
        const a = p.arena();
        var parts: [16][]const Token = undefined;
        const n = @min(values.Stream.splitCommas(p.toks[start..end], &parts), parts.len);
        var alts = try a.alloc([]const MediaFeature, n);
        var negs = try a.alloc(bool, n);
        for (parts[0..n], 0..) |part, k| {
            var feats: std.ArrayList(MediaFeature) = .empty;
            var neg = false;
            var i: usize = 0;
            while (i < part.len) : (i += 1) {
                const t = part[i];
                switch (t.tag) {
                    .ident => {
                        if (eq(t.text, "not")) neg = true else if (eq(t.text, "print") or eq(t.text, "speech")) try feats.append(a, .{ .kind = .never });
                        // screen, all, only, and: no-ops
                    },
                    .lparen => {
                        var e = i + 1;
                        var depth: usize = 1;
                        while (e < part.len) : (e += 1) {
                            if (part[e].tag == .lparen or part[e].tag == .function) depth += 1;
                            if (part[e].tag == .rparen) {
                                depth -= 1;
                                if (depth == 0) break;
                            }
                        }
                        try feats.append(a, parseMediaFeature(part[i + 1 .. e]));
                        i = e;
                    },
                    else => {},
                }
            }
            alts[k] = feats.items;
            negs[k] = neg;
        }
        const mq = try a.create(MediaQuery);
        mq.* = .{ .alternatives = alts, .negated = negs };
        return mq;
    }

    fn evalSupports(p: *SheetParser, start: usize, end: usize) bool {
        // Evaluates `(prop: value)`, `not (...)`, `and`/`or` chains by trying to parse.
        var s = values.Stream.init(p.toks[start..end]);
        return p.supportsExpr(&s);
    }

    fn supportsExpr(p: *SheetParser, s: *values.Stream) bool {
        var result = p.supportsTerm(s);
        while (true) {
            if (s.eatIdent("and")) {
                const r = p.supportsTerm(s);
                result = result and r;
            } else if (s.eatIdent("or")) {
                const r = p.supportsTerm(s);
                result = result or r;
            } else break;
        }
        return result;
    }

    fn supportsTerm(p: *SheetParser, s: *values.Stream) bool {
        if (s.eatIdent("not")) return !p.supportsTerm(s);
        const t = s.next();
        if (t.tag == .function) {
            _ = s.functionBody();
            // selector(...) / font-tech(...): optimistic
            return eq(t.text, "selector");
        }
        if (t.tag != .lparen) return false;
        const start = s.i;
        var depth: usize = 1;
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
        const inner = s.toks[start..s.i];
        s.i += 1;
        // nested condition?
        var is = values.Stream.init(inner);
        const first = is.peek();
        if (first.tag == .lparen or (first.tag == .ident and eq(first.text, "not"))) return p.supportsExpr(&is);
        // declaration
        var k: usize = 0;
        while (k < inner.len and inner[k].tag != .colon) k += 1;
        if (k >= inner.len) return false;
        var name_s = values.Stream.init(inner[0..k]);
        const name = name_s.next();
        if (name.tag != .ident) return false;
        var tmp: std.ArrayList(Declaration) = .empty;
        var scratch = std.heap.ArenaAllocator.init(p.sheet.arena_state.child_allocator);
        defer scratch.deinit();
        props.parseDeclaration(scratch.allocator(), name.text, inner[k + 1 ..], "", false, &tmp) catch return false;
        return true;
    }

    fn parseKeyframes(p: *SheetParser, pre_start: usize, pre_end: usize, start: usize, end: usize) !void {
        const a = p.arena();
        var s = values.Stream.init(p.toks[pre_start..pre_end]);
        const nt = s.next();
        if (nt.tag != .ident and nt.tag != .string) return;
        var frames: std.ArrayList(Keyframe) = .empty;
        var i = start;
        while (i < end) {
            if (p.toks[i].tag == .whitespace) {
                i += 1;
                continue;
            }
            var j = i;
            while (j < end and p.toks[j].tag != .lbrace) : (j += 1) {}
            if (j >= end) break;
            const close = p.matchBlock(j, end);
            var decls: std.ArrayList(Declaration) = .empty;
            var timing: ?props.Timing = null;
            var k = j + 1;
            while (k < close) {
                var e = k;
                var depth: usize = 0;
                while (e < close) : (e += 1) {
                    switch (p.toks[e].tag) {
                        .function, .lparen => depth += 1,
                        .rparen => depth -|= 1,
                        .semicolon => if (depth == 0) break,
                        else => {},
                    }
                }
                // animation-timing-function inside a keyframe applies to that segment
                var ns = values.Stream.init(p.toks[k..e]);
                const first = ns.peek();
                if (first.tag == .ident and eq(first.text, "animation-timing-function")) {
                    _ = ns.next();
                    _ = ns.next(); // colon
                    timing = props.parseTiming(&ns);
                } else p.declaration(k, e, &decls);
                k = e + 1;
            }
            // selectors: from, to, percentages (comma list)
            var sel = values.Stream.init(p.toks[i..j]);
            while (!sel.atEnd()) {
                const t = sel.next();
                const off: ?f32 = switch (t.tag) {
                    .percentage => t.num / 100,
                    .ident => if (eq(t.text, "from")) 0 else if (eq(t.text, "to")) 1 else null,
                    else => null,
                };
                if (off) |o| try frames.append(a, .{ .offset = o, .decls = decls.items, .timing = timing });
                _ = sel.eatComma();
            }
            i = close + 1;
        }
        std.mem.sort(Keyframe, frames.items, {}, struct {
            fn lt(_: void, x: Keyframe, y: Keyframe) bool {
                return x.offset < y.offset;
            }
        }.lt);
        try p.sheet.keyframes.append(a, .{ .name = try a.dupe(u8, nt.text), .frames = frames.items });
    }

    fn parseFontFace(p: *SheetParser, start: usize, end: usize) !void {
        const a = p.arena();
        var ff: FontFace = .{ .family = "", .src = "" };
        var i = start;
        while (i < end) {
            var e = i;
            var depth: usize = 0;
            while (e < end) : (e += 1) {
                switch (p.toks[e].tag) {
                    .function, .lparen => depth += 1,
                    .rparen => depth -|= 1,
                    .semicolon => if (depth == 0) break,
                    else => {},
                }
            }
            var s = values.Stream.init(p.toks[i..e]);
            const name = s.next();
            if (name.tag == .ident and s.next().tag == .colon) {
                if (eq(name.text, "font-family")) {
                    const v = s.next();
                    if (v.tag == .string or v.tag == .ident) ff.family = try a.dupe(u8, v.text);
                } else if (eq(name.text, "src")) {
                    while (!s.atEnd()) {
                        const v = s.next();
                        if (v.tag == .url and ff.src.len == 0) ff.src = try a.dupe(u8, v.text);
                        if (v.tag == .function) {
                            const body = s.functionBody();
                            if (eq(v.text, "url") and ff.src.len == 0) {
                                for (body) |bt| if (bt.tag == .string) {
                                    ff.src = try a.dupe(u8, bt.text);
                                    break;
                                };
                            }
                        }
                    }
                } else if (eq(name.text, "font-weight")) {
                    if (values.parseNumber(&s)) |w| {
                        ff.weight_min = w;
                        ff.weight_max = values.parseNumber(&s) orelse w;
                    } else if (s.eatIdent("bold")) {
                        ff.weight_min = 700;
                        ff.weight_max = 700;
                    }
                } else if (eq(name.text, "font-style")) {
                    ff.italic = s.eatIdent("italic") or s.eatIdent("oblique");
                }
            }
            i = e + 1;
        }
        if (ff.family.len > 0 and ff.src.len > 0) try p.sheet.font_faces.append(a, ff);
    }

    fn parseProperty(p: *SheetParser, pre_start: usize, pre_end: usize, start: usize, end: usize) !void {
        const a = p.arena();
        var s = values.Stream.init(p.toks[pre_start..pre_end]);
        const nt = s.next();
        if (nt.tag != .ident) return;
        var reg: PropertyRegistration = .{ .name = try a.dupe(u8, nt.text), .initial = null, .inherits = true };
        var i = start;
        while (i < end) {
            var e = i;
            while (e < end and p.toks[e].tag != .semicolon) : (e += 1) {}
            var ds = values.Stream.init(p.toks[i..e]);
            const name = ds.next();
            if (name.tag == .ident and ds.peek().tag == .colon) {
                _ = ds.next();
                ds.skipWs();
                if (eq(name.text, "inherits")) {
                    reg.inherits = ds.eatIdent("true");
                } else if (eq(name.text, "initial-value")) {
                    reg.initial = try a.dupe(u8, std.mem.trim(u8, p.srcOf(i + ds.i, e), " \t\r\n"));
                }
            }
            i = e + 1;
        }
        try p.sheet.properties.append(a, reg);
    }
};

fn parseMediaFeature(inner: []const Token) MediaFeature {
    var s = values.Stream.init(inner);
    const name = s.next();
    if (name.tag == .ident) {
        if (s.eatDelim('>') or s.eatDelim('<')) {
            // range syntax: (width >= 40rem) / (width < 600px)
            const op_tok = inner[indexOfDelim(inner)];
            const or_eq = s.eatDelim('=');
            const len = values.parseLength(&s, false) orelse return .{ .kind = .any };
            const v = len.px + len.em * 16 + len.rem * 16;
            const ge = op_tok.delim == '>';
            const fname = name.text;
            const eps: f32 = if (or_eq) 0 else 0.02;
            if (eq(fname, "width")) return if (ge) .{ .kind = .min_width, .value = v + eps } else .{ .kind = .max_width, .value = v - eps };
            if (eq(fname, "height")) return if (ge) .{ .kind = .min_height, .value = v + eps } else .{ .kind = .max_height, .value = v - eps };
            return .{ .kind = .any };
        }
        if (s.next().tag != .colon) {
            if (eq(name.text, "hover")) return .{ .kind = .hover };
            return .{ .kind = .any };
        }
        if (eq(name.text, "prefers-color-scheme")) {
            return if (s.eatIdent("dark")) .{ .kind = .dark } else .{ .kind = .light };
        }
        if (eq(name.text, "prefers-reduced-motion")) {
            return if (s.eatIdent("reduce")) .{ .kind = .reduced_motion } else .{ .kind = .no_reduced_motion };
        }
        if (eq(name.text, "orientation")) {
            return if (s.eatIdent("portrait")) .{ .kind = .portrait } else .{ .kind = .landscape };
        }
        if (eq(name.text, "hover") or eq(name.text, "any-hover")) {
            return if (s.eatIdent("none")) .{ .kind = .never } else .{ .kind = .hover };
        }
        if (eq(name.text, "pointer") or eq(name.text, "any-pointer")) {
            return if (s.eatIdent("fine")) .{ .kind = .any } else .{ .kind = .never };
        }
        if (eq(name.text, "min-resolution") or eq(name.text, "max-resolution") or eq(name.text, "-webkit-min-device-pixel-ratio")) {
            const t = s.next();
            var v: f32 = t.num;
            if (t.tag == .dimension and eq(t.text, "dpi")) v = t.num / 96;
            return .{ .kind = if (std.mem.startsWith(u8, name.text, "max")) .max_resolution else .min_resolution, .value = v };
        }
        const len = values.parseLength(&s, false) orelse return .{ .kind = .any };
        const v = len.px + len.em * 16 + len.rem * 16;
        if (eq(name.text, "min-width")) return .{ .kind = .min_width, .value = v };
        if (eq(name.text, "max-width")) return .{ .kind = .max_width, .value = v };
        if (eq(name.text, "min-height")) return .{ .kind = .min_height, .value = v };
        if (eq(name.text, "max-height")) return .{ .kind = .max_height, .value = v };
    }
    return .{ .kind = .any };
}

fn indexOfDelim(inner: []const Token) usize {
    for (inner, 0..) |t, i| if (t.tag == .delim and (t.delim == '>' or t.delim == '<')) return i;
    return 0;
}

/// Resolve a nested selector against its parent per CSS Nesting:
/// `&` is replaced by the parent (wrapped in :is() for lists); otherwise the
/// nested selector is a descendant of the parent.
fn resolveNesting(a: Allocator, parent: []const u8, nested: []const u8) ![]const u8 {
    const parent_is_list = std.mem.indexOfScalar(u8, parent, ',') != null;
    const replacement = if (parent_is_list) try std.fmt.allocPrint(a, ":is({s})", .{parent}) else parent;
    var out: std.ArrayList(u8) = .empty;
    // split nested by top-level commas
    var depth: usize = 0;
    var start: usize = 0;
    var i: usize = 0;
    while (i <= nested.len) : (i += 1) {
        const at_end = i == nested.len;
        if (!at_end) {
            switch (nested[i]) {
                '(', '[' => depth += 1,
                ')', ']' => depth -|= 1,
                else => {},
            }
        }
        if (at_end or (nested[i] == ',' and depth == 0)) {
            const part = std.mem.trim(u8, nested[start..i], " \t\r\n");
            if (out.items.len > 0) try out.appendSlice(a, ", ");
            if (std.mem.indexOfScalar(u8, part, '&') != null) {
                for (part) |c| {
                    if (c == '&') try out.appendSlice(a, replacement) else try out.append(a, c);
                }
            } else {
                try out.appendSlice(a, replacement);
                try out.append(a, ' ');
                try out.appendSlice(a, part);
            }
            start = i + 1;
        }
    }
    return out.items;
}

/// Parse an inline `style="..."` attribute.
pub fn parseInline(arena: Allocator, src: []const u8, out: *std.ArrayList(Declaration)) Allocator.Error!void {
    var toks = try tok.tokenizeAll(arena, src);
    _ = &toks;
    const t = toks.items;
    var i: usize = 0;
    while (i < t.len and t[i].tag != .eof) {
        var j = i;
        var depth: usize = 0;
        while (j < t.len and t[j].tag != .eof) : (j += 1) {
            switch (t[j].tag) {
                .function, .lparen => depth += 1,
                .rparen => depth -|= 1,
                .semicolon => if (depth == 0) break,
                else => {},
            }
        }
        inlineDecl(arena, src, t, i, j, out) catch |e| switch (e) {
            error.OutOfMemory => return error.OutOfMemory,
            else => {},
        };
        i = j + 1;
    }
}

fn inlineDecl(arena: Allocator, src: []const u8, t: []const Token, start: usize, end: usize, out: *std.ArrayList(Declaration)) !void {
    var i = start;
    while (i < end and t[i].tag == .whitespace) i += 1;
    if (i >= end or t[i].tag != .ident) return error.Invalid;
    const name = t[i].text;
    i += 1;
    while (i < end and t[i].tag == .whitespace) i += 1;
    if (i >= end or t[i].tag != .colon) return error.Invalid;
    i += 1;
    var vend = end;
    var important = false;
    var k = vend;
    while (k > i and t[k - 1].tag == .whitespace) k -= 1;
    if (k >= i + 2 and t[k - 1].tag == .ident and eq(t[k - 1].text, "important") and t[k - 2].tag == .delim and t[k - 2].delim == '!') {
        important = true;
        vend = k - 2;
    }
    const vs = t[i].start;
    const ve = t[vend].start;
    try props.parseDeclaration(arena, name, t[i..vend], src[vs..ve], important, out);
}

fn eq(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}

test "stylesheet parse" {
    var interner = Interner.init(std.testing.allocator);
    defer interner.deinit();
    const src =
        \\@layer theme, base;
        \\:root { --brand: #3b82f6; }
        \\.btn { padding: 4px 8px; color: var(--brand);
        \\  &:hover { color: red }
        \\  .icon { width: 12px }
        \\  @media (prefers-color-scheme: dark) { color: white }
        \\}
        \\@media (min-width: 600px) and (max-width: 900px) { .a { display: none } }
        \\@media (width >= 40rem) { .sm\:flex { display: flex } }
        \\@supports (display: grid) { .g { display: grid } }
        \\@supports (display: banana) { .h { display: none } }
        \\@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        \\@layer base { h1 { font-size: 2em } }
        \\@property --tw-shadow { syntax: "*"; inherits: false; initial-value: 0 0 #0000; }
        \\.broken { color: ; width: 10px }
    ;
    const sheet = try parse(std.testing.allocator, &interner, src);
    defer {
        sheet.deinit();
        std.testing.allocator.destroy(sheet);
    }
    // :root, .btn, &:hover, .btn .icon, (nested media rule), .a, .sm:flex, .g, h1, .broken
    try std.testing.expectEqual(@as(usize, 10), sheet.rules.items.len);
    try std.testing.expectEqual(@as(usize, 1), sheet.keyframes.items.len);
    try std.testing.expectEqual(@as(usize, 2), sheet.keyframes.items[0].frames.len);
    const btn = sheet.rules.items[1];
    try std.testing.expectEqual(@as(usize, 5), btn.decls.len);
    const hover = sheet.rules.items[2];
    try std.testing.expectEqual(@as(usize, 1), hover.selectors[0].compounds.len);
    try std.testing.expectEqual(@as(usize, 1), hover.selectors[0].compounds[0].pseudos.len);
    const icon = sheet.rules.items[3];
    try std.testing.expectEqual(@as(usize, 2), icon.selectors[0].compounds.len);
    const nested_media = sheet.rules.items[4];
    try std.testing.expectEqual(@as(usize, 1), nested_media.media.len);
    try std.testing.expect(nested_media.media[0].matches(.{ .dark = true }));
    try std.testing.expect(!nested_media.media[0].matches(.{ .dark = false }));
    const a_rule = sheet.rules.items[5];
    try std.testing.expect(a_rule.media[0].matches(.{ .width = 700 }));
    try std.testing.expect(!a_rule.media[0].matches(.{ .width = 1000 }));
    const sm = sheet.rules.items[6];
    try std.testing.expect(sm.media[0].matches(.{ .width = 640 }));
    try std.testing.expect(!sm.media[0].matches(.{ .width = 639 }));
    try std.testing.expectEqual(@as(u16, 1), sheet.rules.items[8].layer);
    try std.testing.expectEqual(@as(usize, 1), sheet.properties.items.len);
    try std.testing.expectEqualStrings("0 0 #0000", sheet.properties.items[0].initial.?);
    try std.testing.expectEqual(@as(usize, 1), sheet.rules.items[9].decls.len);
    try std.testing.expect(sheet.errors >= 1);
}
