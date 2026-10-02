// 사진 줄이기 — 기기에서 디코드한 뒤 canvas 로 다시 인코딩해서 올림
// 다시 그리는 과정에서 EXIF(촬영 위치 GPS·기기 정보 등) 메타데이터가 모두 빠짐

// 저장 공간(Upstash 무료 256MB)을 아끼려고 휴대폰 화면에서 충분히 선명한 만큼만 남김
/** 원본 크기 사진: 긴 변 1280px, WebP(안 되면 JPEG) 0.8 부터, 350KB 이하 */
export const FULL = { side: 1280, quality: 0.8, maxBytes: 350 * 1024 };
/** 작은 사진(목록·썸네일, 화면에서 최대 120px 안팎): 긴 변 360px, 0.72, 40KB 이하 */
export const THUMB = { side: 360, quality: 0.72, maxBytes: 40 * 1024 };

const MAX_INPUT_BYTES = 60 * 1024 * 1024;
const MIN_QUALITY = 0.5;

export class PhotoError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // decode(열 수 없는 형식) | too_big(파일이 너무 큼) | encode(줄이기 실패)
  }
}

/** 사진 디코드 (EXIF 회전 반영). 반환: { src, width, height, done() } */
async function decode(file) {
  // 1) createImageBitmap: 회전 정보(Orientation)를 반영해 바로 세운 그림으로
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (bmp.width && bmp.height) return { src: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close && bmp.close() };
    } catch { /* 옵션을 모르는 브라우저 등 → <img> 로 한 번 더 */ }
  }
  // 2) <img> + objectURL (요즘 브라우저는 <img> 에도 회전 정보를 반영)
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    if (img.decode) await img.decode().catch(() => {});
  } catch {
    URL.revokeObjectURL(url);
    throw new PhotoError('decode');
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new PhotoError('decode');
  }
  return { src: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

/** 새 canvas 에 w×h 로 그림. 투명한 부분(PNG 등)은 흰 바탕 */
function paint(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw new PhotoError('encode');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

/** 크게 줄일 때는 반씩 나눠 줄여서 계단 현상을 줄임 */
function scaleTo(src, sw, sh, w, h) {
  let cur = src;
  let cw = sw;
  let ch = sh;
  while (cw / 2 >= w * 1.25) {
    cw = Math.round(cw / 2);
    ch = Math.round(ch / 2);
    cur = paint(cur, cw, ch);
  }
  return paint(cur, w, h);
}

const toBlob = (canvas, type, q) => new Promise((resolve) => {
  try { canvas.toBlob(resolve, type, q); } catch { resolve(null); }
});

let webpOk = null; // 이 브라우저가 WebP 로 인코딩할 수 있는지 (한 번 확인하면 기억)

async function encode(canvas, q) {
  if (webpOk !== false) {
    const b = await toBlob(canvas, 'image/webp', q);
    // 못 하는 브라우저(예전 Safari)는 조용히 PNG 로 줌 → JPEG 로
    if (b && b.type === 'image/webp') { webpOk = true; return b; }
    webpOk = false;
  }
  const b = await toBlob(canvas, 'image/jpeg', q);
  if (!b || b.type !== 'image/jpeg') throw new PhotoError('encode');
  return b;
}

/** 목표 크기·용량에 맞춰 인코딩: 화질을 먼저 조금씩 낮추고, 그래도 크면 크기를 줄임 */
async function fit(src, sw, sh, { side, quality, maxBytes }) {
  let scale = Math.min(1, side / Math.max(sw, sh));
  let q = quality;
  let canvas = null;
  let cw = 0;
  for (let i = 0; i < 12; i++) {
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    if (!canvas || cw !== w) { canvas = scaleTo(src, sw, sh, w, h); cw = w; }
    const blob = await encode(canvas, q);
    if (blob.size <= maxBytes) return { blob, canvas, width: w, height: h };
    if (q - 0.08 >= MIN_QUALITY) q = Math.round((q - 0.08) * 100) / 100;
    else scale *= 0.8;
  }
  throw new PhotoError('encode');
}

/**
 * 고른 사진 파일 → { full: Blob, thumb: Blob, width, height }
 * 디코드 못 하는 형식(예: 데스크톱 크롬의 HEIC)은 PhotoError('decode')
 */
export async function compressPhoto(file) {
  if (!file || typeof file.size !== 'number') throw new PhotoError('decode');
  if (file.size > MAX_INPUT_BYTES) throw new PhotoError('too_big');
  if (file.type && !file.type.startsWith('image/')) throw new PhotoError('decode');
  const d = await decode(file);
  try {
    const full = await fit(d.src, d.width, d.height, FULL);
    // 작은 사진은 이미 줄인 그림에서 만듦 (빠르고 결과도 같음)
    const thumb = await fit(full.canvas, full.width, full.height, THUMB);
    return { full: full.blob, thumb: thumb.blob, width: full.width, height: full.height };
  } finally {
    try { d.done(); } catch { /* 무시 */ }
  }
}

/** Blob → base64 (data: 앞부분 없이) */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : '');
    };
    fr.onerror = () => reject(fr.error || new Error('read'));
    fr.readAsDataURL(blob);
  });
}
