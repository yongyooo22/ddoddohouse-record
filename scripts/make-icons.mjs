// 앱 아이콘 PNG 생성 (외부 의존성 없음: zlib 로 직접 PNG 인코딩)
// 디자인: 종이색 둥근 사각형 위에 잉크색 노트, 종류별 색 책갈피 끈 3개(보드게임·머미·방탈출)
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
  paper: hex('#F5EFE4'),
  paperEdge: hex('#E9E0D2'),
  shadow: [70, 48, 26, 0.16],
  cover: hex('#2B2622'),
  spine: hex('#1D1916'),
  spineHi: hex('#453D36'),
  label: hex('#F5EFE4'),
  labelLine: hex('#BDB2A3'),
  green: hex('#2E8B62'),
  wine: hex('#A3314A'),
  amber: hex('#C57A12'),
};

// ── 도형 (512 좌표계) ──
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRibbon(x, y, x0, x1, y0, y1, notch) {
  if (x < x0 || x > x1 || y < y0) return false;
  const mid = (x0 + x1) / 2;
  const half = (x1 - x0) / 2;
  const edge = y1 - notch * (1 - Math.abs(x - mid) / half);
  return y <= edge;
}

/** 노트 마크 레이어. 좌표는 512 기준, 반환 [r,g,b,a] 또는 null */
function mark(x, y) {
  const X0 = 142, X1 = 370, Y0 = 84, Y1 = 390;
  // 책갈피 끈 (노트 아래로 삐져나옴)
  const ribbons = [
    [198, 222, C.green, 446],
    [232, 256, C.wine, 462],
    [266, 290, C.amber, 438],
  ];
  let out = null;
  // 그림자
  if (inRoundRect(x, y, X0 + 6, Y0 + 12, X1 + 6, Y1 + 12, 30)) out = C.shadow;
  for (const [a, b, col, end] of ribbons) if (inRibbon(x, y, a, b, Y1 - 20, end, 12)) out = col;
  // 표지
  if (inRoundRect(x, y, X0, Y0, X1, Y1, 28)) {
    out = C.cover;
    if (x < X0 + 34) out = C.spine;
    else if (x < X0 + 38) out = C.spineHi;
    // 라벨
    if (inRoundRect(x, y, 198, 138, 330, 212, 12)) {
      out = C.label;
      if (inRoundRect(x, y, 216, 160, 312, 168, 4)) out = C.labelLine;
      if (inRoundRect(x, y, 216, 182, 280, 190, 4)) out = C.labelLine;
    }
    // 표지 아래쪽 작은 별 (기록/평점)
    const sx = 264, sy = 300, R = 30, r = 12.5;
    if (inStar(x - sx, y - sy, R, r)) out = C.amber;
  }
  return out;
}

function inStar(x, y, R, r) {
  // 5각 별: 극좌표로 경계 계산
  const ang = Math.atan2(x, -y); // 위쪽이 0
  const d = Math.hypot(x, y);
  const seg = (Math.PI * 2) / 5;
  let a = ((ang % seg) + seg) % seg; // 0..seg
  if (a > seg / 2) a = seg - a; // 대칭
  // 꼭짓점(R, 0) 과 안쪽점(r, seg/2) 사이 직선
  const p1 = [0, R];
  const p2 = [Math.sin(seg / 2) * r, Math.cos(seg / 2) * r];
  const px = Math.sin(a) * d, py = Math.cos(a) * d;
  // 직선 p1-p2 기준 원점 쪽인지
  const cross = (p2[0] - p1[0]) * (py - p1[1]) - (p2[1] - p1[1]) * (px - p1[0]);
  return d <= R && cross <= 0;
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
            const mv = 262 + (v - 256) / scale;
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
