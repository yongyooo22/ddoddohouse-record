// 예시 기록용 그림 — canvas 로 단순한 그림을 그려 사진처럼 저장 (외부 이미지 없음, 예시와 함께 지워짐)
import * as repo from './repo.js';
import { SAMPLE_ART } from './samples.js';

const W = 1200;
const H = 900;

function toBlob(c, q = 0.85) {
  return new Promise((resolve) => {
    c.toBlob((b) => {
      if (b && b.type === 'image/webp') resolve(b);
      else c.toBlob(resolve, 'image/jpeg', q);
    }, 'image/webp', q);
  });
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 보석 토큰 다섯 개 (보드게임 표지) */
function drawGems(ctx) {
  ctx.fillStyle = '#EFE7D8';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#E4D9C5';
  ctx.fillRect(0, H * 0.72, W, H * 0.28);
  const gems = ['#2F6B4F', '#2B4170', '#8C2F45', '#2A2622', '#F7F3EA'];
  gems.forEach((color, i) => {
    const x = 240 + i * 180;
    const y = 470 + (i % 2 ? -40 : 30);
    ctx.fillStyle = 'rgba(40, 30, 20, .14)';
    ctx.beginPath();
    ctx.ellipse(x, y + 92, 88, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 86, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = i === 4 ? '#B9AE9B' : 'rgba(255,255,255,.35)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(x, y, 60, 0, Math.PI * 2);
    ctx.stroke();
  });
}

/** 시계탑 (방탈출 사진) */
function drawClock(ctx) {
  ctx.fillStyle = '#1F2E4D';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#26375A';
  ctx.beginPath();
  ctx.moveTo(360, H);
  ctx.lineTo(360, 330);
  ctx.arc(600, 330, 240, Math.PI, 0);
  ctx.lineTo(840, H);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#F4EFE6';
  ctx.beginPath();
  ctx.arc(600, 360, 170, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1F2E4D';
  ctx.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.lineWidth = i % 3 === 0 ? 10 : 5;
    ctx.beginPath();
    ctx.moveTo(600 + Math.sin(a) * 140, 360 - Math.cos(a) * 140);
    ctx.lineTo(600 + Math.sin(a) * 155, 360 - Math.cos(a) * 155);
    ctx.stroke();
  }
  const hand = (turn, len, width) => {
    const a = turn * Math.PI * 2;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(600, 360);
    ctx.lineTo(600 + Math.sin(a) * len, 360 - Math.cos(a) * len);
    ctx.stroke();
  };
  hand((3 + 15 / 60) / 12, 88, 12);
  hand(15 / 60, 128, 7);
  ctx.fillStyle = '#C9A45C';
  ctx.beginPath();
  ctx.arc(600, 360, 12, 0, Math.PI * 2);
  ctx.fill();
}

async function save(draw) {
  const full = makeCanvas(W, H);
  draw(full.getContext('2d'));
  const thumb = makeCanvas(480, 360);
  thumb.getContext('2d').drawImage(full, 0, 0, 480, 360);
  const [fb, tb] = await Promise.all([toBlob(full), toBlob(thumb, 0.8)]);
  if (!fb || !tb) return null;
  return repo.putImage({ full: fb, thumb: tb, width: W, height: H, sample: true });
}

/** 예시 그림을 저장하고 { 붙일 곳 id → 사진 id } 반환. 그리지 못하면 그림 없이 */
export async function makeSampleArt() {
  const out = {};
  try {
    const gems = await save(drawGems);
    if (gems) out[SAMPLE_ART.gems] = gems;
    const clock = await save(drawClock);
    if (clock) out[SAMPLE_ART.clock] = clock;
  } catch { /* 그림 없이 예시만 */ }
  return out;
}
