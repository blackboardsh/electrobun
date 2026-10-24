//! Forgiving HTML fragment parser. Builds nodes directly into a Document.
//! Implements the parts of the HTML5 tree-construction rules that matter for
//! app markup: void elements, raw text elements, implied end tags for p/li/
//! option/tr/td, entity decoding, and <style> collection.
const std = @import("std");
const dom = @import("dom.zig");

const Document = dom.Document;
const NodeId = dom.NodeId;
const Allocator = std.mem.Allocator;

pub const Options = struct {
    /// add <style> element contents as document stylesheets (otherwise they
    /// stay in the tree as text)
    collect_styles: bool = true,
    /// keep whitespace-only text nodes (they are ignored by block/flex layout
    /// anyway, but matter inside inline formatting contexts)
    keep_whitespace: bool = true,
    /// when parsing into the document node, create <html><head><body> like a
    /// browser does (explicit html/head/body tags merge into them)
    implicit_root: bool = true,
};

/// The document's <body>, creating html/head/body if needed.
pub fn ensureBody(doc: *Document) Error!NodeId {
    var html_el = doc.documentElement();
    if (html_el == dom.null_id or doc.node(html_el).tag != doc.atoms.html) {
        html_el = try doc.createElement("html");
        // move any existing top-level nodes into the new body
        const body = try doc.createElement("body");
        const head = try doc.createElement("head");
        var c = doc.node(doc.root).first_child;
        while (c != dom.null_id) {
            const next = doc.node(c).next;
            doc.appendChild(body, c);
            c = next;
        }
        doc.appendChild(doc.root, html_el);
        doc.appendChild(html_el, head);
        doc.appendChild(html_el, body);
        return body;
    }
    return childWithTag(doc, html_el, doc.atoms.body) orelse blk: {
        const body = try doc.createElement("body");
        doc.appendChild(html_el, body);
        break :blk body;
    };
}

fn childWithTag(doc: *Document, parent: NodeId, tag: dom.Atom) ?NodeId {
    var c = doc.node(parent).first_child;
    while (c != dom.null_id) : (c = doc.node(c).next) {
        if (doc.node(c).kind == .element and doc.node(c).tag == tag) return c;
    }
    return null;
}

pub const Error = error{OutOfMemory};

/// Parse `src` and append the resulting nodes to `parent`.
pub fn parseInto(doc: *Document, parent: NodeId, src: []const u8, opts: Options) Error!void {
    var p = Parser{ .doc = doc, .src = src, .opts = opts };
    defer p.stack.deinit(doc.gpa);
    if (parent == doc.root and opts.implicit_root) {
        const body = try ensureBody(doc);
        p.html_el = doc.node(body).parent;
        p.body_el = body;
        try p.stack.append(doc.gpa, body);
    } else {
        try p.stack.append(doc.gpa, parent);
    }
    try p.run();
}

const block_closers_p = [_][]const u8{ "address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul" };

fn inList(list: []const []const u8, s: []const u8) bool {
    for (list) |x| if (std.mem.eql(u8, x, s)) return true;
    return false;
}

const Parser = struct {
    doc: *Document,
    src: []const u8,
    pos: usize = 0,
    opts: Options,
    stack: std.ArrayList(NodeId) = .empty,
    text_buf: std.ArrayList(u8) = .empty,
    html_el: NodeId = dom.null_id,
    body_el: NodeId = dom.null_id,

    fn current(p: *Parser) NodeId {
        return p.stack.items[p.stack.items.len - 1];
    }

    fn currentTag(p: *Parser) []const u8 {
        const id = p.current();
        const n = p.doc.node(id);
        if (n.kind != .element) return "";
        return p.doc.interner.str(n.tag);
    }

    fn run(p: *Parser) Error!void {
        defer p.text_buf.deinit(p.doc.gpa);
        while (p.pos < p.src.len) {
            const c = p.src[p.pos];
            if (c == '<') {
                if (p.startsWith("<!--")) {
                    try p.flushText();
                    const end = std.mem.indexOfPos(u8, p.src, p.pos + 4, "-->") orelse p.src.len;
                    p.pos = @min(end + 3, p.src.len);
                    continue;
                }
                if (p.startsWith("<!") or p.startsWith("<?")) {
                    try p.flushText();
                    const end = std.mem.indexOfScalarPos(u8, p.src, p.pos, '>') orelse p.src.len;
                    p.pos = @min(end + 1, p.src.len);
                    continue;
                }
                if (p.pos + 1 < p.src.len and p.src[p.pos + 1] == '/') {
                    if (p.pos + 2 < p.src.len and std.ascii.isAlphabetic(p.src[p.pos + 2])) {
                        try p.flushText();
                        p.endTag();
                        continue;
                    }
                } else if (p.pos + 1 < p.src.len and std.ascii.isAlphabetic(p.src[p.pos + 1])) {
                    try p.flushText();
                    try p.startTag();
                    continue;
                }
            }
            if (c == '&') {
                try p.entity();
                continue;
            }
            try p.text_buf.append(p.doc.gpa, c);
            p.pos += 1;
        }
        try p.flushText();
    }

    fn startsWith(p: *Parser, s: []const u8) bool {
        return std.mem.startsWith(u8, p.src[p.pos..], s);
    }

    fn flushText(p: *Parser) Error!void {
        if (p.text_buf.items.len == 0) return;
        defer p.text_buf.clearRetainingCapacity();
        const all_ws = for (p.text_buf.items) |ch| {
            if (!std.ascii.isWhitespace(ch)) break false;
        } else true;
        if (all_ws and !p.opts.keep_whitespace) return;
        const parent = p.current();
        // merge into a preceding text node
        const last = p.doc.node(parent).last_child;
        if (last != dom.null_id and p.doc.node(last).kind == .text) {
            try p.doc.node(last).text.appendSlice(p.doc.gpa, p.text_buf.items);
            return;
        }
        const t = try p.doc.createText(p.text_buf.items);
        p.doc.appendChild(parent, t);
    }

    fn readName(p: *Parser) []const u8 {
        const start = p.pos;
        while (p.pos < p.src.len) {
            const ch = p.src[p.pos];
            if (std.ascii.isWhitespace(ch) or ch == '>' or ch == '/' or ch == '=') break;
            p.pos += 1;
        }
        return p.src[start..p.pos];
    }

    fn skipWs(p: *Parser) void {
        while (p.pos < p.src.len and std.ascii.isWhitespace(p.src[p.pos])) p.pos += 1;
    }

    fn startTag(p: *Parser) Error!void {
        const gpa = p.doc.gpa;
        p.pos += 1;
        const raw_name = p.readName();
        var name_buf: [64]u8 = undefined;
        const name = if (raw_name.len <= name_buf.len) std.ascii.lowerString(&name_buf, raw_name) else raw_name;

        p.applyImpliedEnds(name);

        if (p.body_el != dom.null_id and (std.mem.eql(u8, name, "html") or std.mem.eql(u8, name, "body") or std.mem.eql(u8, name, "head"))) {
            // merge attributes into the implicit element and continue in body
            const target = if (std.mem.eql(u8, name, "html")) p.html_el else if (std.mem.eql(u8, name, "body")) p.body_el else childWithTag(p.doc, p.html_el, p.doc.atoms.head) orelse p.body_el;
            try p.readAttrsInto(target);
            if (std.mem.eql(u8, name, "head")) {
                try p.stack.append(gpa, target);
            } else {
                p.stack.shrinkRetainingCapacity(1);
                p.stack.items[0] = p.body_el;
            }
            return;
        }

        const el = try p.doc.createElement(name);
        // attributes
        var self_closing = false;
        while (p.pos < p.src.len) {
            p.skipWs();
            if (p.pos >= p.src.len) break;
            const ch = p.src[p.pos];
            if (ch == '>') {
                p.pos += 1;
                break;
            }
            if (ch == '/') {
                p.pos += 1;
                if (p.pos < p.src.len and p.src[p.pos] == '>') {
                    self_closing = true;
                    p.pos += 1;
                    break;
                }
                continue;
            }
            const aname = p.readAttrName();
            if (aname.len == 0) {
                p.pos += 1;
                continue;
            }
            p.skipWs();
            var value: std.ArrayList(u8) = .empty;
            defer value.deinit(gpa);
            if (p.pos < p.src.len and p.src[p.pos] == '=') {
                p.pos += 1;
                p.skipWs();
                try p.readAttrValue(&value);
            }
            if (p.doc.getAttribute(el, aname) == null) try p.doc.setAttribute(el, aname, value.items);
        }

        p.doc.appendChild(p.current(), el);
        if (dom.isVoidElement(name) or self_closing) return;

        if (std.mem.eql(u8, name, "style") or std.mem.eql(u8, name, "script") or std.mem.eql(u8, name, "textarea") or std.mem.eql(u8, name, "title")) {
            const close = rawEnd(p.src, p.pos, name);
            const body = p.src[p.pos..close.start];
            p.pos = close.end;
            if (std.mem.eql(u8, name, "style") and p.opts.collect_styles) {
                _ = p.doc.addStylesheet(body) catch |e| switch (e) {
                    error.OutOfMemory => return error.OutOfMemory,
                };
            } else if (!std.mem.eql(u8, name, "script")) {
                var decoded: std.ArrayList(u8) = .empty;
                defer decoded.deinit(gpa);
                if (std.mem.eql(u8, name, "textarea")) {
                    // a leading newline is dropped
                    const b = if (body.len > 0 and body[0] == '\n') body[1..] else body;
                    try decodeEntities(gpa, b, &decoded);
                } else try decoded.appendSlice(gpa, body);
                if (decoded.items.len > 0) {
                    const t = try p.doc.createText(decoded.items);
                    p.doc.appendChild(el, t);
                }
            }
            return;
        }
        try p.stack.append(gpa, el);
    }

    fn readAttrsInto(p: *Parser, el: NodeId) Error!void {
        const gpa = p.doc.gpa;
        while (p.pos < p.src.len) {
            p.skipWs();
            if (p.pos >= p.src.len) break;
            const ch = p.src[p.pos];
            if (ch == '>') {
                p.pos += 1;
                break;
            }
            if (ch == '/') {
                p.pos += 1;
                continue;
            }
            const aname = p.readAttrName();
            if (aname.len == 0) {
                p.pos += 1;
                continue;
            }
            p.skipWs();
            var value: std.ArrayList(u8) = .empty;
            defer value.deinit(gpa);
            if (p.pos < p.src.len and p.src[p.pos] == '=') {
                p.pos += 1;
                p.skipWs();
                try p.readAttrValue(&value);
            }
            try p.doc.setAttribute(el, aname, value.items);
        }
    }

    fn readAttrName(p: *Parser) []const u8 {
        const start = p.pos;
        // template bindings may use characters like @, :, . in attribute names
        while (p.pos < p.src.len) {
            const ch = p.src[p.pos];
            if (std.ascii.isWhitespace(ch) or ch == '>' or ch == '=' or (ch == '/' and p.pos + 1 < p.src.len and p.src[p.pos + 1] == '>')) break;
            p.pos += 1;
        }
        return p.src[start..p.pos];
    }

    fn readAttrValue(p: *Parser, out: *std.ArrayList(u8)) Error!void {
        const gpa = p.doc.gpa;
        if (p.pos >= p.src.len) return;
        const q = p.src[p.pos];
        if (q == '"' or q == '\'') {
            p.pos += 1;
            const end = std.mem.indexOfScalarPos(u8, p.src, p.pos, q) orelse p.src.len;
            try decodeEntities(gpa, p.src[p.pos..end], out);
            p.pos = @min(end + 1, p.src.len);
            return;
        }
        if (q == '{') {
            // unquoted template expression: {expr} with balanced braces
            var depth: usize = 0;
            const start = p.pos;
            while (p.pos < p.src.len) : (p.pos += 1) {
                if (p.src[p.pos] == '{') depth += 1;
                if (p.src[p.pos] == '}') {
                    depth -= 1;
                    if (depth == 0) {
                        p.pos += 1;
                        break;
                    }
                }
            }
            try out.appendSlice(gpa, p.src[start..p.pos]);
            return;
        }
        const start = p.pos;
        while (p.pos < p.src.len and !std.ascii.isWhitespace(p.src[p.pos]) and p.src[p.pos] != '>') p.pos += 1;
        try decodeEntities(gpa, p.src[start..p.pos], out);
    }

    fn applyImpliedEnds(p: *Parser, name: []const u8) void {
        const cur = p.currentTag();
        if (std.mem.eql(u8, cur, "p") and inList(&block_closers_p, name)) {
            p.popTo("p");
            return;
        }
        if (std.mem.eql(u8, name, "li")) p.closeIfOpenWithin("li", &.{ "ul", "ol", "menu" });
        if (std.mem.eql(u8, name, "dt") or std.mem.eql(u8, name, "dd")) {
            p.closeIfOpenWithin("dt", &.{"dl"});
            p.closeIfOpenWithin("dd", &.{"dl"});
        }
        if (std.mem.eql(u8, name, "option")) p.closeIfOpenWithin("option", &.{ "select", "datalist", "optgroup" });
        if (std.mem.eql(u8, name, "tr")) p.closeIfOpenWithin("tr", &.{ "table", "tbody", "thead", "tfoot" });
        if (std.mem.eql(u8, name, "td") or std.mem.eql(u8, name, "th")) {
            p.closeIfOpenWithin("td", &.{"tr"});
            p.closeIfOpenWithin("th", &.{"tr"});
        }
    }

    /// If `tag` is open above the nearest `boundary`, pop up to and including it.
    fn closeIfOpenWithin(p: *Parser, tag: []const u8, boundaries: []const []const u8) void {
        var i = p.stack.items.len;
        while (i > 1) {
            i -= 1;
            const n = p.doc.node(p.stack.items[i]);
            if (n.kind != .element) return;
            const t = p.doc.interner.str(n.tag);
            if (std.mem.eql(u8, t, tag)) {
                p.stack.shrinkRetainingCapacity(i);
                return;
            }
            if (inList(boundaries, t)) return;
        }
    }

    fn popTo(p: *Parser, tag: []const u8) void {
        var i = p.stack.items.len;
        while (i > 1) {
            i -= 1;
            const n = p.doc.node(p.stack.items[i]);
            if (n.kind == .element and std.mem.eql(u8, p.doc.interner.str(n.tag), tag)) {
                p.stack.shrinkRetainingCapacity(i);
                return;
            }
        }
    }

    fn endTag(p: *Parser) void {
        p.pos += 2;
        const raw = p.readName();
        const end = std.mem.indexOfScalarPos(u8, p.src, p.pos, '>') orelse p.src.len;
        p.pos = @min(end + 1, p.src.len);
        var buf: [64]u8 = undefined;
        const name = if (raw.len <= buf.len) std.ascii.lowerString(&buf, raw) else raw;
        if (p.body_el != dom.null_id and (std.mem.eql(u8, name, "html") or std.mem.eql(u8, name, "body"))) return;
        // find matching open element; ignore stray end tags
        var i = p.stack.items.len;
        while (i > 1) {
            i -= 1;
            const n = p.doc.node(p.stack.items[i]);
            if (n.kind == .element and std.mem.eql(u8, p.doc.interner.str(n.tag), name)) {
                p.stack.shrinkRetainingCapacity(i);
                return;
            }
        }
    }

    fn entity(p: *Parser) Error!void {
        const gpa = p.doc.gpa;
        const end = std.mem.indexOfScalarPos(u8, p.src, p.pos, ';');
        if (end) |e| {
            if (e - p.pos <= 12) {
                var tmp: [4]u8 = undefined;
                if (decodeEntity(p.src[p.pos + 1 .. e], &tmp)) |bytes| {
                    try p.text_buf.appendSlice(gpa, bytes);
                    p.pos = e + 1;
                    return;
                }
            }
        }
        try p.text_buf.append(gpa, '&');
        p.pos += 1;
    }
};

fn rawEnd(src: []const u8, from: usize, name: []const u8) struct { start: usize, end: usize } {
    var i = from;
    while (std.mem.indexOfPos(u8, src, i, "</")) |s| {
        const after = s + 2;
        if (after + name.len <= src.len and std.ascii.eqlIgnoreCase(src[after .. after + name.len], name)) {
            const gt = std.mem.indexOfScalarPos(u8, src, after, '>') orelse src.len;
            return .{ .start = s, .end = @min(gt + 1, src.len) };
        }
        i = after;
    }
    return .{ .start = src.len, .end = src.len };
}

const named_entities = std.StaticStringMap(u21).initComptime(.{
    .{ "amp", '&' },      .{ "lt", '<' },        .{ "gt", '>' },      .{ "quot", '"' },
    .{ "apos", '\'' },    .{ "nbsp", 0xa0 },     .{ "copy", 0xa9 },   .{ "reg", 0xae },
    .{ "trade", 0x2122 }, .{ "hellip", 0x2026 }, .{ "mdash", 0x2014 }, .{ "ndash", 0x2013 },
    .{ "laquo", 0xab },   .{ "raquo", 0xbb },    .{ "bull", 0x2022 }, .{ "middot", 0xb7 },
    .{ "times", 0xd7 },   .{ "divide", 0xf7 },   .{ "deg", 0xb0 },    .{ "plusmn", 0xb1 },
    .{ "larr", 0x2190 },  .{ "uarr", 0x2191 },   .{ "rarr", 0x2192 }, .{ "darr", 0x2193 },
    .{ "harr", 0x2194 },  .{ "lsquo", 0x2018 },  .{ "rsquo", 0x2019 }, .{ "ldquo", 0x201c },
    .{ "rdquo", 0x201d }, .{ "euro", 0x20ac },   .{ "pound", 0xa3 },  .{ "yen", 0xa5 },
    .{ "cent", 0xa2 },    .{ "sect", 0xa7 },     .{ "para", 0xb6 },   .{ "check", 0x2713 },
    .{ "hearts", 0x2665 }, .{ "star", 0x2606 },  .{ "starf", 0x2605 }, .{ "ensp", 0x2002 },
    .{ "emsp", 0x2003 },  .{ "thinsp", 0x2009 }, .{ "zwj", 0x200d },  .{ "zwnj", 0x200c },
    .{ "shy", 0xad },     .{ "iexcl", 0xa1 },    .{ "iquest", 0xbf }, .{ "frac12", 0xbd },
    .{ "frac14", 0xbc },  .{ "frac34", 0xbe },   .{ "micro", 0xb5 },  .{ "infin", 0x221e },
    .{ "ne", 0x2260 },    .{ "le", 0x2264 },     .{ "ge", 0x2265 },   .{ "minus", 0x2212 },
});

fn decodeEntity(name: []const u8, buf: *[4]u8) ?[]const u8 {
    if (name.len == 0) return null;
    var cp: u21 = undefined;
    if (name[0] == '#') {
        const v = if (name.len > 1 and (name[1] == 'x' or name[1] == 'X'))
            std.fmt.parseInt(u21, name[2..], 16) catch return null
        else
            std.fmt.parseInt(u21, name[1..], 10) catch return null;
        cp = if (v == 0 or v > 0x10ffff or (v >= 0xd800 and v <= 0xdfff)) 0xfffd else v;
    } else {
        cp = named_entities.get(name) orelse return null;
    }
    const len = std.unicode.utf8Encode(cp, buf) catch return null;
    return buf[0..len];
}

pub fn decodeEntities(gpa: Allocator, s: []const u8, out: *std.ArrayList(u8)) Error!void {
    var i: usize = 0;
    while (i < s.len) {
        if (s[i] == '&') {
            if (std.mem.indexOfScalarPos(u8, s, i, ';')) |e| {
                if (e - i <= 12) {
                    var tmp: [4]u8 = undefined;
                    if (decodeEntity(s[i + 1 .. e], &tmp)) |bytes| {
                        try out.appendSlice(gpa, bytes);
                        i = e + 1;
                        continue;
                    }
                }
            }
        }
        try out.append(gpa, s[i]);
        i += 1;
    }
}

fn roundTrip(src: []const u8, expected: []const u8) !void {
    const doc = try Document.init(std.testing.allocator);
    defer doc.deinit();
    try parseInto(doc, doc.root, src, .{ .implicit_root = false });
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(std.testing.allocator);
    try doc.serialize(doc.root, &out);
    try std.testing.expectEqualStrings(expected, out.items);
}

test "html basics" {
    try roundTrip("<div class=card><p>Hello &amp; <b>world</b></p><br><input type=text disabled></div>", "<div class=\"card\"><p>Hello &amp; <b>world</b></p><br><input type=\"text\" disabled></div>");
    try roundTrip("<ul><li>a<li>b</ul>", "<ul><li>a</li><li>b</li></ul>");
    try roundTrip("<p>one<div>two</div>", "<p>one</p><div>two</div>");
    try roundTrip("<DIV Id='x'>&#x41;&#66;&nbsp;</div>", "<div id=\"x\">AB\u{a0}</div>");
    try roundTrip("<!-- c --><span>a</span></bogus>b", "<span>a</span>b");
    try roundTrip("<textarea>\n<b>raw</b></textarea>", "<textarea>&lt;b&gt;raw&lt;/b&gt;</textarea>");
    try roundTrip("<button onclick={increment} class:active={on}>+</button>", "<button onclick=\"{increment}\" class:active=\"{on}\">+</button>");
    try roundTrip("<svg viewBox=\"0 0 10 10\"><path d=\"M0 0\"/></svg>", "<svg viewbox=\"0 0 10 10\"><path d=\"M0 0\"></path></svg>");
}

test "style collection" {
    const doc = try Document.init(std.testing.allocator);
    defer doc.deinit();
    try parseInto(doc, doc.root, "<style>.a { color: red }</style><div class=a></div>", .{});
    try std.testing.expectEqual(@as(usize, 1), doc.sheets.items.len);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(std.testing.allocator);
    try doc.serialize(doc.root, &out);
    try std.testing.expectEqualStrings("<html><head></head><body><style></style><div class=\"a\"></div></body></html>", out.items);
    // explicit body attributes merge into the implicit body
    try parseInto(doc, doc.root, "<body class=dark><p>x</p></body>", .{});
    try std.testing.expectEqualStrings("dark", doc.getAttribute(try ensureBody(doc), "class").?);
    try std.testing.expectEqual(@as(usize, 1), doc.sheets.items[0].rules.items.len);
}
