//! String interning. Tag names, attribute names, class names and ids are
//! atoms so selector matching compares integers.
const std = @import("std");

pub const Atom = u32;
pub const none: Atom = 0;

pub const Interner = struct {
    gpa: std.mem.Allocator,
    map: std.StringHashMapUnmanaged(Atom) = .empty,
    strings: std.ArrayList([]const u8) = .empty,

    pub fn init(gpa: std.mem.Allocator) Interner {
        var self: Interner = .{ .gpa = gpa };
        self.strings.append(gpa, "") catch {};
        return self;
    }

    pub fn deinit(self: *Interner) void {
        for (self.strings.items[1..]) |s| self.gpa.free(s);
        self.strings.deinit(self.gpa);
        self.map.deinit(self.gpa);
    }

    pub fn intern(self: *Interner, s: []const u8) !Atom {
        if (s.len == 0) return none;
        if (self.map.get(s)) |a| return a;
        const owned = try self.gpa.dupe(u8, s);
        errdefer self.gpa.free(owned);
        const atom: Atom = @intCast(self.strings.items.len);
        try self.strings.append(self.gpa, owned);
        try self.map.put(self.gpa, owned, atom);
        return atom;
    }

    /// ASCII-lowercased intern (tag/attribute names are case-insensitive).
    pub fn internLower(self: *Interner, s: []const u8) !Atom {
        var buf: [64]u8 = undefined;
        if (s.len <= buf.len) {
            for (s, 0..) |c, i| buf[i] = std.ascii.toLower(c);
            return self.intern(buf[0..s.len]);
        }
        const tmp = try std.ascii.allocLowerString(self.gpa, s);
        defer self.gpa.free(tmp);
        return self.intern(tmp);
    }

    pub fn lookup(self: *const Interner, s: []const u8) ?Atom {
        if (s.len == 0) return none;
        return self.map.get(s);
    }

    pub fn str(self: *const Interner, a: Atom) []const u8 {
        return self.strings.items[a];
    }
};

test "interner" {
    var i = Interner.init(std.testing.allocator);
    defer i.deinit();
    const a = try i.intern("div");
    const b = try i.internLower("DIV");
    try std.testing.expectEqual(a, b);
    try std.testing.expectEqualStrings("div", i.str(a));
}
