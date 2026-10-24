//! Ergonomic Zig apps: a struct with `Signal`/`List` fields and methods is
//! bound to an HTML template by comptime reflection.
//!
//!   const App = struct {
//!       count: ui.Signal(i64) = .init(0),
//!       pub fn inc(self: *App) void { self.count.set(self.count.get() + 1); }
//!       pub fn doubled(self: *App) i64 { return self.count.get() * 2; } // computed
//!       pub const template = "<button onclick={inc}>{count} / {doubled}</button>";
//!   };
//!
//! Field names become template names. `pub fn` methods returning void are
//! event handlers (taking optionally `*Event` and/or an item pointer from a
//! List field); methods returning a value are computeds.
const std = @import("std");
const reactive = @import("reactive.zig");
const template = @import("template.zig");
const events = @import("events.zig");
const ui_mod = @import("ui.zig");
const dom = @import("dom.zig");
const html = @import("html.zig");

const Allocator = std.mem.Allocator;
const Runtime = reactive.Runtime;
const Value = reactive.Value;
const ScopeId = reactive.ScopeId;

pub const Event = events.Event;

/// Typed handle on a reactive signal. Strings are copied into the runtime;
/// `get` returns a slice valid until the next `set`.
pub fn Signal(comptime T: type) type {
    return struct {
        const Self = @This();
        pub const is_signal = true;
        pub const Inner = T;

        rt: ?*Runtime = null,
        id: reactive.NodeId = reactive.none,
        initial: T,

        pub fn init(v: T) Self {
            return .{ .initial = v };
        }

        /// Read (tracked inside computeds/effects).
        pub fn get(s: *const Self) T {
            const rt = s.rt orelse return s.initial;
            return fromValue(T, rt.get(s.id));
        }

        pub fn peek(s: *const Self) T {
            const rt = s.rt orelse return s.initial;
            return fromValue(T, rt.peek(s.id));
        }

        pub fn set(s: *Self, v: T) void {
            const rt = s.rt orelse {
                s.initial = v;
                return;
            };
            rt.set(s.id, toValue(v)) catch {};
        }

        pub fn update(s: *Self, f: *const fn (T) T) void {
            s.set(f(s.peek()));
        }
    };
}

/// Reactive list of `T` items, each bound to its own scope.
pub fn List(comptime T: type) type {
    return struct {
        const Self = @This();
        pub const is_list = true;
        pub const Item = T;

        rt: ?*Runtime = null,
        gpa: ?Allocator = null,
        id: reactive.ListId = 0,
        parent_scope: ScopeId = 0,
        items: std.ArrayList(*T) = .empty,
        scopes: std.ArrayList(ScopeId) = .empty,

        pub fn len(l: *const Self) usize {
            if (l.rt) |rt| _ = rt.listLen(l.id); // track
            return l.items.items.len;
        }

        pub fn at(l: *const Self, i: usize) *T {
            return l.items.items[i];
        }

        pub fn slice(l: *const Self) []const *T {
            if (l.rt) |rt| _ = rt.listLen(l.id);
            return l.items.items;
        }

        /// Append an item (its Signal fields take the given initial values).
        pub fn append(l: *Self, item: T) !*T {
            return l.insert(l.items.items.len, item);
        }

        pub fn insert(l: *Self, index: usize, item: T) !*T {
            const gpa = l.gpa orelse return error.NotBound;
            const rt = l.rt.?;
            const p = try gpa.create(T);
            p.* = item;
            const sc = try rt.scope(l.parent_scope);
            try bindStruct(T, rt, gpa, p, sc);
            try l.items.insert(gpa, index, p);
            try l.scopes.insert(gpa, index, sc);
            try rt.listInsert(l.id, index, .{ .scope = sc });
            return p;
        }

        pub fn indexOf(l: *const Self, item: *const T) ?usize {
            for (l.items.items, 0..) |p, i| if (p == item) return i;
            return null;
        }

        pub fn remove(l: *Self, index: usize) void {
            if (index >= l.items.items.len) return;
            const rt = l.rt.?;
            const gpa = l.gpa.?;
            const p = l.items.orderedRemove(index);
            const sc = l.scopes.orderedRemove(index);
            rt.listRemove(l.id, index);
            unbindStruct(T, rt, gpa, p);
            rt.freeScope(sc);
            gpa.destroy(p);
        }

        pub fn removeItem(l: *Self, item: *const T) void {
            if (l.indexOf(item)) |i| l.remove(i);
        }

        pub fn move(l: *Self, from: usize, to: usize) void {
            if (from >= l.items.items.len or to >= l.items.items.len) return;
            const p = l.items.orderedRemove(from);
            l.items.insert(l.gpa.?, to, p) catch return;
            const sc = l.scopes.orderedRemove(from);
            l.scopes.insert(l.gpa.?, to, sc) catch return;
            l.rt.?.listMove(l.id, from, to);
        }

        pub fn clear(l: *Self) void {
            while (l.items.items.len > 0) l.remove(l.items.items.len - 1);
        }

        /// Item bound to a scope (used to pass items to handlers).
        pub fn fromScope(l: *const Self, sc: ScopeId) ?*T {
            for (l.scopes.items, 0..) |s, i| if (s == sc) return l.items.items[i];
            return null;
        }
    };
}

fn isSignal(comptime F: type) bool {
    return @typeInfo(F) == .@"struct" and @hasDecl(F, "is_signal");
}

fn isList(comptime F: type) bool {
    return @typeInfo(F) == .@"struct" and @hasDecl(F, "is_list");
}

pub fn toValue(v: anytype) Value {
    const T = @TypeOf(v);
    return switch (@typeInfo(T)) {
        .bool => .{ .boolean = v },
        .int, .comptime_int => .{ .number = @floatFromInt(v) },
        .float, .comptime_float => .{ .number = @floatCast(v) },
        .@"enum" => .{ .string = @tagName(v) },
        .pointer => |p| if (p.size == .slice and p.child == u8) Value{ .string = v } else if (p.size == .one and @typeInfo(p.child) == .array) Value{ .string = v } else .nil,
        .optional => if (v) |x| toValue(x) else .nil,
        else => .nil,
    };
}

pub fn fromValue(comptime T: type, v: Value) T {
    return switch (@typeInfo(T)) {
        .bool => v.truthy(),
        .int => switch (v) {
            .number => |n| if (std.math.isNan(n)) 0 else @intFromFloat(std.math.clamp(@round(n), @as(f64, @floatFromInt(std.math.minInt(T))), @as(f64, @floatFromInt(std.math.maxInt(T))))),
            .boolean => |b| @intFromBool(b),
            else => 0,
        },
        .float => switch (v) {
            .number => |n| @floatCast(n),
            else => 0,
        },
        .@"enum" => switch (v) {
            .string => |s| std.meta.stringToEnum(T, s) orelse @enumFromInt(0),
            else => @enumFromInt(0),
        },
        .pointer => switch (v) {
            .string => |s| s,
            else => "",
        },
        .optional => |o| if (v == .nil) null else fromValue(o.child, v),
        else => @compileError("unsupported signal type " ++ @typeName(T)),
    };
}

/// Bind all reactive fields and methods of `self` into `scope`.
pub fn bindStruct(comptime T: type, rt: *Runtime, gpa: Allocator, self: *T, scope: ScopeId) !void {
    const info = @typeInfo(T).@"struct";
    inline for (info.field_names, info.field_types) |fname, F| {
        if (comptime isSignal(F)) {
            const sig = &@field(self, fname);
            sig.rt = rt;
            sig.id = try rt.defineValue(scope, fname, toValue(sig.initial));
        } else if (comptime isList(F)) {
            const l = &@field(self, fname);
            l.rt = rt;
            l.gpa = gpa;
            l.id = try rt.list();
            l.parent_scope = scope;
            _ = try rt.defineValue(scope, fname, .{ .list = l.id });
        } else switch (@typeInfo(F)) {
            .bool, .int, .float, .@"enum" => _ = try rt.defineValue(scope, fname, toValue(@field(self, fname))),
            .pointer => |p| if (p.size == .slice and p.child == u8) {
                _ = try rt.defineValue(scope, fname, toValue(@field(self, fname)));
            },
            else => {},
        }
    }
    // methods
    inline for (comptime std.meta.declarations(T)) |decl_name| {
        const D = @TypeOf(@field(T, decl_name));
        if (@typeInfo(D) == .@"fn") {
            const f = @typeInfo(D).@"fn";
            if (f.param_types.len >= 1 and f.param_types[0] != null and (f.param_types[0].? == *T or f.param_types[0].? == *const T)) {
                const Ret = f.return_type.?;
                if (Ret == void) {
                    try rt.defineHandler(scope, decl_name, .{ .func = Handlers(T, decl_name).call, .ctx = self });
                } else {
                    const c = try rt.computed(Computeds(T, decl_name).compute, self);
                    try rt.defineSlot(scope, decl_name, .{ .node = c });
                }
            }
        }
    }
}

fn unbindStruct(comptime T: type, rt: *Runtime, gpa: Allocator, self: *T) void {
    _ = gpa;
    const info = @typeInfo(T).@"struct";
    inline for (info.field_names, info.field_types) |fname, F| {
        if (comptime isSignal(F)) rt.dispose(@field(self, fname).id);
        if (comptime isList(F)) {
            var l = &@field(self, fname);
            l.clear();
            l.items.deinit(l.gpa.?);
            l.scopes.deinit(l.gpa.?);
        }
    }
}

fn Computeds(comptime T: type, comptime name: []const u8) type {
    return struct {
        fn compute(ctx: ?*anyopaque, rt: *Runtime) Value {
            _ = rt;
            const self: *T = @ptrCast(@alignCast(ctx.?));
            return toValue(@field(T, name)(self));
        }
    };
}

/// Find the item pointer of type P (= *Item) for a scope among self's List fields.
fn itemFromScope(comptime T: type, comptime P: type, self: *T, sc: ScopeId) ?P {
    const Item = @typeInfo(P).pointer.child;
    const info = @typeInfo(T).@"struct";
    inline for (info.field_names, info.field_types) |fname, F| {
        if (comptime isList(F)) {
            if (F.Item == Item) {
                if (@field(self, fname).fromScope(sc)) |p| return p;
            }
        }
    }
    return null;
}

fn Handlers(comptime T: type, comptime name: []const u8) type {
    return struct {
        fn call(ctx: ?*anyopaque, rt: *Runtime, scope: ScopeId, arg: ?*anyopaque) void {
            _ = rt;
            const self: *T = @ptrCast(@alignCast(ctx.?));
            const args: ?*template.CallArgs = @ptrCast(@alignCast(arg));
            const func = @field(T, name);
            const f = @typeInfo(@TypeOf(func)).@"fn";
            var call_args: std.meta.ArgsTuple(@TypeOf(func)) = undefined;
            call_args[0] = self;
            var next_value: usize = 0;
            inline for (f.param_types[1..], 1..) |PT, i| {
                const P = PT.?;
                if (P == *events.Event) {
                    const ev = if (args) |a| a.event else null;
                    if (ev) |e| {
                        call_args[i] = e;
                    } else {
                        var dummy = events.Event{ .type = .click, .target = 0 };
                        call_args[i] = &dummy;
                    }
                } else if (@typeInfo(P) == .pointer and @typeInfo(@typeInfo(P).pointer.child) == .@"struct") {
                    // an item from a List field: from an explicit argument or the calling scope
                    var sc: ScopeId = scope;
                    if (args) |a| if (next_value < a.args.len and a.args[next_value] == .scope) {
                        sc = a.args[next_value].scope;
                        next_value += 1;
                    };
                    call_args[i] = itemFromScope(T, P, self, sc) orelse return;
                } else {
                    const v: Value = if (args) |a| (if (next_value < a.args.len) a.args[next_value] else .nil) else .nil;
                    next_value += 1;
                    call_args[i] = fromValue(P, v);
                }
            }
            @call(.auto, func, call_args);
        }
    };
}

/// A mounted app instance.
pub fn Mounted(comptime T: type) type {
    return struct {
        const Self = @This();
        ui: *ui_mod.Ui,
        rt: *Runtime,
        state: *T,
        tpl: *template.Template,
        mounter: template.Mounter,
        inst: *template.Instance,
        scope: ScopeId,

        pub fn destroy(m: *Self) void {
            const gpa = m.ui.gpa;
            m.inst.destroy();
            unbindStruct(T, m.rt, gpa, m.state);
            m.tpl.destroy();
            m.rt.deinit();
            gpa.destroy(m.rt);
            gpa.destroy(m);
        }
    };
}

/// Mount `state` (of type T) using `T.template` (and optional `T.style`) into the body.
pub fn mount(comptime T: type, ui: *ui_mod.Ui, state: *T) !*Mounted(T) {
    const gpa = ui.gpa;
    const rt = try gpa.create(Runtime);
    rt.* = Runtime.init(gpa);
    errdefer {
        rt.deinit();
        gpa.destroy(rt);
    }
    if (@hasDecl(T, "style")) _ = try ui.doc.addStylesheet(T.style);
    const tpl = try template.compile(gpa, T.template, null);
    errdefer tpl.destroy();
    const scope = try rt.scope(0);
    try bindStruct(T, rt, gpa, state, scope);
    if (@hasDecl(T, "init")) state.init();
    const m = try gpa.create(Mounted(T));
    m.* = .{ .ui = ui, .rt = rt, .state = state, .tpl = tpl, .mounter = .{ .gpa = gpa, .ui = ui, .rt = rt }, .inst = undefined, .scope = scope };
    const body = try html.ensureBody(ui.doc);
    m.inst = try m.mounter.mount(tpl, scope, body, dom.null_id);
    return m;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const style_mod = @import("style.zig");
const font = @import("text/font.zig");

const Todo = struct {
    title: Signal([]const u8) = .init(""),
    done: Signal(bool) = .init(false),

    pub fn toggle(self: *Todo) void {
        self.done.set(!self.done.peek());
    }
};

const TodoApp = struct {
    draft: Signal([]const u8) = .init(""),
    todos: List(Todo) = .{},
    pub const template =
        \\<input id="draft" bind:value={draft}><button id="add" onclick={add}>Add</button>
        \\<p>{remaining} left</p>
        \\<ul><li each={todos} as="t" class:done={t.done}><span onclick={t.toggle}>{t.title}</span><button onclick={remove(t)}>x</button></li></ul>
    ;
    pub fn add(self: *TodoApp) void {
        const text = self.draft.peek();
        if (text.len == 0) return;
        _ = self.todos.append(.{ .title = .init(text) }) catch return;
        self.draft.set("");
    }
    pub fn remove(self: *TodoApp, t: *Todo) void {
        self.todos.removeItem(t);
    }
    pub fn remaining(self: *TodoApp) i64 {
        var n: i64 = 0;
        for (self.todos.slice()) |t| {
            if (!t.done.get()) n += 1;
        }
        return n;
    }
};

test "zig app binding" {
    const ui = try ui_mod.Ui.create(std.testing.allocator, .{ .fonts = try font.MockBackend.create(std.testing.allocator) });
    ui.owns_fonts = true;
    defer ui.destroy();
    var state = TodoApp{};
    const m = try mount(TodoApp, ui, &state);
    defer m.destroy();
    const input = try style_mod.querySelector(ui.doc, ui.doc.root, "#draft");
    const add = try style_mod.querySelector(ui.doc, ui.doc.root, "#add");
    ui.ix.focus(input, false);
    ui.ix.textInput("milk");
    ui.ix.click(add, 0, 0, .{}, 1);
    ui.ix.focus(input, false);
    ui.ix.textInput("eggs");
    ui.ix.click(add, 0, 0, .{}, 1);
    try std.testing.expectEqual(@as(usize, 2), state.todos.len());
    try std.testing.expectEqualStrings("", ui.ix.value(input));
    const p = try style_mod.querySelector(ui.doc, ui.doc.root, "p");
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(std.testing.allocator);
    try ui.doc.textContent(p, &buf);
    try std.testing.expectEqualStrings("2 left", buf.items);
    // toggle via item method
    const span = try style_mod.querySelector(ui.doc, ui.doc.root, "li span");
    ui.ix.click(span, 0, 0, .{}, 1);
    buf.clearRetainingCapacity();
    try ui.doc.textContent(p, &buf);
    try std.testing.expectEqualStrings("1 left", buf.items);
    const li = try style_mod.querySelector(ui.doc, ui.doc.root, "li");
    try std.testing.expectEqualStrings("done", ui.doc.getAttribute(li, "class").?);
    // remove(t) passes the item
    const x = try style_mod.querySelector(ui.doc, ui.doc.root, "li button");
    ui.ix.click(x, 0, 0, .{}, 1);
    try std.testing.expectEqual(@as(usize, 1), state.todos.len());
    try std.testing.expectEqualStrings("eggs", state.todos.at(0).title.peek());
}
