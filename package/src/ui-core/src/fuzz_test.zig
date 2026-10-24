//! Interaction fuzzer: drives a kitchen-sink document with seeded random
//! pointer, keyboard, text, DOM-mutation and animation steps, and checks
//! engine invariants after every frame. Runs under the test allocator with
//! safety checks, so leaks, double frees, out-of-bounds and stale ids panic
//! at the faulty line instead of corrupting memory.
const std = @import("std");
const dom = @import("dom.zig");
const font = @import("text/font.zig");
const style_mod = @import("style.zig");
const ui_mod = @import("ui.zig");
const Ui = ui_mod.Ui;

const page =
    \\<style>
    \\ body { margin: 0; font-size: 12px }
    \\ .b { padding: 4px; background: #eee; transition: background-color .2s, transform .15s }
    \\ .b:hover { background: #ccc; transform: translateY(-1px) }
    \\ .b:active { box-shadow: 0 2px 6px rgba(0,0,0,.3) }
    \\ .card { padding: 6px; border: 1px solid #ddd; box-shadow: 0 4px 12px rgba(0,0,0,.2); opacity: .9 }
    \\ .card::after { content: "!"; color: red }
    \\ .card:hover::after { color: blue }
    \\ @keyframes pop { from { opacity: 0; transform: scale(.9) } }
    \\ .pop { animation: pop .1s ease-out }
    \\ .scroll { height: 60px; overflow: auto }
    \\ input:focus, textarea:focus { outline: 2px solid blue }
    \\ ul li:nth-child(odd) { background: #fafafa }
    \\</style>
    \\<div class="card pop">
    \\ <button class="b" id="b1">One</button><button class="b">Two é</button>
    \\ <input id="t" placeholder="Ada Lovelace"><input type="password" id="pw">
    \\ <textarea id="ta" placeholder="Bio">line1
    \\line2 日本語</textarea>
    \\ <select id="s"><option value="a">Alpha</option><option value="b" selected>Beta</option><option value="c">Gamma</option></select>
    \\ <label><input type="checkbox"> check</label>
    \\ <div class="scroll"><ul><li>one</li><li>two 👍</li><li>three</li><li>four</li><li>five</li><li>six</li></ul></div>
    \\ <p>Some <b>bold</b> and <i>italic</i> text that wraps across the line.</p>
    \\</div>
;

const keys = [_][]const u8{ "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete", "Enter", "Tab", "Escape", "Home", "End", " ", "a", "z", "c", "v" };
const texts = [_][]const u8{ "a", "Z", "é", "日本", "👍", "•", " ", "hello", "x\ny", "\t" };
const tags = [_][]const u8{ "div", "span", "button", "input", "li", "p", "b" };
const classes = [_][]const u8{ "b", "card", "pop", "scroll", "card pop", "" };

fn randomNode(r: std.Random, doc: *dom.Document) dom.NodeId {
    // walk to a random node in document order
    const root = doc.documentElement();
    var n: usize = 0;
    var cur = root;
    while (cur != dom.null_id) : (cur = doc.nextInTree(cur, root)) n += 1;
    var pick = r.uintLessThan(usize, n);
    cur = root;
    while (pick > 0) : (pick -= 1) cur = doc.nextInTree(cur, root);
    return cur;
}

fn checkInvariants(ui: *Ui) !void {
    const doc = ui.doc;
    // ids held across frames refer to live nodes (or none)
    for ([_]dom.NodeId{ doc.focused, doc.hovered, doc.active }) |id| {
        if (id != dom.null_id) try std.testing.expect(doc.get(id) != null);
    }
    // edit states: caret/anchor inside the value, on UTF-8 boundaries
    var it = ui.ix.edits.iterator();
    while (it.next()) |kv| {
        const e = kv.value_ptr.*;
        const v = e.text.items;
        try std.testing.expect(e.caret <= v.len and e.anchor <= v.len);
        for ([_]u32{ e.caret, e.anchor }) |o| {
            if (o < v.len) try std.testing.expect(v[o] & 0xC0 != 0x80);
        }
        try std.testing.expect(std.unicode.utf8ValidateSlice(v));
    }
}

fn run(seed: u64, steps: usize) !void {
    const gpa = std.testing.allocator;
    const ui = try Ui.create(gpa, .{ .fonts = try font.MockBackend.create(gpa) });
    ui.owns_fonts = true;
    defer ui.destroy();
    try ui.setHtml(page);
    ui.resize(420, 320, 2);
    var prng = std.Random.DefaultPrng.init(seed);
    const r = prng.random();
    var now: f64 = 0;
    ui.tick(now);
    _ = try ui.update();

    for (0..steps) |_| {
        const x = r.float(f32) * 440 - 10;
        const y = r.float(f32) * 340 - 10;
        switch (r.uintLessThan(u8, 14)) {
            0, 1, 2 => ui.ix.pointerMove(x, y, .{}),
            3 => ui.ix.pointerDown(x, y, 0, .{ .shift = r.boolean() }),
            4 => ui.ix.pointerUp(x, y, 0, .{}),
            5 => ui.ix.wheel(x, y, 0, r.float(f32) * 80 - 40, .{}),
            6 => ui.ix.keyDown(keys[r.uintLessThan(usize, keys.len)], .{ .shift = r.boolean(), .meta = r.uintLessThan(u8, 4) == 0 }),
            7 => ui.ix.textInput(texts[r.uintLessThan(usize, texts.len)]),
            8 => {
                const id = randomNode(r, ui.doc);
                if (ui.doc.node(id).kind == .element) try ui.doc.setAttribute(id, "class", classes[r.uintLessThan(usize, classes.len)]);
            },
            9 => {
                const id = randomNode(r, ui.doc);
                const n = ui.doc.node(id);
                if (n.kind == .element and n.tag != ui.doc.atoms.html and n.tag != ui.doc.atoms.body and n.tag != ui.doc.atoms.head) ui.destroyNode(id);
            },
            10 => {
                const parent = randomNode(r, ui.doc);
                if (ui.doc.node(parent).kind == .element) {
                    const el = try ui.doc.createElement(tags[r.uintLessThan(usize, tags.len)]);
                    try ui.doc.setAttribute(el, "class", classes[r.uintLessThan(usize, classes.len)]);
                    ui.doc.appendChild(el, try ui.doc.createText(texts[r.uintLessThan(usize, texts.len)]));
                    ui.doc.appendChild(parent, el);
                }
            },
            11 => {
                const id = randomNode(r, ui.doc);
                if (ui.doc.node(id).kind == .element) ui.ix.focus(id, r.boolean());
            },
            12 => ui.ix.pointerLeaveWindow(),
            else => {},
        }
        // frames at irregular intervals, sometimes several events per frame
        if (r.uintLessThan(u8, 3) != 0) {
            now += r.float(f64) * 0.08;
            ui.tick(now);
            _ = try ui.update();
            try checkInvariants(ui);
        }
    }
}

test "interaction fuzz" {
    var seed: u64 = 1;
    while (seed <= 24) : (seed += 1) {
        run(seed, 1500) catch |err| {
            std.debug.print("interaction fuzz failed with seed {d}\n", .{seed});
            return err;
        };
    }
}
