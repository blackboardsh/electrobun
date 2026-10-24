//! Declarative templates: HTML with `{expression}` bindings compiled into DOM
//! nodes plus fine-grained effects on the reactive graph. Any host language
//! drives a template by defining named values and handlers in a scope.
//!
//!   <div class="todo" class:done={item.done}>
//!     <input type="checkbox" bind:checked={item.done}>
//!     <span>{item.title}</span>
//!     <button onclick={remove}>×</button>
//!   </div>
//!
//! Supported: text/attribute interpolation, `class:name={expr}`,
//! `style:prop={expr}`, `on<event>={handler}` or inline statements
//! (`{count++}`, `{open = !open}`), `bind:value`, `bind:checked`,
//! `if={expr}` / `else`, keyed `each={list} as="item" index="i" key={item.id}`,
//! and registered components with props and `<slot/>`.
const std = @import("std");
const dom = @import("dom.zig");
const html = @import("html.zig");
const reactive = @import("reactive.zig");
const events = @import("events.zig");
const ui_mod = @import("ui.zig");

const Allocator = std.mem.Allocator;
const Runtime = reactive.Runtime;
const Value = reactive.Value;
const ScopeId = reactive.ScopeId;
const NodeId = dom.NodeId;

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

pub const Op = enum { add, sub, mul, div, mod, eq, ne, lt, gt, le, ge, @"and", @"or" };

pub const Expr = union(enum) {
    literal: Value,
    path: []const []const u8,
    not: *const Expr,
    neg: *const Expr,
    binary: struct { op: Op, l: *const Expr, r: *const Expr },
    ternary: struct { c: *const Expr, t: *const Expr, f: *const Expr },
    /// statements (handlers): `a = e`, `a += e`, `a++`, sequence with `;`
    assign: struct { target: []const []const u8, op: ?Op, value: *const Expr },
    seq: []const *const Expr,
    /// call of a scope handler by name: `remove(item)` or bare `remove`
    call: struct { name: []const []const u8, args: []const *const Expr },
};

const Tok = struct {
    kind: enum { ident, number, string, op, eof },
    text: []const u8,
};

const ExprParser = struct {
    a: Allocator,
    src: []const u8,
    pos: usize = 0,
    peeked: ?Tok = null,

    fn next(p: *ExprParser) Tok {
        if (p.peeked) |t| {
            p.peeked = null;
            return t;
        }
        while (p.pos < p.src.len and std.ascii.isWhitespace(p.src[p.pos])) p.pos += 1;
        if (p.pos >= p.src.len) return .{ .kind = .eof, .text = "" };
        const c = p.src[p.pos];
        const start = p.pos;
        if (std.ascii.isAlphabetic(c) or c == '_' or c == '$') {
            while (p.pos < p.src.len and (std.ascii.isAlphanumeric(p.src[p.pos]) or p.src[p.pos] == '_' or p.src[p.pos] == '$')) p.pos += 1;
            return .{ .kind = .ident, .text = p.src[start..p.pos] };
        }
        if (std.ascii.isDigit(c) or (c == '.' and p.pos + 1 < p.src.len and std.ascii.isDigit(p.src[p.pos + 1]))) {
            while (p.pos < p.src.len and (std.ascii.isDigit(p.src[p.pos]) or p.src[p.pos] == '.')) p.pos += 1;
            return .{ .kind = .number, .text = p.src[start..p.pos] };
        }
        if (c == '\'' or c == '"' or c == '`') {
            p.pos += 1;
            const s = p.pos;
            while (p.pos < p.src.len and p.src[p.pos] != c) p.pos += 1;
            const text = p.src[s..@min(p.pos, p.src.len)];
            if (p.pos < p.src.len) p.pos += 1;
            return .{ .kind = .string, .text = text };
        }
        const ops3 = [_][]const u8{ "===", "!==" };
        const ops2 = [_][]const u8{ "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=" };
        for (ops3) |o| if (std.mem.startsWith(u8, p.src[p.pos..], o)) {
            p.pos += 3;
            return .{ .kind = .op, .text = o[0..2] };
        };
        for (ops2) |o| if (std.mem.startsWith(u8, p.src[p.pos..], o)) {
            p.pos += 2;
            return .{ .kind = .op, .text = o };
        };
        p.pos += 1;
        return .{ .kind = .op, .text = p.src[start..p.pos] };
    }

    fn peek(p: *ExprParser) Tok {
        if (p.peeked == null) p.peeked = p.next();
        return p.peeked.?;
    }

    fn isOp(t: Tok, s: []const u8) bool {
        return t.kind == .op and std.mem.eql(u8, t.text, s);
    }

    fn mk(p: *ExprParser, e: Expr) !*const Expr {
        const n = try p.a.create(Expr);
        n.* = e;
        return n;
    }

    fn statements(p: *ExprParser) anyerror!*const Expr {
        var list: std.ArrayList(*const Expr) = .empty;
        while (true) {
            if (p.peek().kind == .eof) break;
            try list.append(p.a, try p.statement());
            if (isOp(p.peek(), ";")) {
                _ = p.next();
                continue;
            }
            break;
        }
        if (list.items.len == 1) return list.items[0];
        return p.mk(.{ .seq = list.items });
    }

    fn statement(p: *ExprParser) anyerror!*const Expr {
        const save_pos = p.pos;
        const save_peek = p.peeked;
        if (p.peek().kind == .ident) {
            const path = try p.pathExpr();
            const t = p.peek();
            if (isOp(t, "=") or isOp(t, "+=") or isOp(t, "-=") or isOp(t, "*=") or isOp(t, "/=")) {
                _ = p.next();
                const v = try p.expr();
                const op: ?Op = if (isOp(t, "+=")) .add else if (isOp(t, "-=")) .sub else if (isOp(t, "*=")) .mul else if (isOp(t, "/=")) .div else null;
                return p.mk(.{ .assign = .{ .target = path, .op = op, .value = v } });
            }
            if (isOp(t, "++") or isOp(t, "--")) {
                _ = p.next();
                const one = try p.mk(.{ .literal = .{ .number = 1 } });
                return p.mk(.{ .assign = .{ .target = path, .op = if (isOp(t, "++")) .add else .sub, .value = one } });
            }
            p.pos = save_pos;
            p.peeked = save_peek;
        }
        return p.expr();
    }

    fn pathExpr(p: *ExprParser) ![]const []const u8 {
        var segs: std.ArrayList([]const u8) = .empty;
        const first = p.next();
        try segs.append(p.a, first.text);
        while (isOp(p.peek(), ".")) {
            _ = p.next();
            const t = p.next();
            if (t.kind != .ident) return error.Syntax;
            try segs.append(p.a, t.text);
        }
        return segs.items;
    }

    fn expr(p: *ExprParser) anyerror!*const Expr {
        const c = try p.binary(0);
        if (isOp(p.peek(), "?")) {
            _ = p.next();
            const t = try p.expr();
            if (!isOp(p.next(), ":")) return error.Syntax;
            const f = try p.expr();
            return p.mk(.{ .ternary = .{ .c = c, .t = t, .f = f } });
        }
        return c;
    }

    fn precedence(t: Tok) ?struct { op: Op, prec: u8 } {
        if (t.kind != .op) return null;
        const table = .{
            .{ "||", Op.@"or", 1 }, .{ "&&", Op.@"and", 2 }, .{ "==", Op.eq, 3 }, .{ "!=", Op.ne, 3 },
            .{ "<", Op.lt, 4 },     .{ ">", Op.gt, 4 },      .{ "<=", Op.le, 4 }, .{ ">=", Op.ge, 4 },
            .{ "+", Op.add, 5 },    .{ "-", Op.sub, 5 },     .{ "*", Op.mul, 6 }, .{ "/", Op.div, 6 },
            .{ "%", Op.mod, 6 },
        };
        inline for (table) |e| if (std.mem.eql(u8, t.text, e[0])) return .{ .op = e[1], .prec = e[2] };
        return null;
    }

    fn binary(p: *ExprParser, min: u8) anyerror!*const Expr {
        var l = try p.unary();
        while (true) {
            const info = precedence(p.peek()) orelse break;
            if (info.prec <= min) break;
            _ = p.next();
            const r = try p.binary(info.prec);
            l = try p.mk(.{ .binary = .{ .op = info.op, .l = l, .r = r } });
        }
        return l;
    }

    fn unary(p: *ExprParser) anyerror!*const Expr {
        const t = p.peek();
        if (isOp(t, "!")) {
            _ = p.next();
            return p.mk(.{ .not = try p.unary() });
        }
        if (isOp(t, "-")) {
            _ = p.next();
            return p.mk(.{ .neg = try p.unary() });
        }
        return p.primary();
    }

    fn primary(p: *ExprParser) anyerror!*const Expr {
        const t = p.peek();
        switch (t.kind) {
            .number => {
                _ = p.next();
                return p.mk(.{ .literal = .{ .number = std.fmt.parseFloat(f64, t.text) catch 0 } });
            },
            .string => {
                _ = p.next();
                return p.mk(.{ .literal = .{ .string = t.text } });
            },
            .ident => {
                if (std.mem.eql(u8, t.text, "true") or std.mem.eql(u8, t.text, "false")) {
                    _ = p.next();
                    return p.mk(.{ .literal = .{ .boolean = t.text[0] == 't' } });
                }
                if (std.mem.eql(u8, t.text, "null") or std.mem.eql(u8, t.text, "undefined")) {
                    _ = p.next();
                    return p.mk(.{ .literal = .nil });
                }
                const path = try p.pathExpr();
                if (isOp(p.peek(), "(")) {
                    _ = p.next();
                    var args: std.ArrayList(*const Expr) = .empty;
                    while (!isOp(p.peek(), ")") and p.peek().kind != .eof) {
                        try args.append(p.a, try p.expr());
                        if (isOp(p.peek(), ",")) _ = p.next();
                    }
                    _ = p.next();
                    return p.mk(.{ .call = .{ .name = path, .args = args.items } });
                }
                return p.mk(.{ .path = path });
            },
            .op => {
                if (isOp(t, "(")) {
                    _ = p.next();
                    const e = try p.expr();
                    _ = p.next();
                    return e;
                }
                return error.Syntax;
            },
            .eof => return error.Syntax,
        }
    }
};

pub fn parseExpr(a: Allocator, src_in: []const u8) !*const Expr {
    // tokens borrow from the source: keep it alive with the expression
    const src = try a.dupe(u8, src_in);
    var p = ExprParser{ .a = a, .src = src };
    const e = try p.statements();
    if (p.peek().kind != .eof) return error.Syntax;
    return e;
}

/// Evaluate an expression in a scope (reads are tracked by the current effect).
pub fn eval(rt: *Runtime, scope: ScopeId, e: *const Expr, scratch: Allocator) Value {
    return switch (e.*) {
        .literal => |v| v,
        .path => |segs| resolvePath(rt, scope, segs),
        .not => |x| .{ .boolean = !eval(rt, scope, x, scratch).truthy() },
        .neg => |x| .{ .number = -toNumber(eval(rt, scope, x, scratch)) },
        .ternary => |t| if (eval(rt, scope, t.c, scratch).truthy()) eval(rt, scope, t.t, scratch) else eval(rt, scope, t.f, scratch),
        .binary => |b| binop(rt, scope, b.op, b.l, b.r, scratch),
        .assign, .seq, .call => .nil,
    };
}

fn toNumber(v: Value) f64 {
    return switch (v) {
        .number => |n| n,
        .boolean => |b| if (b) 1 else 0,
        .string => |s| std.fmt.parseFloat(f64, std.mem.trim(u8, s, " ")) catch std.math.nan(f64),
        else => 0,
    };
}

fn binop(rt: *Runtime, scope: ScopeId, op: Op, le: *const Expr, re: *const Expr, scratch: Allocator) Value {
    if (op == .@"and") {
        const l = eval(rt, scope, le, scratch);
        return if (!l.truthy()) l else eval(rt, scope, re, scratch);
    }
    if (op == .@"or") {
        const l = eval(rt, scope, le, scratch);
        return if (l.truthy()) l else eval(rt, scope, re, scratch);
    }
    const l = eval(rt, scope, le, scratch);
    const r = eval(rt, scope, re, scratch);
    switch (op) {
        .add => {
            if (l == .string or r == .string) {
                const s = std.fmt.allocPrint(scratch, "{f}{f}", .{ l, r }) catch return .nil;
                return .{ .string = s };
            }
            return .{ .number = toNumber(l) + toNumber(r) };
        },
        .sub => return .{ .number = toNumber(l) - toNumber(r) },
        .mul => return .{ .number = toNumber(l) * toNumber(r) },
        .div => return .{ .number = toNumber(l) / toNumber(r) },
        .mod => return .{ .number = @mod(toNumber(l), toNumber(r)) },
        .eq => return .{ .boolean = looseEq(l, r) },
        .ne => return .{ .boolean = !looseEq(l, r) },
        .lt => return .{ .boolean = compare(l, r) < 0 },
        .gt => return .{ .boolean = compare(l, r) > 0 },
        .le => return .{ .boolean = compare(l, r) <= 0 },
        .ge => return .{ .boolean = compare(l, r) >= 0 },
        else => return .nil,
    }
}

fn looseEq(a: Value, b: Value) bool {
    if (a == .string and b == .string) return std.mem.eql(u8, a.string, b.string);
    if (a == .nil or b == .nil) return a == .nil and b == .nil;
    if (a == .number or b == .number or a == .boolean or b == .boolean) return toNumber(a) == toNumber(b);
    return a.eql(b);
}

fn compare(a: Value, b: Value) i8 {
    if (a == .string and b == .string) return switch (std.mem.order(u8, a.string, b.string)) {
        .lt => -1,
        .eq => 0,
        .gt => 1,
    };
    const x = toNumber(a);
    const y = toNumber(b);
    return if (x < y) -1 else if (x > y) 1 else 0;
}

pub fn resolvePath(rt: *Runtime, scope: ScopeId, segs: []const []const u8) Value {
    if (segs.len == 0) return .nil;
    var v = rt.scopeValue(scope, segs[0]);
    for (segs[1..]) |seg| {
        v = switch (v) {
            .scope => |s| rt.scopeValue(s, seg),
            .list => |l| if (std.mem.eql(u8, seg, "length")) Value{ .number = @floatFromInt(rt.listLen(l)) } else .nil,
            .string => |s| if (std.mem.eql(u8, seg, "length")) Value{ .number = @floatFromInt(s.len) } else .nil,
            else => .nil,
        };
    }
    return v;
}

/// Find the signal node a path refers to (for assignment and bind:).
fn resolveTarget(rt: *Runtime, scope: ScopeId, segs: []const []const u8) ?reactive.NodeId {
    var sid = scope;
    for (segs[0 .. segs.len - 1]) |seg| {
        const v = rt.scopeValue(sid, seg);
        if (v != .scope) return null;
        sid = v.scope;
    }
    const r = rt.lookup(sid, segs[segs.len - 1]) orelse return null;
    return switch (r.slot) {
        .node => |n| if (rt.node(n).kind == .signal) n else null,
        .handler => null,
    };
}

/// Execute a handler statement.
pub fn exec(rt: *Runtime, scope: ScopeId, e: *const Expr, ev: ?*events.Event, scratch: Allocator) void {
    switch (e.*) {
        .seq => |list| {
            rt.batchBegin();
            for (list) |s| exec(rt, scope, s, ev, scratch);
            rt.batchEnd();
        },
        .assign => |a| {
            const target = resolveTarget(rt, scope, a.target) orelse return;
            var v = eval(rt, scope, a.value, scratch);
            if (a.op) |op| {
                const cur = rt.peek(target);
                const l = Expr{ .literal = cur };
                const r = Expr{ .literal = v };
                v = binop(rt, scope, op, &l, &r, scratch);
            }
            rt.set(target, v) catch {};
        },
        .call => |c| callHandler(rt, scope, c.name, c.args, ev, scratch),
        .path => |p| callHandler(rt, scope, p, &.{}, ev, scratch),
        else => {},
    }
}

pub const CallArgs = struct {
    event: ?*events.Event,
    args: []const Value,
};

fn callHandler(rt: *Runtime, scope: ScopeId, name: []const []const u8, arg_exprs: []const *const Expr, ev: ?*events.Event, scratch: Allocator) void {
    // `item.method`: resolve the prefix to the item's scope
    var sid = scope;
    for (name[0 .. name.len - 1]) |seg| {
        const v = rt.scopeValue(sid, seg);
        if (v != .scope) return;
        sid = v.scope;
    }
    const r = rt.lookup(sid, name[name.len - 1]) orelse return;
    if (r.slot != .handler) return;
    var vals: [8]Value = undefined;
    const n = @min(arg_exprs.len, vals.len);
    for (arg_exprs[0..n], 0..) |ae, i| vals[i] = eval(rt, scope, ae, scratch);
    var args = CallArgs{ .event = ev, .args = vals[0..n] };
    r.slot.handler.func(r.slot.handler.ctx, rt, sid, &args);
}

// ---------------------------------------------------------------------------
// Compiled templates
// ---------------------------------------------------------------------------

const Part = union(enum) {
    static: []const u8,
    expr: *const Expr,
};

const AttrKind = enum { attr, class_toggle, style_prop, event, bind_value, bind_checked, prop };

const DynAttr = struct {
    kind: AttrKind,
    name: []const u8,
    parts: []const Part = &.{},
    expr: ?*const Expr = null,
    event: events.EventType = .click,
};

pub const TNode = struct {
    kind: enum { element, text, component, slot },
    tag: []const u8 = "",
    static_attrs: []const [2][]const u8 = &.{},
    dyn_attrs: []const DynAttr = &.{},
    text: []const Part = &.{},
    children: []const TNode = &.{},
    if_expr: ?*const Expr = null,
    has_else: bool = false,
    else_node: ?*const TNode = null,
    each_expr: ?*const Expr = null,
    each_as: []const u8 = "item",
    each_index: []const u8 = "",
    each_key: ?*const Expr = null,
};

pub const Template = struct {
    arena: std.heap.ArenaAllocator,
    roots: []const TNode,
    styles: []const []const u8,

    pub fn destroy(t: *Template) void {
        const gpa = t.arena.child_allocator;
        t.arena.deinit();
        gpa.destroy(t);
    }
};

/// Parse template source into a reusable compiled template.
pub fn compile(gpa: Allocator, src: []const u8, components: ?*const Registry) !*Template {
    const t = try gpa.create(Template);
    t.* = .{ .arena = std.heap.ArenaAllocator.init(gpa), .roots = &.{}, .styles = &.{} };
    errdefer t.destroy();
    const a = t.arena.allocator();
    // parse HTML into a scratch document
    const doc = try dom.Document.init(gpa);
    defer doc.deinit();
    const holder = try doc.createElement("template-root");
    doc.appendChild(doc.root, holder);
    try html.parseInto(doc, holder, src, .{ .collect_styles = false, .implicit_root = false });
    var styles: std.ArrayList([]const u8) = .empty;
    t.roots = try compileChildren(a, doc, holder, components, &styles);
    t.styles = styles.items;
    return t;
}

fn compileChildren(a: Allocator, doc: *dom.Document, parent: NodeId, comps: ?*const Registry, styles: *std.ArrayList([]const u8)) anyerror![]const TNode {
    var out: std.ArrayList(TNode) = .empty;
    var c = doc.node(parent).first_child;
    while (c != dom.null_id) : (c = doc.node(c).next) {
        const n = doc.node(c);
        switch (n.kind) {
            .text => {
                const parts = try splitParts(a, n.text.items);
                try out.append(a, .{ .kind = .text, .text = parts });
            },
            .element => {
                const tag = doc.interner.str(n.tag);
                if (std.mem.eql(u8, tag, "style")) {
                    var buf: std.ArrayList(u8) = .empty;
                    try doc.textContent(c, &buf);
                    try styles.append(a, try a.dupe(u8, buf.items));
                    buf.deinit(doc.gpa);
                    continue;
                }
                var tn = try compileElement(a, doc, c, comps, styles);
                // `else` attaches to the preceding `if`
                if (tn.has_else and out.items.len > 0) {
                    var k = out.items.len;
                    while (k > 0) {
                        k -= 1;
                        if (out.items[k].kind == .text and isBlank(out.items[k].text)) continue;
                        if (out.items[k].if_expr != null) {
                            tn.has_else = false;
                            const en = try a.create(TNode);
                            en.* = tn;
                            out.items[k].else_node = en;
                            // drop whitespace between if and else
                            out.shrinkRetainingCapacity(k + 1);
                        }
                        break;
                    }
                    if (out.items.len > 0 and out.items[out.items.len - 1].else_node != null) continue;
                }
                try out.append(a, tn);
            },
            else => {},
        }
    }
    return out.items;
}

fn isBlank(parts: []const Part) bool {
    for (parts) |p| switch (p) {
        .static => |s| for (s) |ch| if (!std.ascii.isWhitespace(ch)) return false,
        .expr => return false,
    };
    return true;
}

fn compileElement(a: Allocator, doc: *dom.Document, id: NodeId, comps: ?*const Registry, styles: *std.ArrayList([]const u8)) anyerror!TNode {
    const n = doc.node(id);
    const tag = doc.interner.str(n.tag);
    var tn = TNode{ .kind = .element, .tag = try a.dupe(u8, tag) };
    if (std.mem.eql(u8, tag, "slot")) tn.kind = .slot;
    if (comps) |reg| if (reg.get(tag) != null) {
        tn.kind = .component;
    };
    var statics: std.ArrayList([2][]const u8) = .empty;
    var dyns: std.ArrayList(DynAttr) = .empty;
    for (n.attrs.items) |attr| {
        const name = doc.interner.str(attr.name);
        const val = attr.value;
        const braced = val.len >= 2 and val[0] == '{' and val[val.len - 1] == '}';
        const inner = if (braced) val[1 .. val.len - 1] else val;
        if (std.mem.eql(u8, name, "if")) {
            tn.if_expr = try parseExpr(a, inner);
        } else if (std.mem.eql(u8, name, "else")) {
            tn.has_else = true;
        } else if (std.mem.eql(u8, name, "each")) {
            tn.each_expr = try parseExpr(a, inner);
        } else if (std.mem.eql(u8, name, "as")) {
            tn.each_as = try a.dupe(u8, inner);
        } else if (std.mem.eql(u8, name, "index")) {
            tn.each_index = try a.dupe(u8, inner);
        } else if (std.mem.eql(u8, name, "key")) {
            tn.each_key = try parseExpr(a, inner);
        } else if (std.mem.startsWith(u8, name, "class:")) {
            try dyns.append(a, .{ .kind = .class_toggle, .name = try a.dupe(u8, name[6..]), .expr = try parseExpr(a, if (braced) inner else name[6..]) });
        } else if (std.mem.startsWith(u8, name, "style:")) {
            try dyns.append(a, .{ .kind = .style_prop, .name = try a.dupe(u8, name[6..]), .parts = try splitParts(a, val) });
        } else if (std.mem.eql(u8, name, "bind:value")) {
            try dyns.append(a, .{ .kind = .bind_value, .name = "value", .expr = try parseExpr(a, inner) });
        } else if (std.mem.eql(u8, name, "bind:checked")) {
            try dyns.append(a, .{ .kind = .bind_checked, .name = "checked", .expr = try parseExpr(a, inner) });
        } else if ((std.mem.startsWith(u8, name, "on") or name[0] == '@') and braced) {
            const ev_name = if (name[0] == '@') name[1..] else name;
            const et = events.EventType.fromName(ev_name) orelse return error.UnknownEvent;
            try dyns.append(a, .{ .kind = .event, .name = try a.dupe(u8, name), .expr = try parseExpr(a, inner), .event = et });
        } else if (std.mem.indexOfScalar(u8, val, '{') != null) {
            try dyns.append(a, .{ .kind = if (tn.kind == .component) .prop else .attr, .name = try a.dupe(u8, name), .parts = try splitParts(a, val) });
        } else {
            try statics.append(a, .{ try a.dupe(u8, name), try a.dupe(u8, val) });
        }
    }
    tn.static_attrs = statics.items;
    tn.dyn_attrs = dyns.items;
    tn.children = try compileChildren(a, doc, id, comps, styles);
    return tn;
}

fn splitParts(a: Allocator, s: []const u8) ![]const Part {
    var parts: std.ArrayList(Part) = .empty;
    var i: usize = 0;
    var start: usize = 0;
    while (i < s.len) {
        if (s[i] == '{') {
            var depth: usize = 0;
            var j = i;
            while (j < s.len) : (j += 1) {
                if (s[j] == '{') depth += 1;
                if (s[j] == '}') {
                    depth -= 1;
                    if (depth == 0) break;
                }
            }
            if (j >= s.len) break;
            if (i > start) try parts.append(a, .{ .static = try a.dupe(u8, s[start..i]) });
            try parts.append(a, .{ .expr = try parseExpr(a, s[i + 1 .. j]) });
            i = j + 1;
            start = i;
            continue;
        }
        i += 1;
    }
    if (start < s.len) try parts.append(a, .{ .static = try a.dupe(u8, s[start..]) });
    return parts.items;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

pub const Component = struct {
    template: *Template,
    /// optional host setup: populate the component scope (state, handlers)
    setup: ?*const fn (ctx: ?*anyopaque, rt: *Runtime, scope: ScopeId) void = null,
    ctx: ?*anyopaque = null,
};

pub const Registry = struct {
    gpa: Allocator,
    map: std.StringHashMapUnmanaged(Component) = .empty,

    pub fn get(r: *const Registry, name: []const u8) ?Component {
        return r.map.get(name);
    }
    pub fn register(r: *Registry, name: []const u8, c: Component) !void {
        const key = try std.ascii.allocLowerString(r.gpa, name);
        try r.map.put(r.gpa, key, c);
    }
    pub fn deinit(r: *Registry) void {
        var it = r.map.iterator();
        while (it.next()) |e| {
            r.gpa.free(e.key_ptr.*);
            e.value_ptr.template.destroy();
        }
        r.map.deinit(r.gpa);
    }
};

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/// A mounted template instance: DOM nodes, effects and nested blocks.
pub const Instance = struct {
    m: *Mounter,
    scope: ScopeId,
    /// top-level DOM nodes owned by this instance
    nodes: std.ArrayList(NodeId) = .empty,
    effects: std.ArrayList(reactive.NodeId) = .empty,
    children: std.ArrayList(*Instance) = .empty,
    bindings: std.ArrayList(*Binding) = .empty,
    listeners: std.ArrayList(u32) = .empty,
    owned_scopes: std.ArrayList(ScopeId) = .empty,

    pub fn destroy(inst: *Instance) void {
        const m = inst.m;
        const gpa = m.gpa;
        for (inst.children.items) |c| c.destroy();
        inst.children.deinit(gpa);
        for (inst.effects.items) |e| m.rt.dispose(e);
        inst.effects.deinit(gpa);
        for (inst.listeners.items) |l| m.ui.ix.removeListener(l);
        inst.listeners.deinit(gpa);
        for (inst.nodes.items) |n| if (m.ui.doc.get(n) != null) m.ui.destroyNode(n);
        inst.nodes.deinit(gpa);
        for (inst.bindings.items) |b| b.destroy(gpa);
        inst.bindings.deinit(gpa);
        for (inst.owned_scopes.items) |s| m.rt.freeScope(s);
        inst.owned_scopes.deinit(gpa);
        gpa.destroy(inst);
    }
};

/// Per-binding context for effects and listeners.
const Binding = struct {
    m: *Mounter,
    inst: *Instance,
    scope: ScopeId,
    node: NodeId,
    tn: *const TNode,
    attr: ?*const DynAttr = null,
    /// block anchors (if/each): comment node marking the position
    anchor: NodeId = dom.null_id,
    block: ?*Instance = null,
    else_block: ?*Instance = null,
    showing: ?bool = null,
    /// keyed each state
    items: std.ArrayList(EachItem) = .empty,
    scratch: std.heap.ArenaAllocator,
    /// component prop computed: (expr parts)
    parts: []const Part = &.{},

    fn destroy(b: *Binding, gpa: Allocator) void {
        if (b.block) |x| x.destroy();
        if (b.else_block) |x| x.destroy();
        for (b.items.items) |it| it.inst.destroy();
        b.items.deinit(gpa);
        b.scratch.deinit();
        gpa.destroy(b);
    }
};

const EachItem = struct {
    key: Value,
    inst: *Instance,
    item_sig: reactive.NodeId,
    index_sig: reactive.NodeId,
};

pub const Mounter = struct {
    gpa: Allocator,
    ui: *ui_mod.Ui,
    rt: *Runtime,
    components: ?*const Registry = null,

    pub fn mount(m: *Mounter, t: *const Template, scope: ScopeId, parent: NodeId, before: NodeId) !*Instance {
        for (t.styles) |css| _ = try m.ui.doc.addStylesheet(css);
        return m.mountNodes(t.roots, scope, parent, before, null);
    }

    fn newInstance(m: *Mounter, scope: ScopeId) !*Instance {
        const inst = try m.gpa.create(Instance);
        inst.* = .{ .m = m, .scope = scope };
        return inst;
    }

    fn mountNodes(m: *Mounter, nodes: []const TNode, scope: ScopeId, parent: NodeId, before: NodeId, slot: ?SlotContent) anyerror!*Instance {
        const inst = try m.newInstance(scope);
        errdefer inst.destroy();
        for (nodes) |*tn| {
            const id = try m.mountNode(inst, tn, scope, parent, before, slot);
            if (id != dom.null_id) try inst.nodes.append(m.gpa, id);
        }
        return inst;
    }

    const SlotContent = struct { nodes: []const TNode, scope: ScopeId, slot: ?*const SlotContent };

    fn newBinding(m: *Mounter, inst: *Instance, tn: *const TNode, scope: ScopeId, node: NodeId) !*Binding {
        const b = try m.gpa.create(Binding);
        b.* = .{ .m = m, .inst = inst, .scope = scope, .node = node, .tn = tn, .scratch = std.heap.ArenaAllocator.init(m.gpa) };
        try inst.bindings.append(m.gpa, b);
        return b;
    }

    fn insert(m: *Mounter, parent: NodeId, child: NodeId, before: NodeId) void {
        m.ui.doc.insertBefore(parent, child, before);
    }

    /// Returns the top-level DOM node created (anchor for blocks).
    fn mountNode(m: *Mounter, inst: *Instance, tn: *const TNode, scope: ScopeId, parent: NodeId, before: NodeId, slot: ?SlotContent) anyerror!NodeId {
        const doc = m.ui.doc;
        if (tn.each_expr != null) {
            const anchor = try doc.createComment();
            m.insert(parent, anchor, before);
            const b = try m.newBinding(inst, tn, scope, parent);
            b.anchor = anchor;
            try inst.effects.append(m.gpa, try m.rt.effect(eachEffect, b));
            return anchor;
        }
        if (tn.if_expr != null) {
            const anchor = try doc.createComment();
            m.insert(parent, anchor, before);
            const b = try m.newBinding(inst, tn, scope, parent);
            b.anchor = anchor;
            try inst.effects.append(m.gpa, try m.rt.effect(ifEffect, b));
            return anchor;
        }
        return m.mountPlain(inst, tn, scope, parent, before, slot);
    }

    fn mountPlain(m: *Mounter, inst: *Instance, tn: *const TNode, scope: ScopeId, parent: NodeId, before: NodeId, slot: ?SlotContent) anyerror!NodeId {
        const doc = m.ui.doc;
        switch (tn.kind) {
            .text => {
                if (tn.text.len == 1 and tn.text[0] == .static) {
                    const t = try doc.createText(tn.text[0].static);
                    m.insert(parent, t, before);
                    return t;
                }
                const t = try doc.createText("");
                m.insert(parent, t, before);
                const b = try m.newBinding(inst, tn, scope, t);
                try inst.effects.append(m.gpa, try m.rt.effect(textEffect, b));
                return t;
            },
            .slot => {
                const s = slot orelse return dom.null_id;
                const anchor = try doc.createComment();
                m.insert(parent, anchor, before);
                const child = try m.mountNodes(s.nodes, s.scope, parent, anchor, if (s.slot) |p| p.* else null);
                try inst.children.append(m.gpa, child);
                return anchor;
            },
            .component => {
                const comp = m.components.?.get(tn.tag).?;
                const cscope = try m.rt.scope(0);
                try inst.owned_scopes.append(m.gpa, cscope);
                // props: static strings and reactive computeds from expressions
                for (tn.static_attrs) |sa| _ = try m.rt.defineValue(cscope, sa[0], .{ .string = sa[1] });
                for (tn.dyn_attrs) |*da| {
                    if (da.kind == .prop) {
                        const b = try m.newBinding(inst, tn, scope, dom.null_id);
                        b.attr = da;
                        b.parts = da.parts;
                        const c = try m.rt.computed(propCompute, b);
                        try inst.effects.append(m.gpa, c);
                        try m.rt.defineSlot(cscope, da.name, .{ .node = c });
                    } else if (da.kind == .event) {
                        // `onchange={handler}` on a component: forward the parent's handler
                        if (da.expr.?.* == .path) {
                            const r = m.rt.lookup(scope, da.expr.?.path[da.expr.?.path.len - 1]);
                            if (r) |found| if (found.slot == .handler) try m.rt.defineHandler(cscope, da.name, found.slot.handler);
                        }
                    }
                }
                if (comp.setup) |f| f(comp.ctx, m.rt, cscope);
                for (comp.template.styles) |css| _ = try m.ui.doc.addStylesheet(css);
                const anchor = try doc.createComment();
                m.insert(parent, anchor, before);
                const sc = SlotContent{ .nodes = tn.children, .scope = scope, .slot = if (slot) |s| &s else null };
                const child = try m.mountNodes(comp.template.roots, cscope, parent, anchor, sc);
                try inst.children.append(m.gpa, child);
                return anchor;
            },
            .element => {
                const el = try doc.createElement(tn.tag);
                for (tn.static_attrs) |sa| try doc.setAttribute(el, sa[0], sa[1]);
                m.insert(parent, el, before);
                for (tn.dyn_attrs) |*da| {
                    const b = try m.newBinding(inst, tn, scope, el);
                    b.attr = da;
                    switch (da.kind) {
                        .event => {
                            const lid = try m.ui.ix.addListener(el, da.event, eventHandler, b);
                            try inst.listeners.append(m.gpa, lid);
                        },
                        .bind_value => {
                            try inst.effects.append(m.gpa, try m.rt.effect(bindValueEffect, b));
                            const lid = try m.ui.ix.addListener(el, .input, bindValueInput, b);
                            try inst.listeners.append(m.gpa, lid);
                            if (doc.node(el).tag == doc.atoms.select) {
                                const lid2 = try m.ui.ix.addListener(el, .change, bindValueInput, b);
                                try inst.listeners.append(m.gpa, lid2);
                            }
                        },
                        .bind_checked => {
                            try inst.effects.append(m.gpa, try m.rt.effect(bindCheckedEffect, b));
                            const lid = try m.ui.ix.addListener(el, .change, bindCheckedChange, b);
                            try inst.listeners.append(m.gpa, lid);
                        },
                        else => try inst.effects.append(m.gpa, try m.rt.effect(attrEffect, b)),
                    }
                }
                for (tn.children) |*c| _ = try m.mountNode(inst, c, scope, el, dom.null_id, slot);
                return el;
            },
        }
    }
};

fn renderParts(rt: *Runtime, scope: ScopeId, parts: []const Part, a: Allocator) []const u8 {
    if (parts.len == 1) switch (parts[0]) {
        .static => |s| return s,
        .expr => |e| {
            const v = eval(rt, scope, e, a);
            if (v == .string) return v.string;
            return std.fmt.allocPrint(a, "{f}", .{v}) catch "";
        },
    };
    var out: std.Io.Writer.Allocating = .init(a);
    for (parts) |p| switch (p) {
        .static => |s| out.writer.writeAll(s) catch {},
        .expr => |e| eval(rt, scope, e, a).format(&out.writer) catch {},
    };
    return out.written();
}

fn textEffect(ctx: ?*anyopaque, rt: *Runtime) void {
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    _ = b.scratch.reset(.retain_capacity);
    const s = renderParts(rt, b.scope, b.tn.text, b.scratch.allocator());
    b.m.ui.doc.setText(b.node, s) catch {};
}

fn propCompute(ctx: ?*anyopaque, rt: *Runtime) Value {
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    _ = b.scratch.reset(.retain_capacity);
    if (b.parts.len == 1 and b.parts[0] == .expr) return eval(rt, b.scope, b.parts[0].expr, b.scratch.allocator());
    return .{ .string = renderParts(rt, b.scope, b.parts, b.scratch.allocator()) };
}

const boolean_attrs = [_][]const u8{ "disabled", "checked", "hidden", "readonly", "required", "selected", "open", "autofocus", "multiple" };

fn attrEffect(ctx: ?*anyopaque, rt: *Runtime) void {
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    const doc = b.m.ui.doc;
    const da = b.attr.?;
    _ = b.scratch.reset(.retain_capacity);
    const a = b.scratch.allocator();
    switch (da.kind) {
        .class_toggle => {
            const on = eval(rt, b.scope, da.expr.?, a).truthy();
            setClass(doc, b.node, da.name, on);
        },
        .style_prop => {
            const v = renderParts(rt, b.scope, da.parts, a);
            doc.setStyleProperty(b.node, da.name, v) catch {};
        },
        .attr => {
            // boolean attributes follow truthiness of a single expression
            for (boolean_attrs) |ba| if (std.mem.eql(u8, ba, da.name) and da.parts.len == 1 and da.parts[0] == .expr) {
                const v = eval(rt, b.scope, da.parts[0].expr, a);
                if (v.truthy()) doc.setAttribute(b.node, da.name, "") catch {} else doc.removeAttribute(b.node, da.name) catch {};
                if (std.mem.eql(u8, ba, "checked")) {
                    var s = doc.node(b.node).state;
                    s.checked = v.truthy();
                    doc.setState(b.node, s);
                }
                return;
            };
            const v = renderParts(rt, b.scope, da.parts, a);
            if (std.mem.eql(u8, da.name, "value") and layoutIsTextInput(doc, b.node)) {
                b.m.ui.ix.setValue(b.node, v) catch {};
            }
            doc.setAttribute(b.node, da.name, v) catch {};
        },
        else => {},
    }
}

fn layoutIsTextInput(doc: *dom.Document, id: NodeId) bool {
    return @import("layout.zig").isTextInput(doc, id);
}

fn setClass(doc: *dom.Document, id: NodeId, name: []const u8, on: bool) void {
    const cur = doc.getAttribute(id, "class") orelse "";
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(doc.gpa);
    var has = false;
    var it = std.mem.tokenizeAny(u8, cur, " \t\n");
    while (it.next()) |c| {
        if (std.mem.eql(u8, c, name)) {
            has = true;
            if (!on) continue;
        }
        if (buf.items.len > 0) buf.append(doc.gpa, ' ') catch return;
        buf.appendSlice(doc.gpa, c) catch return;
    }
    if (on and !has) {
        if (buf.items.len > 0) buf.append(doc.gpa, ' ') catch return;
        buf.appendSlice(doc.gpa, name) catch return;
    }
    if (on == has) return;
    doc.setAttribute(id, "class", buf.items) catch {};
}

fn eventHandler(ctx: ?*anyopaque, ev: *events.Event) void {
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    _ = b.scratch.reset(.retain_capacity);
    const rt = b.m.rt;
    // the `event` name is visible to inline statements as event.value etc.
    exec(rt, b.scope, b.attr.?.expr.?, ev, b.scratch.allocator());
}

fn bindValueEffect(ctx: ?*anyopaque, rt: *Runtime) void {
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    _ = b.scratch.reset(.retain_capacity);
    const v = eval(rt, b.scope, b.attr.?.expr.?, b.scratch.allocator());
    const s = if (v == .string) v.string else std.fmt.allocPrint(b.scratch.allocator(), "{f}", .{v}) catch "";
    const doc = b.m.ui.doc;
    if (layoutIsTextInput(doc, b.node)) {
        if (!std.mem.eql(u8, b.m.ui.ix.value(b.node), s)) b.m.ui.ix.setValue(b.node, s) catch {};
    } else {
        doc.setAttribute(b.node, "value", s) catch {};
    }
}

fn bindValueInput(ctx: ?*anyopaque, ev: *events.Event) void {
    _ = ev;
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    const rt = b.m.rt;
    const e = b.attr.?.expr.?;
    if (e.* != .path) return;
    const target = resolveTarget(rt, b.scope, e.path) orelse return;
    const text = b.m.ui.ix.value(b.node);
    // keep numbers numbers
    const cur = rt.peek(target);
    if (cur == .number) {
        if (std.fmt.parseFloat(f64, std.mem.trim(u8, text, " "))) |n| {
            rt.set(target, .{ .number = n }) catch {};
        } else |_| {}
        return;
    }
    rt.set(target, .{ .string = text }) catch {};
}

fn bindCheckedEffect(ctx: ?*anyopaque, rt: *Runtime) void {
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    _ = b.scratch.reset(.retain_capacity);
    const on = eval(rt, b.scope, b.attr.?.expr.?, b.scratch.allocator()).truthy();
    const doc = b.m.ui.doc;
    var s = doc.node(b.node).state;
    if (s.checked == on) return;
    s.checked = on;
    doc.setState(b.node, s);
}

fn bindCheckedChange(ctx: ?*anyopaque, ev: *events.Event) void {
    _ = ev;
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    const rt = b.m.rt;
    const e = b.attr.?.expr.?;
    if (e.* != .path) return;
    const target = resolveTarget(rt, b.scope, e.path) orelse return;
    rt.set(target, .{ .boolean = b.m.ui.doc.node(b.node).state.checked }) catch {};
}

fn ifEffect(ctx: ?*anyopaque, rt: *Runtime) void {
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    _ = b.scratch.reset(.retain_capacity);
    const show = eval(rt, b.scope, b.tn.if_expr.?, b.scratch.allocator()).truthy();
    if (b.showing != null and b.showing.? == show) return;
    b.showing = show;
    // mounting must not subscribe this effect to the block's own reads
    const prev = rt.current;
    rt.current = reactive.none;
    defer rt.current = prev;
    if (b.block) |x| {
        x.destroy();
        b.block = null;
    }
    if (b.else_block) |x| {
        x.destroy();
        b.else_block = null;
    }
    var plain = b.tn.*;
    plain.if_expr = null;
    const parent = b.m.ui.doc.node(b.anchor).parent;
    if (show) {
        const inst = b.m.newInstance(b.scope) catch return;
        const id = b.m.mountNode(inst, &plain, b.scope, parent, b.anchor, null) catch return;
        if (id != dom.null_id) inst.nodes.append(b.m.gpa, id) catch {};
        b.block = inst;
    } else if (b.tn.else_node) |en| {
        const inst = b.m.newInstance(b.scope) catch return;
        const id = b.m.mountNode(inst, en, b.scope, parent, b.anchor, null) catch return;
        if (id != dom.null_id) inst.nodes.append(b.m.gpa, id) catch {};
        b.else_block = inst;
    }
}

fn eachEffect(ctx: ?*anyopaque, rt: *Runtime) void {
    const b: *Binding = @ptrCast(@alignCast(ctx.?));
    _ = b.scratch.reset(.retain_capacity);
    const a = b.scratch.allocator();
    const lv = eval(rt, b.scope, b.tn.each_expr.?, a);
    const items: []const Value = switch (lv) {
        .list => |l| rt.listItems(l),
        .number => |n| blk: {
            // each={5}: a range
            const cnt: usize = @intFromFloat(@max(0, @min(n, 100000)));
            const arr = a.alloc(Value, cnt) catch return;
            for (arr, 0..) |*v, i| v.* = .{ .number = @floatFromInt(i) };
            break :blk arr;
        },
        else => &.{},
    };
    const prev = rt.current;
    rt.current = reactive.none;
    defer rt.current = prev;
    const m = b.m;
    const doc = m.ui.doc;
    const parent = doc.node(b.anchor).parent;
    var plain = b.tn.*;
    plain.each_expr = null;

    // keys of the new list
    var keys = a.alloc(Value, items.len) catch return;
    for (items, 0..) |v, i| {
        if (b.tn.each_key) |ke| {
            // evaluate the key with the item bound
            const tmp = rt.scope(b.scope) catch return;
            defer rt.freeScope(tmp);
            _ = rt.defineValue(tmp, b.tn.each_as, v) catch {};
            const kv = eval(rt, tmp, ke, a);
            keys[i] = if (kv == .string) Value{ .string = a.dupe(u8, kv.string) catch "" } else kv;
        } else keys[i] = v;
    }
    // reuse existing instances by key
    var old = b.items;
    b.items = .empty;
    var used = a.alloc(bool, old.items.len) catch return;
    @memset(used, false);
    for (items, 0..) |v, i| {
        var found: ?usize = null;
        for (old.items, 0..) |o, oi| {
            if (!used[oi] and o.key.eql(keys[i])) {
                found = oi;
                break;
            }
        }
        if (found) |oi| {
            used[oi] = true;
            var it = old.items[oi];
            rt.set(it.item_sig, v) catch {};
            if (it.index_sig != reactive.none) rt.set(it.index_sig, .{ .number = @floatFromInt(i) }) catch {};
            it.key = ownKey(m.gpa, keys[i]);
            freeKey(m.gpa, old.items[oi].key);
            b.items.append(m.gpa, it) catch {};
        } else {
            const sc = rt.scope(b.scope) catch return;
            const item_sig = rt.defineValue(sc, b.tn.each_as, v) catch return;
            var index_sig: reactive.NodeId = reactive.none;
            if (b.tn.each_index.len > 0) index_sig = rt.defineValue(sc, b.tn.each_index, .{ .number = @floatFromInt(i) }) catch reactive.none;
            const inst = m.newInstance(sc) catch return;
            inst.owned_scopes.append(m.gpa, sc) catch {};
            const id = m.mountNode(inst, &plain, sc, parent, b.anchor, null) catch return;
            if (id != dom.null_id) inst.nodes.append(m.gpa, id) catch {};
            b.items.append(m.gpa, .{ .key = ownKey(m.gpa, keys[i]), .inst = inst, .item_sig = item_sig, .index_sig = index_sig }) catch {};
        }
    }
    for (old.items, 0..) |o, oi| {
        if (!used[oi]) {
            o.inst.destroy();
            freeKey(m.gpa, o.key);
        }
    }
    old.deinit(m.gpa);
    // reorder DOM to match: walk backwards inserting before the anchor
    var before = b.anchor;
    var i = b.items.items.len;
    while (i > 0) {
        i -= 1;
        const inst = b.items.items[i].inst;
        var k = inst.nodes.items.len;
        while (k > 0) {
            k -= 1;
            const n = inst.nodes.items[k];
            if (doc.node(n).next != before or doc.node(n).parent != parent) doc.insertBefore(parent, n, before);
            before = n;
        }
    }
}

fn ownKey(gpa: Allocator, k: Value) Value {
    if (k == .string) return .{ .string = gpa.dupe(u8, k.string) catch "" };
    return k;
}

fn freeKey(gpa: Allocator, k: Value) void {
    if (k == .string) gpa.free(k.string);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const style_mod = @import("style.zig");
const font = @import("text/font.zig");

fn testSetup() !struct { ui: *ui_mod.Ui, rt: *Runtime } {
    const ui = try ui_mod.Ui.create(std.testing.allocator, .{ .fonts = try font.MockBackend.create(std.testing.allocator) });
    ui.owns_fonts = true;
    const rt = try std.testing.allocator.create(Runtime);
    rt.* = Runtime.init(std.testing.allocator);
    return .{ .ui = ui, .rt = rt };
}

fn bodyHtml(ui: *ui_mod.Ui) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    const body = try html.ensureBody(ui.doc);
    var c = ui.doc.node(body).first_child;
    while (c != dom.null_id) : (c = ui.doc.node(c).next) try ui.doc.serialize(c, &out);
    return out.toOwnedSlice(std.testing.allocator);
}

test "expressions" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var rt = Runtime.init(std.testing.allocator);
    defer rt.deinit();
    const sc = try rt.scope(0);
    _ = try rt.defineValue(sc, "n", .{ .number = 4 });
    _ = try rt.defineValue(sc, "name", .{ .string = "ada" });
    try std.testing.expectEqual(@as(f64, 9), eval(&rt, sc, try parseExpr(a, "n * 2 + 1"), a).number);
    try std.testing.expect(eval(&rt, sc, try parseExpr(a, "n > 3 && name == 'ada'"), a).boolean);
    try std.testing.expectEqualStrings("hi ada", eval(&rt, sc, try parseExpr(a, "'hi ' + name"), a).string);
    try std.testing.expectEqualStrings("big", eval(&rt, sc, try parseExpr(a, "n >= 4 ? 'big' : 'small'"), a).string);
    exec(&rt, sc, try parseExpr(a, "n++; name = name + '!'"), null, a);
    try std.testing.expectEqual(@as(f64, 5), rt.scopeValue(sc, "n").number);
    try std.testing.expectEqualStrings("ada!", rt.scopeValue(sc, "name").string);
}

test "template bindings, if/else and keyed each" {
    const s = try testSetup();
    const ui = s.ui;
    const rt = s.rt;
    defer {
        rt.deinit();
        std.testing.allocator.destroy(rt);
        ui.destroy();
    }
    const tpl = try compile(std.testing.allocator,
        \\<p class="c" class:on={n > 1}>Count: {n}</p>
        \\<span if={n == 0}>zero</span><span else>many</span>
        \\<ul><li each={items} as="it" key={it.id}>{it.label}</li></ul>
        \\<button onclick={n++}>+</button>
    , null);
    defer tpl.destroy();
    const root = try rt.scope(0);
    const n = try rt.defineValue(root, "n", .{ .number = 0 });
    const list = try rt.list();
    _ = try rt.defineValue(root, "items", .{ .list = list });
    inline for (.{ .{ 1, "a" }, .{ 2, "b" } }) |e| {
        const is = try rt.scope(0);
        _ = try rt.defineValue(is, "id", .{ .number = e[0] });
        _ = try rt.defineValue(is, "label", .{ .string = e[1] });
        try rt.listPush(list, .{ .scope = is });
    }
    var m = Mounter{ .gpa = std.testing.allocator, .ui = ui, .rt = rt };
    const body = try html.ensureBody(ui.doc);
    const inst = try m.mount(tpl, root, body, dom.null_id);
    defer inst.destroy();
    var out = try bodyHtml(ui);
    try std.testing.expectEqualStrings("<p class=\"c\">Count: 0</p>\n<span>zero</span>\n<ul><li>a</li><li>b</li></ul>\n<button>+</button>", out);
    std.testing.allocator.free(out);
    // event handler mutates state -> fine-grained updates
    const btn = try style_mod.querySelector(ui.doc, ui.doc.root, "button");
    ui.ix.click(btn, 0, 0, .{}, 1);
    ui.ix.click(btn, 0, 0, .{}, 1);
    try std.testing.expectEqual(@as(f64, 2), rt.peek(n).number);
    // reorder the list: move b first (DOM nodes are moved, not recreated)
    const li_b = try style_mod.querySelector(ui.doc, ui.doc.root, "li:nth-child(2)");
    rt.listMove(list, 1, 0);
    const li_first = try style_mod.querySelector(ui.doc, ui.doc.root, "li:first-child");
    try std.testing.expectEqual(li_b, li_first);
    out = try bodyHtml(ui);
    try std.testing.expectEqualStrings("<p class=\"c on\">Count: 2</p>\n<span>many</span>\n<ul><li>b</li><li>a</li></ul>\n<button>+</button>", out);
    std.testing.allocator.free(out);
}

test "bind:value and components" {
    const s = try testSetup();
    const ui = s.ui;
    const rt = s.rt;
    defer {
        rt.deinit();
        std.testing.allocator.destroy(rt);
        ui.destroy();
    }
    var reg = Registry{ .gpa = std.testing.allocator };
    defer reg.deinit();
    try reg.register("Card", .{ .template = try compile(std.testing.allocator, "<div class=\"card\"><h2>{title}</h2><slot></slot></div>", null) });
    const tpl = try compile(std.testing.allocator,
        \\<input bind:value={name}><Card title={'Hi ' + name}><b>{name}</b></Card>
    , &reg);
    defer tpl.destroy();
    const root = try rt.scope(0);
    const name = try rt.defineValue(root, "name", .{ .string = "x" });
    var m = Mounter{ .gpa = std.testing.allocator, .ui = ui, .rt = rt, .components = &reg };
    const body = try html.ensureBody(ui.doc);
    const inst = try m.mount(tpl, root, body, dom.null_id);
    defer inst.destroy();
    var out = try bodyHtml(ui);
    try std.testing.expectEqualStrings("<input><div class=\"card\"><h2>Hi x</h2><b>x</b></div>", out);
    std.testing.allocator.free(out);
    // typing updates the signal and everything bound to it
    const input = try style_mod.querySelector(ui.doc, ui.doc.root, "input");
    ui.ix.focus(input, false);
    ui.ix.textInput("yz");
    try std.testing.expectEqualStrings("xyz", rt.peek(name).string);
    out = try bodyHtml(ui);
    try std.testing.expectEqualStrings("<input><div class=\"card\"><h2>Hi xyz</h2><b>xyz</b></div>", out);
    std.testing.allocator.free(out);
    // setting the signal updates the input
    try rt.set(name, .{ .string = "q" });
    try std.testing.expectEqualStrings("q", ui.ix.value(input));
}
