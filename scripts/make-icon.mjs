#!/usr/bin/env node
// 生成 docs/assets/icon.png —— 无第三方依赖，纯 zlib deflate 手写 PNG。
// 图形：深色圆角方块底 + 一个「折返箭头」寓意把被丢弃的输出拽回来。
// 只在维护图标时手动跑：node scripts/make-icon.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "docs", "assets", "icon.png");

/** @type {Uint8Array} RGBA 像素 */
const px = new Uint8Array(SIZE * SIZE * 4);

const bg = [24, 26, 34, 255];
const accent = [122, 162, 247, 255];
const accentDim = [86, 116, 190, 255];
const paper = [226, 232, 240, 255];

/** 圆角方块覆盖率（抗锯齿用解析距离场） */
function roundedCoverage(x, y, inset, radius) {
  const x0 = inset + radius;
  const y0 = inset + radius;
  const x1 = SIZE - inset - radius;
  const y1 = SIZE - inset - radius;
  const cx = Math.min(Math.max(x, x0), x1);
  const cy = Math.min(Math.max(y, y0), y1);
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);
  // 1 = 完全在内
  return Math.min(Math.max(radius + 0.5 - dist, 0), 1);
}

/** 线段带抗锯齿的覆盖率 */
function segmentCoverage(x, y, ax, ay, bx, by, halfWidth) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(Math.max((wx * vx + wy * vy) / len2, 0), 1);
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  const dist = Math.hypot(dx, dy);
  return Math.min(Math.max(halfWidth + 0.5 - dist, 0), 1);
}

function blend(index, color, alpha) {
  if (alpha <= 0) return;
  const a = Math.min(alpha, 1);
  for (let c = 0; c < 3; c += 1) {
    px[index + c] = Math.round(px[index + c] * (1 - a) + color[c] * a);
  }
  px[index + 3] = Math.max(px[index + 3], Math.round(255 * a));
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const index = (y * SIZE + x) * 4;
    const cx = x + 0.5;
    const cy = y + 0.5;

    blend(index, bg, roundedCoverage(cx, cy, 8, 44));

    // 三条「文字行」，最后一条短 —— 暗示被截断的输出
    const lines = [
      { y: 88, x0: 62, x1: 194 },
      { y: 118, x0: 62, x1: 194 },
      { y: 148, x0: 62, x1: 154 },
    ];
    for (const line of lines) {
      const cov = segmentCoverage(cx, cy, line.x0, line.y, line.x1, line.y, 5.5);
      blend(index, paper, cov * 0.92);
    }

    // 折返箭头：底边向右，再折向上，箭头朝上 —— 表示把内容拉回上下文
    const base = segmentCoverage(cx, cy, 62, 196, 148, 196, 5.5);
    const riser = segmentCoverage(cx, cy, 148, 196, 148, 172, 5.5);
    blend(index, accent, Math.max(base, riser) * 0.95);

    // 箭头头部：尖端在 (148,168)，两条腿向下张开
    const headLeft = segmentCoverage(cx, cy, 148, 168, 136, 182, 4.5);
    const headRight = segmentCoverage(cx, cy, 148, 168, 160, 182, 4.5);
    blend(index, accentDim, Math.max(headLeft, headRight) * 0.95);
  }
}

// ---- 编码 ----
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// 每行前缀一个 filter 字节 0
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
