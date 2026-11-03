// Run with Node 24+ to regenerate the genuine compressed-block Zstd fixture.
// Checked-in bytes: Node 24.11.1, libzstd 1.5.7, compression level 3.
// Source: 8192 bytes, SHA-256
// 07e0756ccdfdb405f9e883e589b1f338f6b53daff3f1783dfbbda63320374c52.
// Frame: 6058 bytes, SHA-256
// 9f0d4379765e6fab8a38e6938274d940e7945cc3342907d55903ab0d7713807e.
// Skewed symbol frequencies require an FSE-compressed Huffman table; the HTTP
// test places that table across a buffer boundary using a skippable frame.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { constants, zstdCompressSync } from "node:zlib";

let state = 0x31415926;
const source = Buffer.alloc(8192);
for (let index = 0; index < source.length; index++) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  source[index] = (state & 255) < 128 ? state & 7 : (state >>> 8) & 127;
}
const compressed = zstdCompressSync(source, {
  params: { [constants.ZSTD_c_compressionLevel]: 3 },
});
writeFileSync(new URL("http-compressed-blocks.zst", import.meta.url), compressed);
console.log({
  sourceSize: source.length,
  compressedSize: compressed.length,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
});
