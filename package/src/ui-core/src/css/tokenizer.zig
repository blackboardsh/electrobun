//! CSS Syntax Level 3 tokenizer (the parts a UI stylesheet needs).
//! Tokens borrow from the source; escapes are not decoded (rare in app CSS).
const std = @import("std");

pub const Tag = enum {
    ident,
    function, // text is the name, without "("
    at_keyword, // text without "@"
    hash, // text without "#"
    string, // text without quotes
    url,
    number,
    percentage,
    dimension, // text is the unit
    whitespace,
    colon,
    semicolon,
    comma,
    lbracket,
    rbracket,
    lparen,
    rparen,
    lbrace,
    rbrace,
    delim,
    cdo,
    cdc,
    eof,
};

pub const Token = struct {
    tag: Tag,
    text: []const u8 = "",
    num: f32 = 0,
    is_int: bool = false,
    delim: u8 = 0,
    start: u32 = 0,
};

pub const Tokenizer = struct {
    src: []const u8,
    pos: usize = 0,

    pub fn init(src: []const u8) Tokenizer {
        return .{ .src = src };
    }

    fn peekAt(t: *const Tokenizer, off: usize) u8 {
        const i = t.pos + off;
        return if (i < t.src.len) t.src[i] else 0;
    }

    fn isNameStart(c: u8) bool {
        return std.ascii.isAlphabetic(c) or c == '_' or c >= 0x80;
    }
    fn isName(c: u8) bool {
        return isNameStart(c) or std.ascii.isDigit(c) or c == '-';
    }
    fn startsIdent(t: *const Tokenizer, off: usize) bool {
        const c0 = t.peekAt(off);
        if (c0 == '-') {
            const c1 = t.peekAt(off + 1);
            return isNameStart(c1) or c1 == '-' or (c1 == '\\');
        }
        return isNameStart(c0) or c0 == '\\';
    }
    fn startsNumber(t: *const Tokenizer, off: usize) bool {
        const c0 = t.peekAt(off);
        if (std.ascii.isDigit(c0)) return true;
        if (c0 == '.') return std.ascii.isDigit(t.peekAt(off + 1));
        if (c0 == '+' or c0 == '-') {
            const c1 = t.peekAt(off + 1);
            if (std.ascii.isDigit(c1)) return true;
            return c1 == '.' and std.ascii.isDigit(t.peekAt(off + 2));
        }
        return false;
    }

    fn consumeName(t: *Tokenizer) []const u8 {
        const start = t.pos;
        while (t.pos < t.src.len) {
            const c = t.src[t.pos];
            if (isName(c)) {
                t.pos += 1;
            } else if (c == '\\' and t.pos + 1 < t.src.len) {
                t.pos += 2;
            } else break;
        }
        return t.src[start..t.pos];
    }

    fn consumeNumber(t: *Tokenizer) struct { v: f32, int: bool } {
        const start = t.pos;
        var is_int = true;
        if (t.peekAt(0) == '+' or t.peekAt(0) == '-') t.pos += 1;
        while (std.ascii.isDigit(t.peekAt(0))) t.pos += 1;
        if (t.peekAt(0) == '.' and std.ascii.isDigit(t.peekAt(1))) {
            is_int = false;
            t.pos += 1;
            while (std.ascii.isDigit(t.peekAt(0))) t.pos += 1;
        }
        const e = t.peekAt(0);
        if ((e == 'e' or e == 'E') and (std.ascii.isDigit(t.peekAt(1)) or
            ((t.peekAt(1) == '-' or t.peekAt(1) == '+') and std.ascii.isDigit(t.peekAt(2)))))
        {
            is_int = false;
            t.pos += 2;
            while (std.ascii.isDigit(t.peekAt(0))) t.pos += 1;
        }
        const v = std.fmt.parseFloat(f32, t.src[start..t.pos]) catch 0;
        return .{ .v = v, .int = is_int };
    }

    pub fn next(t: *Tokenizer) Token {
        // comments
        while (t.peekAt(0) == '/' and t.peekAt(1) == '*') {
            if (std.mem.indexOfPos(u8, t.src, t.pos + 2, "*/")) |end| {
                t.pos = end + 2;
            } else {
                t.pos = t.src.len;
            }
        }
        const start: u32 = @intCast(t.pos);
        if (t.pos >= t.src.len) return .{ .tag = .eof, .start = start };
        const c = t.src[t.pos];
        switch (c) {
            ' ', '\t', '\n', '\r', 0x0c => {
                while (t.pos < t.src.len and std.ascii.isWhitespace(t.src[t.pos])) t.pos += 1;
                return .{ .tag = .whitespace, .start = start };
            },
            '"', '\'' => {
                t.pos += 1;
                const s = t.pos;
                while (t.pos < t.src.len and t.src[t.pos] != c) {
                    if (t.src[t.pos] == '\\') t.pos += 1;
                    if (t.src[t.pos] == '\n') break;
                    t.pos += 1;
                }
                const text = t.src[s..@min(t.pos, t.src.len)];
                if (t.pos < t.src.len) t.pos += 1;
                return .{ .tag = .string, .text = text, .start = start };
            },
            '#' => {
                if (isName(t.peekAt(1)) or t.peekAt(1) == '\\') {
                    t.pos += 1;
                    return .{ .tag = .hash, .text = t.consumeName(), .start = start };
                }
                t.pos += 1;
                return .{ .tag = .delim, .delim = c, .start = start };
            },
            '(' => return t.single(.lparen, start),
            ')' => return t.single(.rparen, start),
            '[' => return t.single(.lbracket, start),
            ']' => return t.single(.rbracket, start),
            '{' => return t.single(.lbrace, start),
            '}' => return t.single(.rbrace, start),
            ',' => return t.single(.comma, start),
            ':' => return t.single(.colon, start),
            ';' => return t.single(.semicolon, start),
            '@' => {
                if (t.startsIdent(1)) {
                    t.pos += 1;
                    return .{ .tag = .at_keyword, .text = t.consumeName(), .start = start };
                }
                return t.delimTok(start);
            },
            '<' => {
                if (std.mem.startsWith(u8, t.src[t.pos..], "<!--")) {
                    t.pos += 4;
                    return .{ .tag = .cdo, .start = start };
                }
                return t.delimTok(start);
            },
            else => {},
        }
        if (t.startsNumber(0)) return t.numeric(start);
        if (c == '-' and std.mem.startsWith(u8, t.src[t.pos..], "-->")) {
            t.pos += 3;
            return .{ .tag = .cdc, .start = start };
        }
        if (t.startsIdent(0)) return t.identLike(start);
        return t.delimTok(start);
    }

    fn single(t: *Tokenizer, tag: Tag, start: u32) Token {
        t.pos += 1;
        return .{ .tag = tag, .start = start };
    }
    fn delimTok(t: *Tokenizer, start: u32) Token {
        const c = t.src[t.pos];
        t.pos += 1;
        return .{ .tag = .delim, .delim = c, .start = start };
    }

    fn numeric(t: *Tokenizer, start: u32) Token {
        const n = t.consumeNumber();
        if (t.startsIdent(0)) {
            const unit = t.consumeName();
            return .{ .tag = .dimension, .num = n.v, .is_int = n.int, .text = unit, .start = start };
        }
        if (t.peekAt(0) == '%') {
            t.pos += 1;
            return .{ .tag = .percentage, .num = n.v, .start = start };
        }
        return .{ .tag = .number, .num = n.v, .is_int = n.int, .start = start };
    }

    fn identLike(t: *Tokenizer, start: u32) Token {
        const name = t.consumeName();
        if (t.peekAt(0) == '(') {
            t.pos += 1;
            if (std.ascii.eqlIgnoreCase(name, "url")) {
                // unquoted url(...)
                var p = t.pos;
                while (p < t.src.len and std.ascii.isWhitespace(t.src[p])) p += 1;
                if (p < t.src.len and t.src[p] != '"' and t.src[p] != '\'') {
                    const s = p;
                    while (p < t.src.len and t.src[p] != ')') p += 1;
                    const text = std.mem.trimEnd(u8, t.src[s..p], " \t\n\r");
                    t.pos = @min(p + 1, t.src.len);
                    return .{ .tag = .url, .text = text, .start = start };
                }
            }
            return .{ .tag = .function, .text = name, .start = start };
        }
        return .{ .tag = .ident, .text = name, .start = start };
    }
};

/// Tokenize a whole string into a list (whitespace preserved).
pub fn tokenizeAll(gpa: std.mem.Allocator, src: []const u8) !std.ArrayList(Token) {
    var list: std.ArrayList(Token) = .empty;
    errdefer list.deinit(gpa);
    var t = Tokenizer.init(src);
    while (true) {
        const tok = t.next();
        try list.append(gpa, tok);
        if (tok.tag == .eof) break;
    }
    return list;
}

test "tokenize basics" {
    var t = Tokenizer.init(".btn:hover > a { width: calc(100% - 12.5px); color: #fff }");
    const expected = [_]Tag{ .delim, .ident, .colon, .ident, .whitespace, .delim, .whitespace, .ident, .whitespace, .lbrace, .whitespace, .ident, .colon, .whitespace, .function, .percentage, .whitespace, .delim, .whitespace, .dimension, .rparen, .semicolon, .whitespace, .ident, .colon, .whitespace, .hash, .whitespace, .rbrace, .eof };
    for (expected) |e| {
        const tok = t.next();
        try std.testing.expectEqual(e, tok.tag);
    }
}

test "tokenize numbers" {
    var t = Tokenizer.init("-1.5em 10% +3 .5");
    var tok = t.next();
    try std.testing.expectEqual(Tag.dimension, tok.tag);
    try std.testing.expectEqual(@as(f32, -1.5), tok.num);
    try std.testing.expectEqualStrings("em", tok.text);
    _ = t.next();
    tok = t.next();
    try std.testing.expectEqual(Tag.percentage, tok.tag);
    _ = t.next();
    tok = t.next();
    try std.testing.expectEqual(@as(f32, 3), tok.num);
    _ = t.next();
    tok = t.next();
    try std.testing.expectEqual(@as(f32, 0.5), tok.num);
}
