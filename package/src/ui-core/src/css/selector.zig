//! Selector data model and parser (Selectors Level 4 subset).
const std = @import("std");
const tok = @import("tokenizer.zig");
const atom_mod = @import("../atom.zig");
const values = @import("values.zig");

const Atom = atom_mod.Atom;
const Interner = atom_mod.Interner;
const Token = tok.Token;
const Allocator = std.mem.Allocator;

pub const Combinator = enum(u8) { descendant, child, next_sibling, subsequent_sibling };

pub const PseudoElement = enum(u8) { none, before, after, placeholder, selection, marker, scrollbar, scrollbar_thumb, scrollbar_track };

pub const AttrOp = enum(u8) { exists, eq, includes, dash, prefix, suffix, substring };

pub const AttrSel = struct {
    name: Atom,
    op: AttrOp = .exists,
    value: []const u8 = "",
    case_insensitive: bool = false,
};

pub const Nth = struct {
    a: i32,
    b: i32,
    pub fn matches(n: Nth, index1: i32) bool {
        if (n.a == 0) return index1 == n.b;
        const diff = index1 - n.b;
        if (@rem(diff, n.a) != 0) return false;
        return @divTrunc(diff, n.a) >= 0;
    }
};

pub const Pseudo = union(enum) {
    hover,
    active,
    focus,
    focus_visible,
    focus_within,
    disabled,
    enabled,
    checked,
    indeterminate,
    required,
    optional,
    read_only,
    read_write,
    placeholder_shown,
    first_child,
    last_child,
    only_child,
    first_of_type,
    last_of_type,
    only_of_type,
    nth_child: Nth,
    nth_last_child: Nth,
    nth_of_type: Nth,
    nth_last_of_type: Nth,
    empty,
    root,
    scope,
    link,
    visited,
    target,
    open,
    not: []const Selector,
    is: []const Selector, // also :where (with zero specificity) and :matches
    where: []const Selector,
    has: []const Selector,
    dark, // matches when prefers-color-scheme is dark (non-standard helper; see @media)
    /// pseudo-classes that never match in this engine (:host outside shadow
    /// trees, :autofill, validity states, ...)
    never,
    /// pseudo-classes that always match (:defined)
    always,
};

pub const Compound = struct {
    tag: Atom = atom_mod.none, // none = universal
    id: Atom = atom_mod.none,
    classes: []const Atom = &.{},
    attrs: []const AttrSel = &.{},
    pseudos: []const Pseudo = &.{},
    pseudo_element: PseudoElement = .none,
    /// `&` in nested rules: matches the parent rule's selector
    nesting: bool = false,
};

pub const Selector = struct {
    /// left-to-right compounds; combinators[i] joins compounds[i] and compounds[i+1]
    compounds: []const Compound,
    combinators: []const Combinator,
    specificity: u32,

    pub fn subject(s: Selector) *const Compound {
        return &s.compounds[s.compounds.len - 1];
    }
};

pub const ParseError = error{ OutOfMemory, Invalid };

pub fn parseList(arena: Allocator, interner: *Interner, toks: []const Token) ParseError![]const Selector {
    var parts: [256][]const Token = undefined;
    const n = values.Stream.splitCommas(toks, &parts);
    if (n > parts.len) return error.Invalid;
    var list: std.ArrayList(Selector) = .empty;
    for (parts[0..n]) |p| {
        try list.append(arena, try parseOne(arena, interner, p));
    }
    return list.items;
}

/// Forgiving variant for :is()/:where(): invalid entries are dropped.
fn parseForgiving(arena: Allocator, interner: *Interner, toks: []const Token) ParseError![]const Selector {
    var parts: [64][]const Token = undefined;
    const n = values.Stream.splitCommas(toks, &parts);
    var list: std.ArrayList(Selector) = .empty;
    for (parts[0..@min(n, parts.len)]) |p| {
        const sel = parseOne(arena, interner, p) catch |e| switch (e) {
            error.OutOfMemory => return error.OutOfMemory,
            error.Invalid => continue,
        };
        try list.append(arena, sel);
    }
    return list.items;
}

pub fn parseOne(arena: Allocator, interner: *Interner, toks_in: []const Token) ParseError!Selector {
    var toks = toks_in;
    // trim whitespace
    while (toks.len > 0 and toks[0].tag == .whitespace) toks = toks[1..];
    while (toks.len > 0 and toks[toks.len - 1].tag == .whitespace) toks = toks[0 .. toks.len - 1];
    if (toks.len == 0) return error.Invalid;

    var compounds: std.ArrayList(Compound) = .empty;
    var combinators: std.ArrayList(Combinator) = .empty;
    var i: usize = 0;
    var pending_comb: ?Combinator = null;
    // relative selector (nested `> .a` or :has(> .a)) starts with a combinator
    if (combinatorOf(toks[0])) |c| {
        try compounds.append(arena, .{ .nesting = true });
        pending_comb = c;
        i = 1;
    }
    while (i < toks.len) {
        const t = toks[i];
        if (t.tag == .whitespace) {
            i += 1;
            if (pending_comb == null) pending_comb = .descendant;
            continue;
        }
        if (combinatorOf(t)) |c| {
            pending_comb = c;
            i += 1;
            continue;
        }
        if (compounds.items.len > 0) {
            try combinators.append(arena, pending_comb orelse return error.Invalid);
        }
        pending_comb = null;
        const c = try parseCompound(arena, interner, toks, &i);
        try compounds.append(arena, c);
    }
    if (pending_comb != null and pending_comb.? != .descendant) return error.Invalid;
    if (compounds.items.len == 0) return error.Invalid;
    var spec: u32 = 0;
    for (compounds.items) |c| spec += compoundSpecificity(c);
    return .{ .compounds = compounds.items, .combinators = combinators.items, .specificity = spec };
}

fn combinatorOf(t: Token) ?Combinator {
    if (t.tag != .delim) return null;
    return switch (t.delim) {
        '>' => .child,
        '+' => .next_sibling,
        '~' => .subsequent_sibling,
        else => null,
    };
}

pub fn compoundSpecificity(c: Compound) u32 {
    var a: u32 = 0;
    var b: u32 = 0;
    var cc: u32 = 0;
    if (c.id != atom_mod.none) a += 1;
    b += @intCast(c.classes.len + c.attrs.len);
    if (c.tag != atom_mod.none) cc += 1;
    if (c.pseudo_element != .none) cc += 1;
    for (c.pseudos) |p| switch (p) {
        .where => {},
        .not, .is, .has => |list| {
            var max: u32 = 0;
            for (list) |s| max = @max(max, s.specificity);
            a += max >> 16;
            b += (max >> 8) & 0xff;
            cc += max & 0xff;
        },
        else => b += 1,
    };
    return (@as(u32, @min(a, 255)) << 16) | (@as(u32, @min(b, 255)) << 8) | @as(u32, @min(cc, 255));
}

fn parseCompound(arena: Allocator, interner: *Interner, toks: []const Token, ip: *usize) ParseError!Compound {
    var c: Compound = .{};
    var classes: std.ArrayList(Atom) = .empty;
    var attrs: std.ArrayList(AttrSel) = .empty;
    var pseudos: std.ArrayList(Pseudo) = .empty;
    var i = ip.*;
    var first = true;
    while (i < toks.len) {
        const t = toks[i];
        switch (t.tag) {
            .ident => {
                if (!first) break;
                c.tag = try interner.internLower(t.text);
                i += 1;
            },
            .delim => switch (t.delim) {
                '*' => {
                    if (!first) break;
                    i += 1;
                },
                '&' => {
                    c.nesting = true;
                    i += 1;
                },
                '.' => {
                    if (i + 1 >= toks.len or toks[i + 1].tag != .ident) return error.Invalid;
                    try classes.append(arena, try interner.intern(try unescapeIdent(arena, toks[i + 1].text)));
                    i += 2;
                },
                else => break,
            },
            .hash => {
                c.id = try interner.intern(t.text);
                i += 1;
            },
            .lbracket => {
                i += 1;
                const a = try parseAttr(arena, interner, toks, &i);
                try attrs.append(arena, a);
            },
            .colon => {
                i += 1;
                if (i < toks.len and toks[i].tag == .colon) {
                    i += 1;
                    if (i >= toks.len or toks[i].tag != .ident) return error.Invalid;
                    c.pseudo_element = pseudoElementOf(toks[i].text) orelse return error.Invalid;
                    i += 1;
                    continue;
                }
                if (i >= toks.len) return error.Invalid;
                const pt = toks[i];
                if (pt.tag == .ident) {
                    i += 1;
                    if (pseudoElementOf(pt.text)) |pe| {
                        if (pe == .before or pe == .after) {
                            c.pseudo_element = pe;
                            continue;
                        }
                    }
                    try pseudos.append(arena, simplePseudo(pt.text) orelse return error.Invalid);
                } else if (pt.tag == .function) {
                    i += 1;
                    const start = i;
                    var depth: usize = 1;
                    while (i < toks.len) : (i += 1) {
                        switch (toks[i].tag) {
                            .function, .lparen => depth += 1,
                            .rparen => {
                                depth -= 1;
                                if (depth == 0) break;
                            },
                            else => {},
                        }
                    }
                    const body = toks[start..i];
                    i += 1;
                    try pseudos.append(arena, try functionalPseudo(arena, interner, pt.text, body));
                } else return error.Invalid;
            },
            else => break,
        }
        first = false;
    }
    if (i == ip.*) return error.Invalid;
    ip.* = i;
    c.classes = classes.items;
    c.attrs = attrs.items;
    c.pseudos = pseudos.items;
    return c;
}

fn unescapeIdent(arena: Allocator, s: []const u8) ![]const u8 {
    // Tailwind-style class names: .hover\:bg-blue-500, .w-1\/2
    if (std.mem.indexOfScalar(u8, s, '\\') == null) return s;
    var out = try arena.alloc(u8, s.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] == '\\' and i + 1 < s.len) {
            i += 1;
        }
        out[n] = s[i];
        n += 1;
    }
    return out[0..n];
}

fn parseAttr(arena: Allocator, interner: *Interner, toks: []const Token, ip: *usize) ParseError!AttrSel {
    var i = ip.*;
    while (i < toks.len and toks[i].tag == .whitespace) i += 1;
    if (i >= toks.len or toks[i].tag != .ident) return error.Invalid;
    var a: AttrSel = .{ .name = try interner.internLower(toks[i].text) };
    i += 1;
    while (i < toks.len and toks[i].tag == .whitespace) i += 1;
    if (i < toks.len and toks[i].tag == .delim) {
        const d = toks[i].delim;
        a.op = switch (d) {
            '=' => .eq,
            '~' => .includes,
            '|' => .dash,
            '^' => .prefix,
            '$' => .suffix,
            '*' => .substring,
            else => return error.Invalid,
        };
        i += 1;
        if (a.op != .eq) {
            if (i >= toks.len or toks[i].tag != .delim or toks[i].delim != '=') return error.Invalid;
            i += 1;
        }
        while (i < toks.len and toks[i].tag == .whitespace) i += 1;
        if (i >= toks.len or (toks[i].tag != .ident and toks[i].tag != .string and toks[i].tag != .number)) return error.Invalid;
        a.value = if (toks[i].tag == .number) try std.fmt.allocPrint(arena, "{d}", .{toks[i].num}) else try arena.dupe(u8, toks[i].text);
        i += 1;
        while (i < toks.len and toks[i].tag == .whitespace) i += 1;
        if (i < toks.len and toks[i].tag == .ident and std.ascii.eqlIgnoreCase(toks[i].text, "i")) {
            a.case_insensitive = true;
            i += 1;
        }
    }
    while (i < toks.len and toks[i].tag == .whitespace) i += 1;
    if (i >= toks.len or toks[i].tag != .rbracket) return error.Invalid;
    ip.* = i + 1;
    return a;
}

fn pseudoElementOf(name: []const u8) ?PseudoElement {
    const map = std.StaticStringMap(PseudoElement).initComptime(.{
        .{ "before", .before },
        .{ "after", .after },
        .{ "placeholder", .placeholder },
        .{ "selection", .selection },
        .{ "marker", .marker },
        .{ "-webkit-scrollbar", .scrollbar },
        .{ "-webkit-scrollbar-thumb", .scrollbar_thumb },
        .{ "-webkit-scrollbar-track", .scrollbar_track },
        .{ "-webkit-input-placeholder", .placeholder },
    });
    var buf: [32]u8 = undefined;
    if (name.len > buf.len) return null;
    return map.get(std.ascii.lowerString(&buf, name));
}

fn simplePseudo(name: []const u8) ?Pseudo {
    const map = std.StaticStringMap(Pseudo).initComptime(.{
        .{ "hover", .hover },
        .{ "active", .active },
        .{ "focus", .focus },
        .{ "focus-visible", .focus_visible },
        .{ "focus-within", .focus_within },
        .{ "disabled", .disabled },
        .{ "enabled", .enabled },
        .{ "checked", .checked },
        .{ "indeterminate", .indeterminate },
        .{ "required", .required },
        .{ "optional", .optional },
        .{ "read-only", .read_only },
        .{ "read-write", .read_write },
        .{ "placeholder-shown", .placeholder_shown },
        .{ "first-child", .first_child },
        .{ "last-child", .last_child },
        .{ "only-child", .only_child },
        .{ "first-of-type", .first_of_type },
        .{ "last-of-type", .last_of_type },
        .{ "only-of-type", .only_of_type },
        .{ "empty", .empty },
        .{ "root", .root },
        .{ "scope", .scope },
        .{ "link", .link },
        .{ "any-link", .link },
        .{ "visited", .visited },
        .{ "target", .target },
        .{ "open", .open },
        .{ "host", .never },
        .{ "autofill", .never },
        .{ "-webkit-autofill", .never },
        .{ "modal", .never },
        .{ "popover-open", .never },
        .{ "fullscreen", .never },
        .{ "invalid", .never },
        .{ "user-invalid", .never },
        .{ "in-range", .always },
        .{ "out-of-range", .never },
        .{ "valid", .always },
        .{ "user-valid", .always },
        .{ "defined", .always },
        .{ "playing", .never },
        .{ "paused", .never },
    });
    var buf: [32]u8 = undefined;
    if (name.len > buf.len) return null;
    return map.get(std.ascii.lowerString(&buf, name));
}

fn functionalPseudo(arena: Allocator, interner: *Interner, name: []const u8, body: []const Token) ParseError!Pseudo {
    if (eq(name, "not")) return .{ .not = try parseList(arena, interner, body) };
    if (eq(name, "is") or eq(name, "matches") or eq(name, "-webkit-any")) return .{ .is = try parseForgiving(arena, interner, body) };
    if (eq(name, "where")) return .{ .where = try parseForgiving(arena, interner, body) };
    if (eq(name, "has")) return .{ .has = try parseList(arena, interner, body) };
    if (eq(name, "host") or eq(name, "host-context") or eq(name, "state") or eq(name, "lang") or eq(name, "dir")) return .never;
    if (eq(name, "nth-child")) return .{ .nth_child = try parseNth(body) };
    if (eq(name, "nth-last-child")) return .{ .nth_last_child = try parseNth(body) };
    if (eq(name, "nth-of-type")) return .{ .nth_of_type = try parseNth(body) };
    if (eq(name, "nth-last-of-type")) return .{ .nth_last_of_type = try parseNth(body) };
    return error.Invalid;
}

fn eq(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}

/// an+b microsyntax. Re-serializes the tokens and parses the string, since the
/// tokenizer splits "2n+1" as dimension(2,"n") + number(+1) and "-n" as ident.
fn parseNth(body: []const Token) ParseError!Nth {
    var buf: [64]u8 = undefined;
    var n: usize = 0;
    for (body) |t| {
        const piece: []const u8 = switch (t.tag) {
            .whitespace => continue,
            .ident => t.text,
            .number, .dimension => blk: {
                const num = std.fmt.bufPrint(buf[n..], "{s}{d}", .{ if (t.num >= 0 and t.tag == .number and n > 0) "+" else "", @as(i32, @intFromFloat(t.num)) }) catch return error.Invalid;
                n += num.len;
                break :blk if (t.tag == .dimension) t.text else "";
            },
            .delim => if (t.delim == '+' or t.delim == '-') @as([]const u8, if (t.delim == '+') "+" else "-") else return error.Invalid,
            else => return error.Invalid,
        };
        if (n + piece.len > buf.len) return error.Invalid;
        @memcpy(buf[n .. n + piece.len], piece);
        n += piece.len;
    }
    const s = std.ascii.lowerString(buf[0..n], buf[0..n]);
    if (std.mem.eql(u8, s, "odd")) return .{ .a = 2, .b = 1 };
    if (std.mem.eql(u8, s, "even")) return .{ .a = 2, .b = 0 };
    if (std.mem.indexOfScalar(u8, s, 'n')) |ni| {
        const a_str = s[0..ni];
        const a: i32 = if (a_str.len == 0 or std.mem.eql(u8, a_str, "+")) 1 else if (std.mem.eql(u8, a_str, "-")) -1 else std.fmt.parseInt(i32, a_str, 10) catch return error.Invalid;
        const rest = std.mem.trim(u8, s[ni + 1 ..], " ");
        var b: i32 = 0;
        if (rest.len > 0) {
            const r = if (rest[0] == '+') rest[1..] else rest;
            // "-n-1": rest is "-1"
            b = std.fmt.parseInt(i32, r, 10) catch return error.Invalid;
        }
        return .{ .a = a, .b = b };
    }
    const b = std.fmt.parseInt(i32, if (s.len > 0 and s[0] == '+') s[1..] else s, 10) catch return error.Invalid;
    return .{ .a = 0, .b = b };
}

test "selector parsing and specificity" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var interner = Interner.init(std.testing.allocator);
    defer interner.deinit();

    const toks = try tok.tokenizeAll(arena, "div.card > a#home:hover, .list li:nth-child(2n+1), .hover\\:bg-red:hover, input[type=\"checkbox\"]:checked + label");
    const list = try parseList(arena, &interner, toks.items[0 .. toks.items.len - 1]);
    try std.testing.expectEqual(@as(usize, 4), list.len);
    try std.testing.expectEqual(@as(usize, 2), list[0].compounds.len);
    try std.testing.expectEqual(Combinator.child, list[0].combinators[0]);
    try std.testing.expectEqual(@as(u32, (1 << 16) | (2 << 8) | 2), list[0].specificity);
    const nth = list[1].compounds[1].pseudos[0].nth_child;
    try std.testing.expectEqual(@as(i32, 2), nth.a);
    try std.testing.expectEqual(@as(i32, 1), nth.b);
    try std.testing.expectEqualStrings("hover:bg-red", interner.str(list[2].compounds[0].classes[0]));
    try std.testing.expectEqual(Combinator.next_sibling, list[3].combinators[0]);
    try std.testing.expectEqualStrings("checkbox", list[3].compounds[0].attrs[0].value);
}

test "nth" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const cases = .{ .{ "odd", 2, 1 }, .{ "even", 2, 0 }, .{ "3", 0, 3 }, .{ "-n+3", -1, 3 }, .{ "n", 1, 0 }, .{ "2n-1", 2, -1 } };
    inline for (cases) |c| {
        const toks = try tok.tokenizeAll(arena, c[0]);
        const n = try parseNth(toks.items[0 .. toks.items.len - 1]);
        try std.testing.expectEqual(@as(i32, c[1]), n.a);
        try std.testing.expectEqual(@as(i32, c[2]), n.b);
    }
    const n = Nth{ .a = -1, .b = 3 };
    try std.testing.expect(n.matches(1) and n.matches(3) and !n.matches(4));
}
