// 사진 API 테스트 (node:test) — 형식 판별 / 크기·개수·용량 한도 / 가져오기 멱등 / 바이너리 응답 헤더 /
// 기록 photos 검증 / 기록 삭제·수정 시 정리 / in_use / gc 24시간 규칙 / 경합 / Blob 어댑터 / 개발 서버 본문 한도.
// 사진 파일은 Blob(여기서는 인메모리 가짜)에, Redis 에는 파일 경로와 작은 정보만 들어가는지도 확인한다.
// 저장소 시나리오는 인메모리 가짜 Redis와 (설치돼 있으면) 실제 redis-server 양쪽에서 돌려
// Lua 스크립트와 가짜 구현이 똑같이 동작하는지 확인한다.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandlers, UPSERT_SCRIPT, RECORD_DELETE_SCRIPT, RECORDS_KEY, MEMBERS_KEY, PHOTOS_KEY, MAX_BODY_BYTES } from '../lib/handler.js';
import {
  IMAGE_COMMIT_SCRIPT,
  IMAGE_DELETE_SCRIPT,
  IMAGE_FORGET_SCRIPT,
  IMAGE_GC_SCRIPT,
  IMAGE_RELEASE_SCRIPT,
  IMAGE_RESERVE_SCRIPT,
  IMAGE_ROLLBACK_SCRIPT,
  IMAGE_SWEEP_BATCH,
  MAX_FULL_BYTES,
  MAX_IMAGE_BODY_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  MAX_IMAGES,
  MAX_THUMB_BYTES,
  base64Length,
  decodeImage,
  detectImageType,
  photoPaths,
  publicMeta,
} from '../lib/images.js';
import { BLOB_DEL_BATCH, MAX_BLOB_READ_BYTES, createBlobFromEnv, wrapBlob } from '../lib/blob.js';
import { validateRecord, LIMITS } from '../lib/validate.js';
import { createMemoryBlob, createMemoryRedis, enhanceResponse, startDevServer } from '../scripts/dev.mjs';
import {
  fakeJpeg as jpeg,
  fakeWebp as webp,
  hasRedisServer,
  jpegWithSegments,
  mockRes,
  startRedisServer,
  testRedis,
  webpWithChunks,
} from './redis-helpers.mjs';

const SECRET = 'test-secret-key-0123456789';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOUR = 60 * 60 * 1000;
const silent = { error() {} };

// ── 도우미 ───────────────────────────────────────────────────

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(200, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
const WAV = (() => {
  const b = webp(64);
  b.write('WAVE', 8, 'latin1');
  return b;
})();
const b64 = (buf) => buf.toString('base64');

const rec = (over = {}) => ({ type: 'boardgame', date: '2026-09-01', title: '카탄', members: [], ...over });

/** 미리 넣어 둘 사진 메타 (파일 경로는 boardgame/photos/<id>-seed.jpg · …-seed-thumb.jpg) */
function metaJson(id, { bytesF = 10, bytesT = 5, createdAt = '2026-01-01T00:00:00.000Z', state } = {}) {
  const files = photoPaths(id, 'seed', 'image/jpeg', 'image/jpeg');
  return JSON.stringify({ id, ...files, mime: 'image/jpeg', mimeT: 'image/jpeg', bytesF, bytesT, createdAt, ...(state ? { state } : {}) });
}

/** 이 앱의 키만 비움 (테스트 사이 초기화 — 전체 초기화 명령은 쓰지 않음) */
const clearApp = (redis) => redis.del(RECORDS_KEY, MEMBERS_KEY, PHOTOS_KEY);

function setup({ redis = createMemoryRedis(), blob = createMemoryBlob(), now, logger = silent, env = { APP_SECRET: SECRET } } = {}) {
  const handlers = createHandlers({ redis, blob, env, now, logger });
  async function call(route, { method = 'GET', key = SECRET, ip = '10.0.0.1', body, query = {}, headers = {} } = {}) {
    const req = {
      method,
      headers: { ...(key === null ? {} : { 'x-app-key': key }), 'x-forwarded-for': ip, ...headers },
      query,
      body,
    };
    const res = mockRes();
    await handlers[route](req, res);
    return res;
  }
  const upload = (full = jpeg(), thumb = jpeg(300, 2), extra = {}, opts = {}) =>
    call('images', { method: 'POST', body: { full: b64(full), thumb: b64(thumb), ...extra }, ...opts });
  const getImage = (id, size, opts = {}) => call('images', { query: size === undefined ? { id } : { id, size }, ...opts });
  const delImage = (id) => call('images', { method: 'DELETE', query: { id } });
  const stats = async () => (await call('images', { query: { stats: '1' } })).body;
  const gc = () => call('images', { method: 'POST', query: { action: 'gc' } });
  const saveRecord = (record, baseUpdatedAt) => call('records', { method: 'POST', body: { record, baseUpdatedAt } });
  const delRecord = (id) => call('records', { method: 'DELETE', query: { id } });
  return { handlers, redis, blob, call, upload, getImage, delImage, stats, gc, saveRecord, delRecord };
}

/** 사진 메타(파일 경로)와 Blob 파일이 모두 있는지 / 모두 없는지 */
async function imageState(redis, blob, id) {
  const raw = await redis.hget(PHOTOS_KEY, id);
  const meta = raw ? JSON.parse(raw) : null;
  const files = blob.paths().filter((p) => p.startsWith(`boardgame/photos/${id}-`));
  if (meta && !meta.state && files.length === 2 && files.includes(meta.full) && files.includes(meta.thumb)) return 'present';
  if (!meta && !files.length) return 'gone';
  return `partial(meta=${meta ? meta.state || 'ok' : 'none'},files=${files.length})`;
}

/** 기록에서 빠진(또는 다시 쓰겠다고 한) 시각 — 메타의 touchedAt (없으면 null) */
async function touchedOf(redis, id) {
  const raw = await redis.hget(PHOTOS_KEY, id);
  return raw ? JSON.parse(raw).touchedAt ?? null : null;
}

/** touchedAt 이 적힌 사진 id 들 (정렬) */
async function touchedIds(redis) {
  const all = await redis.hgetall(PHOTOS_KEY);
  return Object.entries(all).filter(([, v]) => v.includes('"touchedAt":"')).map(([id]) => id).sort();
}

// ── 형식 판별 · base64 ───────────────────────────────────────

describe('형식 판별 (매직 바이트)', () => {
  test('JPEG·WebP 만 인정, PNG/GIF/SVG/WAV/짧은 조각은 null', () => {
    assert.equal(detectImageType(jpeg()), 'image/jpeg');
    assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg');
    assert.equal(detectImageType(webp()), 'image/webp');
    for (const [label, buf] of [
      ['PNG', PNG],
      ['GIF', GIF],
      ['SVG', SVG],
      ['RIFF WAVE', WAV],
      ['FF D8 만', Buffer.from([0xff, 0xd8])],
      ['FF D8 00', Buffer.from([0xff, 0xd8, 0x00, 0x01])],
      ['RIFF 만', Buffer.from('RIFF\0\0\0\0WEB', 'latin1')],
      ['빈 버퍼', Buffer.alloc(0)],
      ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ]) {
      assert.equal(detectImageType(buf), null, label);
    }
    assert.equal(detectImageType(null), null);
  });

  test('decodeImage: 엄격한 base64, data: 머리 허용, 한도는 디코드된 바이트 기준', () => {
    const img = jpeg(1000);
    const ok = decodeImage(b64(img), 1000);
    assert.equal(ok.ok, true);
    assert.equal(ok.mime, 'image/jpeg');
    assert.ok(ok.bytes.equals(img));
    assert.equal(ok.base64, b64(img));
    // FileReader.readAsDataURL 결과 그대로
    const dataUrl = decodeImage(`data:image/webp;base64,${b64(webp(300))}`, 1000);
    assert.equal(dataUrl.ok, true);
    assert.equal(dataUrl.mime, 'image/webp');
    // 머리에 적힌 형식이 아니라 실제 바이트로 판별
    assert.equal(decodeImage(`data:image/jpeg;base64,${b64(PNG)}`, 1000).error, 'format');
    assert.equal(decodeImage(b64(img), 999).error, 'too_large');
    // base64 길이만으로도 한도 초과를 먼저 거름 (큰 문자열을 디코드하지 않음)
    assert.equal(decodeImage('A'.repeat(base64Length(999) + 4), 999).error, 'too_large');
    for (const bad of ['', 'abc', 'ab!d', `${b64(img).slice(0, 8)} ${b64(img).slice(8)}`, b64(img).replace(/\+/g, '-').replace(/\//g, '_') + '-_-_', 'A===', '====', 'AB=A']) {
      assert.equal(decodeImage(bad, 10_000).ok, false, JSON.stringify(bad.slice(0, 20)));
    }
    for (const v of [undefined, null, 123, {}, [b64(img)]]) assert.deepEqual(decodeImage(v, 10_000), { ok: false, error: 'invalid' });
    // 비표준 끝자리 비트 → 표준 표기로 다시 인코딩해 저장 (34바이트 → '==' 앞 글자의 남는 4비트를 켬)
    const canon = b64(jpeg(34));
    assert.ok(canon.endsWith('=='));
    const odd = canon.slice(0, -3) + String.fromCharCode(canon.charCodeAt(canon.length - 3) + 1) + '==';
    const tail = decodeImage(odd, 100);
    assert.equal(tail.ok, true);
    assert.equal(tail.base64, canon);
    assert.equal(base64Length(MAX_FULL_BYTES), 955_736);
  });

  test('메타데이터 제거: JPEG APP1(EXIF·XMP)·APP13(IPTC)·COM·MPF·EOI 뒤 꼬리는 떼고, JFIF·ICC·Adobe·그림 데이터는 그대로', () => {
    const base = jpeg(500, 3);
    const exif = 'Exif\0\0MM\0*GPS 37.5665N 126.9780E SECRETMAKE';
    const xmp = 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>37,33.99N</exif:GPSLatitude></x:xmpmeta>';
    const icc = Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), Buffer.alloc(40, 7)]);
    const adobe = 'Adobe\0d\0\0\0\0\x01';
    const dirty = Buffer.concat([
      jpegWithSegments(base, [[0xe1, exif], [0xe2, icc], [0xe1, xmp], [0xed, 'Photoshop 3.0\0IPTC secret'], [0xfe, 'comment secret'], [0xee, adobe], [0xe2, 'MPF\0secret']]),
      Buffer.from('trailing motion-photo secret', 'latin1'),
    ]);
    const r = decodeImage(b64(dirty), 10_000);
    assert.equal(r.ok, true);
    assert.equal(r.mime, 'image/jpeg');
    for (const needle of ['Exif', 'SECRETMAKE', 'GPSLatitude', 'IPTC', 'comment secret', 'MPF', 'motion-photo']) {
      assert.equal(r.bytes.includes(Buffer.from(needle, 'latin1')), false, needle);
    }
    assert.ok(r.bytes.equals(jpegWithSegments(base, [[0xe2, icc], [0xee, adobe]])));
    assert.equal(r.base64, b64(r.bytes));

    // 스캔이 여러 번(프로그레시브)이고 그 사이에 APP1·채움 바이트가 있어도, 압축 데이터 안의 FF 00·RSTn 은 그대로
    const sos = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0];
    const head = base.subarray(0, 20); // SOI + APP0(JFIF)
    const multi = Buffer.concat([head, Buffer.from([...sos, 1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4, 0xff, 0xff, 0xff, 0xe1, 0x00, 0x08]),
      Buffer.from('Exif\0\0', 'latin1'), Buffer.from([...sos, 5, 6, 0xff, 0xd9])]);
    const m = decodeImage(b64(multi), 10_000);
    assert.equal(m.ok, true);
    assert.ok(m.bytes.equals(Buffer.concat([head, Buffer.from([...sos, 1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4, ...sos, 5, 6, 0xff, 0xd9])])));
    // 메타데이터가 없으면 바이트 그대로
    assert.ok(decodeImage(b64(base), 10_000).bytes.equals(base));
  });

  test('메타데이터 제거: WebP EXIF·XMP 청크를 떼고 VP8X 표시도 끔, ICC·그림은 그대로', () => {
    const base = webp(1000, 2);
    const dirty = webpWithChunks(base, [['EXIF', 'Exif\0\0GPS SECRET'], ['XMP ', '<x:xmpmeta>GPSLatitude</x:xmpmeta>'], ['ICCP', 'icc-data']], 0x20 | 0x08 | 0x04);
    const r = decodeImage(b64(dirty), 10_000);
    assert.equal(r.ok, true);
    assert.equal(r.mime, 'image/webp');
    for (const needle of ['EXIF', 'SECRET', 'GPSLatitude', 'XMP ']) assert.equal(r.bytes.includes(Buffer.from(needle, 'latin1')), false, needle);
    assert.ok(r.bytes.equals(webpWithChunks(base, [['ICCP', 'icc-data']], 0x20)));
    assert.equal(r.bytes.readUInt32LE(4), r.bytes.length - 8, 'RIFF 크기');
    assert.ok(decodeImage(b64(base), 10_000).bytes.equals(base), '뗄 게 없으면 그대로');
  });

  test('구조를 읽을 수 없는 파일은 앞의 매직 바이트가 맞아도 거부 (format)', () => {
    const riff = (body, size = 4 + body.length) => {
      const h = Buffer.alloc(12);
      h.write('RIFF', 0, 'latin1');
      h.writeUInt32LE(size, 4);
      h.write('WEBP', 8, 'latin1');
      return Buffer.concat([h, body]);
    };
    for (const [label, buf] of [
      ['JPEG 매직 뒤에 HTML', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<html><script>alert(1)</script></html>')])],
      ['JPEG 구간 길이가 파일보다 김', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x00, 1, 2, 3])],
      ['JPEG 그림 데이터(SOS) 없이 끝', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xd9])],
      ['JPEG 표식 자리에 다른 바이트', Buffer.concat([jpeg(40).subarray(0, 20), Buffer.from('xx'), jpeg(40).subarray(20)])],
      ['WebP 매직 뒤에 SVG', riff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))],
      ['WebP 청크 크기가 파일보다 큼', (() => { const b = webp(200); b.writeUInt32LE(5000, 16); return b; })()],
      ['WebP RIFF 크기가 파일보다 큼', (() => { const b = webp(200); b.writeUInt32LE(5000, 4); return b; })()],
      ['WebP VP8X 가 너무 짧음', riff(Buffer.from('VP8X\x02\0\0\0\0\0', 'latin1'))],
    ]) {
      assert.deepEqual(decodeImage(b64(buf), 10_000), { ok: false, error: 'format' }, label);
    }
  });

  test('본문 한도: 최대 원본 + 최대 썸네일(base64) 이 1.5MB 안에 들어감', () => {
    const json = JSON.stringify({ full: 'A'.repeat(base64Length(MAX_FULL_BYTES)), thumb: 'A'.repeat(base64Length(MAX_THUMB_BYTES)), id: 'x'.repeat(64) });
    assert.ok(json.length < MAX_IMAGE_BODY_BYTES, `${json.length}`);
    assert.equal(MAX_IMAGE_BODY_BYTES, 1.5 * 1024 * 1024);
    assert.equal(MAX_BODY_BYTES, 64 * 1024);
  });
});

describe('기록 photos 검증', () => {
  test('없으면 담지 않음(지금 사진 유지), null → [], 순서 유지, 중복 제거', () => {
    assert.equal(Object.hasOwn(validateRecord(rec()).value, 'photos'), false);
    assert.deepEqual(validateRecord(rec({ photos: null })).value.photos, []);
    assert.deepEqual(validateRecord(rec({ photos: [] })).value.photos, []);
    assert.deepEqual(validateRecord(rec({ photos: ['c', 'a', 'b'] })).value.photos, ['c', 'a', 'b']);
    assert.deepEqual(validateRecord(rec({ photos: ['a', 'b', 'a', 'b'] })).value.photos, ['a', 'b']);
    assert.equal(LIMITS.photos, 4);
    assert.deepEqual(validateRecord(rec({ photos: ['p1', 'p2', 'p3', 'p4'] })).value.photos, ['p1', 'p2', 'p3', 'p4']);
  });

  for (const [label, photos] of [
    ['5장', ['p1', 'p2', 'p3', 'p4', 'p5']],
    ['배열 아님', 'p1'],
    ['객체', { 0: 'p1' }],
    ['잘못된 id', ['p1', 'bad id!']],
    ['경로', ['../x']],
    ['숫자', [1]],
    ['null 항목', [null]],
    ['객체 기본 속성 이름', ['__proto__']],
    ['65자', ['x'.repeat(65)]],
  ]) {
    test(`거부: ${label}`, () => {
      assert.deepEqual(validateRecord(rec({ photos })), { ok: false, field: 'photos' });
    });
  }
});

// ── 인증 · 공통 응답 ─────────────────────────────────────────

describe('사진 API: 인증 · 공통', () => {
  test('키 없는 업로드·조회·삭제·gc 는 401, Redis·Blob 도 건드리지 않음', async () => {
    const touched = [];
    const spy = (obj, tag) => Object.fromEntries(Object.entries(obj).map(([k, fn]) => [k, (...a) => { touched.push(`${tag}.${k}`); return fn(...a); }]));
    const { call, upload, getImage } = setup({ redis: spy(createMemoryRedis(), 'redis'), blob: spy(createMemoryBlob(), 'blob') });
    const responses = [
      await upload(jpeg(), jpeg(100), {}, { key: null }),
      await getImage('abc', 't', { key: null }),
      await getImage('abc', 'f', { key: '  ' }),
      await call('images', { method: 'DELETE', query: { id: 'abc' }, key: null }),
      await call('images', { method: 'POST', query: { action: 'gc' }, key: null }),
      await call('images', { query: { stats: '1' }, key: null }),
    ];
    for (const res of responses) {
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { error: 'unauthorized' });
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.raw, undefined, '바이너리를 보내면 안 됨');
    }
    assert.deepEqual(touched, []);
  });

  test('틀린 키는 401 + 실패 카운트, 20번이면 사진 조회도 429', async () => {
    const { redis, upload, getImage } = setup();
    const up = await upload();
    assert.equal(up.statusCode, 200);
    const id = up.body.image.id;
    assert.equal((await upload(jpeg(), jpeg(100), {}, { key: 'wrong-key', ip: '4.4.4.4' })).statusCode, 401);
    assert.equal((await getImage(id, 't', { key: 'wrong-key', ip: '4.4.4.4' })).statusCode, 401);
    assert.equal(await redis.get('boardgame:fail:4.4.4.4'), '2');
    for (let i = 0; i < 18; i++) await getImage(id, 't', { key: `bad-${i}`, ip: '4.4.4.4' });
    const locked = await getImage(id, 't', { ip: '4.4.4.4' });
    assert.equal(locked.statusCode, 429);
    assert.equal(locked.raw, undefined);
    assert.equal((await getImage(id, 't', { ip: '4.4.4.5' })).statusCode, 200);
  });

  test('APP_SECRET·Redis 설정 없으면 503', async () => {
    for (const opts of [{ env: {} }, { redis: null }]) {
      const { upload, getImage } = setup(opts);
      for (const res of [await upload(), await getImage('abc', 't')]) {
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: 'not_configured' });
      }
    }
  });

  test('Blob(사진 파일 저장소)이 연결되지 않으면 사진 올리기·보기·지우기·gc 만 503 (reason blob) — 기록·멤버·통계는 그대로', async () => {
    const { call, upload, getImage, delImage, gc, stats, saveRecord, delRecord, redis } = setup({ blob: null });
    for (const res of [await upload(), await getImage('abc', 't'), await delImage('abc'), await gc()]) {
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, { error: 'not_configured', reason: 'blob' });
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    // 입력 형식 오류는 그대로 400
    assert.deepEqual((await getImage('bad id', 't')).body, { error: 'invalid', field: 'id' });
    assert.deepEqual(await stats(), { count: 0, bytes: 0, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES, ready: false });
    assert.deepEqual((await call('images', { query: { list: '1' } })).body, { images: [] });
    const r = await saveRecord(rec());
    assert.equal(r.statusCode, 200);
    assert.deepEqual((await saveRecord(rec({ photos: ['p1'] }))).body, { error: 'invalid', field: 'photos', missing: ['p1'] });
    assert.deepEqual((await delRecord(r.body.record.id)).body, { ok: true });
    assert.equal(await redis.hget(PHOTOS_KEY, 'p1'), null);
  });

  test('허용되지 않은 메서드 405 + Allow, 알 수 없는 action 400', async () => {
    const { call } = setup();
    for (const method of ['PUT', 'PATCH', 'HEAD']) {
      const res = await call('images', { method, query: { id: 'abc' } });
      assert.equal(res.statusCode, 405);
      assert.equal(res.headers.allow, 'GET, POST, DELETE');
      assert.equal(res.raw, undefined);
    }
    const bad = await call('images', { method: 'POST', query: { action: 'drop' }, body: {} });
    assert.deepEqual(bad.body, { error: 'invalid', field: 'action' });
  });

  test('JSON 응답은 모두 no-store (오류·통계·업로드), 500 은 내부 정보 숨김', async () => {
    const { call, upload, getImage, delImage, gc } = setup();
    const responses = [
      await upload(),
      await upload(PNG, jpeg(100)),
      await getImage('nope', 't'),
      await getImage('bad id', 't'),
      await delImage('nope'),
      await gc(),
      await call('images', { query: { stats: '1' } }),
      await call('images', { query: { list: '1' } }),
    ];
    for (const r of responses) {
      assert.equal(r.headers['cache-control'], 'no-store', JSON.stringify(r.body));
      assert.equal(r.raw, undefined);
    }

    const logged = [];
    const redis = { ...createMemoryRedis(), hget: async (k) => { if (k === PHOTOS_KEY) throw new Error(`boom KV_REST_API_TOKEN=${SECRET}`); return null; } };
    const broken = setup({ redis, logger: { error: (...a) => logged.push(a) } });
    const res = await broken.getImage('abc', 't');
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'server_error' });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(logged.length, 1);
  });

  test('본문 한도: 1.5MB 초과 413 (content-length·실제 크기), 64KB~1.5MB 는 사진에서만 허용', async () => {
    const { call, upload } = setup();
    const huge = { full: 'A'.repeat(MAX_IMAGE_BODY_BYTES), thumb: b64(jpeg(100)) };
    let res = await call('images', { method: 'POST', body: huge });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.body, { error: 'too_large' });
    res = await call('images', { method: 'POST', body: JSON.stringify(huge) });
    assert.equal(res.statusCode, 413);
    res = await upload(jpeg(), jpeg(100), {}, { headers: { 'content-length': String(MAX_IMAGE_BODY_BYTES + 1) } });
    assert.equal(res.statusCode, 413);
    // 64KB 넘는 사진은 되지만, 같은 크기의 기록 본문은 여전히 413
    const big = jpeg(200 * 1024);
    res = await upload(big, jpeg(100));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    res = await call('records', { method: 'POST', body: { record: rec(), pad: b64(big) } });
    assert.equal(res.statusCode, 413);
    // 잘못된 JSON 문자열 본문
    res = await call('images', { method: 'POST', body: '{"full":' });
    assert.deepEqual(res.body, { error: 'invalid', field: 'body' });
  });
});

// ── 저장소 시나리오 (가짜 / 실제 Redis 공통, 파일은 인메모리 가짜 Blob) ────────

function imageSuite(label, makeRedis) {
  describe(`사진 저장 (${label})`, () => {
    let redis;
    let blob = createMemoryBlob();
    before(async () => {
      redis = await makeRedis();
    });

    /** 이 앱의 키와 가짜 Blob 을 비움 */
    async function reset() {
      await clearApp(redis);
      blob = createMemoryBlob();
    }

    function fresh(opts = {}) {
      return setup({ redis, blob, ...opts });
    }

    test('업로드 → 앱에는 {id,mime,mimeT,bytesF,bytesT,createdAt}, 파일은 Blob 에, Redis 에는 파일 경로 문자열만', async () => {
      await reset();
      const t0 = Date.parse('2026-09-29T01:02:03.004Z');
      const { upload } = fresh({ now: () => new Date(t0) });
      const full = webp(5000, 3);
      const thumb = jpeg(700, 4);
      const res = await upload(full, thumb);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.headers['cache-control'], 'no-store');
      const { image } = res.body;
      assert.match(image.id, UUID_RE);
      assert.deepEqual(image, {
        id: image.id,
        mime: 'image/webp',
        mimeT: 'image/jpeg',
        bytesF: 5000,
        bytesT: 700,
        createdAt: '2026-09-29T01:02:03.004Z',
      });
      assert.equal(res.body.existed, undefined);
      // Redis: 사진 id → 파일 경로·형식·크기·시각 (작은 JSON 하나)
      const raw = await redis.hget(PHOTOS_KEY, image.id);
      const stored = JSON.parse(raw);
      assert.deepEqual(stored, { ...image, full: stored.full, thumb: stored.thumb });
      assert.match(stored.full, new RegExp(`^boardgame/photos/${image.id}-[0-9a-f]{12}\\.webp$`));
      assert.equal(stored.thumb, stored.full.replace(/\.webp$/, '-thumb.jpg'));
      assert.ok(raw.length < 400, `메타 ${raw.length}B`);
      assert.ok(!raw.includes(b64(full).slice(8, 48)) && !raw.includes(b64(thumb).slice(8, 48)), 'Redis 에 사진 데이터(base64) 없음');
      // Blob: 원본·썸네일 파일 두 개 (형식 그대로)
      assert.deepEqual(blob.paths(), [stored.thumb, stored.full].sort());
      assert.ok((await blob.get(stored.full)).equals(full));
      assert.ok((await blob.get(stored.thumb)).equals(thumb));
      assert.equal(blob.contentType(stored.full), 'image/webp');
      assert.equal(blob.contentType(stored.thumb), 'image/jpeg');
    });

    test('Redis 로 가는 명령에는 사진 데이터가 없음 (올리기·보기·지우기 모두 — 요청이 작음)', async () => {
      await reset();
      const sent = [];
      const tracing = new Proxy(redis, {
        get(target, name) {
          const fn = target[name];
          return typeof fn !== 'function' ? fn : (...a) => { sent.push(JSON.stringify(a)); return fn.apply(target, a); };
        },
      });
      const { upload, getImage, delImage } = fresh({ redis: tracing });
      const full = jpeg(MAX_FULL_BYTES, 21);
      const thumb = webp(MAX_THUMB_BYTES, 22);
      const { image } = (await upload(full, thumb)).body;
      assert.ok((await getImage(image.id, 'f')).raw.equals(full));
      assert.ok((await getImage(image.id, 't')).raw.equals(thumb));
      assert.deepEqual((await delImage(image.id)).body, { ok: true });
      assert.ok(sent.length >= 5);
      for (const cmd of sent) {
        assert.ok(cmd.length < 6000, `Redis 명령 ${cmd.length}B`);
        assert.ok(!cmd.includes(b64(full).slice(100, 160)) && !cmd.includes(b64(thumb).slice(100, 160)));
      }
      assert.deepEqual(blob.paths(), []);
    });

    test('GET 바이너리: 저장된 형식·헤더·바이트 그대로 (size=t|f, 기본 f)', async () => {
      const { upload, getImage } = fresh();
      const full = jpeg(4321, 5);
      const thumb = webp(321, 6);
      const { image } = (await upload(full, thumb)).body;
      for (const [size, bytes, mime] of [['f', full, image.mime], ['t', thumb, image.mimeT], [undefined, full, image.mime]]) {
        const res = await getImage(image.id, size);
        assert.equal(res.statusCode, 200, String(size));
        assert.equal(res.body, undefined, 'JSON 이 아님');
        assert.ok(Buffer.isBuffer(res.raw) && res.raw.equals(bytes), `${size} 바이트`);
        assert.equal(res.headers['content-type'], mime);
        assert.equal(res.headers['content-length'], String(bytes.length));
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['content-disposition'], 'inline');
        assert.equal(res.headers['cache-control'], 'private, max-age=604800, immutable');
        assert.equal(res.headers.vary, 'x-app-key');
        assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
      }
      assert.equal(image.mime, 'image/jpeg');
      assert.equal(image.mimeT, 'image/webp');
    });

    test('GET: 없으면 404 JSON(no-store), 잘못된 id·size 400', async () => {
      const { getImage, call } = fresh();
      const missing = await getImage('no-such-image', 't');
      assert.equal(missing.statusCode, 404);
      assert.deepEqual(missing.body, { error: 'not_found' });
      assert.equal(missing.headers['cache-control'], 'no-store');
      assert.equal(missing.headers.vary, undefined);
      assert.deepEqual((await getImage('bad id', 't')).body, { error: 'invalid', field: 'id' });
      assert.deepEqual((await getImage('__proto__', 't')).body, { error: 'invalid', field: 'id' });
      assert.deepEqual((await getImage('abc', 'x')).body, { error: 'invalid', field: 'size' });
      assert.deepEqual((await getImage('abc', 'full')).body, { error: 'invalid', field: 'size' });
      assert.deepEqual((await call('images', { query: {} })).body, { error: 'invalid', field: 'id' });
      // 배열로 온 쿼리(?id=a&id=b)는 첫 값
      const { image } = (await fresh().upload()).body;
      const arr = await call('images', { query: { id: [image.id, 'other'], size: ['t'] } });
      assert.equal(arr.statusCode, 200);
    });

    test('GET: 파일이 JPEG·WebP 가 아니면 500 (image/jpeg·webp 외로는 안 보냄), 파일이 없거나 올리는 중이면 404', async () => {
      const errors = [];
      const { getImage } = fresh({ logger: { error: (...a) => errors.push(a.join(' ')) } });
      for (const [id, buf] of [['junk-svg', SVG], ['junk-png', PNG], ['junk-html', Buffer.from('<html><script>alert(1)</script>')]]) {
        await redis.hset(PHOTOS_KEY, { [id]: metaJson(id) });
        await blob.put(JSON.parse(metaJson(id)).thumb, buf, 'image/jpeg');
        const res = await getImage(id, 't');
        assert.equal(res.statusCode, 500, id);
        assert.deepEqual(res.body, { error: 'server_error' });
        assert.equal(res.raw, undefined, `${id}: 바이너리 없음`);
        assert.equal(res.headers['content-type'], undefined);
        assert.equal(res.headers['cache-control'], 'no-store');
        await redis.hdel(PHOTOS_KEY, id);
        await blob.del([JSON.parse(metaJson(id)).thumb]);
      }
      assert.equal(errors.length, 3);
      // 메타는 있는데 Blob 에 파일이 없음 → 404
      await redis.hset(PHOTOS_KEY, { lost: metaJson('lost') });
      assert.deepEqual((await getImage('lost', 'f')).body, { error: 'not_found' });
      // 올리는 중·지우는 중 → 404 (파일이 있어도)
      for (const state of ['uploading', 'deleting']) {
        await redis.hset(PHOTOS_KEY, { half: metaJson('half', { state }) });
        await blob.put(JSON.parse(metaJson('half')).full, jpeg(), 'image/jpeg');
        assert.deepEqual((await getImage('half', 'f')).body, { error: 'not_found' }, state);
      }
      await redis.hdel(PHOTOS_KEY, 'lost');
      await redis.hdel(PHOTOS_KEY, 'half');
    });

    test('형식 거부: PNG/GIF/SVG/가짜 매직 → 400 reason format (full·thumb 각각), 아무것도 저장 안 됨', async () => {
      await reset();
      const { upload, call, stats } = fresh();
      for (const [label, buf] of [['PNG', PNG], ['GIF', GIF], ['SVG', SVG], ['WAV', WAV], ['FF D8', Buffer.from([0xff, 0xd8, 0x00, 0x00])]]) {
        let res = await upload(buf, jpeg(100));
        assert.equal(res.statusCode, 400, label);
        assert.deepEqual(res.body, { error: 'invalid', field: 'full', reason: 'format' }, label);
        res = await upload(jpeg(), buf);
        assert.deepEqual(res.body, { error: 'invalid', field: 'thumb', reason: 'format' }, label);
      }
      for (const [body, field] of [
        [{ thumb: b64(jpeg(100)) }, 'full'],
        [{ full: b64(jpeg()) }, 'thumb'],
        [{ full: 'not base64!', thumb: b64(jpeg(100)) }, 'full'],
        [{ full: b64(jpeg()), thumb: 12345 }, 'thumb'],
        [{ full: '', thumb: b64(jpeg(100)) }, 'full'],
        [{ full: b64(jpeg()), thumb: b64(jpeg(100)), id: 'bad id' }, 'id'],
        [{ full: b64(jpeg()), thumb: b64(jpeg(100)), id: '__proto__' }, 'id'],
        [{ full: b64(jpeg()), thumb: b64(jpeg(100)), id: 42 }, 'id'],
      ]) {
        const res = await call('images', { method: 'POST', body });
        assert.deepEqual(res.body, { error: 'invalid', field }, JSON.stringify(body).slice(0, 60));
      }
      assert.deepEqual((await call('images', { method: 'POST', body: [] })).body, { error: 'invalid', field: 'body' });
      assert.equal((await stats()).count, 0);
      assert.deepEqual(await redis.hgetall(PHOTOS_KEY), {});
      assert.deepEqual(blob.paths(), []);
    });

    test('크기 한도: 원본 700KB·썸네일 100KB 까지 (디코드 기준), 넘으면 413 + field', async () => {
      await reset();
      const { upload, getImage, stats } = fresh();
      const maxFull = jpeg(MAX_FULL_BYTES, 7);
      const ok = await upload(maxFull, jpeg(MAX_THUMB_BYTES, 8));
      assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
      assert.ok((await getImage(ok.body.image.id, 'f')).raw.equals(maxFull));
      let res = await upload(jpeg(MAX_FULL_BYTES + 1), jpeg(100));
      assert.equal(res.statusCode, 413);
      assert.deepEqual(res.body, { error: 'too_large', field: 'full' });
      res = await upload(jpeg(), jpeg(MAX_THUMB_BYTES + 1));
      assert.deepEqual(res.body, { error: 'too_large', field: 'thumb' });
      assert.equal((await stats()).count, 1);
    });

    test('개수 한도 3000 → 409 limit(count), 이미 있는 id 가져오기는 그대로 200, 올리다 끊긴 id 는 새 파일로 채움', async () => {
      await reset();
      const t0 = Date.parse('2026-09-01T00:00:00.000Z');
      const filler = {};
      // 모두 방금 올린 사진 → 가득 차도 자동 정리로 지울 게 없음
      for (let i = 0; i < MAX_IMAGES; i++) filler[`fill-${i}`] = metaJson(`fill-${i}`, { createdAt: new Date(t0).toISOString() });
      // fill-8: 올리다 끊김 (원본 파일만 쓰고 멈춤)
      filler['fill-8'] = metaJson('fill-8', { createdAt: new Date(t0).toISOString(), state: 'uploading' });
      await redis.hset(PHOTOS_KEY, filler);
      const seed7 = JSON.parse(metaJson('fill-7'));
      await blob.put(seed7.full, jpeg(), 'image/jpeg');
      await blob.put(seed7.thumb, jpeg(100), 'image/jpeg');
      const seed8 = JSON.parse(metaJson('fill-8'));
      await blob.put(seed8.full, jpeg(), 'image/jpeg');
      const { upload, stats, getImage } = fresh({ now: () => new Date(t0 + HOUR) });
      const over = await upload();
      assert.equal(over.statusCode, 409);
      assert.deepEqual(over.body, { error: 'limit', reason: 'count' });
      const again = await upload(jpeg(), jpeg(100), { id: 'fill-7' });
      assert.equal(again.statusCode, 200);
      assert.equal(again.body.existed, true);
      // 올리다 끊긴 id 는 한도와 상관없이 같은 id 로 이어받아 새 파일로 채움 (예전 파일은 지움)
      const heal = await upload(jpeg(500, 5), jpeg(100, 5), { id: 'fill-8' });
      assert.equal(heal.statusCode, 200, JSON.stringify(heal.body));
      assert.equal(heal.body.existed, undefined);
      assert.equal(await imageState(redis, blob, 'fill-8'), 'present');
      assert.equal(blob.paths().includes(seed8.full), false, '끊긴 올리기의 파일은 지움');
      assert.ok((await getImage('fill-8', 'f')).raw.equals(jpeg(500, 5)));
      assert.equal((await stats()).count, MAX_IMAGES);
      await reset();
    });

    test('총 용량 한도 500MB: 딱 맞으면 저장, 넘으면 409 limit(bytes) — 메타 합산', async () => {
      await reset();
      await redis.hset(PHOTOS_KEY, {
        big: metaJson('big', { bytesF: MAX_IMAGE_TOTAL_BYTES - 3000, bytesT: 1000 }),
      });
      // big 은 방금 올린 사진 (자동 정리 대상 아님)
      const { upload, stats } = fresh({ now: () => new Date('2026-01-01T01:00:00.000Z') });
      const fits = await upload(jpeg(1500), jpeg(500));
      assert.equal(fits.statusCode, 200, JSON.stringify(fits.body));
      let s = await stats();
      assert.deepEqual(s, { count: 2, bytes: MAX_IMAGE_TOTAL_BYTES, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES, ready: true });
      const over = await upload(jpeg(40), jpeg(40));
      assert.equal(over.statusCode, 409);
      assert.deepEqual(over.body, { error: 'limit', reason: 'bytes' });
      s = await stats();
      assert.equal(s.count, 2);
      await reset();
    });

    test('가득 차면 올린 지 하루 지난 안 쓰는 사진을 한 번 정리하고 다시 시도 (기록이 쓰는·새 사진은 그대로)', async () => {
      await reset();
      let clock = Date.parse('2026-09-10T00:00:00.000Z');
      const { upload, saveRecord, stats } = fresh({ now: () => new Date(clock) });
      const used = (await upload()).body.image.id;
      const old = (await upload()).body.image.id;
      assert.equal((await saveRecord(rec({ photos: [used] }))).statusCode, 200);
      clock += 25 * HOUR;
      const young = (await upload()).body.image.id;
      const per = 2000 + 300;
      await redis.hset(PHOTOS_KEY, {
        filler: metaJson('filler', { bytesF: MAX_IMAGE_TOTAL_BYTES - 3 * per - 100, bytesT: 0, createdAt: new Date(clock).toISOString() }),
      });
      const res = await upload();
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(await imageState(redis, blob, old), 'gone');
      assert.equal(await imageState(redis, blob, used), 'present');
      assert.equal(await imageState(redis, blob, young), 'present');
      assert.equal((await stats()).bytes, MAX_IMAGE_TOTAL_BYTES - 100);
      // 더 지울 게 없으면 409
      assert.deepEqual((await upload()).body, { error: 'limit', reason: 'bytes' });
      await reset();
    });

    test('id 지정(가져오기): 그 id 로 저장, 다시 보내면 existed:true + 원래 메타·파일 유지 (멱등)', async () => {
      await reset();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, getImage, stats } = fresh({ now: () => new Date(clock) });
      const first = await upload(jpeg(900, 1), jpeg(90, 1), { id: 'imp-1', createdAt: '2020-01-01T00:00:00.000Z' });
      assert.equal(first.statusCode, 200);
      assert.equal(first.body.image.id, 'imp-1');
      assert.equal(first.body.existed, undefined);
      // createdAt 은 서버가 정함 (옛 날짜로 들어와 gc 에 바로 걸리지 않게)
      assert.equal(first.body.image.createdAt, '2026-09-01T00:00:00.000Z');
      const files = blob.paths();
      clock += HOUR;
      const again = await upload(webp(500, 2), webp(50, 2), { id: 'imp-1' });
      assert.equal(again.statusCode, 200);
      assert.deepEqual(again.body, { image: first.body.image, existed: true });
      assert.deepEqual(blob.paths(), files, '파일을 다시 올리지 않음');
      assert.ok((await getImage('imp-1', 'f')).raw.equals(jpeg(900, 1)));
      assert.equal((await getImage('imp-1', 't')).headers['content-type'], 'image/jpeg');
      assert.equal((await stats()).count, 1);
      // 곧 기록에 붙일 사진이므로 정리 유예를 지금부터 다시 셈
      assert.equal(await touchedOf(redis, 'imp-1'), new Date(clock).toISOString());
      // 빈 문자열 id 는 없는 것으로
      const gen = await upload(jpeg(), jpeg(100), { id: '' });
      assert.match(gen.body.image.id, UUID_RE);
    });

    test('stats · list (목록에는 파일 경로·내부 표시 없음)', async () => {
      await reset();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, call, stats } = fresh({ now: () => new Date((clock += 1000)) });
      assert.deepEqual(await stats(), { count: 0, bytes: 0, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES, ready: true });
      const a = (await upload(jpeg(1000), jpeg(100))).body.image;
      const b = (await upload(webp(2000), webp(200))).body.image;
      assert.deepEqual(await stats(), { count: 2, bytes: 3300, limitBytes: 500 * 1024 * 1024, limitCount: 3000, ready: true });
      const list = await call('images', { query: { list: '1' } });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.body, { images: [a, b] });
    });

    test('DELETE: 안 쓰는 사진 200 (파일도 지움), 기록이 쓰면 409 in_use, 없으면 404, 잘못된 id 400', async () => {
      await reset();
      const { upload, delImage, getImage, saveRecord, stats } = fresh();
      const free = (await upload()).body.image;
      const used = (await upload()).body.image;
      assert.equal((await saveRecord(rec({ photos: [used.id] }))).statusCode, 200);

      const ok = await delImage(free.id);
      assert.equal(ok.statusCode, 200);
      assert.deepEqual(ok.body, { ok: true });
      assert.equal(await imageState(redis, blob, free.id), 'gone');
      assert.equal((await getImage(free.id, 't')).statusCode, 404);

      const inUse = await delImage(used.id);
      assert.equal(inUse.statusCode, 409);
      assert.deepEqual(inUse.body, { error: 'in_use' });
      assert.equal(await imageState(redis, blob, used.id), 'present');

      assert.deepEqual((await delImage(free.id)).body, { error: 'not_found' });
      assert.equal((await delImage(free.id)).statusCode, 404);
      assert.deepEqual((await delImage('bad id')).body, { error: 'invalid', field: 'id' });
      assert.equal((await stats()).count, 1);
    });

    test('기록 photos: 없는 사진 참조 400 (missing 목록), 있으면 순서대로 저장', async () => {
      await reset();
      const { upload, saveRecord, call } = fresh();
      const a = (await upload()).body.image.id;
      const b = (await upload()).body.image.id;
      const bad = await saveRecord(rec({ photos: [a, 'ghost-1', b, 'ghost-2'] }));
      assert.equal(bad.statusCode, 400);
      assert.deepEqual(bad.body, { error: 'invalid', field: 'photos', missing: ['ghost-1', 'ghost-2'] });
      assert.deepEqual((await call('data')).body.records, [], '저장되면 안 됨');

      const ok = await saveRecord(rec({ photos: [b, a, b] }));
      assert.equal(ok.statusCode, 200);
      assert.deepEqual(ok.body.record.photos, [b, a]);
      assert.deepEqual((await call('data')).body.records[0].photos, [b, a]);
      // 사진 없는 기록도 photos: []
      const none = await saveRecord(rec({ title: '사진 없음' }));
      assert.deepEqual(none.body.record.photos, []);
      // 5장은 검증에서 거부
      const five = await saveRecord(rec({ photos: [a, b, 'c', 'd', 'e'] }));
      assert.deepEqual(five.body, { error: 'invalid', field: 'photos' });
    });

    test('기록 삭제: 그 기록에만 있던 사진은 하루 유예 뒤 정리 (다른 기록이 쓰는 사진·저장 전 새 사진은 그대로)', async () => {
      await reset();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, saveRecord, delRecord, gc } = fresh({ now: () => new Date(clock) });
      const own = (await upload()).body.image.id;
      const shared = (await upload()).body.image.id;
      clock += 30 * HOUR; // 올린 지 하루가 지난 사진들
      const t1 = clock;
      const pending = (await upload()).body.image.id; // 다른 폼에서 방금 올린 사진
      const r1 = (await saveRecord(rec({ photos: [own, shared] }))).body.record;
      const r2 = (await saveRecord(rec({ title: '카탄 2판', photos: [shared] }))).body.record;

      assert.deepEqual((await delRecord(r1.id)).body, { ok: true });
      // 바로 지우지 않음: 다른 기기에서 아직 저장하지 않은 폼이 이 사진을 가리킬 수 있음 → 빠진 시각만 적음
      assert.equal(await imageState(redis, blob, own), 'present');
      assert.equal(await touchedOf(redis, own), new Date(t1).toISOString());
      clock = t1 + HOUR;
      assert.deepEqual((await gc()).body, { deleted: 0 }, 'gc 도 빠진 지 하루가 안 됐으면 남김');
      clock = t1 + 24 * HOUR - 1;
      await saveRecord(rec({ title: '아무 기록' }));
      assert.equal(await imageState(redis, blob, own), 'present', '하루가 되기 전');

      // 하루 뒤 아무 기록이나 저장·삭제하면 함께 정리 (gc 를 누르지 않아도)
      clock = t1 + 24 * HOUR;
      assert.deepEqual((await delRecord(r2.id)).body, { ok: true });
      assert.equal(await imageState(redis, blob, own), 'gone');
      assert.equal(await imageState(redis, blob, shared), 'present', '방금 빠짐 → 유예');
      assert.equal(await imageState(redis, blob, pending), 'present', '기록에 붙은 적 없는 사진은 gc 에서만');

      clock = t1 + 48 * HOUR;
      await saveRecord(rec({ title: '또 다른 기록' }));
      assert.equal(await imageState(redis, blob, shared), 'gone');
      assert.equal(await imageState(redis, blob, pending), 'present');
      assert.deepEqual(await touchedIds(redis), []);
      assert.equal((await delRecord(r2.id)).statusCode, 404);
    });

    test('기록 수정으로 빠진 사진: 하루 유예 뒤 정리 (다른 기록이 쓰면 유지), 순서만 바뀌면 그대로', async () => {
      await reset();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, saveRecord } = fresh({ now: () => new Date(clock) });
      const [a, b, c] = [(await upload()).body.image.id, (await upload()).body.image.id, (await upload()).body.image.id];
      const other = (await saveRecord(rec({ title: '다른 기록', photos: [c] }))).body.record;
      let r = (await saveRecord(rec({ photos: [a, b, c] }))).body.record;

      r = (await saveRecord({ ...r, photos: [c, b, a] }, r.updatedAt)).body.record;
      assert.deepEqual(await touchedIds(redis), [], '순서만 바뀜');

      const res = await saveRecord({ ...r, photos: [b] }, r.updatedAt);
      assert.equal(res.statusCode, 200);
      for (const id of [a, b, c]) assert.equal(await imageState(redis, blob, id), 'present');
      assert.deepEqual(await touchedIds(redis), [a, c].sort());

      // 충돌(409)로 저장이 안 되면 빠진 것으로 치지 않음
      const stale = await saveRecord({ ...r, photos: [] }, r.updatedAt);
      assert.equal(stale.statusCode, 409);
      assert.equal(await touchedOf(redis, b), null);

      clock += 24 * HOUR;
      r = res.body.record;
      assert.equal((await saveRecord({ ...r, title: '카탄 (고침)' }, r.updatedAt)).statusCode, 200);
      assert.equal(await imageState(redis, blob, a), 'gone');
      assert.equal(await imageState(redis, blob, b), 'present');
      assert.equal(await imageState(redis, blob, c), 'present', '다른 기록이 씀');
      assert.deepEqual(other.photos, [c]);
      assert.deepEqual(await touchedIds(redis), [], '쓰는 사진은 표시만 지움');
    });

    test('photos 를 안 보낸 수정(사진을 모르는 예전 앱·예전 백업)은 사진을 그대로 둠, [] 를 보내야 뺌', async () => {
      await reset();
      const { upload, saveRecord, getImage, call } = fresh();
      const a = (await upload()).body.image.id;
      const b = (await upload()).body.image.id;
      const r = (await saveRecord(rec({ photos: [a, b] }))).body.record;
      const { photos, ...legacy } = r; // 예전 앱이 보내는 모양: photos 필드 없음
      assert.deepEqual(photos, [a, b]);
      const res = await saveRecord({ ...legacy, title: '카탄 (예전 앱에서 고침)' }, r.updatedAt);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.record.photos, [a, b]);
      assert.equal(res.body.record.title, '카탄 (예전 앱에서 고침)');
      assert.deepEqual((await call('data')).body.records[0].photos, [a, b]);
      for (const id of [a, b]) {
        assert.equal(await imageState(redis, blob, id), 'present');
        assert.equal((await getImage(id, 'f')).statusCode, 200);
      }
      assert.deepEqual(await touchedIds(redis), [], '빠진 사진 없음');
      // 새 기록이면 사진 없음
      assert.deepEqual((await saveRecord(rec({ title: '새 기록' }))).body.record.photos, []);
      // 이미 깨진 참조(사진이 사라짐)만 조용히 빼고 저장 (예전 앱은 사진 오류를 처리하지 못함)
      const gone = JSON.parse(await redis.hget(PHOTOS_KEY, b));
      await blob.del([gone.full, gone.thumb]);
      await redis.hdel(PHOTOS_KEY, b);
      const cur = res.body.record;
      const res2 = await saveRecord({ ...legacy, title: '또 고침' }, cur.updatedAt);
      assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
      assert.deepEqual(res2.body.record.photos, [a]);
      // 빈 배열을 보내면 모두 뺌
      const res3 = await saveRecord({ ...res2.body.record, photos: [] }, res2.body.record.updatedAt);
      assert.deepEqual(res3.body.record.photos, []);
      assert.ok(await touchedOf(redis, a));
    });

    test('기록이 지워져도 하루 동안은 그 사진으로 다시 저장 가능 (삭제된 기록 되살리기·가져다 쓴 이전 대표 사진)', async () => {
      await reset();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, saveRecord, delRecord, getImage } = fresh({ now: () => new Date(clock) });
      const p = (await upload()).body.image.id;
      const q = (await upload()).body.image.id;
      clock += 30 * HOUR; // 올린 지 오래된 사진이어도
      const r = (await saveRecord(rec({ photos: [p, q] }))).body.record;
      // 기기 1은 r 을 고치는 중, 기기 2는 p 를 '이전 대표 사진'으로 가져다 쓴 새 기록을 쓰는 중 → 그사이 r 삭제
      assert.equal((await delRecord(r.id)).statusCode, 200);
      clock += 3 * HOUR;
      // 기기 1: 404 → '새 기록으로 다시 저장'
      const again = await saveRecord({ ...r, title: '되살린 카탄' }, null);
      assert.equal(again.statusCode, 200, JSON.stringify(again.body));
      assert.deepEqual(again.body.record.photos, [p, q]);
      // 기기 2: 가져다 쓴 대표 사진 그대로
      const reuse = await saveRecord(rec({ date: '2026-09-02', photos: [p] }));
      assert.equal(reuse.statusCode, 200, JSON.stringify(reuse.body));
      clock += 30 * HOUR;
      await saveRecord(rec({ title: '아무 기록' }));
      for (const id of [p, q]) assert.equal((await getImage(id, 't')).statusCode, 200);
      assert.deepEqual(await touchedIds(redis), []);
    });

    test('기록 삭제는 실제로 지운 값의 사진을 정리 (읽은 뒤 다른 기기가 사진을 더해 저장해도 새지 않음)', async () => {
      await reset();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const now = () => new Date(clock);
      const { upload, saveRecord } = fresh({ now });
      const p1 = (await upload()).body.image.id;
      const p2 = (await upload()).body.image.id;
      const r = (await saveRecord(rec({ photos: [p1] }))).body.record;
      let raced = false;
      const racing = {
        ...redis,
        async eval(script, keys, args) {
          if (script === RECORD_DELETE_SCRIPT && !raced) {
            raced = true;
            assert.equal((await saveRecord({ ...r, photos: [p1, p2] }, r.updatedAt)).statusCode, 200);
          }
          return redis.eval(script, keys, args);
        },
      };
      const { delRecord } = fresh({ redis: racing, now });
      assert.deepEqual((await delRecord(r.id)).body, { ok: true });
      assert.ok(raced);
      assert.deepEqual(await touchedIds(redis), [p1, p2].sort());
      clock += 24 * HOUR;
      await saveRecord(rec({ title: '아무 기록' }));
      assert.equal(await imageState(redis, blob, p1), 'gone');
      assert.equal(await imageState(redis, blob, p2), 'gone');
    });

    test('같은 사진을 다른 기록에서 재사용 (공유 참조, 복제 없음)', async () => {
      await reset();
      const { upload, saveRecord, stats } = fresh();
      const cover = (await upload()).body.image.id;
      const first = (await saveRecord(rec({ photos: [cover] }))).body.record;
      const second = await saveRecord(rec({ date: '2026-09-20', photos: [cover] }));
      assert.equal(second.statusCode, 200);
      assert.deepEqual(second.body.record.photos, first.photos);
      assert.equal((await stats()).count, 1);
      assert.equal(blob.paths().length, 2);
    });

    test('정리는 best-effort: 정리 스크립트가 실패해도 기록 삭제·수정은 성공 (로그), gc 로 복구', async () => {
      await reset();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const logged = [];
      const flaky = {
        ...redis,
        async eval(script, keys, args) {
          if (script === IMAGE_RELEASE_SCRIPT && !flaky.ok) throw new Error('redis timeout');
          return redis.eval(script, keys, args);
        },
      };
      const { upload, saveRecord, delRecord, gc } = fresh({ redis: flaky, now: () => new Date(clock), logger: { error: (...a) => logged.push(a[0]) } });
      const a = (await upload()).body.image.id;
      const b = (await upload()).body.image.id;
      let r = (await saveRecord(rec({ photos: [a, b] }))).body.record;
      assert.deepEqual(logged, ['[api] photo cleanup failed']);
      const upd = await saveRecord({ ...r, photos: [b] }, r.updatedAt);
      assert.equal(upd.statusCode, 200);
      r = upd.body.record;
      assert.equal((await delRecord(r.id)).statusCode, 200);
      assert.deepEqual(logged, ['[api] photo cleanup failed', '[api] photo cleanup failed', '[api] photo cleanup failed']);
      assert.equal(await imageState(redis, blob, a), 'present');
      assert.equal(await imageState(redis, blob, b), 'present');
      clock += 25 * HOUR;
      flaky.ok = true;
      assert.deepEqual((await gc()).body, { deleted: 2 });
      assert.equal(await imageState(redis, blob, a), 'gone');
      assert.equal(await imageState(redis, blob, b), 'gone');
    });

    test('Blob 파일 삭제가 실패하면 메타를 지우는 중(deleting)으로 남겨 다음 정리가 다시 지움 (주인 없는 파일이 새지 않음)', async () => {
      await reset();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const logged = [];
      const flakyBlob = { ...blob, async del(paths) { if (!flakyBlob.ok) throw new Error('blob 503'); return blob.del(paths); } };
      const { upload, delImage, gc, getImage, saveRecord, stats } = fresh({ blob: flakyBlob, now: () => new Date(clock), logger: { error: (...a) => logged.push(a[0]) } });
      const a = (await upload()).body.image.id;
      const b = (await upload()).body.image.id;
      // 직접 지우기: 앱에는 지워진 것처럼 (보이지도, 기록에 붙지도 않음), 파일은 다음 정리 때
      assert.deepEqual((await delImage(a)).body, { ok: true });
      assert.equal(JSON.parse(await redis.hget(PHOTOS_KEY, a)).state, 'deleting');
      assert.equal((await getImage(a, 't')).statusCode, 404);
      assert.deepEqual((await saveRecord(rec({ photos: [a] }))).body, { error: 'invalid', field: 'photos', missing: [a] });
      assert.equal(blob.paths().filter((p) => p.includes(a)).length, 2, '파일은 아직 있음');
      // gc: 파일 삭제가 또 실패 → 지운 것으로 세지 않고 메타 유지
      clock += 25 * HOUR;
      assert.deepEqual((await gc()).body, { deleted: 0 });
      assert.equal(JSON.parse(await redis.hget(PHOTOS_KEY, b)).state, 'deleting');
      assert.equal((await stats()).count, 2, '지우는 중인 사진도 용량에 셈');
      assert.deepEqual(logged, ['[api] photo file delete failed', '[api] photo file delete failed']);
      // Blob 이 돌아오면 다음 정리가 마저 지움
      flakyBlob.ok = true;
      assert.deepEqual((await gc()).body, { deleted: 2 });
      assert.deepEqual(await redis.hgetall(PHOTOS_KEY), {});
      assert.deepEqual(blob.paths(), []);
    });

    test('gc: 참조 없음 + 올린 지 24시간 지난 것만 삭제', async () => {
      await reset();
      const t0 = Date.parse('2026-09-01T00:00:00.000Z');
      let clock = t0;
      const { upload, saveRecord, gc, stats } = fresh({ now: () => new Date(clock) });
      const used = (await upload()).body.image.id;
      const orphan = (await upload()).body.image.id;
      await saveRecord(rec({ photos: [used] }));
      clock = t0 + 23 * HOUR;
      const young = (await upload()).body.image.id;

      let res = await gc();
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { deleted: 0 });

      clock = t0 + 24 * HOUR - 1;
      assert.deepEqual((await gc()).body, { deleted: 0 }, '24시간이 되기 전');
      clock = t0 + 24 * HOUR;
      assert.deepEqual((await gc()).body, { deleted: 1 });
      assert.equal(await imageState(redis, blob, orphan), 'gone');
      assert.equal(await imageState(redis, blob, used), 'present');
      assert.equal(await imageState(redis, blob, young), 'present');

      clock = t0 + 47 * HOUR + 1;
      assert.deepEqual((await gc()).body, { deleted: 1 });
      assert.equal(await imageState(redis, blob, young), 'gone');
      assert.equal(await imageState(redis, blob, used), 'present');
      assert.equal((await stats()).count, 1);
    });

    test('gc: 만든 시각이 깨진 메타도 정리, 후보가 많아도(여러 번에 나눠) 모두 처리', async () => {
      await reset();
      const { gc, stats, saveRecord } = fresh({ now: () => new Date('2026-09-29T00:00:00.000Z') });
      const n = IMAGE_SWEEP_BATCH * 2 + 17;
      const filler = {};
      for (let i = 0; i < n; i++) filler[`old-${i}`] = metaJson(`old-${i}`);
      filler['broken-meta'] = '{not json';
      filler['no-date'] = JSON.stringify({ id: 'no-date', bytesF: 1, bytesT: 1 });
      filler['bad-date'] = JSON.stringify({ id: 'bad-date', bytesF: 1, bytesT: 1, createdAt: 'zzz' });
      await redis.hset(PHOTOS_KEY, filler);
      for (const i of [0, IMAGE_SWEEP_BATCH + 3]) {
        const m = JSON.parse(metaJson(`old-${i}`));
        await blob.put(m.full, jpeg(), 'image/jpeg');
        await blob.put(m.thumb, jpeg(100), 'image/jpeg');
      }
      // 하나는 기록이 참조
      assert.equal((await saveRecord(rec({ photos: [`old-${n - 1}`] }))).statusCode, 200);
      assert.deepEqual((await gc()).body, { deleted: n + 2 });
      assert.deepEqual(blob.paths(), []);
      assert.equal((await stats()).count, 1);
      assert.deepEqual(Object.keys(await redis.hgetall(PHOTOS_KEY)), [`old-${n - 1}`]);
    });

    test('기록 JSON 안의 글자는 참조로 치지 않음 (제목·후기에 "photos":["id"] 를 써도)', async () => {
      await reset();
      const { upload, saveRecord, delImage } = fresh();
      const x = (await upload()).body.image.id;
      const y = (await upload()).body.image.id;
      const r1 = await saveRecord(rec({ title: `"photos":["${x}"]`, oneLiner: `] "${x}" [`, review: `{"photos":["${x}"]}`, photos: [] }));
      assert.equal(r1.statusCode, 200);
      // 사진 목록보다 앞에 오는 필드에 ] 나 "photos":[ 가 있어도 진짜 목록을 찾음
      const r2 = await saveRecord(rec({ title: ']"photos":[', oneLiner: `"${y}"]`, tags: [']', '"x"'], photos: [y] }));
      assert.equal(r2.statusCode, 200);
      assert.deepEqual((await delImage(x)).body, { ok: true });
      assert.deepEqual((await delImage(y)).body, { error: 'in_use' });
    });

    test('경합: 저장 직전에 사진이 지워지면 기록 저장이 400 (깨진 참조가 안 생김)', async () => {
      await reset();
      const { upload, call } = fresh();
      const img = (await upload()).body.image.id;
      const racing = {
        ...redis,
        async eval(script, keys, args) {
          if (script === UPSERT_SCRIPT) {
            await redis.eval(IMAGE_DELETE_SCRIPT, [RECORDS_KEY, PHOTOS_KEY], [img]); // 다른 기기가 그 사이 사진을 지움
          }
          return redis.eval(script, keys, args);
        },
      };
      const { saveRecord } = fresh({ redis: racing });
      const res = await saveRecord(rec({ photos: [img] }));
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: 'invalid', field: 'photos', missing: [img] });
      assert.deepEqual((await call('data')).body.records, []);
    });

    test('경합: 지우기 직전에 다른 기록이 그 사진을 붙이면 지우지 않음 (in_use)', async () => {
      await reset();
      const { upload } = fresh();
      const img = (await upload()).body.image.id;
      const racing = {
        ...redis,
        async eval(script, keys, args) {
          if (script === IMAGE_DELETE_SCRIPT) {
            await redis.hset(RECORDS_KEY, { sneaky: JSON.stringify({ id: 'sneaky', ...validateRecord(rec({ photos: [img] })).value }) });
          }
          return redis.eval(script, keys, args);
        },
      };
      const { delImage } = fresh({ redis: racing });
      assert.deepEqual((await delImage(img)).body, { error: 'in_use' });
      assert.equal(await imageState(redis, blob, img), 'present');
    });

    test('Redis 재시도로 자리 잡기·마무리 EVAL 이 두 번 실행돼도 정상 저장 (가짜 충돌 없음)', async () => {
      await reset();
      const retrying = {
        ...redis,
        async eval(script, keys, args) {
          if (script === IMAGE_RESERVE_SCRIPT || script === IMAGE_COMMIT_SCRIPT) await redis.eval(script, keys, args);
          return redis.eval(script, keys, args);
        },
      };
      const { upload, getImage, stats } = fresh({ redis: retrying });
      const full = jpeg(1234, 9);
      const res = await upload(full, jpeg(100));
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.existed, undefined);
      assert.ok((await getImage(res.body.image.id, 'f')).raw.equals(full));
      assert.equal((await stats()).count, 1);
      const imp = await upload(jpeg(), jpeg(100), { id: 'retry-imp' });
      assert.equal(imp.statusCode, 200);
      assert.equal(imp.body.existed, undefined);
      assert.equal(blob.paths().length, 4);
    });

    test('서버도 메타데이터를 뗌: 손으로 만든 백업·직접 API 로 올린 EXIF·XMP 도 저장 안 됨 (크기도 뗀 뒤 기준)', async () => {
      await reset();
      const { upload, getImage } = fresh();
      const clean = jpeg(800, 6);
      const dirty = jpegWithSegments(clean, [[0xe1, 'Exif\0\0GPS 37.5665N SECRETMAKE'], [0xfe, 'secret comment']]);
      const thumb = webp(200, 1);
      const res = await upload(dirty, webpWithChunks(thumb, [['EXIF', 'Exif\0\0GPS']], 0x08), { id: 'restore-crafted-0001' });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.image.bytesF, clean.length);
      assert.ok((await getImage('restore-crafted-0001', 'f')).raw.equals(clean));
      const t = (await getImage('restore-crafted-0001', 't')).raw;
      assert.ok(t.equals(webpWithChunks(thumb, [], 0x00)));
      assert.equal(t.includes(Buffer.from('Exif')), false);
    });

    test('올리다 끊긴 사진(uploading 메타만 남음): 기록이 가리킬 수 없고, 목록에 pending 으로 표시되며, 같은 id 로 다시 올리면 채워짐', async () => {
      await reset();
      const now = () => new Date('2026-09-01T00:00:00.000Z');
      // 함수가 파일을 쓰는 도중에 멈춘 것처럼: 파일 쓰기와 되돌리기(파일 지우기)가 모두 실패
      const dying = {
        ...blob,
        async put(p, bytes, type) {
          await blob.put(p, bytes, type);
          throw new Error('function timeout');
        },
        async del() { throw new Error('function timeout'); },
      };
      const first = await fresh({ blob: dying, now }).upload(jpeg(900, 3), jpeg(90, 3), { id: 'imp-x' });
      assert.equal(first.statusCode, 500);
      const left = JSON.parse(await redis.hget(PHOTOS_KEY, 'imp-x'));
      assert.equal(left.state, 'uploading');
      assert.equal(blob.paths().length, 2, '파일은 남았지만 경로가 메타에 적혀 있음');

      const { upload, saveRecord, getImage, call } = fresh({ now });
      const listed = (await call('images', { query: { list: '1' } })).body.images;
      assert.deepEqual(listed.map((m) => [m.id, m.pending]), [['imp-x', true]], '가져오기가 건너뛰지 않게 목록에 pending');
      assert.deepEqual((await saveRecord(rec({ photos: ['imp-x'] }))).body, { error: 'invalid', field: 'photos', missing: ['imp-x'] });
      assert.equal((await getImage('imp-x', 'f')).statusCode, 404);

      const again = await upload(jpeg(900, 3), jpeg(90, 3), { id: 'imp-x' });
      assert.equal(again.statusCode, 200, JSON.stringify(again.body));
      assert.equal(again.body.existed, undefined);
      assert.equal(again.body.image.pending, undefined);
      assert.equal(JSON.parse(await redis.hget(PHOTOS_KEY, 'imp-x')).state, undefined);
      assert.equal(await imageState(redis, blob, 'imp-x'), 'present');
      assert.ok(!blob.paths().includes(left.full) && !blob.paths().includes(left.thumb), '끊긴 올리기의 파일은 지움');
      assert.ok((await getImage('imp-x', 'f')).raw.equals(jpeg(900, 3)));
      assert.equal((await saveRecord(rec({ photos: ['imp-x'] }))).statusCode, 200);
      assert.equal((await upload(jpeg(900, 3), jpeg(90, 3), { id: 'imp-x' })).body.existed, true, '다 올라간 뒤엔 건너뜀');
    });

    test('되돌리기: 같은 id 를 다른 요청이 이어받아 마무리하고 기록에 붙였으면 그 사진은 그대로 (두 기기에서 같은 백업 가져오기)', async () => {
      await reset();
      const other = fresh();
      let raced = false;
      const racing = {
        ...blob,
        async put(p, bytes, type) {
          if (!raced) {
            raced = true;
            // 이 요청이 파일을 쓰려는 순간, 다른 기기가 같은 id 를 다 올리고 기록까지 저장
            assert.equal((await other.upload(jpeg(700, 4), jpeg(70, 4), { id: 'dup-1' })).statusCode, 200);
            assert.equal((await other.saveRecord(rec({ photos: ['dup-1'] }))).statusCode, 200);
            throw new Error('write failed');
          }
          return blob.put(p, bytes, type);
        },
      };
      const res = await fresh({ blob: racing }).upload(jpeg(700, 4), jpeg(70, 4), { id: 'dup-1' });
      assert.equal(res.statusCode, 500);
      assert.equal(await imageState(redis, blob, 'dup-1'), 'present', '이 요청의 파일만 지우고 이어받은 쪽 파일·메타는 그대로');
      assert.equal((await other.getImage('dup-1', 'f')).statusCode, 200);
      assert.equal((await other.call('data')).body.records[0].photos[0], 'dup-1');
    });

    test('지우는 중인 사진을 같은 id 로 다시 올리면 새 파일로 이어받고, 지우던 쪽은 새 메타·파일을 건드리지 않음', async () => {
      await reset();
      const { upload, getImage } = fresh();
      await upload(jpeg(600, 1), jpeg(60, 1), { id: 'again-1' });
      const oldMeta = JSON.parse(await redis.hget(PHOTOS_KEY, 'again-1'));
      let raced = false;
      const racing = {
        ...blob,
        async del(paths) {
          if (!raced) {
            raced = true;
            // 지우는 도중(파일을 지우기 직전)에 다른 기기가 같은 id 를 백업에서 다시 올림
            const res = await upload(jpeg(600, 2), jpeg(60, 2), { id: 'again-1' });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
          }
          return blob.del(paths);
        },
      };
      assert.deepEqual((await fresh({ blob: racing }).delImage('again-1')).body, { ok: true });
      assert.ok(raced);
      assert.equal(await imageState(redis, blob, 'again-1'), 'present');
      assert.notEqual(JSON.parse(await redis.hget(PHOTOS_KEY, 'again-1')).full, oldMeta.full);
      assert.ok(!blob.paths().includes(oldMeta.full));
      assert.ok((await getImage('again-1', 'f')).raw.equals(jpeg(600, 2)));
    });

    test('gc keep: 요청한 기기의 초안 사진은 남기고, 다른 기기의 gc 에서도 하루 더 보호', async () => {
      await reset();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, call, gc } = fresh({ now: () => new Date(clock) });
      const draft = (await upload()).body.image.id;
      const orphan = (await upload()).body.image.id;
      clock += 25 * HOUR;
      const res = await call('images', { method: 'POST', query: { action: 'gc' }, body: { keep: [draft, 'not-there'] } });
      assert.deepEqual(res.body, { deleted: 1 });
      assert.equal(await imageState(redis, blob, draft), 'present');
      assert.equal(await imageState(redis, blob, orphan), 'gone');
      assert.equal(await touchedOf(redis, draft), new Date(clock).toISOString());
      assert.equal(await redis.hget(PHOTOS_KEY, 'not-there'), null);
      clock += 23 * HOUR;
      assert.deepEqual((await gc()).body, { deleted: 0 }, '다른 기기의 gc: 아직 유예 중');
      clock += 2 * HOUR;
      assert.deepEqual((await gc()).body, { deleted: 1 });
      for (const keep of ['x', [1], ['bad id'], Array(41).fill('a'), { 0: 'a' }]) {
        assert.deepEqual((await call('images', { method: 'POST', query: { action: 'gc' }, body: { keep } })).body, { error: 'invalid', field: 'keep' });
      }
      assert.deepEqual((await call('images', { method: 'POST', query: { action: 'gc' }, body: '{bad' })).body, { error: 'invalid', field: 'body' });
    });

    test('파일 저장이 실패하면 500 + 메타·파일 되돌림 (개수·용량에 안 남음)', async () => {
      await reset();
      const logged = [];
      const failing = {
        ...blob,
        async put(p, bytes, type) {
          if (p.includes('-thumb.')) throw new Error('write failed'); // 썸네일 쓰기 실패
          return blob.put(p, bytes, type);
        },
      };
      const { upload, stats } = fresh({ blob: failing, logger: { error: (...a) => logged.push(a[0]) } });
      const res = await upload();
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { error: 'server_error' });
      assert.deepEqual(await redis.hgetall(PHOTOS_KEY), {});
      assert.deepEqual(blob.paths(), [], '먼저 쓴 원본 파일도 지움');
      assert.deepEqual(await stats(), { count: 0, bytes: 0, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES, ready: true });
      assert.deepEqual(logged, ['[api] server_error']);
    });
  });
}

imageSuite('인메모리 가짜 Redis', () => createMemoryRedis());

// ── 실제 redis-server: Lua 스크립트와 가짜 구현 비교 ─────────────

describe('실제 redis-server (사진)', { skip: hasRedisServer ? false : 'redis-server 없음' }, () => {
  let server;
  let wrapped;

  before(async () => {
    server = await startRedisServer();
    wrapped = testRedis(server.client.raw);
  });

  after(() => server?.stop());

  test('가짜 Redis 와 같은 결과: 자리 잡기·마무리·되돌리기·지우기·정리·빼기 / UPSERT(사진 확인) / RECORD_DELETE', async () => {
    await clearApp(wrapped);
    const fake = createMemoryRedis();
    const both = async (fn) => {
      const [a, b] = [await fn(wrapped), await fn(fake)];
      assert.deepEqual(a, b);
      return a;
    };
    const T0 = '2026-09-01T00:00:00.000Z';
    const meta = (id, bytes, extra = {}) => JSON.stringify({ id, ...photoPaths(id, 'n1', 'image/jpeg', 'image/jpeg'), mime: 'image/jpeg', mimeT: 'image/jpeg', bytesF: bytes, bytesT: 1, createdAt: T0, ...extra });
    const up = (id, bytes, extra) => meta(id, bytes, { ...extra, state: 'uploading' });
    const reserve = (id, pending, bytes, { maxCount = '4', maxBytes = '100', at = T0, takeover = '' } = {}) => (r) =>
      r.eval(IMAGE_RESERVE_SCRIPT, [PHOTOS_KEY], [id, pending, String(bytes + 1), maxCount, maxBytes, at, takeover]);
    const commit = (id, pending, final) => (r) => r.eval(IMAGE_COMMIT_SCRIPT, [PHOTOS_KEY], [id, pending, final]);
    const rollback = (id, pending) => async (r) => Number(await r.eval(IMAGE_ROLLBACK_SCRIPT, [PHOTOS_KEY], [id, pending]));
    const del = (id) => (r) => r.eval(IMAGE_DELETE_SCRIPT, [RECORDS_KEY, PHOTOS_KEY], [id]);
    const sweep = (script, at, cutoff, max, extra = []) => (r) => r.eval(script, [RECORDS_KEY, PHOTOS_KEY], [at, cutoff, String(max), ...extra]);
    const forget = (...pairs) => async (r) => Number(await r.eval(IMAGE_FORGET_SCRIPT, [PHOTOS_KEY], pairs.flat()));
    const upsert = (id, photos) => (r) =>
      r.eval(UPSERT_SCRIPT, [RECORDS_KEY, PHOTOS_KEY], [id, '', JSON.stringify({ id, title: `"photos":["a"]`, photos }), '10', ...photos]);

    // 자리 잡기 → 재시도 → 마무리 → 마무리 재시도
    assert.deepEqual(await both(reserve('a', up('a', 40), 40)), ['ok', '']);
    assert.deepEqual(await both(reserve('a', up('a', 40), 40)), ['ok', ''], '같은 요청의 재시도');
    assert.deepEqual(await both(reserve('a', up('a', 41), 41)), ['taken', ''], '이어받기 안 됨(새 id 충돌)');
    assert.equal(await both(commit('a', up('a', 40), meta('a', 40))), 'ok');
    assert.equal(await both(commit('a', up('a', 40), meta('a', 40))), 'ok', '마무리 재시도');
    // 다 올라간 id: 유예를 지금부터 (touchedAt) → 'exists'
    const touchedA = meta('a', 40, { touchedAt: '2026-09-01T05:00:00.000Z' });
    assert.deepEqual(await both(reserve('a', up('a', 9), 9, { at: '2026-09-01T05:00:00.000Z' })), ['exists', touchedA]);
    // 한도: 41 + 59 = 100 (딱 맞음) → 그다음은 bytes / count
    assert.deepEqual(await both(reserve('b', up('b', 58), 58)), ['ok', '']);
    assert.deepEqual(await both(reserve('c', up('c', 0), 0)), ['limit', 'bytes']);
    assert.deepEqual(await both(reserve('c', up('c', 0), 0, { maxCount: '2', maxBytes: '1000' })), ['limit', 'count']);
    // 올리다 끊긴 b 를 가져오기가 이어받음 (새 파일 경로) → 예전 요청의 마무리는 lost, 되돌리기는 남의 자리를 건드리지 않음
    const b2 = JSON.stringify({ ...JSON.parse(up('b', 58)), full: 'boardgame/photos/b-n2.jpg', thumb: 'boardgame/photos/b-n2-thumb.jpg' });
    assert.deepEqual(await both(reserve('b', b2, 58, { takeover: '1' })), ['incomplete', up('b', 58)]);
    assert.equal(await both(commit('b', up('b', 58), meta('b', 58))), 'lost');
    assert.equal(await both(rollback('b', up('b', 58))), 0);
    assert.equal(await both(rollback('b', b2)), 1);
    assert.equal(await both((r) => r.hget(PHOTOS_KEY, 'b')), null);
    assert.deepEqual(await both(reserve('b', up('b', 58), 58)), ['ok', '']);

    // UPSERT: 올리는 중(b)·없는 사진은 없는 것으로, 다 올라간 사진(a)은 붙일 수 있음
    assert.deepEqual(await both(upsert('r1', ['a', 'b', 'x', 'y'])), ['missing', 'b,x,y']);
    assert.deepEqual(await both(upsert('r1', ['a'])), ['ok', '']);
    assert.deepEqual(await both(upsert('r2', [])), ['ok', '']);

    // 직접 지우기: 없음 / 기록이 씀 / 지울 차례로 (다시 불러도 같은 값)
    assert.deepEqual(await both(del('zz')), ['missing', '']);
    assert.deepEqual(await both(del('a')), ['in_use', '']);
    const doomedB = up('b', 58).replace(',"state":"uploading"}', ',"state":"deleting"}');
    assert.deepEqual(await both(del('b')), ['deleting', doomedB]);
    assert.deepEqual(await both(del('b')), ['deleting', doomedB]);
    assert.deepEqual(await both(upsert('r3', ['b'])), ['missing', 'b'], '지우는 중인 사진도 없는 것으로');
    assert.equal(await both(commit('b', up('b', 58), meta('b', 58))), 'lost', '지우는 중이면 올리기 마무리 안 됨');
    assert.equal(await both(forget(['b', 'not-the-same'], ['zz', doomedB])), 0);
    assert.equal(await both(forget(['b', doomedB])), 1);

    // 기록에서 빠짐(RELEASE): 빠진 사진에 시각을 적고, 적힌 지 하루 지난 것 중 안 쓰는 것만 지울 차례로
    for (const [id, m] of [['d', meta('d', 1)], ['e', meta('e', 1)], ['f', meta('f', 1)], ['g', meta('g', 1)]]) await both((r) => r.hset(PHOTOS_KEY, { [id]: m }));
    await both((r) => r.hset(RECORDS_KEY, { r4: JSON.stringify({ id: 'r4', photos: ['d', 'a'] }) }));
    const at1 = '2026-09-02T00:00:00.000Z';
    assert.deepEqual(await both(sweep(IMAGE_RELEASE_SCRIPT, at1, '2026-09-01T00:00:00.000Z', 10, ['d', 'e', 'b', 'nope'])), [], '방금 빠짐 → 유예');
    assert.equal(JSON.parse(await wrapped.hget(PHOTOS_KEY, 'e')).touchedAt, at1);
    const at2 = '2026-09-03T00:00:01.000Z';
    const out = await both(async (r) => (await sweep(IMAGE_RELEASE_SCRIPT, at2, '2026-09-02T00:00:01.000Z', 10)(r)).map(String));
    assert.deepEqual(out, ['e', JSON.stringify({ ...JSON.parse(meta('e', 1)), touchedAt: at1, state: 'deleting' })], 'e 만 (d 는 기록 r4 가 씀 → 시각만 지움)');
    assert.equal(JSON.parse(await wrapped.hget(PHOTOS_KEY, 'd')).touchedAt, undefined);
    assert.equal(await both(forget(['e', out[1]])), 1);

    // gc: keep 은 유예를 새로, 올린·빠진 시각이 모두 기준보다 오래된 안 쓰는 사진 (시각이 깨졌으면 오래된 것으로)
    // (실제 Redis 해시는 순서가 정해져 있지 않으므로 id 순으로 비교)
    await both((r) => r.hset(PHOTOS_KEY, {
      h: meta('h', 1, { createdAt: '2026-09-05T00:00:00.000Z' }),
      broken: '{not json',
      z: meta('z', 1, { createdAt: 'zzz' }),
    }));
    const byId = (flat) => {
      const pairs = [];
      for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
      return pairs.sort((x, y) => x[0].localeCompare(y[0]));
    };
    const gcRun = (extra) => async (r) => byId(await sweep(IMAGE_GC_SCRIPT, '2026-09-04T00:00:00.000Z', '2026-09-03T00:00:00.000Z', 10, extra)(r));
    const gc = await both(gcRun(['f']));
    assert.deepEqual(gc.map(([id]) => id), ['broken', 'g', 'z'], 'h 는 새 사진, a·d 는 기록이 씀, f 는 keep');
    assert.equal(gc[0][1], '{not jso,"state":"deleting"}');
    assert.equal(JSON.parse(await wrapped.hget(PHOTOS_KEY, 'f')).touchedAt, '2026-09-04T00:00:00.000Z', 'keep');
    assert.deepEqual(await both(gcRun([])), gc, '아직 빼지 않은 것은 같은 값으로 다시 (파일 지우기 재시도)');
    assert.equal(await both(forget(...gc)), 3);
    assert.deepEqual(await both(gcRun([])), []);

    for (const key of [PHOTOS_KEY, RECORDS_KEY]) {
      assert.deepEqual(await wrapped.hgetall(key), await fake.hgetall(key), key);
    }

    // 기록 삭제: 지운 값을 돌려줌, 없으면 nil
    const rd = (id) => (r) => r.eval(RECORD_DELETE_SCRIPT, [RECORDS_KEY], [id]);
    const r1 = await wrapped.hget(RECORDS_KEY, 'r1');
    assert.equal(await both(rd('r1')), r1);
    assert.equal(await both(rd('r1')), null);
    // 한 번에 max 장까지만 지울 차례로 (나머지는 다음 번에 — 어느 것이 먼저인지는 해시 순서에 따름)
    for (const r of [wrapped, fake]) {
      await r.hset(PHOTOS_KEY, { m1: meta('m1', 1), m2: meta('m2', 1), m3: meta('m3', 1) });
      const run = () => sweep(IMAGE_GC_SCRIPT, '2026-09-04T00:00:00.000Z', '2026-09-03T00:00:00.000Z', 2)(r);
      const first = await run();
      assert.equal(first.length, 4);
      assert.equal(Number(await forget(...byId(first))(r)), 2);
      const second = await run();
      assert.equal(second.length, 2);
      assert.equal(Number(await forget(...byId(second))(r)), 1);
      assert.deepEqual(await run(), []);
    }
    // 다 지우면 해시도 사라짐 (가짜도 같음)
    for (const id of ['a', 'd', 'f', 'h']) await both((r) => r.hdel(PHOTOS_KEY, id));
    assert.equal(Number(await server.client.cmd('EXISTS', PHOTOS_KEY)), 0);
    assert.deepEqual(await fake.hgetall(PHOTOS_KEY), {});
    await clearApp(wrapped);
  });

  imageSuite('실제 redis-server + wrapUpstash', async () => wrapped);
});

// ── lib/blob.js: Vercel Blob 어댑터 ─────────────────────────────

describe('lib/blob.js 어댑터 (Vercel Blob 비공개 저장소)', () => {
  /** @vercel/blob 의 put·get·del 흉내 (호출 기록) */
  function fakeSdk() {
    const files = new Map();
    const log = [];
    const stream = (buf) => new ReadableStream({
      start(c) {
        for (let i = 0; i < buf.length; i += 1000) c.enqueue(new Uint8Array(buf.subarray(i, i + 1000)));
        c.close();
      },
    });
    return {
      files,
      log,
      async put(pathname, body, opts) {
        log.push(['put', pathname, opts]);
        files.set(pathname, Buffer.from(body));
        return { pathname, url: `https://store.private.blob.vercel-storage.com/${pathname}` };
      },
      async get(pathname, opts) {
        log.push(['get', pathname, opts]);
        const f = files.get(pathname);
        return f ? { statusCode: 200, stream: stream(f), blob: { size: f.length } } : null;
      },
      async del(list, opts) {
        log.push(['del', list, opts]);
        for (const p of list) files.delete(p);
      },
    };
  }

  test('BLOB_READ_WRITE_TOKEN: 비공개(access private)로 올리고, 경로는 그대로(임의 꼬리 없음)·재시도 덮어쓰기 허용', async () => {
    const sdk = fakeSdk();
    const blob = createBlobFromEnv({ BLOB_READ_WRITE_TOKEN: '  vercel_blob_rw_abc_123  ' }, sdk);
    const bytes = jpeg(2500);
    await blob.put('boardgame/photos/p1-n1.jpg', bytes, 'image/jpeg');
    assert.deepEqual(sdk.log[0], ['put', 'boardgame/photos/p1-n1.jpg', {
      token: 'vercel_blob_rw_abc_123', access: 'private', contentType: 'image/jpeg', addRandomSuffix: false, allowOverwrite: true,
    }]);
    const got = await blob.get('boardgame/photos/p1-n1.jpg');
    assert.ok(Buffer.isBuffer(got) && got.equals(bytes), '여러 조각으로 온 스트림을 모음');
    assert.deepEqual(sdk.log[1], ['get', 'boardgame/photos/p1-n1.jpg', { token: 'vercel_blob_rw_abc_123', access: 'private' }]);
    assert.equal(await blob.get('boardgame/photos/none.jpg'), null);
  });

  test('BLOB_STORE_ID 만 있으면 Vercel OIDC 로 (토큰 없이 storeId), 둘 다 없으면 null', async () => {
    const sdk = fakeSdk();
    const blob = createBlobFromEnv({ BLOB_STORE_ID: 'store_abc' }, sdk);
    await blob.put('boardgame/photos/p2-n1.webp', webp(100), 'image/webp');
    assert.deepEqual(sdk.log[0][2], { storeId: 'store_abc', access: 'private', contentType: 'image/webp', addRandomSuffix: false, allowOverwrite: true });
    assert.equal(createBlobFromEnv({}), null);
    assert.equal(createBlobFromEnv({ BLOB_READ_WRITE_TOKEN: '   ' }), null);
    assert.equal(typeof createBlobFromEnv({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x_y' }).put, 'function', '실제 SDK 로 감싼 객체 (요청은 보내지 않음)');
  });

  test('del: 같은 경로는 한 번만, 100개씩 나눠 지움', async () => {
    const sdk = fakeSdk();
    const blob = wrapBlob(sdk, { token: 't' });
    const paths = Array.from({ length: 250 }, (_, i) => `boardgame/photos/p${i}-n1.jpg`);
    await blob.del([...paths, paths[0], paths[1]]);
    const calls = sdk.log.filter((l) => l[0] === 'del');
    assert.deepEqual(calls.map((c) => c[1].length), [BLOB_DEL_BATCH, BLOB_DEL_BATCH, 50]);
    assert.deepEqual(calls[0][2], { token: 't' });
    await blob.del([]);
    assert.equal(sdk.log.filter((l) => l[0] === 'del').length, 3, '빈 목록은 요청 안 함');
  });

  test('boardgame/photos/ 밖의 경로는 요청을 보내지 않고 오류 (다른 앱 파일을 건드리지 않게)', async () => {
    const sdk = fakeSdk();
    const blob = wrapBlob(sdk, { token: 't' });
    for (const bad of ['mahjong/photos/a.jpg', 'boardgame/other/a.jpg', 'boardgame/photos/', 'boardgame/photos/../mahjong/a.jpg', 'boardgame/photos/a b.jpg', '', null]) {
      await assert.rejects(blob.put(bad, jpeg(), 'image/jpeg'), /밖의 경로/, String(bad));
      await assert.rejects(blob.get(bad), /밖의 경로/, String(bad));
      await assert.rejects(blob.del(['boardgame/photos/ok.jpg', bad]), /밖의 경로/, String(bad));
    }
    assert.deepEqual(sdk.log, []);
  });

  test('실제 @vercel/blob SDK 로 보내는 요청: 비공개·경로 그대로·덮어쓰기 허용·환경변수의 토큰 (Blob API 흉내 서버)', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        const pathname = new URL(req.url, 'http://x').searchParams.get('pathname');
        res.end(req.method === 'PUT'
          ? JSON.stringify({ url: `https://store123.private.blob.vercel-storage.com/${pathname}`, downloadUrl: '', pathname, contentType: req.headers['x-content-type'], contentDisposition: 'inline', etag: '"e1"' })
          : '{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const prev = process.env.VERCEL_BLOB_API_URL;
    process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${server.address().port}`;
    try {
      const blob = createBlobFromEnv({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store123_abcdefghijklmnop' });
      const bytes = jpeg(3000, 5);
      await blob.put('boardgame/photos/p1-abc123.jpg', bytes, 'image/jpeg');
      await blob.del(['boardgame/photos/p1-abc123.jpg', 'boardgame/photos/p1-abc123-thumb.jpg']);
      const [put, del] = seen;
      assert.equal(put.method, 'PUT');
      assert.equal(new URL(put.url, 'http://x').searchParams.get('pathname'), 'boardgame/photos/p1-abc123.jpg');
      assert.ok(put.body.equals(bytes));
      assert.equal(put.headers['x-vercel-blob-access'], 'private');
      assert.equal(put.headers['x-content-type'], 'image/jpeg');
      assert.equal(put.headers['x-add-random-suffix'], '0');
      assert.equal(put.headers['x-allow-overwrite'], '1');
      assert.equal(put.headers.authorization, 'Bearer vercel_blob_rw_store123_abcdefghijklmnop');
      assert.equal(del.method, 'POST');
      assert.equal(new URL(del.url, 'http://x').pathname, '/delete');
      assert.deepEqual(JSON.parse(del.body.toString()).urls, ['boardgame/photos/p1-abc123.jpg', 'boardgame/photos/p1-abc123-thumb.jpg']);
    } finally {
      if (prev === undefined) delete process.env.VERCEL_BLOB_API_URL;
      else process.env.VERCEL_BLOB_API_URL = prev;
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  test('get: 한도보다 큰 파일은 오류 (이 앱이 올린 파일이 아님)', async () => {
    const sdk = fakeSdk();
    sdk.files.set('boardgame/photos/huge.jpg', Buffer.alloc(MAX_BLOB_READ_BYTES + 1));
    await assert.rejects(wrapBlob(sdk).get('boardgame/photos/huge.jpg'), /too large/);
  });

  test('publicMeta: 앱에는 파일 경로·내부 표시를 보내지 않음', () => {
    const m = JSON.parse(metaJson('p9', { state: 'deleting' }));
    assert.deepEqual(publicMeta({ ...m, touchedAt: '2026-01-02T00:00:00.000Z' }), {
      id: 'p9', mime: 'image/jpeg', mimeT: 'image/jpeg', bytesF: 10, bytesT: 5, createdAt: '2026-01-01T00:00:00.000Z', pending: true,
    });
    assert.deepEqual(photoPaths('p9', 'abc', 'image/webp', 'image/jpeg'), { full: 'boardgame/photos/p9-abc.webp', thumb: 'boardgame/photos/p9-abc-thumb.jpg' });
  });
});

// ── 개발 서버: 본문 한도·바이너리 응답·보안 헤더 ────────────────

describe('개발 서버 (사진)', () => {
  let server;
  const api = (p, init = {}) =>
    fetch(server.url + p, { ...init, headers: { 'content-type': 'application/json', 'x-app-key': SECRET, ...(init.headers || {}) } });

  before(async () => {
    server = await startDevServer({ port: 0, secret: SECRET, logger: silent });
  });
  after(() => server?.close());

  test('최대 크기 업로드(≈1.1MB 본문) → 바이너리 조회: 바이트·헤더·CSP', async () => {
    const full = jpeg(MAX_FULL_BYTES, 11);
    const thumb = webp(MAX_THUMB_BYTES, 12);
    const body = JSON.stringify({ full: b64(full), thumb: b64(thumb) });
    assert.ok(body.length > 1024 * 1024 && body.length < MAX_IMAGE_BODY_BYTES);
    let res = await api('/api/images', { method: 'POST', body });
    assert.equal(res.status, 200);
    const { image } = await res.json();
    assert.equal(image.bytesF, MAX_FULL_BYTES);

    for (const [size, bytes, mime] of [['f', full, 'image/jpeg'], ['t', thumb, 'image/webp']]) {
      res = await api(`/api/images?id=${image.id}&size=${size}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), mime);
      assert.equal(res.headers.get('content-length'), String(bytes.length));
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-disposition'), 'inline');
      assert.equal(res.headers.get('cache-control'), 'private, max-age=604800, immutable');
      assert.equal(res.headers.get('vary'), 'x-app-key');
      // vercel.json 전역 보안 헤더도 그대로 (CSP 는 blob: 사진 허용)
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'.*img-src 'self' data: blob:;.*frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes), size);
    }

    res = await api('/api/images?stats=1');
    assert.deepEqual(await res.json(), { count: 1, bytes: MAX_FULL_BYTES + MAX_THUMB_BYTES, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES, ready: true });
    // 파일은 (가짜) Blob 에, Redis 에는 경로만
    assert.equal(server.blob.paths().length, 2);
    assert.ok((await server.redis.hget('boardgame:photos', image.id)).length < 400);
    res = await api(`/api/images?id=${image.id}`, { method: 'DELETE' });
    assert.deepEqual(await res.json(), { ok: true });
    res = await api(`/api/images?id=${image.id}&size=t`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await res.arrayBuffer();
  });

  test('본문 한도: /api/images 만 1.5MB, 다른 API 는 64KB 그대로', async () => {
    let res = await api('/api/images', { method: 'POST', body: JSON.stringify({ full: 'A'.repeat(MAX_IMAGE_BODY_BYTES), thumb: '' }) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'too_large' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    res = await api('/api/images', { method: 'POST', body: JSON.stringify({ full: b64(jpeg(MAX_FULL_BYTES + 3)), thumb: b64(jpeg(100)) }) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'too_large', field: 'full' });
    res = await api('/api/records', { method: 'POST', body: JSON.stringify({ record: rec(), pad: 'x'.repeat(100 * 1024) }) });
    assert.equal(res.status, 413);
    await res.arrayBuffer();
  });

  test('키 없는 사진 요청은 401 JSON + 보안 헤더 (바이너리 없음)', async () => {
    const res = await fetch(`${server.url}/api/images?id=abc&size=t`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /img-src 'self' data: blob:/);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  });

  test('res.send (Vercel 도우미 흉내): Buffer·문자열·객체', async () => {
    const srv = http.createServer((req, res) => {
      enhanceResponse(res);
      if (req.url === '/buf') return res.status(201).send(Buffer.from([0, 1, 2, 255]));
      if (req.url === '/str') return res.send('안녕');
      return res.send({ ok: true });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      let res = await fetch(`${base}/buf`);
      assert.equal(res.status, 201);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
      assert.equal(res.headers.get('content-length'), '4');
      assert.deepEqual([...Buffer.from(await res.arrayBuffer())], [0, 1, 2, 255]);
      res = await fetch(`${base}/str`);
      assert.match(res.headers.get('content-type'), /^text\/html/);
      assert.equal(await res.text(), '안녕');
      res = await fetch(`${base}/obj`);
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(r));
    }
  });
});
