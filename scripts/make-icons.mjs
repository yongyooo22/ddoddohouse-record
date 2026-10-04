// 앱 아이콘 PNG 생성 (외부 의존성 없음: zlib 로 직접 PNG 인코딩)
// 디자인: 크림색 둥근 사각형 위에 진초록 선으로 그린 노트와 연필 (연필심이 닿은 마지막 줄은 금빛)
//        — 앱 안의 로고(js/dom.js 의 logo 아이콘)와 같은 모양
// 실행: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const hex = (h, a = 1) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
};

const C = {
  paper: hex('#F4F1EC'),
  paperEdge: hex('#E6E1D9'),
  ink: hex('#2E5A46'), // 진초록 (앱의 강조색)
  star: hex('#A9823F'), // 금빛
};

// ── 도형 (512 좌표계) ──
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 점과 선분 사이 거리 */
function distSeg(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

// 로고 아이콘(24 좌표계)을 512 좌표계로 (84% 크기): 가로 가운데 11.75, 세로 가운데 12
const K = (512 / 24) * 0.84;
const P = (x, y) => [256 + (x - 11.75) * K, 256 + (y - 12) * K];
/** 둥근 모서리용: 중심 (cx, cy), 반지름 r, 각도 a0 → a1 (라디안) 사이를 점 n+1개로 */
function arc(cx, cy, r, a0, a1, n = 10) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(P(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return out;
}
const H = Math.PI / 2;
// 노트: 오른쪽 위 모서리부터 시계 반대 방향, 연필이 지나가는 오른쪽 변 가운데는 비움 (아이콘 path 와 같음)
const PAGE = [
  ...arc(12, 5.5, 2, 0, -H), ...arc(5, 5.5, 2, -H, -2 * H), ...arc(5, 18.5, 2, 2 * H, H), ...arc(12, 18.5, 2, H, 0), P(14, 14.4),
];
const LINES = [[P(6, 7.6), P(10.5, 7.6)], [P(6, 11), P(8.7, 11)]];
const GOLD = [P(6, 14.6), P(9.3, 14.6)];
// 연필: 지우개 쪽 끝 → 몸통 → 깎은 끝(심) → 다시 몸통 (닫힌 선) + 금속 띠 · 깎은 부분 경계
const PENCIL = [P(17.9, 3.6), P(20.5, 6.2), P(14.1, 12.6), P(10.3, 13.8), P(11.5, 10), P(17.9, 3.6)];
const PENCIL_LINES = [[P(16.6, 4.9), P(19.2, 7.5)], [P(11.5, 10), P(14.1, 12.6)]];
const W = 28; // 선 굵기 (끝·꺾이는 곳은 둥글게)

/** 점들을 이은 선 위(굵기 안)인지 */
function onPolyline(x, y, pts, hw) {
  for (let i = 0; i < pts.length - 1; i++) if (distSeg(x, y, pts[i], pts[i + 1]) <= hw) return true;
  return false;
}

/** 노트와 연필 마크 레이어. 좌표는 512 기준, 반환 [r,g,b,a] 또는 null */
function mark(x, y) {
  const hw = W / 2;
  if (onPolyline(x, y, GOLD, hw)) return C.star;
  if (onPolyline(x, y, PENCIL, hw) || PENCIL_LINES.some((l) => onPolyline(x, y, l, hw))) return C.ink;
  if (onPolyline(x, y, PAGE, hw) || LINES.some((l) => onPolyline(x, y, l, hw))) return C.ink;
  return null;
}

function blend(dst, src) {
  const a = src[3];
  return [
    dst[0] * (1 - a) + src[0] * a,
    dst[1] * (1 - a) + src[1] * a,
    dst[2] * (1 - a) + src[2] * a,
    dst[3] + a * (1 - dst[3]),
  ];
}

/**
 * @param size 출력 크기
 * @param opts.rounded 바깥 모서리를 둥글게(투명) 할지
 * @param opts.scale 마크 크기 비율 (가운데 기준)
 */
function render(size, { rounded, scale }) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  const k = 512 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (i + (sx + 0.5) / SS) * k;
          const v = (j + (sy + 0.5) / SS) * k;
          let col = [0, 0, 0, 0];
          const bgInside = rounded ? inRoundRect(u, v, 0, 0, 512, 512, 114) : true;
          if (bgInside) {
            col = C.paper.slice();
            if (rounded && !inRoundRect(u, v, 3, 3, 509, 509, 111)) col = C.paperEdge.slice();
            const mu = 256 + (u - 256) / scale;
            const mv = 256 + (v - 256) / scale;
            const m = mark(mu, mv);
            if (m) col = blend(col, m);
          }
          // 미리 곱한 알파로 누적
          acc[0] += col[0] * col[3];
          acc[1] += col[1] * col[3];
          acc[2] += col[2] * col[3];
          acc[3] += col[3];
        }
      }
      const n = SS * SS;
      const a = acc[3] / n;
      const o = (j * size + i) * 4;
      px[o] = a ? Math.round(acc[0] / acc[3]) : 0;
      px[o + 1] = a ? Math.round(acc[1] / acc[3]) : 0;
      px[o + 2] = a ? Math.round(acc[2] / acc[3]) : 0;
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

// ── PNG 인코딩 ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outputs = [
  ['icon-192.png', 192, { rounded: true, scale: 1 }],
  ['icon-512.png', 512, { rounded: true, scale: 1 }],
  ['icon-maskable-512.png', 512, { rounded: false, scale: 0.74 }],
  ['apple-touch-icon.png', 180, { rounded: false, scale: 0.88 }],
];

for (const [name, size, opts] of outputs) {
  const png = encodePNG(size, render(size, opts));
  writeFileSync(path.join(ROOT, name), png);
  console.log(`${name} (${size}×${size}, ${png.length} bytes)`);
}
