//! Style-data lifetime regressions. Styles shallow-copy inherited slices
//! (font_family, text_shadow, custom property maps) out of their ancestors'
//! arenas, and cached layout holds *Style pointers, so an arena may only be
//! freed once nothing computed from it remains. These run under a quarantining
//! allocator (freed memory poisoned, never reused) so a dangling read faults
//! deterministically instead of depending on allocator reuse.
const std = @import("std");
const font = @import("text/font.zig");
const style_mod = @import("style.zig");
const Ui = @import("ui.zig").Ui;
const Quarantine = @import("quarantine.zig").Quarantine;

fn makeUi(q: *Quarantine, components: bool, markup: []const u8) !*Ui {
    const gpa = q.allocator();
    const ui = try Ui.create(gpa, .{ .fonts = try font.MockBackend.create(gpa) });
    ui.owns_fonts = true;
    if (components) try ui.useComponents();
    try ui.setHtml(markup);
    ui.resize(400, 300, 1);
    ui.tick(0);
    _ = try ui.update();
    return ui;
}

// The kitchen "hover sweep over styled components" crash (CI segfault at 0x5
// on macOS Intel): moving the pointer in and out of `.eb-app` toggles its
// :hover. The component sheet has ancestor :hover rules, so the whole subtree
// is restyled; `.eb-app` got a new arena and the old one was freed while its
// descendants' old styles still pointed at their inherited `font_family`
// (from `font: ... var(--eb-font)`), which `layoutEqual` then read.
test "hover sweep over component styles keeps inherited style data alive" {
    var q = Quarantine.init(std.testing.allocator);
    defer q.deinit();
    const ui = try makeUi(&q, true,
        \\<style>body { margin: 0 } .nav { width: 180px; padding: 8px }</style>
        \\<div class="eb-app" style="display: flex; gap: 16px; padding: 8px">
        \\ <nav class="nav eb-nav"><button class="eb-nav-item">Components</button><button class="eb-nav-item">Forms</button>
        \\  <button class="eb-nav-item">Todo</button><button class="eb-nav-item">Motion</button></nav>
        \\ <div style="display: flex; flex-direction: column; gap: 8px">
        \\  <button class="eb-btn">Primary</button><button class="eb-btn outline">Outline</button>
        \\  <input class="eb-input" placeholder="Placeholder text">
        \\  <label class="eb-switch"><input type="checkbox"><span></span></label>
        \\ </div>
        \\</div>
    );
    defer ui.destroy();
    var now: f64 = 0;
    for (0..6) |pass| {
        var y: f32 = 10;
        while (y < 260) : (y += 9) {
            ui.ix.pointerMove(if (pass % 2 == 1) 300 else 90, y, .{});
            now += 0.016;
            ui.tick(now);
            _ = try ui.update();
        }
    }
    const nav = try style_mod.querySelector(ui.doc, ui.doc.root, ".eb-nav-item");
    try std.testing.expect(style_mod.of(ui.doc, nav).font_family.len > 0);
}

// Same class through destruction instead of restyle: a node moved out of a
// subtree keeps its old style (inheriting from the old ancestors) until the
// next style pass, so destroying those ancestors must not free that data.
test "moving a node out of a destroyed ancestor keeps its inherited style data alive" {
    var q = Quarantine.init(std.testing.allocator);
    defer q.deinit();
    const ui = try makeUi(&q, false,
        \\<style>.p { --f: "Inter", sans-serif; font-family: var(--f); --c: #123; text-shadow: 0 1px 2px red }
        \\ .k { color: var(--c) } #q { font-family: Arial, serif }</style>
        \\<div class="p" id="p"><div class="k" id="k">some <b>text</b></div></div><div id="q"></div>
    );
    defer ui.destroy();
    const k = try style_mod.querySelector(ui.doc, ui.doc.root, "#k");
    const qn = try style_mod.querySelector(ui.doc, ui.doc.root, "#q");
    const p = try style_mod.querySelector(ui.doc, ui.doc.root, "#p");
    try std.testing.expectEqualStrings("Inter", style_mod.of(ui.doc, k).font_family[0]);
    ui.doc.appendChild(qn, k);
    ui.destroyNode(p);
    // hit testing between frames still walks cached layout
    ui.ix.pointerMove(5, 5, .{});
    _ = try ui.update();
    try std.testing.expectEqualStrings("Arial", style_mod.of(ui.doc, k).font_family[0]);
}
