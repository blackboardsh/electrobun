#!/usr/bin/env python3
"""Generate the image decoder test fixtures (deterministic).

Pixels come from pattern functions that src/image/tests.zig recomputes, so
lossless formats are checked exactly on every platform. JPEGs are encoded
with libjpeg-turbo's cjpeg from a smooth pattern. Run from this directory:
    python3 gen.py
"""
import struct, zlib, subprocess

W, H = 37, 29  # odd sizes: exercise partial MCUs, Adam7 passes, row padding


def pat(x, y):
    """RGBA pattern for lossless formats."""
    return (x * 255 // (W - 1), y * 255 // (H - 1), ((x * 7) ^ (y * 5)) & 255, (x * 11 + y * 17) & 255)


def smooth(x, y):
    """Smooth RGB pattern for lossy JPEG."""
    return (x * 255 // (W - 1), y * 255 // (H - 1), (x + y) * 255 // (W + H - 2))


# ---------------------------------------------------------------- PNG

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def pack_bits(samples, depth):
    if depth == 8:
        return bytes(samples)
    if depth == 16:
        return b"".join(struct.pack(">H", s) for s in samples)
    out, acc, n = bytearray(), 0, 0
    for s in samples:
        acc = (acc << depth) | s
        n += depth
        if n == 8:
            out.append(acc); acc = 0; n = 0
    if n:
        out.append(acc << (8 - n))
    return bytes(out)


def filter_row(ftype, row, prev, bpp):
    out = bytearray()
    for i, v in enumerate(row):
        a = row[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        if ftype == 0: p = 0
        elif ftype == 1: p = a
        elif ftype == 2: p = b
        elif ftype == 3: p = (a + b) // 2
        else:
            pp = a + b - c; pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
            p = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
        out.append((v - p) & 255)
    return bytes([ftype]) + bytes(out)


ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def png(name, color, depth, samples_at, interlace=False, plte=None, trns=None):
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    bpp = max(1, channels * depth // 8)
    passes = ADAM7 if interlace else [(0, 0, 1, 1)]
    raw, row_index = bytearray(), 0
    for x0, y0, dx, dy in passes:
        xs = list(range(x0, W, dx)); ys = list(range(y0, H, dy))
        if not xs or not ys:
            continue
        prev = bytes((len(xs) * channels * depth + 7) // 8)
        for y in ys:
            samples = [s for x in xs for s in samples_at(x, y)]
            row = pack_bits(samples, depth)
            raw += filter_row(row_index % 5, row, prev, bpp)
            prev = row; row_index += 1
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, depth, color, 0, 0, 1 if interlace else 0))
    if plte: data += chunk(b"PLTE", plte)
    if trns is not None: data += chunk(b"tRNS", trns)
    data += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    open(f"{name}.png", "wb").write(data)


def gray(depth):
    return lambda x, y: [pat(x, y)[0] * ((1 << depth) - 1) // 255]


def palette_index(depth):
    return lambda x, y: [(x + 2 * y) % (1 << depth)]


PALETTE = bytes(v for i in range(256) for v in ((i * 37) & 255, (i * 91) & 255, (i * 13 + 40) & 255))

for d in (1, 2, 4, 8, 16):
    png(f"g{d}", 0, d, gray(d))
png("ga8", 4, 8, lambda x, y: [pat(x, y)[0], pat(x, y)[3]])
png("ga16", 4, 16, lambda x, y: [pat(x, y)[0] * 257, min(pat(x, y)[3] * 257 + 3, 65535)])
png("rgb8", 2, 8, lambda x, y: list(pat(x, y)[:3]))
png("rgb16", 2, 16, lambda x, y: [min(v * 257 + 5, 65535) for v in pat(x, y)[:3]])
png("rgb8_i", 2, 8, lambda x, y: list(pat(x, y)[:3]), interlace=True)
png("rgba8", 6, 8, lambda x, y: list(pat(x, y)))
png("rgba16", 6, 16, lambda x, y: [min(v * 257 + 7, 65535) for v in pat(x, y)])
png("rgba8_i", 6, 8, lambda x, y: list(pat(x, y)), interlace=True)
for d in (1, 2, 4, 8):
    png(f"p{d}", 3, d, palette_index(d), plte=PALETTE[: 3 << d])
png("p8_trns", 3, 8, palette_index(8), plte=PALETTE, trns=bytes((i * 29) & 255 for i in range(200)))
png("g8_trns", 0, 8, gray(8), trns=struct.pack(">H", pat(18, 0)[0]))
png("rgb8_trns", 2, 8, lambda x, y: list(pat(x, y)[:3]), trns=struct.pack(">HHH", *pat(3, 4)[:3]))

# ---------------------------------------------------------------- GIF

def lzw(indices, min_code):
    clear, eoi = 1 << min_code, (1 << min_code) + 1
    out, acc, nbits = bytearray(), 0, 0
    def emit(code, size):
        nonlocal acc, nbits
        acc |= code << nbits; nbits += size
        while nbits >= 8:
            out.append(acc & 255); acc >>= 8; nbits -= 8
    table = {(i,): i for i in range(clear)}
    size, nxt = min_code + 1, eoi + 1
    emit(clear, size)
    w = ()
    for k in indices:
        wk = w + (k,)
        if wk in table:
            w = wk; continue
        emit(table[w], size)
        if nxt < 4096:
            table[wk] = nxt; nxt += 1
            if nxt > (1 << size) and size < 12: size += 1
        else:
            emit(clear, size)
            table = {(i,): i for i in range(clear)}; size, nxt = min_code + 1, eoi + 1
        w = (k,)
    if w: emit(table[w], size)
    emit(eoi, size)
    if nbits: out.append(acc & 255)
    return bytes(out)


def gif(name, interlace, transparent):
    idx = lambda x, y: (x * 3 + y) % 64
    rows = list(range(H))
    if interlace:
        rows = list(range(0, H, 8)) + list(range(4, H, 8)) + list(range(2, H, 4)) + list(range(1, H, 2))
    indices = [idx(x, y) for y in rows for x in range(W)]
    data = b"GIF89a" + struct.pack("<HHBBB", W, H, 0x80 | 5, 0, 0) + PALETTE[: 64 * 3]
    if transparent is not None:
        data += b"\x21\xF9\x04" + bytes([1, 0, 0, transparent, 0])
    data += b"\x2C" + struct.pack("<HHHHB", 0, 0, W, H, 0x40 if interlace else 0) + bytes([6])
    body = lzw(indices, 6)
    for i in range(0, len(body), 255):
        part = body[i:i + 255]; data += bytes([len(part)]) + part
    data += b"\x00\x3B"
    open(f"{name}.gif", "wb").write(data)


gif("plain", False, None)
gif("interlaced_trns", True, 5)

# ---------------------------------------------------------------- BMP

def bmp(name, bpp, top_down=False, bitfields=False):
    stride = ((W * bpp + 31) // 32) * 4
    ncolors = (1 << bpp) if bpp <= 8 else 0
    # bitfields use a BITMAPV5HEADER tagged sRGB (masks incl. alpha live in
    # the header); ImageIO rejects V4 and LCS_WINDOWS_COLOR_SPACE variants
    header_size = 124 if bitfields else 40
    offset = 14 + header_size + ncolors * 4
    rows = []
    for y in range(H):
        if bpp <= 8:
            row = pack_bits([(x + 2 * y) % (1 << bpp) for x in range(W)], bpp)
        elif bpp == 24:
            row = b"".join(bytes([pat(x, y)[2], pat(x, y)[1], pat(x, y)[0]]) for x in range(W))
        else:
            row = b"".join(bytes([pat(x, y)[2], pat(x, y)[1], pat(x, y)[0], pat(x, y)[3]]) for x in range(W))
        rows.append(row + bytes(stride - len(row)))
    pixels = b"".join(rows if top_down else reversed(rows))
    compression = 3 if bitfields else 0
    data = b"BM" + struct.pack("<IHHI", offset + len(pixels), 0, 0, offset)
    data += struct.pack("<IiiHHIIiiII", header_size, W, -H if top_down else H, 1, bpp, compression, len(pixels), 2835, 2835, ncolors, 0)
    if bitfields:
        data += struct.pack("<IIII", 0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000)
        data += struct.pack("<I", 0x73524742) + bytes(36) + bytes(12)  # 'sRGB', endpoints, gamma
        data += struct.pack("<IIII", 4, 0, 0, 0)  # intent, profile offset/size, reserved
    for i in range(ncolors):
        r, g, b = PALETTE[i * 3: i * 3 + 3]
        data += bytes([b, g, r, 0])
    open(f"{name}.bmp", "wb").write(data + pixels)


bmp("rgb24", 24)
bmp("rgb24_topdown", 24, top_down=True)
bmp("argb32_v5", 32, bitfields=True)
bmp("pal8", 8)
bmp("pal4", 4)
bmp("pal1", 1)

# ---------------------------------------------------------------- JPEG (libjpeg-turbo cjpeg)

ppm = b"P6\n%d %d\n255\n" % (W, H) + bytes(v for y in range(H) for x in range(W) for v in smooth(x, y))
open("smooth.ppm", "wb").write(ppm)
JPEGS = {
    "base444": ["-quality", "92", "-sample", "1x1"],
    "base422": ["-quality", "92", "-sample", "2x1"],
    "base420": ["-quality", "92", "-sample", "2x2"],
    "prog420": ["-quality", "92", "-sample", "2x2", "-progressive"],
    "prog444": ["-quality", "92", "-sample", "1x1", "-progressive"],
    "restart420": ["-quality", "92", "-sample", "2x2", "-restart", "1"],
    "optimized": ["-quality", "92", "-sample", "2x2", "-optimize"],
    "gray": ["-quality", "92", "-grayscale"],
    "rgb": ["-quality", "92", "-rgb"],
    "arith": ["-quality", "92", "-arithmetic"],
}
for name, args in JPEGS.items():
    subprocess.run(["cjpeg", *args, "-outfile", f"{name}.jpg", "smooth.ppm"], check=True)

# EXIF orientation 6 (rotate 90° clockwise) injected into base444
base = open("base444.jpg", "rb").read()
tiff = b"MM\x00\x2a\x00\x00\x00\x08" + struct.pack(">H", 1) + struct.pack(">HHIHH", 0x0112, 3, 1, 6, 0) + b"\x00\x00\x00\x00"
app1 = b"Exif\x00\x00" + tiff
open("orient6.jpg", "wb").write(base[:2] + b"\xFF\xE1" + struct.pack(">H", len(app1) + 2) + app1 + base[2:])
