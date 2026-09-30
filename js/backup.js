// 백업 파일 — 작품·플레이 기록·사진(선택)을 JSON 한 파일로. 다른 기기로 옮기거나 따로 보관할 때 쓴다.
// 순수 함수만 (node 테스트 가능). 파일 읽기·내려받기는 views/settings.js 에서.
import { BACKUP_APP, BACKUP_VERSION, LIMITS } from './constants.js';
import { normalizeWork, normalizePlay, isId, isIso, isGenre, titleKey, cleanLine } from './model.js';

const IMAGE_TYPES = ['image/webp', 'image/jpeg', 'image/png'];

// ── base64 ↔ 바이트 ──
export function bytesToBase64(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  } catch {
    return null;
  }
}

/** 바이트 앞부분으로 사진 형식 판별 (WebP·JPEG·PNG 만) */
export function sniffType(u8) {
  if (!u8 || u8.length < 12) return null;
  if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'image/jpeg';
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'image/png';
  const ascii = (a, b) => String.fromCharCode(...u8.subarray(a, b));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// ── 내보내기 ──

/** 사진 레코드(IndexedDB) → 백업 항목 */
export function imageEntry(rec) {
  return {
    id: rec.id,
    type: rec.type,
    thumbType: rec.thumbType,
    width: rec.width || 0,
    height: rec.height || 0,
    createdAt: rec.createdAt || null,
    full: bytesToBase64(rec.full),
    thumb: bytesToBase64(rec.thumb),
  };
}

/**
 * 백업 JSON 앞부분(사진 제외). 사진은 크기가 커서 한 덩어리 문자열로 만들지 않고
 * backupTail 과 사진 항목들을 Blob 조각으로 이어 붙인다.
 */
export function backupHead({ bookName, works, plays, exportedAt = new Date().toISOString(), withImages }) {
  const head = JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION, exportedAt, bookName, works, plays }, null, 1);
  // 마지막 '}' 를 떼고 images 배열을 이어 붙일 준비
  return withImages ? `${head.slice(0, -2)},\n "images": [` : head;
}
export const backupTail = (withImages) => (withImages ? '\n ]\n}' : '');

// ── 가져오기 ──

function imageFromEntry(e, idMap = null) {
  if (!e || typeof e !== 'object') return null;
  const id = idMap ? idMap(e.id) : e.id;
  if (!isId(id)) return null;
  const full = base64ToBytes(e.full);
  const thumb = base64ToBytes(e.thumb) || full;
  if (!full || !full.length) return null;
  const type = sniffType(full);
  const thumbType = sniffType(thumb);
  if (!IMAGE_TYPES.includes(type) || !IMAGE_TYPES.includes(thumbType)) return null;
  return {
    id,
    type,
    thumbType,
    full: full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength),
    thumb: thumb.buffer.slice(thumb.byteOffset, thumb.byteOffset + thumb.byteLength),
    width: Number.isFinite(e.width) ? e.width : 0,
    height: Number.isFinite(e.height) ? e.height : 0,
    size: full.byteLength + thumb.byteLength,
    createdAt: isIso(e.createdAt) ? e.createdAt : new Date().toISOString(),
  };
}

/**
 * 백업 파일 글자 → 검증한 데이터.
 * @returns {{ok:true, format:'v2'|'v1', bookName, works, plays, images, skipped, notes:string[]} | {ok:false, reason:string}}
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: '백업 파일(JSON)을 읽지 못했어요' };
  }
  if (!data || typeof data !== 'object' || data.app !== BACKUP_APP) return { ok: false, reason: '이 기록장의 백업 파일이 아니에요' };
  if (data.version === BACKUP_VERSION) return parseV2(data);
  if (data.version === 1) return parseV1(data);
  return { ok: false, reason: '이 앱보다 새 버전에서 만든 백업이에요. 앱을 새로 고친 뒤 다시 시도해 주세요' };
}

function parseV2(data) {
  let skipped = 0;
  const works = [];
  const workById = new Map();
  for (const raw of Array.isArray(data.works) ? data.works : []) {
    if (!raw || !isId(raw.id)) { skipped++; continue; }
    const r = normalizeWork(raw);
    if (!r.ok || workById.has(r.value.id)) { skipped++; continue; }
    works.push(r.value);
    workById.set(r.value.id, r.value);
  }
  const plays = [];
  const seen = new Set();
  for (const raw of Array.isArray(data.plays) ? data.plays : []) {
    const w = raw && workById.get(raw.workId);
    if (!w || !isId(raw.id) || seen.has(raw.id)) { skipped++; continue; }
    const r = normalizePlay(raw, w.genre);
    if (!r.ok) { skipped++; continue; }
    plays.push(r.value);
    seen.add(r.value.id);
  }
  // 기록이 하나도 없는 작품은 버림
  const used = new Set(plays.map((p) => p.workId));
  const keptWorks = works.filter((w) => used.has(w.id));
  skipped += works.length - keptWorks.length;
  const images = [];
  for (const e of Array.isArray(data.images) ? data.images : []) {
    const im = imageFromEntry(e);
    if (im) images.push(im);
  }
  const bookName = [...cleanLine(data.bookName)].slice(0, LIMITS.bookName).join('') || null;
  return { ok: true, format: 'v2', bookName, works: keptWorks, plays, images, skipped, notes: [] };
}

// ── 예전 버전(모임용 서버 기록장, version 1) 백업 ──

/** 문자열 → 짧은 해시 (같은 백업을 두 번 가져와도 같은 작품 id 가 나오게) */
export function hashKey(s) {
  let h1 = 0x811C9DC5;
  let h2 = 0x01000193;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5BD1E995) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

const V1_FORMAT = { box: 'home', store: 'store', online: 'online' };
const v1Id = (id) => (isId(id) ? `v1_${id}`.slice(0, 64) : null);
const half = (v) => (typeof v === 'number' && v > 0 && v <= 5 ? Math.round(v * 2) / 2 : null);
const level = (v, min) => (typeof v === 'number' && v > 0 ? Math.max(min, Math.min(5, Math.round(v))) : null);

/**
 * 예전 버전 백업 → 새 구조. 예전에는 '작품' 개념이 없어서 같은 장르·같은 제목
 * (방탈출은 매장·지점까지 같을 때)인 기록을 한 작품으로 묶는다.
 */
function parseV1(data) {
  const notes = ['예전 버전 백업이에요. 같은 장르·같은 제목(방탈출은 매장·지점까지 같을 때)인 기록은 한 작품으로 묶어요.',
    '멤버별 점수·순위, 태그, 장소, 세부 점수는 새 기록장에 없는 항목이라 가져오지 않아요. 스포일러로 표시한 기록의 한줄평·후기는 스포일러 메모로 옮겨요.'];
  const members = new Map();
  for (const m of Array.isArray(data.members) ? data.members : []) {
    if (m && isId(m.id) && typeof m.name === 'string') members.set(m.id, cleanLine(m.name).slice(0, LIMITS.companion));
  }
  const works = new Map();
  const plays = [];
  let skipped = 0;
  for (const r of Array.isArray(data.records) ? data.records : []) {
    if (!r || !isGenre(r.type) || !isId(r.id)) { skipped++; continue; }
    const genre = r.type;
    const er = (r.er && typeof r.er === 'object') ? r.er : {};
    const bg = (r.bg && typeof r.bg === 'object') ? r.bg : {};
    const mm = (r.mm && typeof r.mm === 'object') ? r.mm : {};
    const store = genre === 'escaperoom' ? cleanLine(er.brand) : '';
    const branch = genre === 'escaperoom' ? cleanLine(er.branch) : '';
    const key = [genre, titleKey(r.title), titleKey(store), titleKey(branch)].join('|');
    let work = works.get(key);
    if (!work) {
      const wr = normalizeWork({ id: `w_v1_${hashKey(key)}`, genre, title: r.title, store, branch, createdAt: r.createdAt, updatedAt: r.updatedAt });
      if (!wr.ok) { skipped++; continue; }
      work = wr.value;
      works.set(key, work);
    }
    const review = typeof r.review === 'string' ? r.review : '';
    const details = {};
    const spoiler = {};
    if (genre === 'boardgame') {
      details.players = Array.isArray(bg.results) && bg.results.length ? bg.results.length : null;
      details.expansions = bg.expansion || '';
      details.durationMin = bg.playTimeMin > 0 ? bg.playTimeMin : null;
    } else if (genre === 'murdermystery') {
      details.format = V1_FORMAT[mm.format] || null;
      details.durationMin = mm.playTimeMin > 0 ? mm.playTimeMin : null;
      details.story = half(mm.scores && mm.scores.story);
      const culprits = (Array.isArray(mm.roles) ? mm.roles : []).filter((x) => x && x.culprit)
        .map((x) => cleanLine(x.character) || members.get(x.memberId) || '').filter(Boolean);
      spoiler.culprit = culprits.join(', ').slice(0, LIMITS.culprit);
    } else {
      details.result = er.cleared === true ? 'success' : er.cleared === false ? 'fail' : null;
      details.remainingSec = er.cleared === true && Number.isInteger(er.remainingSec) ? er.remainingSec : null;
      details.hints = Number.isInteger(er.hints) ? er.hints : null;
      details.difficulty = level(er.difficulty, 1);
      details.fear = level(er.fear, 1);
    }
    // 예전에는 '스포일러 있음' 표시 하나로 한줄평과 후기를 함께 가렸음 → 그런 기록의 한줄평·후기는 통째로 스포일러 메모로
    const hidden = r.spoiler === true;
    if (hidden) spoiler.memo = [...[typeof r.oneLiner === 'string' ? r.oneLiner.trim() : '', review.trim()].filter(Boolean).join('\n\n')].slice(0, LIMITS.memo).join('');
    const pr = normalizePlay({
      id: v1Id(r.id),
      workId: work.id,
      date: r.date,
      rating: half(r.rating),
      oneLiner: hidden ? '' : r.oneLiner,
      review: hidden ? '' : review,
      companions: (Array.isArray(r.members) ? r.members : []).map((id) => members.get(id)).filter(Boolean),
      photos: (Array.isArray(r.photos) ? r.photos : []).map(v1Id).filter(Boolean),
      details,
      spoiler,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }, genre);
    if (!pr.ok) { skipped++; continue; }
    plays.push(pr.value);
  }
  const used = new Set(plays.map((p) => p.workId));
  const images = [];
  for (const e of Array.isArray(data.images) ? data.images : []) {
    const im = imageFromEntry(e, v1Id);
    if (im) images.push(im);
  }
  return { ok: true, format: 'v1', bookName: null, works: [...works.values()].filter((w) => used.has(w.id)), plays, images, skipped, notes };
}
