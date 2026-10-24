//! Image store shared by layout (natural sizes), painting and both
//! renderers. Decoding and SVG rasterization use the platform (ImageIO /
//! CoreGraphics on macOS) so they add no code size.
const std = @import("std");
const builtin = @import("builtin");
const dom = @import("dom.zig");
const geom = @import("geom.zig");
const svg = @import("svg.zig");

const Allocator = std.mem.Allocator;
const platform = if (builtin.os.tag == .macos) @import("platform/image_mac.zig") else struct {
    pub fn decode(gpa: Allocator, data: []const u8) ?Decoded {
        _ = gpa;
        _ = data;
        return null;
    }
    pub fn rasterizeSvg(gpa: Allocator, pic: *const svg.Picture, w: u32, h: u32) ?[]u8 {
        _ = gpa;
        _ = pic;
        _ = w;
        _ = h;
        return null;
    }
};

pub const Decoded = @import("image/common.zig").Decoded;

const image_portable = @import("platform/image_portable.zig");

/// Decode encoded image bytes: ImageIO on macOS (unless
/// ELECTROBUN_UI_PORTABLE_IMAGES=1), the pure-Zig decoders elsewhere.
pub fn decodeBytes(gpa: Allocator, data: []const u8) ?Decoded {
    if (builtin.os.tag == .macos and !usePortableDecoders()) return platform.decode(gpa, data);
    return image_portable.decode(gpa, data);
}

fn usePortableDecoders() bool {
    const v = std.c.getenv("ELECTROBUN_UI_PORTABLE_IMAGES") orelse return false;
    return std.mem.eql(u8, std.mem.span(v), "1");
}

/// Rasterize an SVG picture to premultiplied RGBA8: the pure-Zig rasterizer
/// everywhere, CoreGraphics on macOS unless ELECTROBUN_UI_PORTABLE_SVG=1
/// (a runtime switch so source-level consumers need no build options).
pub fn rasterizeSvg(gpa: Allocator, pic: *const svg.Picture, w: u32, h: u32) ?[]u8 {
    if (builtin.os.tag == .macos and !usePortableSvg()) return @import("platform/image_mac.zig").rasterizeSvg(gpa, pic, w, h);
    return @import("platform/svg_portable.zig").rasterizeSvg(gpa, pic, w, h);
}

fn usePortableSvg() bool {
    const v = std.c.getenv("ELECTROBUN_UI_PORTABLE_SVG") orelse return false;
    return v[0] == '1';
}

pub const Image = struct {
    w: u32,
    h: u32,
    /// premultiplied RGBA
    px: []u8,
    /// bumps when pixels change (renderers re-upload)
    version: u32 = 1,
    /// natural size in CSS px (SVG renders at device scale)
    css_w: f32,
    css_h: f32,
    last_used: u64 = 0,
};

pub const Store = struct {
    gpa: Allocator,
    images: std.ArrayList(?Image) = .empty,
    by_url: std.StringHashMapUnmanaged(u32) = .empty,
    failed: std.StringHashMapUnmanaged(void) = .empty,
    by_svg: std.AutoHashMapUnmanaged(u64, u32) = .empty,
    /// directory relative URLs resolve against
    base_dir: []const u8 = "",
    io: ?std.Io = null,
    frame: u64 = 0,

    pub fn init(gpa: Allocator) Store {
        var s = Store{ .gpa = gpa };
        s.images.append(gpa, null) catch {};
        return s;
    }

    pub fn deinit(s: *Store) void {
        for (s.images.items) |maybe| if (maybe) |img| s.gpa.free(img.px);
        s.images.deinit(s.gpa);
        var it = s.by_url.keyIterator();
        while (it.next()) |k| s.gpa.free(k.*);
        s.by_url.deinit(s.gpa);
        var fit = s.failed.keyIterator();
        while (fit.next()) |k| s.gpa.free(k.*);
        s.failed.deinit(s.gpa);
        s.by_svg.deinit(s.gpa);
        if (s.base_dir.len > 0) s.gpa.free(s.base_dir);
    }

    pub fn setBaseDir(s: *Store, dir: []const u8) !void {
        if (s.base_dir.len > 0) s.gpa.free(s.base_dir);
        s.base_dir = try s.gpa.dupe(u8, dir);
    }

    pub fn get(s: *const Store, id: u32) ?*const Image {
        if (id == 0 or id >= s.images.items.len) return null;
        if (s.images.items[id]) |*img| return img;
        return null;
    }

    fn add(s: *Store, img: Image) !u32 {
        try s.images.append(s.gpa, img);
        return @intCast(s.images.items.len - 1);
    }

    /// Register raw premultiplied RGBA pixels (e.g. from the app).
    pub fn addPixels(s: *Store, w: u32, h: u32, px: []const u8) !u32 {
        const copy = try s.gpa.dupe(u8, px[0 .. @as(usize, w) * h * 4]);
        return s.add(.{ .w = w, .h = h, .px = copy, .css_w = @floatFromInt(w), .css_h = @floatFromInt(h) });
    }

    /// Look up or load an image by URL (data:, file paths). Null if it
    /// cannot be loaded.
    pub fn load(s: *Store, url: []const u8) ?u32 {
        if (s.by_url.get(url)) |id| return id;
        if (s.failed.contains(url)) return null;
        const decoded = s.loadUrl(url) orelse {
            const k = s.gpa.dupe(u8, url) catch return null;
            s.failed.put(s.gpa, k, {}) catch s.gpa.free(k);
            return null;
        };
        const id = s.add(.{ .w = decoded.w, .h = decoded.h, .px = decoded.px, .css_w = @floatFromInt(decoded.w), .css_h = @floatFromInt(decoded.h) }) catch return null;
        const k = s.gpa.dupe(u8, url) catch return id;
        s.by_url.put(s.gpa, k, id) catch s.gpa.free(k);
        return id;
    }

    fn loadUrl(s: *Store, url: []const u8) ?Decoded {
        if (std.mem.startsWith(u8, url, "data:")) {
            const comma = std.mem.indexOfScalar(u8, url, ',') orelse return null;
            const meta = url[5..comma];
            const payload = url[comma + 1 ..];
            if (std.mem.indexOf(u8, meta, ";base64") != null) {
                const dec = std.base64.standard.Decoder;
                const n = dec.calcSizeForSlice(payload) catch return null;
                const buf = s.gpa.alloc(u8, n) catch return null;
                defer s.gpa.free(buf);
                dec.decode(buf, payload) catch return null;
                return decodeBytes(s.gpa, buf);
            }
            return decodeBytes(s.gpa, payload);
        }
        const io = s.io orelse return null;
        var path_buf: std.ArrayList(u8) = .empty;
        defer path_buf.deinit(s.gpa);
        var path = url;
        if (std.mem.startsWith(u8, path, "file://")) path = path[7..];
        if (!std.fs.path.isAbsolute(path) and s.base_dir.len > 0) {
            path_buf.appendSlice(s.gpa, s.base_dir) catch return null;
            path_buf.append(s.gpa, '/') catch return null;
            path_buf.appendSlice(s.gpa, path) catch return null;
            path = path_buf.items;
        }
        const data = std.Io.Dir.cwd().readFileAlloc(io, path, s.gpa, .limited(64 << 20)) catch return null;
        defer s.gpa.free(data);
        return decodeBytes(s.gpa, data);
    }

    /// Rasterize an inline <svg> at device size; cached by content+size+color.
    pub fn svgImage(s: *Store, doc: *const dom.Document, node: dom.NodeId, w: f32, h: f32, scale: f32, color: geom.Color) ?u32 {
        const pw: u32 = @intFromFloat(@max(1, @round(w * scale)));
        const ph: u32 = @intFromFloat(@max(1, @round(h * scale)));
        if (pw > 4096 or ph > 4096) return null;
        var hasher = std.hash.Wyhash.init(0);
        hashSubtree(doc, node, &hasher);
        hasher.update(std.mem.asBytes(&pw));
        hasher.update(std.mem.asBytes(&ph));
        hasher.update(std.mem.asBytes(&color));
        const key = hasher.final();
        if (s.by_svg.get(key)) |id| return id;
        const pic = svg.fromDom(s.gpa, doc, node, color) catch return null;
        defer {
            pic.deinit();
            s.gpa.destroy(pic);
        }
        const px = rasterizeSvg(s.gpa, pic, pw, ph) orelse return null;
        const id = s.add(.{ .w = pw, .h = ph, .px = px, .css_w = w, .css_h = h }) catch return null;
        s.by_svg.put(s.gpa, key, id) catch {};
        return id;
    }
};

fn hashSubtree(doc: *const dom.Document, id: dom.NodeId, h: *std.hash.Wyhash) void {
    const n = doc.node(id);
    h.update(std.mem.asBytes(&n.tag));
    for (n.attrs.items) |a| {
        h.update(std.mem.asBytes(&a.name));
        h.update(a.value);
    }
    var c = n.first_child;
    while (c != dom.null_id) : (c = doc.node(c).next) hashSubtree(doc, c, h);
}
