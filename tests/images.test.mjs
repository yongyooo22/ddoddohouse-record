// 사진 API 테스트 (node:test) — 형식 판별 / 크기·개수·용량 한도 / 가져오기 멱등 / 바이너리 응답 헤더 /
// 기록 photos 검증 / 기록 삭제·수정 시 정리 / in_use / gc 24시간 규칙 / 경합 / 개발 서버 본문 한도.
// 저장소 시나리오는 인메모리 가짜 Redis와 (설치돼 있으면) 실제 redis-server 양쪽에서 돌려
// Lua 스크립트와 가짜 구현이 똑같이 동작하는지 확인한다.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandlers, UPSERT_SCRIPT, RECORD_DELETE_SCRIPT, RECORDS_KEY, GAMES_KEY, MAX_BODY_BYTES } from '../lib/handler.js';
import {
  IMAGE_ADD_SCRIPT,
  IMAGE_COMMIT_SCRIPT,
  IMAGE_DELETE_SCRIPT,
  IMAGE_DELETE_BATCH,
  IMAGE_META_KEY,
  IMAGE_ROLLBACK_SCRIPT,
  IMAGE_TOUCH_KEY,
  MAX_FULL_BYTES,
  MAX_IMAGE_BODY_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  MAX_IMAGES,
  MAX_THUMB_BYTES,
  base64Length,
  decodeImage,
  deleteScriptArgs,
  detectImageType,
  imageKey,
} from '../lib/images.js';
import { validateRecord, LIMITS } from '../lib/validate.js';
import { wrapUpstash } from '../lib/redis.js';
import { createMemoryRedis, enhanceResponse, startDevServer } from '../scripts/dev.mjs';
import {
  fakeJpeg as jpeg,
  fakeWebp as webp,
  hasRedisServer,
  jpegWithSegments,
  mockRes,
  startRedisServer,
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

function metaJson(id, { bytesF = 10, bytesT = 5, createdAt = '2026-01-01T00:00:00.000Z' } = {}) {
  return JSON.stringify({ id, mime: 'image/jpeg', mimeT: 'image/jpeg', bytesF, bytesT, createdAt });
}

function setup({ redis = createMemoryRedis(), now, logger = silent, env = { APP_SECRET: SECRET } } = {}) {
  const handlers = createHandlers({ redis, env, now, logger });
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
  return { handlers, redis, call, upload, getImage, delImage, stats, gc, saveRecord, delRecord };
}

/** 사진 데이터 키·메타가 모두 있는지 / 모두 없는지 */
async function imageState(redis, id) {
  const [f, t, meta] = await Promise.all([
    redis.get(imageKey(id, 'f')),
    redis.get(imageKey(id, 't')),
    redis.hget(IMAGE_META_KEY, id),
  ]);
  if (f && t && meta) return 'present';
  if (!f && !t && !meta) return 'gone';
  return `partial(f=${!!f},t=${!!t},meta=${!!meta})`;
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
  test('키 없는 업로드·조회·삭제·gc 는 401, Redis 도 건드리지 않음', async () => {
    const base = createMemoryRedis();
    const touched = [];
    const redis = Object.fromEntries(Object.entries(base).map(([k, fn]) => [k, (...a) => { touched.push(k); return fn(...a); }]));
    const { call, upload, getImage } = setup({ redis });
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
    assert.equal(await redis.get('ddh:fail:4.4.4.4'), '2');
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
    const redis = { ...createMemoryRedis(), get: async (k) => { if (k.startsWith('ddh:img:')) throw new Error(`boom KV_REST_API_TOKEN=${SECRET}`); return null; } };
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

// ── 저장소 시나리오 (가짜 / 실제 Redis 공통) ──────────────────

function imageSuite(label, makeRedis) {
  describe(`사진 저장 (${label})`, () => {
    let redis;
    before(async () => {
      redis = await makeRedis();
    });

    function fresh(opts = {}) {
      return setup({ redis, ...opts });
    }

    test('업로드 → 메타 {id,mime,mimeT,bytesF,bytesT,createdAt}, 원본·썸네일 따로 저장', async () => {
      await redis.flushall();
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
      assert.equal(await redis.get(imageKey(image.id, 'f')), b64(full));
      assert.equal(await redis.get(imageKey(image.id, 't')), b64(thumb));
      assert.deepEqual(JSON.parse(await redis.hget(IMAGE_META_KEY, image.id)), image);
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

    test('GET: 저장된 값이 JPEG·WebP 가 아니면(깨진 키) 바이너리 없이 500 — image/jpeg·webp 외의 형식으로는 안 보냄', async () => {
      const errors = [];
      const { getImage } = fresh({ logger: { error: (...a) => errors.push(a.join(' ')) } });
      for (const [id, buf] of [['junk-svg', SVG], ['junk-png', PNG], ['junk-html', Buffer.from('<html><script>alert(1)</script>')]]) {
        await redis.set(imageKey(id, 't'), b64(buf));
        const res = await getImage(id, 't');
        assert.equal(res.statusCode, 500, id);
        assert.deepEqual(res.body, { error: 'server_error' });
        assert.equal(res.raw, undefined, `${id}: 바이너리 없음`);
        assert.equal(res.headers['content-type'], undefined);
        assert.equal(res.headers['cache-control'], 'no-store');
        await redis.del(imageKey(id, 't'));
      }
      assert.equal(errors.length, 3);
    });

    test('형식 거부: PNG/GIF/SVG/가짜 매직 → 400 reason format (full·thumb 각각), 아무것도 저장 안 됨', async () => {
      await redis.flushall();
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
      assert.deepEqual(await redis.hgetall(IMAGE_META_KEY), {});
    });

    test('크기 한도: 원본 700KB·썸네일 100KB 까지 (디코드 기준), 넘으면 413 + field', async () => {
      await redis.flushall();
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

    test('개수 한도 3000 → 409 limit(count), 이미 있는 id 가져오기는 그대로 200, 올리다 끊긴 id 는 채움', async () => {
      await redis.flushall();
      const t0 = Date.parse('2026-09-01T00:00:00.000Z');
      const filler = {};
      // 모두 방금 올린 사진 → 가득 차도 자동 정리로 지울 게 없음
      for (let i = 0; i < MAX_IMAGES; i++) filler[`fill-${i}`] = metaJson(`fill-${i}`, { createdAt: new Date(t0).toISOString() });
      await redis.hset(IMAGE_META_KEY, filler);
      await redis.set(imageKey('fill-7', 'f'), b64(jpeg()));
      await redis.set(imageKey('fill-7', 't'), b64(jpeg(100)));
      const { upload, stats, getImage } = fresh({ now: () => new Date(t0 + HOUR) });
      const over = await upload();
      assert.equal(over.statusCode, 409);
      assert.deepEqual(over.body, { error: 'limit', reason: 'count' });
      const again = await upload(jpeg(), jpeg(100), { id: 'fill-7' });
      assert.equal(again.statusCode, 200);
      assert.equal(again.body.existed, true);
      // 메타만 있고 데이터가 없는 id(올리다 끊김)는 한도와 상관없이 같은 id 로 데이터를 채움
      const heal = await upload(jpeg(500, 5), jpeg(100, 5), { id: 'fill-8' });
      assert.equal(heal.statusCode, 200, JSON.stringify(heal.body));
      assert.equal(heal.body.existed, undefined);
      assert.equal(await imageState(redis, 'fill-8'), 'present');
      assert.ok((await getImage('fill-8', 'f')).raw.equals(jpeg(500, 5)));
      assert.equal((await stats()).count, MAX_IMAGES);
      await redis.flushall();
    });

    test('총 용량 한도 150MB: 딱 맞으면 저장, 넘으면 409 limit(bytes) — 메타 합산', async () => {
      await redis.flushall();
      await redis.hset(IMAGE_META_KEY, {
        big: metaJson('big', { bytesF: MAX_IMAGE_TOTAL_BYTES - 3000, bytesT: 1000 }),
      });
      // big 은 방금 올린 사진 (자동 정리 대상 아님)
      const { upload, stats } = fresh({ now: () => new Date('2026-01-01T01:00:00.000Z') });
      const fits = await upload(jpeg(1500), jpeg(500));
      assert.equal(fits.statusCode, 200, JSON.stringify(fits.body));
      let s = await stats();
      assert.deepEqual(s, { count: 2, bytes: MAX_IMAGE_TOTAL_BYTES, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES });
      const over = await upload(jpeg(40), jpeg(40));
      assert.equal(over.statusCode, 409);
      assert.deepEqual(over.body, { error: 'limit', reason: 'bytes' });
      s = await stats();
      assert.equal(s.count, 2);
      await redis.flushall();
    });

    test('가득 차면 올린 지 하루 지난 안 쓰는 사진을 한 번 정리하고 다시 시도 (기록이 쓰는·새 사진은 그대로)', async () => {
      await redis.flushall();
      let clock = Date.parse('2026-09-10T00:00:00.000Z');
      const { upload, saveRecord, stats } = fresh({ now: () => new Date(clock) });
      const used = (await upload()).body.image.id;
      const old = (await upload()).body.image.id;
      assert.equal((await saveRecord(rec({ photos: [used] }))).statusCode, 200);
      clock += 25 * HOUR;
      const young = (await upload()).body.image.id;
      const per = 2000 + 300;
      await redis.hset(IMAGE_META_KEY, {
        filler: metaJson('filler', { bytesF: MAX_IMAGE_TOTAL_BYTES - 3 * per - 100, bytesT: 0, createdAt: new Date(clock).toISOString() }),
      });
      const res = await upload();
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(await imageState(redis, old), 'gone');
      assert.equal(await imageState(redis, used), 'present');
      assert.equal(await imageState(redis, young), 'present');
      assert.equal((await stats()).bytes, MAX_IMAGE_TOTAL_BYTES - 100);
      // 더 지울 게 없으면 409
      assert.deepEqual((await upload()).body, { error: 'limit', reason: 'bytes' });
      await redis.flushall();
    });

    test('id 지정(가져오기): 그 id 로 저장, 다시 보내면 existed:true + 원래 메타·데이터 유지 (멱등)', async () => {
      await redis.flushall();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, getImage, stats } = fresh({ now: () => new Date(clock) });
      const first = await upload(jpeg(900, 1), jpeg(90, 1), { id: 'imp-1', createdAt: '2020-01-01T00:00:00.000Z' });
      assert.equal(first.statusCode, 200);
      assert.equal(first.body.image.id, 'imp-1');
      assert.equal(first.body.existed, undefined);
      // createdAt 은 서버가 정함 (옛 날짜로 들어와 gc 에 바로 걸리지 않게)
      assert.equal(first.body.image.createdAt, '2026-09-01T00:00:00.000Z');
      clock += HOUR;
      const again = await upload(webp(500, 2), webp(50, 2), { id: 'imp-1' });
      assert.equal(again.statusCode, 200);
      assert.deepEqual(again.body, { image: first.body.image, existed: true });
      assert.ok((await getImage('imp-1', 'f')).raw.equals(jpeg(900, 1)));
      assert.equal((await getImage('imp-1', 't')).headers['content-type'], 'image/jpeg');
      assert.equal((await stats()).count, 1);
      // 빈 문자열 id 는 없는 것으로
      const gen = await upload(jpeg(), jpeg(100), { id: '' });
      assert.match(gen.body.image.id, UUID_RE);
    });

    test('stats · list', async () => {
      await redis.flushall();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, call, stats } = fresh({ now: () => new Date((clock += 1000)) });
      assert.deepEqual(await stats(), { count: 0, bytes: 0, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES });
      const a = (await upload(jpeg(1000), jpeg(100))).body.image;
      const b = (await upload(webp(2000), webp(200))).body.image;
      assert.deepEqual(await stats(), { count: 2, bytes: 3300, limitBytes: 150 * 1024 * 1024, limitCount: 3000 });
      const list = await call('images', { query: { list: '1' } });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.body, { images: [a, b] });
    });

    test('DELETE: 안 쓰는 사진 200, 기록이 쓰면 409 in_use, 없으면 404, 잘못된 id 400', async () => {
      await redis.flushall();
      const { upload, delImage, getImage, saveRecord, stats } = fresh();
      const free = (await upload()).body.image;
      const used = (await upload()).body.image;
      assert.equal((await saveRecord(rec({ photos: [used.id] }))).statusCode, 200);

      const ok = await delImage(free.id);
      assert.equal(ok.statusCode, 200);
      assert.deepEqual(ok.body, { ok: true });
      assert.equal(await imageState(redis, free.id), 'gone');
      assert.equal((await getImage(free.id, 't')).statusCode, 404);

      const inUse = await delImage(used.id);
      assert.equal(inUse.statusCode, 409);
      assert.deepEqual(inUse.body, { error: 'in_use' });
      assert.equal(await imageState(redis, used.id), 'present');

      assert.deepEqual((await delImage(free.id)).body, { error: 'not_found' });
      assert.equal((await delImage(free.id)).statusCode, 404);
      assert.deepEqual((await delImage('bad id')).body, { error: 'invalid', field: 'id' });
      assert.equal((await stats()).count, 1);
    });

    test('기록 photos: 없는 사진 참조 400 (missing 목록), 있으면 순서대로 저장', async () => {
      await redis.flushall();
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
      await redis.flushall();
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
      assert.equal(await imageState(redis, own), 'present');
      assert.equal(await redis.hget(IMAGE_TOUCH_KEY, own), new Date(t1).toISOString());
      clock = t1 + HOUR;
      assert.deepEqual((await gc()).body, { deleted: 0 }, 'gc 도 빠진 지 하루가 안 됐으면 남김');
      clock = t1 + 24 * HOUR - 1;
      await saveRecord(rec({ title: '아무 기록' }));
      assert.equal(await imageState(redis, own), 'present', '하루가 되기 전');

      // 하루 뒤 아무 기록이나 저장·삭제하면 함께 정리 (gc 를 누르지 않아도)
      clock = t1 + 24 * HOUR;
      assert.deepEqual((await delRecord(r2.id)).body, { ok: true });
      assert.equal(await imageState(redis, own), 'gone');
      assert.equal(await redis.hget(IMAGE_TOUCH_KEY, own), null);
      assert.equal(await imageState(redis, shared), 'present', '방금 빠짐 → 유예');
      assert.equal(await imageState(redis, pending), 'present', '기록에 붙은 적 없는 사진은 gc 에서만');

      clock = t1 + 48 * HOUR;
      await saveRecord(rec({ title: '또 다른 기록' }));
      assert.equal(await imageState(redis, shared), 'gone');
      assert.equal(await imageState(redis, pending), 'present');
      assert.deepEqual(await redis.hgetall(IMAGE_TOUCH_KEY), {});
      assert.equal((await delRecord(r2.id)).statusCode, 404);
    });

    test('기록 수정으로 빠진 사진: 하루 유예 뒤 정리 (다른 기록이 쓰면 유지), 순서만 바뀌면 그대로', async () => {
      await redis.flushall();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, saveRecord } = fresh({ now: () => new Date(clock) });
      const [a, b, c] = [(await upload()).body.image.id, (await upload()).body.image.id, (await upload()).body.image.id];
      const other = (await saveRecord(rec({ title: '다른 기록', photos: [c] }))).body.record;
      let r = (await saveRecord(rec({ photos: [a, b, c] }))).body.record;

      r = (await saveRecord({ ...r, photos: [c, b, a] }, r.updatedAt)).body.record;
      assert.deepEqual(await redis.hgetall(IMAGE_TOUCH_KEY), {}, '순서만 바뀜');

      const res = await saveRecord({ ...r, photos: [b] }, r.updatedAt);
      assert.equal(res.statusCode, 200);
      for (const id of [a, b, c]) assert.equal(await imageState(redis, id), 'present');
      assert.deepEqual(Object.keys(await redis.hgetall(IMAGE_TOUCH_KEY)).sort(), [a, c].sort());

      // 충돌(409)로 저장이 안 되면 빠진 것으로 치지 않음
      const stale = await saveRecord({ ...r, photos: [] }, r.updatedAt);
      assert.equal(stale.statusCode, 409);
      assert.equal(await redis.hget(IMAGE_TOUCH_KEY, b), null);

      clock += 24 * HOUR;
      r = res.body.record;
      assert.equal((await saveRecord({ ...r, title: '카탄 (고침)' }, r.updatedAt)).statusCode, 200);
      assert.equal(await imageState(redis, a), 'gone');
      assert.equal(await imageState(redis, b), 'present');
      assert.equal(await imageState(redis, c), 'present', '다른 기록이 씀');
      assert.deepEqual(other.photos, [c]);
      assert.deepEqual(await redis.hgetall(IMAGE_TOUCH_KEY), {}, '쓰는 사진은 표시만 지움');
    });

    test('photos 를 안 보낸 수정(사진을 모르는 예전 앱·예전 백업)은 사진을 그대로 둠, [] 를 보내야 뺌', async () => {
      await redis.flushall();
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
        assert.equal(await imageState(redis, id), 'present');
        assert.equal((await getImage(id, 'f')).statusCode, 200);
      }
      assert.deepEqual(await redis.hgetall(IMAGE_TOUCH_KEY), {}, '빠진 사진 없음');
      // 새 기록이면 사진 없음
      assert.deepEqual((await saveRecord(rec({ title: '새 기록' }))).body.record.photos, []);
      // 이미 깨진 참조(사진이 사라짐)만 조용히 빼고 저장 (예전 앱은 사진 오류를 처리하지 못함)
      await redis.del(imageKey(b, 'f'), imageKey(b, 't'));
      await redis.hdel(IMAGE_META_KEY, b);
      const cur = res.body.record;
      const res2 = await saveRecord({ ...legacy, title: '또 고침' }, cur.updatedAt);
      assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
      assert.deepEqual(res2.body.record.photos, [a]);
      // 빈 배열을 보내면 모두 뺌
      const res3 = await saveRecord({ ...res2.body.record, photos: [] }, res2.body.record.updatedAt);
      assert.deepEqual(res3.body.record.photos, []);
      assert.ok(await redis.hget(IMAGE_TOUCH_KEY, a));
    });

    test('기록이 지워져도 하루 동안은 그 사진으로 다시 저장 가능 (삭제된 기록 되살리기·가져다 쓴 이전 대표 사진)', async () => {
      await redis.flushall();
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
      assert.deepEqual(await redis.hgetall(IMAGE_TOUCH_KEY), {});
    });

    test('기록 삭제는 실제로 지운 값의 사진을 정리 (읽은 뒤 다른 기기가 사진을 더해 저장해도 새지 않음)', async () => {
      await redis.flushall();
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
      const { delRecord } = setup({ redis: racing, now });
      assert.deepEqual((await delRecord(r.id)).body, { ok: true });
      assert.ok(raced);
      assert.deepEqual(Object.keys(await redis.hgetall(IMAGE_TOUCH_KEY)).sort(), [p1, p2].sort());
      clock += 24 * HOUR;
      await saveRecord(rec({ title: '아무 기록' }));
      assert.equal(await imageState(redis, p1), 'gone');
      assert.equal(await imageState(redis, p2), 'gone');
    });

    test('같은 사진을 다른 기록에서 재사용 (공유 참조, 복제 없음)', async () => {
      await redis.flushall();
      const { upload, saveRecord, stats } = fresh();
      const cover = (await upload()).body.image.id;
      const first = (await saveRecord(rec({ photos: [cover] }))).body.record;
      const second = await saveRecord(rec({ date: '2026-09-20', photos: [cover] }));
      assert.equal(second.statusCode, 200);
      assert.deepEqual(second.body.record.photos, first.photos);
      assert.equal((await stats()).count, 1);
    });

    test('정리는 best-effort: 정리 표시가 실패해도 기록 삭제·수정은 성공 (로그), gc 로 복구', async () => {
      await redis.flushall();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const logged = [];
      const flaky = {
        ...redis,
        async hset(key, values) {
          if (key === IMAGE_TOUCH_KEY && !flaky.ok) throw new Error('redis timeout');
          return redis.hset(key, values);
        },
      };
      const { upload, saveRecord, delRecord, gc } = setup({ redis: flaky, now: () => new Date(clock), logger: { error: (...a) => logged.push(a[0]) } });
      const a = (await upload()).body.image.id;
      const b = (await upload()).body.image.id;
      let r = (await saveRecord(rec({ photos: [a, b] }))).body.record;
      const upd = await saveRecord({ ...r, photos: [b] }, r.updatedAt);
      assert.equal(upd.statusCode, 200);
      r = upd.body.record;
      assert.equal((await delRecord(r.id)).statusCode, 200);
      assert.deepEqual(logged, ['[api] photo cleanup failed', '[api] photo cleanup failed']);
      assert.equal(await imageState(redis, a), 'present');
      assert.equal(await imageState(redis, b), 'present');
      clock += 25 * HOUR;
      flaky.ok = true;
      assert.deepEqual((await gc()).body, { deleted: 2 });
      assert.equal(await imageState(redis, a), 'gone');
      assert.equal(await imageState(redis, b), 'gone');
    });

    test('gc: 참조 없음 + 올린 지 24시간 지난 것만 삭제', async () => {
      await redis.flushall();
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
      assert.equal(await imageState(redis, orphan), 'gone');
      assert.equal(await imageState(redis, used), 'present');
      assert.equal(await imageState(redis, young), 'present');

      clock = t0 + 47 * HOUR + 1;
      assert.deepEqual((await gc()).body, { deleted: 1 });
      assert.equal(await imageState(redis, young), 'gone');
      assert.equal(await imageState(redis, used), 'present');
      assert.equal((await stats()).count, 1);
    });

    test('게임 대표 이미지: 쓰는 동안은 정리하지 않고, 바꾸거나 게임을 지우면 하루 유예 뒤 정리', async () => {
      await redis.flushall();
      const t0 = Date.parse('2026-09-01T00:00:00.000Z');
      let clock = t0;
      const { call, upload, gc, delImage } = fresh({ now: () => new Date(clock) });
      const saveGame = (game) => call('games', { method: 'POST', body: { game } });
      const [a, b] = [(await upload()).body.image.id, (await upload()).body.image.id];
      let g = (await saveGame({ type: 'boardgame', title: '카탄', cover: a })).body.game;
      assert.equal(g.cover, a);
      assert.equal((await delImage(a)).statusCode, 409, '대표 이미지로 쓰는 사진은 바로 못 지움');
      clock = t0 + 30 * HOUR;
      assert.deepEqual((await gc()).body, { deleted: 1 }, '안 쓰는 b 만');
      assert.equal(await imageState(redis, a), 'present');
      // 대표 이미지를 바꾸면 이전 것은 빠진 시각부터 하루 유예
      const c = (await upload()).body.image.id;
      g = (await saveGame({ ...g, cover: c })).body.game;
      assert.ok(await redis.hget(IMAGE_TOUCH_KEY, a));
      assert.deepEqual((await gc()).body, { deleted: 0 });
      clock = t0 + 54 * HOUR;
      assert.deepEqual((await gc()).body, { deleted: 1 });
      assert.equal(await imageState(redis, a), 'gone');
      assert.equal(await imageState(redis, b), 'gone');
      // 이름·메모만 고치는 예전 앱의 저장은 대표 이미지를 지우지 않음
      g = (await saveGame({ id: g.id, type: 'boardgame', title: '카탄 (고침)', memo: '' })).body.game;
      assert.equal(g.cover, c);
      // cover: null 을 보내야 뺌
      g = (await saveGame({ ...g, cover: null })).body.game;
      assert.equal(g.cover, undefined);
      assert.ok(await redis.hget(IMAGE_TOUCH_KEY, c));
      // 게임을 지워도 대표 이미지는 빠진 것으로 표시
      const d = (await upload()).body.image.id;
      const g2 = (await saveGame({ type: 'escaperoom', title: '연구소', cover: d })).body.game;
      assert.equal((await call('games', { method: 'DELETE', query: { id: g2.id } })).statusCode, 200);
      assert.ok(await redis.hget(IMAGE_TOUCH_KEY, d));
      assert.equal(await imageState(redis, d), 'present', '하루 동안은 남음');
    });

    test('gc: 만든 시각이 깨진 메타도 정리, 후보가 많아도(여러 번에 나눠) 모두 처리', async () => {
      await redis.flushall();
      const { gc, stats, saveRecord } = fresh({ now: () => new Date('2026-09-29T00:00:00.000Z') });
      const n = IMAGE_DELETE_BATCH * 2 + 17;
      const filler = {};
      for (let i = 0; i < n; i++) filler[`old-${i}`] = metaJson(`old-${i}`);
      filler['broken-meta'] = '{not json';
      filler['no-date'] = JSON.stringify({ id: 'no-date', bytesF: 1, bytesT: 1 });
      await redis.hset(IMAGE_META_KEY, filler);
      for (const i of [0, IMAGE_DELETE_BATCH + 3]) {
        await redis.set(imageKey(`old-${i}`, 'f'), b64(jpeg()));
        await redis.set(imageKey(`old-${i}`, 't'), b64(jpeg(100)));
      }
      // 마지막 묶음에 있는 것 하나는 기록이 참조
      assert.equal((await saveRecord(rec({ photos: [`old-${n - 1}`] }))).statusCode, 200);
      assert.deepEqual((await gc()).body, { deleted: n + 1 });
      assert.equal(await redis.get(imageKey('old-0', 'f')), null);
      assert.equal(await redis.get(imageKey(`old-${IMAGE_DELETE_BATCH + 3}`, 't')), null);
      assert.equal((await stats()).count, 1);
      assert.ok(await redis.hget(IMAGE_META_KEY, `old-${n - 1}`));
    });

    test('기록 JSON 안의 글자는 참조로 치지 않음 (제목·후기에 "photos":["id"] 를 써도)', async () => {
      await redis.flushall();
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
      await redis.flushall();
      const { upload, call } = fresh();
      const img = (await upload()).body.image.id;
      const racing = {
        ...redis,
        async eval(script, keys, args) {
          if (script === UPSERT_SCRIPT) {
            const [k, a] = deleteScriptArgs(RECORDS_KEY, [img]);
            await redis.eval(IMAGE_DELETE_SCRIPT, k, a); // 다른 기기가 그 사이 사진을 지움
          }
          return redis.eval(script, keys, args);
        },
      };
      const { saveRecord } = setup({ redis: racing });
      const res = await saveRecord(rec({ photos: [img] }));
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: 'invalid', field: 'photos', missing: [img] });
      assert.deepEqual((await call('data')).body.records, []);
    });

    test('경합: 지우기 직전에 다른 기록이 그 사진을 붙이면 지우지 않음 (in_use)', async () => {
      await redis.flushall();
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
      const { delImage } = setup({ redis: racing });
      assert.deepEqual((await delImage(img)).body, { error: 'in_use' });
      assert.equal(await imageState(redis, img), 'present');
    });

    test('Redis 재시도로 메타 예약 EVAL 이 두 번 실행돼도 정상 저장 (가짜 충돌 없음)', async () => {
      await redis.flushall();
      const retrying = {
        ...redis,
        async eval(script, keys, args) {
          if (script === IMAGE_ADD_SCRIPT) await redis.eval(script, keys, args);
          return redis.eval(script, keys, args);
        },
      };
      const { upload, getImage, stats } = setup({ redis: retrying });
      const full = jpeg(1234, 9);
      const res = await upload(full, jpeg(100));
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.existed, undefined);
      assert.ok((await getImage(res.body.image.id, 'f')).raw.equals(full));
      assert.equal((await stats()).count, 1);
      const imp = await upload(jpeg(), jpeg(100), { id: 'retry-imp' });
      assert.equal(imp.statusCode, 200);
      assert.equal(imp.body.existed, undefined);
    });

    test('서버도 메타데이터를 뗌: 손으로 만든 백업·직접 API 로 올린 EXIF·XMP 도 저장 안 됨 (크기도 뗀 뒤 기준)', async () => {
      await redis.flushall();
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

    test('올리다 끊긴 사진(pending 메타만 남음): 기록이 가리킬 수 없고, 목록에 표시되며, 같은 id 로 다시 올리면 채워짐', async () => {
      await redis.flushall();
      const now = () => new Date('2026-09-01T00:00:00.000Z');
      // 함수가 데이터를 쓰는 도중에 멈춘 것처럼: SET 과 되돌리기가 모두 실패
      const dying = {
        ...redis,
        async set() { throw new Error('function timeout'); },
        async eval(script, keys, args) {
          if (script === IMAGE_ROLLBACK_SCRIPT) throw new Error('function timeout');
          return redis.eval(script, keys, args);
        },
      };
      const first = await setup({ redis: dying, now }).upload(jpeg(900, 3), jpeg(90, 3), { id: 'imp-x' });
      assert.equal(first.statusCode, 500);
      assert.equal(JSON.parse(await redis.hget(IMAGE_META_KEY, 'imp-x')).pending, true);

      const { upload, saveRecord, getImage, call } = fresh({ now });
      const listed = (await call('images', { query: { list: '1' } })).body.images;
      assert.deepEqual(listed.map((m) => [m.id, m.pending]), [['imp-x', true]], '가져오기가 건너뛰지 않게 목록에 pending');
      assert.deepEqual((await saveRecord(rec({ photos: ['imp-x'] }))).body, { error: 'invalid', field: 'photos', missing: ['imp-x'] });
      assert.equal((await getImage('imp-x', 'f')).statusCode, 404);

      const again = await upload(jpeg(900, 3), jpeg(90, 3), { id: 'imp-x' });
      assert.equal(again.statusCode, 200, JSON.stringify(again.body));
      assert.equal(again.body.existed, undefined);
      assert.equal(again.body.image.pending, undefined);
      assert.equal(JSON.parse(await redis.hget(IMAGE_META_KEY, 'imp-x')).pending, undefined);
      assert.ok((await getImage('imp-x', 'f')).raw.equals(jpeg(900, 3)));
      assert.equal((await saveRecord(rec({ photos: ['imp-x'] }))).statusCode, 200);
      assert.equal((await upload(jpeg(900, 3), jpeg(90, 3), { id: 'imp-x' })).body.existed, true, '다 올라간 뒤엔 건너뜀');
    });

    test('되돌리기: 같은 id 를 다른 요청이 마무리하고 기록에 붙였으면 지우지 않음 (두 기기에서 같은 백업 가져오기)', async () => {
      await redis.flushall();
      const other = fresh();
      let raced = false;
      const racing = {
        ...redis,
        async set(key, value) {
          if (!raced) {
            raced = true;
            // 이 요청이 데이터를 쓰려는 순간, 다른 기기가 같은 id 를 다 올리고 기록까지 저장
            assert.equal((await other.upload(jpeg(700, 4), jpeg(70, 4), { id: 'dup-1' })).statusCode, 200);
            assert.equal((await other.saveRecord(rec({ photos: ['dup-1'] }))).statusCode, 200);
            throw new Error('write failed');
          }
          return redis.set(key, value);
        },
      };
      const res = await setup({ redis: racing }).upload(jpeg(700, 4), jpeg(70, 4), { id: 'dup-1' });
      assert.equal(res.statusCode, 500);
      assert.equal(await imageState(redis, 'dup-1'), 'present');
      assert.equal((await other.getImage('dup-1', 'f')).statusCode, 200);
      assert.equal((await other.call('data')).body.records[0].photos[0], 'dup-1');
    });

    test('gc keep: 요청한 기기의 초안 사진은 남기고, 다른 기기의 gc 에서도 하루 더 보호', async () => {
      await redis.flushall();
      let clock = Date.parse('2026-09-01T00:00:00.000Z');
      const { upload, call, gc } = fresh({ now: () => new Date(clock) });
      const draft = (await upload()).body.image.id;
      const orphan = (await upload()).body.image.id;
      clock += 25 * HOUR;
      const res = await call('images', { method: 'POST', query: { action: 'gc' }, body: { keep: [draft, 'not-there'] } });
      assert.deepEqual(res.body, { deleted: 1 });
      assert.equal(await imageState(redis, draft), 'present');
      assert.equal(await imageState(redis, orphan), 'gone');
      assert.equal(await redis.hget(IMAGE_TOUCH_KEY, draft), new Date(clock).toISOString());
      assert.equal(await redis.hget(IMAGE_TOUCH_KEY, 'not-there'), null);
      clock += 23 * HOUR;
      assert.deepEqual((await gc()).body, { deleted: 0 }, '다른 기기의 gc: 아직 유예 중');
      clock += 2 * HOUR;
      assert.deepEqual((await gc()).body, { deleted: 1 });
      for (const keep of ['x', [1], ['bad id'], Array(41).fill('a'), { 0: 'a' }]) {
        assert.deepEqual((await call('images', { method: 'POST', query: { action: 'gc' }, body: { keep } })).body, { error: 'invalid', field: 'keep' });
      }
      assert.deepEqual((await call('images', { method: 'POST', query: { action: 'gc' }, body: '{bad' })).body, { error: 'invalid', field: 'body' });
    });

    test('데이터 저장이 실패하면 500 + 메타·데이터 되돌림 (개수·용량에 안 남음)', async () => {
      await redis.flushall();
      const logged = [];
      let calls = 0;
      const failing = {
        ...redis,
        async set(key, value) {
          if (++calls === 2) throw new Error('write failed'); // 썸네일 쓰기 실패
          return redis.set(key, value);
        },
      };
      const { upload, stats } = setup({ redis: failing, logger: { error: (...a) => logged.push(a[0]) } });
      const res = await upload();
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { error: 'server_error' });
      assert.deepEqual(await redis.hgetall(IMAGE_META_KEY), {});
      assert.deepEqual(await stats(), { count: 0, bytes: 0, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES });
      assert.deepEqual(logged, ['[api] server_error']);
    });

    test('원본·썸네일은 하나씩 따로 저장 (한 요청에 묶여 커지지 않게)', async () => {
      await redis.flushall();
      const order = [];
      const tracing = {
        ...redis,
        async set(key, value) {
          order.push(`start:${key.slice(-1)}`);
          const r = await redis.set(key, value);
          order.push(`end:${key.slice(-1)}`);
          return r;
        },
      };
      const { upload } = setup({ redis: tracing });
      assert.equal((await upload()).statusCode, 200);
      assert.deepEqual(order, ['start:f', 'end:f', 'start:t', 'end:t']);
    });
  });
}

imageSuite('인메모리 가짜 Redis', () => createMemoryRedis());

// ── 실제 redis-server: Lua 스크립트와 가짜 구현 비교 ─────────────

describe('실제 redis-server (사진)', { skip: hasRedisServer ? false : 'redis-server 없음' }, () => {
  let server;
  let client;
  let wrapped;

  before(async () => {
    server = await startRedisServer();
    client = server.client;
    wrapped = wrapUpstash(client.raw);
    wrapped.flushall = () => client.cmd('FLUSHALL');
  });

  after(() => server?.stop());

  test('어댑터: SET/GET/DEL/HEXISTS 가 문자열 그대로', async () => {
    const big = b64(jpeg(300 * 1024));
    assert.equal(await wrapped.set('t:img', big), 'OK');
    assert.equal(await wrapped.get('t:img'), big);
    assert.equal(await wrapped.set('t:num', '12345'), 'OK');
    assert.equal(await wrapped.get('t:num'), '12345');
    assert.equal(Number(await wrapped.del('t:img', 't:num', 't:none')), 2);
    assert.equal(await wrapped.get('t:img'), null);
    await wrapped.hset('t:h', { a: '1' });
    assert.equal(Number(await wrapped.hexists('t:h', 'a')), 1);
    assert.equal(Number(await wrapped.hexists('t:h', 'b')), 0);
  });

  test('가짜 Redis 와 같은 결과: IMAGE_ADD·COMMIT·ROLLBACK·DELETE / UPSERT(사진 확인) / RECORD_DELETE', async () => {
    await wrapped.flushall();
    const fake = createMemoryRedis();
    const both = async (fn) => {
      const [a, b] = [await fn(wrapped), await fn(fake)];
      assert.deepEqual(a, b);
      return a;
    };
    const dataKeys = (id) => [imageKey(id, 'f'), imageKey(id, 't')];
    const pend = (id, bytes) => JSON.stringify({ ...JSON.parse(metaJson(id, { bytesF: bytes, bytesT: 1 })), pending: true });
    const add = (id, bytes, maxCount = '3', maxBytes = '100', at = 'T1') => (r) =>
      r.eval(IMAGE_ADD_SCRIPT, [IMAGE_META_KEY, ...dataKeys(id), IMAGE_TOUCH_KEY], [id, pend(id, bytes), String(bytes + 1), maxCount, maxBytes, at]);
    const commit = (id, bytes) => (r) => r.eval(IMAGE_COMMIT_SCRIPT, [IMAGE_META_KEY, ...dataKeys(id)], [id, metaJson(id, { bytesF: bytes, bytesT: 1 })]);
    const rollback = (id) => (r) => r.eval(IMAGE_ROLLBACK_SCRIPT, [RECORDS_KEY, IMAGE_META_KEY, ...dataKeys(id), GAMES_KEY], [id]);
    const setData = (id, sizes = 'ft') => async (r) => {
      for (const size of sizes) await r.set(imageKey(id, size), `${id}-${size}`);
      return 'OK';
    };
    const complete = async (id, bytes) => {
      assert.deepEqual(await both(add(id, bytes, '10', '1000')), ['ok', '']);
      await both(setData(id));
      assert.equal(await both(commit(id, bytes)), 'ok');
    };

    assert.deepEqual(await both(add('a', 40)), ['ok', '']);
    assert.deepEqual(await both(add('a', 10)), ['incomplete', pend('a', 40)], 'pending → 마저 씀');
    assert.equal(await both(commit('a', 40)), 'incomplete', '데이터가 없으면 마무리 안 함');
    await both(setData('a'));
    assert.equal(await both(commit('a', 40)), 'ok');
    assert.deepEqual(await both(add('a', 10, '3', '100', 'T2')), ['exists', metaJson('a', { bytesF: 40, bytesT: 1 })]);
    assert.deepEqual(await both(add('b', 58)), ['ok', '']); // 41 + 59 = 100 (딱 맞음)
    assert.deepEqual(await both(add('c', 0)), ['limit', 'bytes']);
    assert.deepEqual(await both(add('c', 0, '2', '1000')), ['limit', 'count']);
    await both(setData('b', 'f')); // b: 원본만 쓰고 멈춤 (pending)
    // 메타는 다 됐는데 데이터가 빠진 것도 마저 씀
    await both((r) => r.hset(IMAGE_META_KEY, { m: metaJson('m', { bytesF: 1, bytesT: 1 }) }));
    assert.deepEqual(await both(add('m', 1, '10', '1000')), ['incomplete', metaJson('m', { bytesF: 1, bytesT: 1 })]);
    await both((r) => r.hdel(IMAGE_META_KEY, 'm'));
    await both((r) => r.hdel(IMAGE_TOUCH_KEY, 'm'));

    const upsert = (id, photos) => (r) =>
      r.eval(UPSERT_SCRIPT, [RECORDS_KEY, IMAGE_META_KEY], [id, '', JSON.stringify({ id, title: `"photos":["a"]`, photos }), '10', ...photos]);
    assert.deepEqual(await both(upsert('r1', ['a', 'b', 'x', 'y'])), ['missing', 'b,x,y'], 'pending 사진은 없는 것으로');
    assert.deepEqual(await both(upsert('r1', ['a'])), ['ok', '']);
    assert.deepEqual(await both(upsert('r2', [])), ['ok', '']);

    // 되돌리기: 다 올라간(a)·남이 마무리한 건 그대로, 올리는 중(b)이고 안 쓰면 메타·데이터 모두, 메타 없는 데이터(z)도
    assert.equal(await both(rollback('a')), 'kept');
    assert.equal(await both(rollback('b')), 'deleted');
    await both(setData('z', 'f'));
    assert.equal(await both(rollback('z')), 'deleted');
    // pending 인데 기록이 가리키면(예전 데이터) 메타를 남김 — 같은 id 로 다시 올려 채울 수 있게
    await both((r) => r.hset(IMAGE_META_KEY, { p: pend('p', 5) }));
    await both((r) => r.hset(RECORDS_KEY, { r3: JSON.stringify({ id: 'r3', photos: ['p'] }) }));
    assert.equal(await both(rollback('p')), 'in_use');
    await both((r) => r.hdel(RECORDS_KEY, 'r3'));
    // 게임 정보의 대표 이미지로 쓰는 사진도 쓰는 중으로 봄
    await both((r) => r.hset(GAMES_KEY, { g1: JSON.stringify({ id: 'g1', title: '"cover":"q"', cover: 'p' }) }));
    assert.equal(await both(rollback('p')), 'in_use');
    await both((r) => r.hdel(GAMES_KEY, 'g1'));
    await both((r) => r.hdel(IMAGE_META_KEY, 'p'));

    // 지우기: 유예 기준 시각(cutoff) 뒤에 적힌 imgtouch 는 남김, 쓰거나 없는 사진의 imgtouch 는 지움
    await complete('d', 1);
    await complete('e', 1);
    await both((r) => r.hset(IMAGE_TOUCH_KEY, { d: 'T5', e: 'T1', zz: 'T1' }));
    const del = (ids, cutoff = '') => (r) => {
      const [keys, args] = deleteScriptArgs(RECORDS_KEY, ids, cutoff);
      return r.eval(IMAGE_DELETE_SCRIPT, keys, args);
    };
    assert.deepEqual(await both(del(['a', 'd', 'e', 'zz'], 'T3')), ['in_use', 'young', 'deleted', 'missing']);
    // 대표 이미지로 쓰는 사진은 남김 (제목 속 글자는 대표 이미지로 보지 않음)
    await both((r) => r.hset(GAMES_KEY, { g2: JSON.stringify({ id: 'g2', title: '"cover":"e"', memo: 'x', cover: 'd' }) }));
    assert.deepEqual(await both(del(['d'])), ['in_use'], '게임 대표 이미지');
    await both((r) => r.hdel(GAMES_KEY, 'g2'));
    assert.deepEqual(await both(del(['d'])), ['deleted'], '유예 없이(직접 지우기)');
    assert.deepEqual(await both(del(['e'])), ['missing']);
    for (const key of [...dataKeys('a'), ...dataKeys('b'), ...dataKeys('d'), ...dataKeys('e'), ...dataKeys('z')]) {
      assert.equal(await wrapped.get(key), await fake.get(key), key);
    }
    for (const key of [IMAGE_META_KEY, RECORDS_KEY, IMAGE_TOUCH_KEY]) {
      assert.deepEqual(await wrapped.hgetall(key), await fake.hgetall(key), key);
    }
    assert.deepEqual(await wrapped.hgetall(IMAGE_TOUCH_KEY), {});

    // 기록 삭제: 지운 값을 돌려줌, 없으면 nil
    const rd = (id) => (r) => r.eval(RECORD_DELETE_SCRIPT, [RECORDS_KEY], [id]);
    const r1 = await wrapped.hget(RECORDS_KEY, 'r1');
    assert.equal(await both(rd('r1')), r1);
    assert.equal(await both(rd('r1')), null);
    // 메타가 다 지워지면 해시도 사라짐 (가짜도 같음)
    await both((r) => r.hdel(RECORDS_KEY, 'r2'));
    assert.deepEqual(await both(del(['a'])), ['deleted']);
    assert.equal(Number(await client.cmd('EXISTS', IMAGE_META_KEY)), 0);
  });

  imageSuite('실제 redis-server + wrapUpstash', async () => wrapped);
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
    assert.deepEqual(await res.json(), { count: 1, bytes: MAX_FULL_BYTES + MAX_THUMB_BYTES, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES });
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
