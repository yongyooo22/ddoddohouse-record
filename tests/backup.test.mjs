// 백업 파일 — 내보낸 JSON 을 다시 읽기, 잘못된 값 거르기, 예전 버전(모임용 서버) 백업 옮기기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupHead, backupTail, imageEntry, parseBackup, base64ToBytes, bytesToBase64, sniffType, hashKey } from '../js/backup.js';
import { buildSamples } from '../js/samples.js';

const NOW = '2026-09-30T00:00:00.000Z';
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]);
const SVG = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));

function build(images = []) {
  const { works, plays } = buildSamples({ now: NOW });
  const withImages = images.length > 0;
  let text = backupHead({ bookName: '내 기록장', works, plays, withImages, exportedAt: NOW });
  images.forEach((im, i) => { text += `${i ? ',' : ''}\n  ${JSON.stringify(im)}`; });
  return text + backupTail(withImages);
}

test('base64 ↔ 바이트, 형식 판별', () => {
  const b64 = bytesToBase64(JPEG);
  assert.deepEqual([...base64ToBytes(b64)], [...JPEG]);
  assert.equal(base64ToBytes('not base64!'), null);
  assert.equal(sniffType(JPEG), 'image/jpeg');
  assert.equal(sniffType(WEBP), 'image/webp');
  assert.equal(sniffType(SVG), null);
});

test('내보낸 백업(사진 없이)을 그대로 다시 읽음', () => {
  const r = parseBackup(build());
  assert.equal(r.ok, true);
  assert.equal(r.format, 'v2');
  assert.equal(r.bookName, '내 기록장');
  assert.equal(r.works.length, 5);
  assert.equal(r.plays.length, 6);
  assert.equal(r.skipped, 0);
  const spoiler = r.plays.find((p) => p.id === 'p_sample_redmansion').spoiler;
  assert.equal(spoiler.culprit, '막내딸 에이미', '스포일러도 백업에는 그대로 (화면에서 가리는 기능일 뿐)');
});

test('사진 포함 백업: JPEG·WebP 만, SVG 등은 버림', () => {
  const rec = (id, bytes) => ({ id, type: 'image/jpeg', thumbType: 'image/jpeg', width: 10, height: 10, createdAt: NOW, full: bytes.buffer, thumb: bytes.buffer });
  const good = imageEntry(rec('i_a', JPEG));
  const webp = imageEntry(rec('i_b', WEBP));
  const bad = imageEntry(rec('i_c', SVG));
  const r = parseBackup(build([good, webp, bad, { id: '../x', full: good.full }]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.images.map((i) => i.id), ['i_a', 'i_b']);
  assert.equal(r.images[1].type, 'image/webp', '형식은 선언이 아니라 바이트로 판별');
  assert.ok(r.images[0].full instanceof ArrayBuffer);
});

test('잘못된 기록은 건너뜀', () => {
  const data = JSON.parse(build());
  data.plays.push({ id: 'p_bad', workId: 'w_missing', date: '2026-01-01' });
  data.plays.push({ id: 'p_bad2', workId: 'w_sample_splendor', date: 'yesterday' });
  data.plays.push({ ...data.plays[0] }); // 같은 id 두 번
  data.works.push({ id: 'w_empty', genre: 'boardgame', title: '기록 없는 작품' });
  data.works.push({ id: 'w_bad', genre: 'chess', title: '체스' });
  const r = parseBackup(JSON.stringify(data));
  assert.equal(r.ok, true);
  assert.equal(r.plays.length, 6);
  assert.ok(!r.works.some((w) => w.id === 'w_empty'), '기록이 없는 작품은 버림');
  assert.equal(r.skipped, 5);
});

test('이 앱 백업이 아니면 거절', () => {
  assert.equal(parseBackup('{').ok, false);
  assert.equal(parseBackup(JSON.stringify({ app: 'other' })).ok, false);
  assert.match(parseBackup(JSON.stringify({ app: 'ddoddohouse-record', version: 9 })).reason, /새 버전/);
});

test('예전 버전(모임용 서버) 백업 → 작품·플레이 구조로', () => {
  const v1 = {
    app: 'ddoddohouse-record', version: 1,
    members: [{ id: 'm1', name: '민지' }, { id: 'm2', name: '준호' }],
    records: [
      { id: 'r1', type: 'escaperoom', date: '2025-05-05', title: '시계탑', members: ['m1', 'm9'], rating: 4, oneLiner: '재밌다', review: '결말이 반전', spoiler: true, photos: ['ph1'], er: { brand: '달빛', branch: '강남점', cleared: true, remainingSec: 300, hints: 2, difficulty: 3.5, fear: 0 } },
      { id: 'r2', type: 'escaperoom', date: '2025-06-06', title: '시계탑', members: [], rating: 0, er: { brand: '열쇠', branch: '홍대점', cleared: false, remainingSec: 100 } },
      { id: 'r3', type: 'escaperoom', date: '2025-07-07', title: ' 시계탑', members: [], er: { brand: '달빛', branch: '강남점', cleared: true } },
      { id: 'r4', type: 'murdermystery', date: '2025-08-08', title: '저택', review: '좋았다', mm: { format: 'box', playTimeMin: 180, scores: { story: 4.5 }, roles: [{ memberId: 'm2', character: '집사', culprit: true }] } },
      { id: 'r5', type: 'boardgame', date: '2025-09-09', title: '카탄', bg: { playTimeMin: 60, expansion: '항해사', results: [{ memberId: 'm1' }, { memberId: 'm2' }] } },
      { id: 'bad', type: 'chess', date: '2025-09-09', title: '체스' },
    ],
    images: [{ id: 'ph1', mime: 'image/jpeg', full: bytesToBase64(JPEG), thumb: bytesToBase64(JPEG) }],
  };
  const r = parseBackup(JSON.stringify(v1));
  assert.equal(r.ok, true);
  assert.equal(r.format, 'v1');
  assert.equal(r.skipped, 1);
  assert.equal(r.plays.length, 5);
  // 같은 테마명이라도 매장이 다르면 다른 작품, 같은 매장이면 한 작품
  const ers = r.works.filter((w) => w.genre === 'escaperoom');
  assert.equal(ers.length, 2);
  const gn = ers.find((w) => w.branch === '강남점');
  assert.equal(r.plays.filter((p) => p.workId === gn.id).length, 2);
  const p1 = r.plays.find((p) => p.id === 'v1_r1');
  assert.equal(p1.review, '', '스포일러로 표시한 후기는 일반 후기에서 뺌');
  assert.equal(p1.oneLiner, '', '예전 앱이 함께 가렸던 한줄평도 빼서 카드에 나오지 않게');
  assert.equal(p1.spoiler.memo, '재밌다\n\n결말이 반전');
  assert.deepEqual(p1.companions, ['민지']);
  assert.deepEqual(p1.photos, ['v1_ph1']);
  assert.equal(p1.details.result, 'success');
  assert.equal(p1.details.remainingSec, 300);
  assert.equal(p1.details.difficulty, 4);
  assert.equal(p1.details.fear, null, '예전 0 = 미평가');
  const p2 = r.plays.find((p) => p.id === 'v1_r2');
  assert.equal(p2.details.result, 'fail');
  assert.equal(p2.details.remainingSec, null);
  assert.equal(p2.rating, null);
  const mm = r.plays.find((p) => p.id === 'v1_r4');
  assert.equal(mm.details.format, 'home');
  assert.equal(mm.details.story, 4.5);
  assert.equal(mm.spoiler.culprit, '집사');
  const bg = r.plays.find((p) => p.id === 'v1_r5');
  assert.equal(bg.details.players, 2);
  assert.equal(bg.details.expansions, '항해사');
  assert.deepEqual(r.images.map((i) => i.id), ['v1_ph1']);
  // 같은 백업을 다시 읽어도 같은 작품 id (다시 가져와도 중복되지 않게)
  assert.deepEqual(parseBackup(JSON.stringify(v1)).works.map((w) => w.id), r.works.map((w) => w.id));
  assert.equal(hashKey('a'), hashKey('a'));
  assert.notEqual(hashKey('a'), hashKey('b'));
});
