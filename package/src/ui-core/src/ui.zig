//! The UI engine facade: one document with its style engine, layout and
//! display list. Hosts (windows, bindings, tests) drive it with mutations and
//! call `update()` once per frame.
const std = @import("std");
const builtin = @import("builtin");
const dom = @import("dom.zig");
const html = @import("html.zig");
const style_mod = @import("style.zig");
const layout = @import("layout.zig");
const paint = @import("paint.zig");
const font = @import("text/font.zig");
const events = @import("events.zig");
const anim = @import("anim.zig");
const images = @import("images.zig");
const geom = @import("geom.zig");

const Allocator = std.mem.Allocator;

pub const Options = struct {
    /// text backend; null = platform default
    fonts: ?font.Backend = null,
};

/// CoreText on macOS; the pure-Zig portable backend elsewhere. Set
/// ELECTROBUN_UI_PORTABLE_TEXT=1 to use the portable backend on macOS too.
pub fn defaultFonts(gpa: Allocator) !font.Backend {
    if (builtin.os.tag == .macos and !envFlag("ELECTROBUN_UI_PORTABLE_TEXT")) return @import("text/coretext.zig").CoreTextBackend.create(gpa);
    return @import("text/portable.zig").PortableBackend.create(gpa, .{});
}

fn envFlag(name: [:0]const u8) bool {
    const v = std.c.getenv(name) orelse return false;
    return v[0] != 0 and v[0] != '0';
}

pub const Ui = struct {
    gpa: Allocator,
    doc: *dom.Document,
    styles: style_mod.Engine,
    fonts: font.Backend,
    owns_fonts: bool,
    layout: layout.Layout,
    dl: paint.DisplayList,
    /// autofocus element inserted since the last update
    pending_autofocus: dom.NodeId = dom.null_id,
    ix: events.Interaction,
    animator: anim.Animator,
    images: images.Store,
    paint_hooks: paint.Hooks = .{},
    /// seconds, advanced by `tick`
    now: f64 = 0,
    width: f32 = 800,
    height: f32 = 600,
    scale: f32 = 1,
    dark: bool = false,
    /// The surface is alpha-composited (a transparent window, an overlay
    /// view): with no html/body background the canvas stays transparent
    /// instead of painting the default white.
    transparent: bool = false,
    reduced_motion: bool = false,
    /// set when the display list changed since the last `takeFrame`
    frame_dirty: bool = true,

    pub fn create(gpa: Allocator, opts: Options) !*Ui {
        const ui = try gpa.create(Ui);
        errdefer gpa.destroy(ui);
        const fonts = opts.fonts orelse try defaultFonts(gpa);
        const doc = try dom.Document.init(gpa);
        doc.node_finalizer = finalizeNode;
        ui.* = .{
            .gpa = gpa,
            .doc = doc,
            .styles = style_mod.Engine.init(gpa),
            .fonts = fonts,
            .owns_fonts = opts.fonts == null,
            .layout = layout.Layout.init(gpa, doc, fonts),
            .dl = paint.DisplayList.init(gpa),
            .ix = undefined,
            .animator = undefined,
            .images = images.Store.init(gpa),
        };
        ui.ix = events.Interaction.init(gpa, doc, &ui.layout, &ui.dl);
        ui.animator = anim.Animator.init(gpa, doc, &ui.styles);
        ui.styles.on_style_change = anim.Animator.onStyleChange;
        ui.styles.on_style_change_ctx = &ui.animator;
        ui.layout.hooks = .{ .ctx = ui, .control_text = controlText, .natural_size = naturalSize };
        ui.paint_hooks = .{ .ctx = ui, .text_state = textState, .image_for = imageFor, .svg_image = svgImage };
        doc.observer = observe;
        doc.observer_ctx = ui;
        return ui;
    }

    fn controlText(ctx: ?*anyopaque, doc: *dom.Document, node: dom.NodeId) ?[]const u8 {
        const ui: *Ui = @ptrCast(@alignCast(ctx.?));
        _ = doc;
        const e = ui.ix.edits.get(node) orelse return null;
        if (ui.doc.node(node).getAttr(ui.doc.atoms.type)) |t| if (std.ascii.eqlIgnoreCase(t, "password")) {
            return ui.layout.passwordMask(e.text.items);
        };
        return e.text.items;
    }

    fn naturalSize(ctx: ?*anyopaque, doc: *dom.Document, node: dom.NodeId) ?[2]f32 {
        const ui: *Ui = @ptrCast(@alignCast(ctx.?));
        const src = doc.node(node).getAttr(doc.atoms.src) orelse return null;
        const id = ui.images.load(src) orelse return null;
        const img = ui.images.get(id).?;
        return .{ img.css_w, img.css_h };
    }

    fn imageFor(ctx: ?*anyopaque, url: []const u8) ?paint.ImageRef {
        const ui: *Ui = @ptrCast(@alignCast(ctx.?));
        const id = ui.images.load(url) orelse return null;
        const img = ui.images.get(id).?;
        return .{ .id = id, .w = @floatFromInt(img.w), .h = @floatFromInt(img.h) };
    }

    fn svgImage(ctx: ?*anyopaque, node: dom.NodeId, w: f32, h: f32, color: geom.Color) ?paint.ImageRef {
        const ui: *Ui = @ptrCast(@alignCast(ctx.?));
        const id = ui.images.svgImage(ui.doc, node, w, h, ui.scale, color) orelse return null;
        const img = ui.images.get(id).?;
        return .{ .id = id, .w = @floatFromInt(img.w), .h = @floatFromInt(img.h) };
    }

    fn textState(ctx: ?*anyopaque, node: dom.NodeId) ?paint.TextState {
        const ui: *Ui = @ptrCast(@alignCast(ctx.?));
        if (ui.doc.focused != node) return null;
        const e = ui.ix.edits.get(node) orelse return null;
        return .{ .caret = ui.ix.layoutOffset(node, e, e.caret), .anchor = ui.ix.layoutOffset(node, e, e.anchor), .scroll_x = e.scroll_x, .scroll_y = e.scroll_y };
    }

    fn observe(doc: *dom.Document, kind: dom.MutationKind, node: dom.NodeId, ctx: ?*anyopaque) void {
        const ui: *Ui = @ptrCast(@alignCast(ctx.?));
        if (kind != .inserted or ui.pending_autofocus != dom.null_id) return;
        // HTML autofocus: the first autofocus element in an inserted subtree
        // takes focus once (applied at the next update, if still connected)
        var cur = node;
        while (cur != dom.null_id) : (cur = doc.nextInTree(cur, node)) {
            const n = doc.node(cur);
            if (n.kind == .element and n.hasAttr(doc.atoms.autofocus)) {
                ui.pending_autofocus = cur;
                return;
            }
        }
    }

    fn applyAutofocus(ui: *Ui) void {
        const id = ui.pending_autofocus;
        ui.pending_autofocus = dom.null_id;
        if (id == dom.null_id or ui.doc.get(id) == null) return;
        if (!ui.doc.isInclusiveAncestor(ui.doc.root, id)) return;
        ui.ix.focus(id, false);
    }

    /// Destroy a node subtree, dropping its listeners and editing state.
    pub fn destroyNode(ui: *Ui, id: dom.NodeId) void {
        var cur = id;
        while (cur != dom.null_id) : (cur = ui.doc.nextInTree(cur, id)) ui.ix.removeNodeListeners(cur);
        ui.doc.destroy(id);
    }

    fn finalizeNode(doc: *dom.Document, n: *dom.Node) void {
        style_mod.finalizeNode(doc, n);
        layout.finalizeNode(doc, n);
    }

    pub fn destroy(ui: *Ui) void {
        const gpa = ui.gpa;
        ui.doc.deinit();
        ui.styles.deinit();
        ui.layout.deinit();
        ui.ix.deinit();
        ui.animator.deinit();
        ui.images.deinit();
        ui.dl.deinit();
        if (ui.owns_fonts) ui.fonts.deinit();
        gpa.destroy(ui);
    }

    /// Replace the body content with parsed HTML (styles in <style> are added).
    pub fn setHtml(ui: *Ui, src: []const u8) !void {
        const body = try html.ensureBody(ui.doc);
        var c = ui.doc.node(body).first_child;
        while (c != dom.null_id) {
            const next = ui.doc.node(c).next;
            ui.destroyNode(c);
            c = next;
        }
        try html.parseInto(ui.doc, ui.doc.root, src, .{});
    }

    /// The built-in component stylesheet (eb-* classes; see src/components).
    pub const components_css = @embedFile("components/electrobun.css");

    pub fn useComponents(ui: *Ui) !void {
        _ = try ui.doc.addStylesheet(components_css);
    }

    pub fn addCss(ui: *Ui, css: []const u8) !void {
        _ = try ui.doc.addStylesheet(css);
    }

    pub fn resize(ui: *Ui, w: f32, h: f32, scale: f32) void {
        if (w == ui.width and h == ui.height and scale == ui.scale) return;
        ui.width = w;
        ui.height = h;
        ui.scale = scale;
        ui.doc.needs_paint = true;
        const root = ui.doc.documentElement();
        if (root != dom.null_id) ui.doc.markLayoutDirty(root);
    }

    pub fn setColorScheme(ui: *Ui, dark: bool) void {
        ui.dark = dark;
    }

    /// See `transparent`.
    pub fn setTransparent(ui: *Ui, on: bool) void {
        if (ui.transparent == on) return;
        ui.transparent = on;
        ui.doc.needs_paint = true;
    }

    /// Advance the clock (seconds). Drives caret blinking and animations.
    pub fn tick(ui: *Ui, now: f64) void {
        ui.now = now;
        ui.ix.now = now;
        if (ui.doc.focused != dom.null_id and ui.ix.edits.contains(ui.doc.focused)) {
            const vis = ui.ix.caretVisible();
            if (vis != ui.paint_hooks.caret_visible) {
                ui.paint_hooks.caret_visible = vis;
                ui.doc.needs_paint = true;
            }
        }
    }

    /// Whether the host should keep producing frames (caret blink, animations).
    pub fn wantsFrames(ui: *const Ui) bool {
        if (ui.animator.active()) return true;
        return ui.doc.focused != dom.null_id and ui.ix.edits.contains(ui.doc.focused);
    }

    /// Run style, layout and paint as needed. Returns true if a new frame is ready.
    pub fn update(ui: *Ui) !bool {
        ui.applyAutofocus();
        ui.styles.setEnv(.{ .width = ui.width, .height = ui.height, .dark = ui.dark, .reduced_motion = ui.reduced_motion, .resolution = ui.scale });
        ui.animator.now = if (ui.animator.now == 0) ui.now else ui.animator.now;
        ui.animator.reduced_motion = ui.reduced_motion;
        _ = try ui.styles.update(ui.doc);
        ui.animator.apply(ui.now);
        _ = try ui.layout.run(ui.width, ui.height);
        // styles and layout now reference only live style data
        ui.doc.releaseRetired();
        if (!ui.doc.needs_paint) return false;
        var painter = paint.Painter{ .doc = ui.doc, .L = &ui.layout, .dl = &ui.dl, .hooks = ui.paint_hooks, .scale = ui.scale, .transparent_canvas = ui.transparent };
        try painter.paint();
        ui.doc.needs_paint = false;
        ui.frame_dirty = true;
        return true;
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

fn testUi(markup: []const u8) !*Ui {
    const ui = try Ui.create(std.testing.allocator, .{ .fonts = try font.MockBackend.create(std.testing.allocator) });
    ui.owns_fonts = true;
    try ui.setHtml(markup);
    ui.resize(400, 300, 1);
    _ = try ui.update();
    return ui;
}

const Counter = struct {
    n: u32 = 0,
    last: events.EventType = .click,
    fn cb(ctx: ?*anyopaque, ev: *events.Event) void {
        const c: *Counter = @ptrCast(@alignCast(ctx.?));
        c.n += 1;
        c.last = ev.type;
    }
};

test "transparent surfaces keep an unpainted canvas transparent" {
    const ui = try testUi(
        \\<style>html, body { background: transparent; margin: 0 }</style><div>x</div>
    );
    defer ui.destroy();
    // an opaque window gets the default white canvas
    try std.testing.expect(ui.dl.background.eql(geom.Color.white));
    ui.setTransparent(true);
    _ = try ui.update();
    try std.testing.expectEqual(@as(u8, 0), ui.dl.background.a);
    // a page background still wins
    try ui.addCss("body { background: #123456 }");
    _ = try ui.update();
    try std.testing.expect(ui.dl.background.eql(geom.Color.hex(0x123456)));
}

test "hover restyles and click dispatches" {
    const ui = try testUi(
        \\<style>body { margin: 0 } .b { width: 100px; height: 40px; background: #111 } .b:hover { background: #222 }</style>
        \\<div class="b" id="b"><span id="s">x</span></div>
    );
    defer ui.destroy();
    const b = try style_mod.querySelector(ui.doc, ui.doc.root, "#b");
    var counter = Counter{};
    _ = try ui.ix.addListener(b, .click, Counter.cb, &counter);
    ui.ix.pointerMove(10, 10, .{});
    _ = try ui.update();
    try std.testing.expect(style_mod.of(ui.doc, b).background_color.eql(geom.Color.hex(0x222222)));
    ui.ix.pointerDown(10, 10, 0, .{});
    ui.ix.pointerUp(10, 10, 0, .{});
    try std.testing.expectEqual(@as(u32, 1), counter.n);
    ui.ix.pointerMove(300, 200, .{});
    _ = try ui.update();
    try std.testing.expect(style_mod.of(ui.doc, b).background_color.eql(geom.Color.hex(0x111111)));
}

test "paint-only restyles keep cached inline style pointers valid" {
    const ui = try testUi(
        \\<style>body { margin: 0 } .b { color: #111 } .b:hover { color: #222 } .b::after { content: "!" } .b:hover::after { color: #333 }</style>
        \\<div class="b" id="b">hello <span>world</span></div>
    );
    defer ui.destroy();
    const b = try style_mod.querySelector(ui.doc, ui.doc.root, "#b");
    for (0..4) |i| {
        if (i % 2 == 0) ui.ix.pointerMove(5, 5, .{}) else ui.ix.pointerMove(390, 290, .{});
        _ = try ui.update();
        const il = layout.boxOfNode(ui.doc.node(b)).?.inline_layout.?;
        for (il.frags) |f| {
            if (f.kind != .text or f.item.pseudo != .none) continue;
            try std.testing.expect(f.style == style_mod.of(ui.doc, f.item.node));
        }
    }
    try std.testing.expect(style_mod.of(ui.doc, b).color.eql(geom.Color.hex(0x111111)));
}

test "clicking into a placeholder puts the caret at the start of the value" {
    const ui = try testUi(
        \\<style>body { margin: 0; font-size: 10px } input { width: 300px }</style>
        \\<input id="t" placeholder="Ada Lovelace">
    );
    defer ui.destroy();
    const t = try style_mod.querySelector(ui.doc, ui.doc.root, "#t");
    const o = ui.ix.contentOrigin(t).?;
    // press over the middle of the placeholder text
    ui.ix.pointerDown(o[0] + 30, o[1] + 4, 0, .{});
    ui.ix.pointerUp(o[0] + 30, o[1] + 4, 0, .{});
    _ = try ui.update();
    ui.ix.textInput("a");
    _ = try ui.update();
    ui.ix.textInput("b");
    try std.testing.expectEqualStrings("ab", ui.ix.value(t));
}

test "password caret tracks the bullets, not the value bytes" {
    const ui = try testUi(
        \\<style>body { margin: 0; font-size: 10px } input { width: 300px }</style>
        \\<input id="p" type="password">
    );
    defer ui.destroy();
    const p = try style_mod.querySelector(ui.doc, ui.doc.root, "#p");
    const o0 = ui.ix.contentOrigin(p).?;
    ui.ix.pointerDown(o0[0] + 5, o0[1] + 4, 0, .{});
    ui.ix.pointerUp(o0[0] + 5, o0[1] + 4, 0, .{});
    var last_x: f32 = -1;
    var step: f32 = 0;
    const chars = [_][]const u8{ "h", "u", "n", "t", "é", "r", "2" };
    for (chars, 0..) |ch, i| {
        ui.ix.textInput(ch);
        _ = try ui.update();
        const il = layout.boxOfNode(ui.doc.node(p)).?.inline_layout.?;
        const e = ui.ix.edits.get(p).?;
        const c = il.caretAt(p, ui.ix.layoutOffset(p, e, e.caret)).?;
        // every keystroke moves the caret right by exactly one bullet
        if (i == 1) step = c.x - last_x;
        if (i >= 1) try std.testing.expectApproxEqAbs(step, c.x - last_x, 0.01);
        try std.testing.expect(c.x > last_x);
        last_x = c.x;
    }
    try std.testing.expectEqualStrings("huntér2", ui.ix.value(p));
    // clicking past the end maps back to the end of the value
    const o = ui.ix.contentOrigin(p).?;
    try std.testing.expectEqual(@as(?u32, "huntér2".len), ui.ix.offsetAtPoint(p, o[0] + 250, o[1] + 4));
}

test "window drag regions click when the window didn't move" {
    const ui = try testUi(
        \\<style>body { margin: 0 } #p { width: 120px; height: 40px; -webkit-app-region: drag } #p:active { background: red }</style>
        \\<div id="p">pill</div>
    );
    defer ui.destroy();
    const p = try style_mod.querySelector(ui.doc, ui.doc.root, "#p");
    var counter = Counter{};
    _ = try ui.ix.addListener(p, .click, Counter.cb, &counter);
    const Drag = struct {
        var moved = false;
        fn begin(_: ?*anyopaque) bool {
            return moved;
        }
    };
    ui.ix.host.begin_window_drag = Drag.begin;
    // press without moving: the modal drag returns unmoved -> click
    ui.ix.pointerDown(10, 10, 0, .{});
    try std.testing.expectEqual(@as(u32, 1), counter.n);
    try std.testing.expectEqual(@as(u8, 0), ui.ix.buttons);
    try std.testing.expect(!ui.doc.node(p).state.active);
    // dragged: no click, and no press state left behind
    Drag.moved = true;
    ui.ix.pointerDown(10, 10, 0, .{});
    try std.testing.expectEqual(@as(u32, 1), counter.n);
    try std.testing.expectEqual(@as(u8, 0), ui.ix.buttons);
    try std.testing.expect(!ui.doc.node(p).state.active);
    try std.testing.expectEqual(dom.null_id, ui.ix.down_target);
}

test "autofocus focuses an inserted element once" {
    const ui = try testUi("<style>body { margin: 0 }</style><div id=\"host\"></div>");
    defer ui.destroy();
    const host = try style_mod.querySelector(ui.doc, ui.doc.root, "#host");
    const wrap = try ui.doc.createElement("div");
    const input = try ui.doc.createElement("input");
    try ui.doc.setAttribute(input, "autofocus", "");
    ui.doc.appendChild(wrap, input);
    ui.doc.appendChild(host, wrap);
    _ = try ui.update();
    try std.testing.expectEqual(input, ui.doc.focused);
    // only on insertion: blurring and updating again doesn't refocus
    ui.ix.blur();
    _ = try ui.update();
    try std.testing.expectEqual(dom.null_id, ui.doc.focused);
    // an autofocus element removed before the update is ignored
    const other = try ui.doc.createElement("input");
    try ui.doc.setAttribute(other, "autofocus", "");
    ui.doc.appendChild(host, other);
    ui.destroyNode(other);
    _ = try ui.update();
    try std.testing.expectEqual(dom.null_id, ui.doc.focused);
}

test "checkbox, label and typing" {
    const ui = try testUi(
        \\<style>body { margin: 0; font-size: 10px }</style>
        \\<label id="l"><input type="checkbox" id="c"> Remember</label><br><input id="t" value="ab">
    );
    defer ui.destroy();
    const c = try style_mod.querySelector(ui.doc, ui.doc.root, "#c");
    const t = try style_mod.querySelector(ui.doc, ui.doc.root, "#t");
    // click the checkbox
    ui.ix.click(c, 0, 0, .{}, 1);
    try std.testing.expect(ui.doc.node(c).state.checked);
    // clicking the label toggles it back
    ui.ix.click(try style_mod.querySelector(ui.doc, ui.doc.root, "#l"), 0, 0, .{}, 1);
    try std.testing.expect(!ui.doc.node(c).state.checked);
    // focus the text input and type
    ui.ix.focus(t, false);
    ui.ix.textInput("cd");
    try std.testing.expectEqualStrings("abcd", ui.ix.value(t));
    ui.ix.keyDown("ArrowLeft", .{});
    ui.ix.keyDown("Backspace", .{});
    try std.testing.expectEqualStrings("abd", ui.ix.value(t));
    ui.ix.keyDown("a", .{ .meta = true, .ctrl = true });
    ui.ix.textInput("z");
    try std.testing.expectEqualStrings("z", ui.ix.value(t));
    ui.ix.keyDown("z", .{ .meta = true, .ctrl = true });
    try std.testing.expectEqualStrings("abd", ui.ix.value(t));
    _ = try ui.update();
    // tab navigation goes checkbox -> text input
    ui.ix.blur();
    ui.ix.keyDown("Tab", .{});
    try std.testing.expectEqual(c, ui.doc.focused);
    ui.ix.keyDown("Tab", .{});
    try std.testing.expectEqual(t, ui.doc.focused);
}

test "wheel scrolls overflow containers" {
    const ui = try testUi(
        \\<style>body { margin: 0 } .s { height: 100px; overflow: auto } .c { height: 500px }</style>
        \\<div class="s" id="s"><div class="c"></div></div>
    );
    defer ui.destroy();
    const s = try style_mod.querySelector(ui.doc, ui.doc.root, "#s");
    ui.ix.wheel(10, 10, 0, 50, .{});
    try std.testing.expectEqual(@as(f32, 50), ui.doc.node(s).scroll_y);
    ui.ix.wheel(10, 10, 0, 1000, .{});
    try std.testing.expectEqual(@as(f32, 400), ui.doc.node(s).scroll_y);
}

test "css transitions and keyframes" {
    const ui = try testUi(
        \\<style>body { margin: 0 } .b { width: 100px; height: 40px; opacity: 1; transition: opacity 1s linear, width 1s linear }
        \\ .b.off { opacity: 0; width: 200px }
        \\ @keyframes pulse { from { opacity: 1 } 50% { opacity: .2 } to { opacity: 1 } }
        \\ .k { animation: pulse 2s linear infinite; width: 10px; height: 10px }</style>
        \\<div class="b" id="b"></div><div class="k" id="k"></div>
    );
    defer ui.destroy();
    const b = try style_mod.querySelector(ui.doc, ui.doc.root, "#b");
    const k = try style_mod.querySelector(ui.doc, ui.doc.root, "#k");
    try ui.doc.setAttribute(b, "class", "b off");
    ui.tick(0.0);
    _ = try ui.update();
    ui.tick(0.5);
    _ = try ui.update();
    try std.testing.expectApproxEqAbs(@as(f32, 0.5), style_mod.of(ui.doc, b).opacity, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 150), layout.boxOfNode(ui.doc.node(b)).?.w, 0.5);
    try std.testing.expect(ui.wantsFrames());
    // keyframes at t=0.5s of 2s: halfway to the 50% keyframe -> 0.6
    try std.testing.expectApproxEqAbs(@as(f32, 0.6), style_mod.of(ui.doc, k).opacity, 0.02);
    // interrupt: go back; starts from the current value 0.5
    try ui.doc.setAttribute(b, "class", "b");
    _ = try ui.update();
    ui.tick(1.0);
    _ = try ui.update();
    try std.testing.expectApproxEqAbs(@as(f32, 1.0), style_mod.of(ui.doc, b).opacity, 0.01);
    ui.tick(2.0);
    _ = try ui.update();
    try std.testing.expectApproxEqAbs(@as(f32, 100), layout.boxOfNode(ui.doc.node(b)).?.w, 0.5);
}

test "finished animations restore cascaded values without a restyle trigger" {
    const ui = try testUi(
        \\<style>body { margin: 0 }
        \\ @keyframes in { from { opacity: 0; transform: translateY(8px) scale(.98) } }
        \\ .t { width: 50px; height: 20px; box-shadow: 0 4px 12px rgba(0,0,0,.2); animation: in .2s ease-out }
        \\ .m { width: 50px; height: 20px; transform: translateX(0px); transition: transform .2s linear }
        \\ .m.on { transform: translateX(40px) }</style>
        \\<div class="t" id="t"></div><div class="m" id="m"></div>
    );
    defer ui.destroy();
    const t = try style_mod.querySelector(ui.doc, ui.doc.root, "#t");
    const m = try style_mod.querySelector(ui.doc, ui.doc.root, "#m");
    try ui.doc.setAttribute(m, "class", "m on");
    var now: f64 = 0;
    while (now < 0.6) : (now += 1.0 / 60.0) {
        ui.tick(now);
        _ = try ui.update();
    }
    const ts = style_mod.of(ui.doc, t);
    try std.testing.expectApproxEqAbs(@as(f32, 1), ts.opacity, 0.001);
    try std.testing.expectEqual(@as(usize, 0), ts.transform.len);
    try std.testing.expectEqual(@as(usize, 1), ts.box_shadow.len);
    try std.testing.expectApproxEqAbs(@as(f32, 12), ts.box_shadow[0].blur, 0.001);
    // the transition's end value is the cascaded one, not frame-arena data
    const ms = style_mod.of(ui.doc, m);
    try std.testing.expectEqual(@as(usize, 1), ms.transform.len);
    try std.testing.expect(!ui.wantsFrames());
}

test "opacity layers cover box-shadow and overflowing descendants" {
    const ui = try testUi(
        \\<style>body { margin: 0 } .l { position: absolute; left: 50px; top: 50px; width: 100px; height: 40px; opacity: .5; box-shadow: 0 10px 20px #000 }
        \\ .o { position: absolute; left: 90px; top: 60px; width: 30px; height: 30px; background: red }</style>
        \\<div class="l"><div class="o"></div></div>
    );
    defer ui.destroy();
    var found = false;
    for (ui.dl.cmds.items) |c| switch (c) {
        .push_layer => |l| {
            found = true;
            // border box is 50..150 x 50..90; shadow reaches ~30px further down
            try std.testing.expect(l.bounds.y + l.bounds.h >= 90 + 10 + 25);
            try std.testing.expect(l.bounds.x <= 50 - 25);
            // the absolutely positioned child overflows to x = 170
            try std.testing.expect(l.bounds.x + l.bounds.w >= 170);
        },
        else => {},
    };
    try std.testing.expect(found);
}

test "springs" {
    const ui = try testUi(
        \\<style>body { margin: 0 } .b { width: 10px; height: 10px }</style><div class="b" id="b"></div>
    );
    defer ui.destroy();
    const b = try style_mod.querySelector(ui.doc, ui.doc.root, "#b");
    try ui.animator.springTo(b, .opacity, .{ .num = 0 }, .{});
    var t: f64 = 0;
    while (t < 3) : (t += 1.0 / 60.0) {
        ui.tick(t);
        _ = try ui.update();
    }
    try std.testing.expect(!ui.animator.active());
    try std.testing.expectApproxEqAbs(@as(f32, 0), style_mod.of(ui.doc, b).opacity, 0.001);
    // the resting value survives restyles
    ui.doc.markStyleDirty(b);
    _ = try ui.update();
    try std.testing.expectApproxEqAbs(@as(f32, 0), style_mod.of(ui.doc, b).opacity, 0.001);
}

test "select popup" {
    const ui = try testUi(
        \\<style>body { margin: 0 }</style><select id="s"><option value="a">Alpha</option><option value="b" selected>Beta</option><option value="c">Gamma</option></select>
    );
    defer ui.destroy();
    const sel = try style_mod.querySelector(ui.doc, ui.doc.root, "#s");
    var counter = Counter{};
    _ = try ui.ix.addListener(sel, .change, Counter.cb, &counter);
    try std.testing.expectEqualStrings("b", ui.ix.value(sel));
    ui.ix.click(sel, 0, 0, .{}, 1);
    try std.testing.expect(ui.ix.popup != 0);
    _ = try ui.update();
    ui.ix.keyDown("ArrowDown", .{});
    ui.ix.keyDown("Enter", .{});
    try std.testing.expectEqual(@as(dom.NodeId, 0), ui.ix.popup);
    try std.testing.expectEqualStrings("c", ui.ix.value(sel));
    try std.testing.expectEqual(@as(u32, 1), counter.n);
    // clicking an option in the popup
    ui.ix.click(sel, 0, 0, .{}, 1);
    _ = try ui.update();
    const first = ui.doc.node(ui.ix.popup).first_child;
    const b = layout.boxOfNode(ui.doc.node(first)).?;
    const o = ui.ix.contentOrigin(first).?;
    _ = b;
    ui.ix.pointerDown(o[0] + 2, o[1] + 2, 0, .{});
    ui.ix.pointerUp(o[0] + 2, o[1] + 2, 0, .{});
    try std.testing.expectEqualStrings("a", ui.ix.value(sel));
}


test "nowrap shrink-to-fit boxes fit their text" {
    // spaces in nowrap text are not break opportunities, so they count
    // toward min-content (an absolutely positioned tooltip was too narrow)
    const ui = try testUi(
        \\<style>body { margin: 0; font-size: 14px } .h { position: relative; display: inline-flex; margin: 50px }
        \\ .t { position: absolute; left: 50%; bottom: 100%; transform: translateX(-50%); padding: 4px 8px; font-size: 12px; white-space: nowrap }
        \\ .w { position: absolute; left: 50%; top: 100%; padding: 4px 8px; font-size: 12px }</style>
        \\<div class="h"><button>Hover me</button><div class="t" id="t">Tooltips are CSS :hover</div><div class="w" id="w">wraps at spaces normally</div></div>
    );
    defer ui.destroy();
    const t = try style_mod.querySelector(ui.doc, ui.doc.root, "#t");
    const b = layout.boxOfNode(ui.doc.node(t)).?;
    var text_w: f32 = 0;
    for (b.inline_layout.?.frags) |f| text_w = @max(text_w, f.x + f.w);
    try std.testing.expect(b.w - b.padding.horizontal() >= text_w - 0.01);
    // normal white-space still shrinks to the widest word, not the sum
    const w = try style_mod.querySelector(ui.doc, ui.doc.root, "#w");
    const wl = layout.boxOfNode(ui.doc.node(w)).?.inline_layout.?;
    try std.testing.expect(wl.lines.len > 1);
}
