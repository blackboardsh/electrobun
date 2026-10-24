//! Accessibility tree: semantic nodes (role, name, value, states, bounds)
//! derived from the DOM and layout, serialized for the platform host
//! (NSAccessibility on macOS; UIA / AT-SPI hosts consume the same format).
const std = @import("std");
const dom = @import("dom.zig");
const style_mod = @import("style.zig");
const layout = @import("layout.zig");
const events = @import("events.zig");
const ui_mod = @import("ui.zig");

const Allocator = std.mem.Allocator;
const NodeId = dom.NodeId;
const null_id = dom.null_id;

pub const Role = enum(u8) {
    group = 0,
    button,
    link,
    checkbox,
    radio,
    text_field,
    text_area,
    static_text,
    heading,
    image,
    list,
    list_item,
    slider,
    progress,
    combo_box,
    tab,
    tab_list,
    dialog,
    menu,
    menu_item,
    switch_,
    table,
    row,
    cell,
    toolbar,
    navigation,
    main,
    form,
    separator,
};

pub const State = packed struct(u16) {
    focused: bool = false,
    disabled: bool = false,
    checked: bool = false,
    mixed: bool = false,
    expanded: bool = false,
    collapsed: bool = false,
    selected: bool = false,
    required: bool = false,
    readonly: bool = false,
    focusable: bool = false,
    _pad: u6 = 0,
};

pub const Node = struct {
    id: NodeId,
    parent: u32, // index into nodes, 0xffffffff = root
    role: Role,
    level: u8 = 0,
    state: State = .{},
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    name: []const u8,
    value: []const u8,
    description: []const u8 = "",
    min: f32 = 0,
    max: f32 = 0,
    now: f32 = 0,
};

pub const Tree = struct {
    arena: std.heap.ArenaAllocator,
    nodes: std.ArrayList(Node) = .empty,

    pub fn deinit(t: *Tree) void {
        t.arena.deinit();
    }
};

const no_parent: u32 = 0xffffffff;

fn roleFromAttr(r: []const u8) ?Role {
    const map = std.StaticStringMap(Role).initComptime(.{
        .{ "button", .button },       .{ "link", .link },           .{ "checkbox", .checkbox },
        .{ "radio", .radio },         .{ "textbox", .text_field },  .{ "heading", .heading },
        .{ "img", .image },           .{ "image", .image },         .{ "list", .list },
        .{ "listitem", .list_item },  .{ "slider", .slider },       .{ "progressbar", .progress },
        .{ "combobox", .combo_box },  .{ "tab", .tab },             .{ "tablist", .tab_list },
        .{ "dialog", .dialog },       .{ "alertdialog", .dialog },  .{ "menu", .menu },
        .{ "menubar", .menu },        .{ "menuitem", .menu_item },  .{ "switch", .switch_ },
        .{ "table", .table },         .{ "grid", .table },          .{ "row", .row },
        .{ "cell", .cell },           .{ "gridcell", .cell },       .{ "toolbar", .toolbar },
        .{ "navigation", .navigation }, .{ "main", .main },         .{ "form", .form },
        .{ "separator", .separator }, .{ "group", .group },         .{ "region", .group },
    });
    return map.get(r);
}

fn attr(doc: *const dom.Document, n: *const dom.Node, name: []const u8) ?[]const u8 {
    const a = doc.interner.lookup(name) orelse return null;
    return n.getAttr(a);
}

fn tagIs(doc: *const dom.Document, n: *const dom.Node, name: []const u8) bool {
    return std.mem.eql(u8, doc.interner.str(n.tag), name);
}

/// Semantic role of an element, or null if it is presentational.
fn roleOf(doc: *const dom.Document, id: NodeId) ?struct { role: Role, level: u8 } {
    const n = doc.node(id);
    if (attr(doc, n, "role")) |r| {
        if (std.mem.eql(u8, r, "presentation") or std.mem.eql(u8, r, "none")) return null;
        if (roleFromAttr(r)) |role| return .{ .role = role, .level = 0 };
    }
    const tag = doc.interner.str(n.tag);
    const t = std.StaticStringMap(Role).initComptime(.{
        .{ "button", .button },   .{ "a", .link },          .{ "textarea", .text_area }, .{ "select", .combo_box },
        .{ "img", .image },       .{ "svg", .image },       .{ "ul", .list },            .{ "ol", .list },
        .{ "li", .list_item },    .{ "progress", .progress }, .{ "dialog", .dialog },    .{ "table", .table },
        .{ "tr", .row },          .{ "td", .cell },         .{ "th", .cell },            .{ "nav", .navigation },
        .{ "main", .main },       .{ "form", .form },       .{ "hr", .separator },       .{ "summary", .button },
        .{ "menu", .menu },
    });
    if (tag.len == 2 and tag[0] == 'h' and tag[1] >= '1' and tag[1] <= '6') return .{ .role = .heading, .level = tag[1] - '0' };
    if (std.mem.eql(u8, tag, "input")) {
        const ty = attr(doc, n, "type") orelse "text";
        if (std.ascii.eqlIgnoreCase(ty, "checkbox")) return .{ .role = .checkbox, .level = 0 };
        if (std.ascii.eqlIgnoreCase(ty, "radio")) return .{ .role = .radio, .level = 0 };
        if (std.ascii.eqlIgnoreCase(ty, "range")) return .{ .role = .slider, .level = 0 };
        if (std.ascii.eqlIgnoreCase(ty, "button") or std.ascii.eqlIgnoreCase(ty, "submit") or std.ascii.eqlIgnoreCase(ty, "reset")) return .{ .role = .button, .level = 0 };
        if (std.ascii.eqlIgnoreCase(ty, "hidden")) return null;
        return .{ .role = .text_field, .level = 0 };
    }
    if (std.mem.eql(u8, tag, "a") and n.getAttr(doc.atoms.href) == null) return null;
    if (t.get(tag)) |r| return .{ .role = r, .level = 0 };
    return null;
}

fn collectText(doc: *const dom.Document, id: NodeId, out: *std.ArrayList(u8), a: Allocator) !void {
    const n = doc.node(id);
    if (n.kind == .text) {
        // collapse whitespace
        var prev_space = out.items.len == 0 or out.items[out.items.len - 1] == ' ';
        for (n.text.items) |ch| {
            if (std.ascii.isWhitespace(ch)) {
                if (!prev_space) try out.append(a, ' ');
                prev_space = true;
            } else {
                try out.append(a, ch);
                prev_space = false;
            }
        }
        return;
    }
    if (n.kind != .element) return;
    const st = style_mod.of(doc, id);
    if (st.display == .none or st.visibility != .visible) return;
    if (attr(doc, n, "aria-hidden")) |h| if (std.mem.eql(u8, h, "true")) return;
    if (attr(doc, n, "aria-label")) |l| {
        try out.appendSlice(a, l);
        try out.append(a, ' ');
        return;
    }
    if (n.tag == doc.atoms.img) if (attr(doc, n, "alt")) |alt| {
        try out.appendSlice(a, alt);
        return;
    };
    var c = n.first_child;
    while (c != null_id) : (c = doc.node(c).next) try collectText(doc, c, out, a);
}

fn labelFor(doc: *const dom.Document, id: NodeId, a: Allocator) ![]const u8 {
    const n = doc.node(id);
    // <label for=id>
    if (n.getAttr(doc.atoms.id)) |eid| {
        var cur = doc.root;
        while (cur != null_id) : (cur = doc.nextInTree(cur, doc.root)) {
            const cn = doc.node(cur);
            if (cn.kind == .element and cn.tag == doc.atoms.label) {
                if (cn.getAttr(doc.atoms.for_)) |f| if (std.mem.eql(u8, f, eid)) {
                    var buf: std.ArrayList(u8) = .empty;
                    try collectText(doc, cur, &buf, a);
                    return std.mem.trim(u8, buf.items, " ");
                };
            }
        }
    }
    // wrapping <label>
    var p = n.parent;
    while (p != null_id and doc.node(p).kind == .element) : (p = doc.node(p).parent) {
        if (doc.node(p).tag == doc.atoms.label) {
            var buf: std.ArrayList(u8) = .empty;
            try collectText(doc, p, &buf, a);
            return std.mem.trim(u8, buf.items, " ");
        }
    }
    return "";
}

/// Build the accessibility tree for the current layout.
pub fn build(gpa: Allocator, ui: *ui_mod.Ui) !*Tree {
    const t = try gpa.create(Tree);
    t.* = .{ .arena = std.heap.ArenaAllocator.init(gpa) };
    errdefer {
        t.deinit();
        gpa.destroy(t);
    }
    const root = ui.doc.documentElement();
    if (root != null_id) try visit(t, ui, root, no_parent);
    return t;
}

fn visit(t: *Tree, ui: *ui_mod.Ui, id: NodeId, parent_index: u32) Allocator.Error!void {
    const doc = ui.doc;
    const a = t.arena.allocator();
    const n = doc.node(id);
    if (n.kind == .text) {
        // loose text directly in a container becomes static text
        const trimmed = std.mem.trim(u8, n.text.items, " \t\r\n");
        if (trimmed.len == 0) return;
        // frame of the nearest laid-out ancestor (inline elements have no box)
        var host = n.parent;
        while (host != null_id and doc.node(host).kind == .element) : (host = doc.node(host).parent) {
            if (layout.boxOfNode(doc.node(host))) |hb| if (hb.placed) break;
        }
        if (host == null_id or doc.node(host).kind != .element) return;
        const b = layout.boxOfNode(doc.node(host)) orelse return;
        const o = ui.ix.contentOrigin(host) orelse return;
        try t.nodes.append(a, .{ .id = id, .parent = parent_index, .role = .static_text, .x = o[0], .y = o[1], .w = b.w, .h = b.h, .name = try a.dupe(u8, trimmed), .value = "" });
        return;
    }
    if (n.kind != .element) return;
    const st = style_mod.of(doc, id);
    if (st.display == .none or st.visibility != .visible) return;
    if (attr(doc, n, "aria-hidden")) |h| if (std.mem.eql(u8, h, "true")) return;
    const role = roleOf(doc, id);
    var my_index = parent_index;
    if (role) |r| {
        var name: []const u8 = attr(doc, n, "aria-label") orelse "";
        var value: []const u8 = "";
        var state = State{};
        state.focused = doc.focused == id;
        state.disabled = n.hasAttr(doc.atoms.disabled);
        state.focusable = ui.ix.isFocusable(id);
        state.checked = n.state.checked or (if (attr(doc, n, "aria-checked")) |c| std.mem.eql(u8, c, "true") else false);
        state.selected = if (attr(doc, n, "aria-selected")) |c| std.mem.eql(u8, c, "true") else false;
        if (attr(doc, n, "aria-expanded")) |e| {
            state.expanded = std.mem.eql(u8, e, "true");
            state.collapsed = !state.expanded;
        }
        state.required = n.hasAttr(doc.atoms.required);
        state.readonly = n.hasAttr(doc.atoms.readonly);
        var min: f32 = 0;
        var max: f32 = 0;
        var now: f32 = 0;
        switch (r.role) {
            .text_field, .text_area, .combo_box => {
                if (name.len == 0) name = try labelFor(doc, id, a);
                if (name.len == 0) name = n.getAttr(doc.atoms.placeholder) orelse "";
                value = try a.dupe(u8, ui.ix.value(id));
            },
            .checkbox, .radio, .slider, .switch_ => {
                if (name.len == 0) name = try labelFor(doc, id, a);
                if (r.role == .slider) {
                    min = parseF(n.getAttr(doc.atoms.min)) orelse 0;
                    max = parseF(n.getAttr(doc.atoms.max)) orelse 100;
                    now = parseF(n.getAttr(doc.atoms.value)) orelse (min + max) / 2;
                }
            },
            .progress => {
                max = parseF(n.getAttr(doc.atoms.max)) orelse 1;
                now = parseF(n.getAttr(doc.atoms.value)) orelse 0;
            },
            .image => {
                if (name.len == 0) name = n.getAttr(doc.atoms.alt) orelse (attr(doc, n, "title") orelse "");
            },
            else => {
                if (name.len == 0) {
                    var buf: std.ArrayList(u8) = .empty;
                    try collectText(doc, id, &buf, a);
                    name = std.mem.trim(u8, buf.items, " ");
                }
            },
        }
        const b = layout.boxOfNode(n);
        var x: f32 = 0;
        var y: f32 = 0;
        var w: f32 = 0;
        var h: f32 = 0;
        if (b) |box| if (ui.ix.contentOrigin(id)) |o| {
            x = o[0] - box.border.left - box.padding.left;
            y = o[1] - box.border.top - box.padding.top;
            w = box.w;
            h = box.h;
        };
        try t.nodes.append(a, .{
            .id = id,
            .parent = parent_index,
            .role = r.role,
            .level = r.level,
            .state = state,
            .x = x,
            .y = y,
            .w = w,
            .h = h,
            .name = name,
            .value = value,
            .description = attr(doc, n, "title") orelse "",
            .min = min,
            .max = max,
            .now = now,
        });
        my_index = @intCast(t.nodes.items.len - 1);
        // leaf roles: their text is the name, children are not exposed
        switch (r.role) {
            .button, .link, .checkbox, .radio, .text_field, .text_area, .image, .heading, .slider, .progress, .combo_box, .tab, .menu_item, .switch_ => return,
            else => {},
        }
    }
    var c = n.first_child;
    while (c != null_id) : (c = doc.node(c).next) try visit(t, ui, c, my_index);
}

fn parseF(v: ?[]const u8) ?f32 {
    const s = v orelse return null;
    return std.fmt.parseFloat(f32, std.mem.trim(u8, s, " ")) catch null;
}

/// Serialize for the native host. Per node: id u32, parent u32, role u8,
/// level u8, state u16, x y w h f32, min max now f32, name/value/description
/// as u32 length + UTF-8 bytes.
pub fn serialize(t: *const Tree, gpa: Allocator, out: *std.ArrayList(u8)) !void {
    const W = struct {
        fn u32_(o: *std.ArrayList(u8), g: Allocator, v: u32) !void {
            var b: [4]u8 = undefined;
            std.mem.writeInt(u32, &b, v, .little);
            try o.appendSlice(g, &b);
        }
        fn f32_(o: *std.ArrayList(u8), g: Allocator, v: f32) !void {
            try u32_(o, g, @bitCast(v));
        }
        fn str(o: *std.ArrayList(u8), g: Allocator, s: []const u8) !void {
            try u32_(o, g, @intCast(s.len));
            try o.appendSlice(g, s);
        }
    };
    try W.u32_(out, gpa, @intCast(t.nodes.items.len));
    for (t.nodes.items) |n| {
        try W.u32_(out, gpa, n.id);
        try W.u32_(out, gpa, n.parent);
        try out.append(gpa, @intFromEnum(n.role));
        try out.append(gpa, n.level);
        var sb: [2]u8 = undefined;
        std.mem.writeInt(u16, &sb, @bitCast(n.state), .little);
        try out.appendSlice(gpa, &sb);
        try W.f32_(out, gpa, n.x);
        try W.f32_(out, gpa, n.y);
        try W.f32_(out, gpa, n.w);
        try W.f32_(out, gpa, n.h);
        try W.f32_(out, gpa, n.min);
        try W.f32_(out, gpa, n.max);
        try W.f32_(out, gpa, n.now);
        try W.str(out, gpa, n.name);
        try W.str(out, gpa, n.value);
        try W.str(out, gpa, n.description);
    }
}

pub const Action = enum(u8) { press = 0, focus = 1, increment = 2, decrement = 3, set_value = 4 };

/// Perform an assistive-technology action on a node.
pub fn perform(ui: *ui_mod.Ui, id: NodeId, action: Action, value: []const u8) void {
    if (ui.doc.get(id) == null) return;
    switch (action) {
        .press => {
            if (ui.ix.isFocusable(id)) ui.ix.focus(id, true);
            ui.ix.click(id, 0, 0, .{}, 1);
        },
        .focus => ui.ix.focus(id, true),
        .increment, .decrement => {
            const n = ui.doc.node(id);
            const w = &ui.doc.atoms;
            const cur = parseF(n.getAttr(w.value)) orelse 50;
            const step = parseF(n.getAttr(w.step)) orelse 1;
            const min = parseF(n.getAttr(w.min)) orelse 0;
            const max = parseF(n.getAttr(w.max)) orelse 100;
            const next = std.math.clamp(if (action == .increment) cur + step else cur - step, min, max);
            var buf: [32]u8 = undefined;
            const s = std.fmt.bufPrint(&buf, "{d}", .{next}) catch return;
            ui.doc.setAttribute(id, "value", s) catch {};
            var ev = events.Event{ .type = .input, .target = id };
            _ = ui.ix.dispatch(&ev);
        },
        .set_value => {
            ui.ix.setValue(id, value) catch {};
            var ev = events.Event{ .type = .input, .target = id };
            _ = ui.ix.dispatch(&ev);
        },
    }
}

// ---------------------------------------------------------------------------

const font = @import("text/font.zig");

test "accessibility tree" {
    const ui = try ui_mod.Ui.create(std.testing.allocator, .{ .fonts = try font.MockBackend.create(std.testing.allocator) });
    ui.owns_fonts = true;
    defer ui.destroy();
    try ui.setHtml(
        \\<nav><a href="#">Home</a></nav>
        \\<h2>Settings</h2>
        \\<label>Email <input id="e" value="a@b.c"></label>
        \\<button aria-label="Close"><svg></svg></button>
        \\<div><span>plain text</span></div>
        \\<input type="checkbox" id="c" checked><label for="c">Remember me</label>
    );
    ui.resize(400, 300, 1);
    _ = try ui.update();
    const t = try build(std.testing.allocator, ui);
    defer {
        t.deinit();
        std.testing.allocator.destroy(t);
    }
    const find = struct {
        fn f(tree: *const Tree, role: Role) ?Node {
            for (tree.nodes.items) |n| if (n.role == role) return n;
            return null;
        }
    }.f;
    try std.testing.expectEqualStrings("Home", find(t, .link).?.name);
    try std.testing.expect(find(t, .navigation) != null);
    try std.testing.expectEqual(@as(u8, 2), find(t, .heading).?.level);
    try std.testing.expectEqualStrings("Email", find(t, .text_field).?.name);
    try std.testing.expectEqualStrings("a@b.c", find(t, .text_field).?.value);
    try std.testing.expectEqualStrings("Close", find(t, .button).?.name);
    try std.testing.expectEqualStrings("Remember me", find(t, .checkbox).?.name);
    try std.testing.expect(find(t, .checkbox).?.state.checked);
    var saw_plain = false;
    for (t.nodes.items) |n| if (n.role == .static_text and std.mem.eql(u8, n.name, "plain text")) {
        saw_plain = true;
    };
    try std.testing.expect(saw_plain);
}
