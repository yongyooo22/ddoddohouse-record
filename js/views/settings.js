// 설정 — 연결 상태, 사진 저장 공간, 내보내기/가져오기, 테마, 잠금 해제 정보 지우기
import { h, icon } from '../dom.js';
import { APP_NAME, APP_VERSION, TYPE_KEYS } from '../constants.js';
import { state, getTheme, setTheme, wipeLocal, upsertRecord, upsertMember, upsertGame, recordById, referencedPhotos, photosOf, getDraft } from '../store.js';
import { relTime, dateStamp, nameKey, fmtBytes } from '../format.js';
import { storageUsage } from '../stats.js';
import * as api from '../api.js';
import { blobToBase64 } from '../compress.js';
import { existingPhotos, clearHttpImageCache } from '../images.js';
import { segmented, openDialog, confirmDialog, toast, appBar, switchRow } from '../ui.js';
import { photoErrorMessage } from './photos.js';

let ctxRef = null;
let rootRef = null;
let exportPhotos = true; // 내보내기에 사진 포함 (기본 켬)

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ── 사진 저장 공간 ──
// 설정 화면은 데이터가 바뀔 때마다 다시 그려지므로 결과는 여기 기억해 두고, 서버에는 열 때·정리 뒤에만 물어봄
let photoStats = { status: 'idle', data: null, code: null };

async function loadPhotoStats() {
  photoStats = { ...photoStats, status: 'loading' };
  rerender();
  try {
    const data = await api.imageStats();
    photoStats = { status: 'ok', data, code: null };
  } catch (e) {
    photoStats = { status: 'error', data: photoStats.data, code: e.code };
  }
  rerender();
}

function rerender() {
  if (rootRef && rootRef.isConnected) render(rootRef);
}

/** 80% 넘게 찼거나 가득 찼을 때의 안내 (기록은 사진과 따로라 계속 저장됨) */
function storeWarning(data) {
  if (!data) return null;
  const u = storageUsage(data);
  if (!u.warn) return null;
  return h('p', { class: `store-warn${u.full ? ' is-full' : ''}` }, icon('info'), h('span', {
    text: u.full
      ? '가득 찼어요. 새 사진을 넣으려면 아래 ‘사용하지 않는 사진 정리’를 누르거나 오래된 기록의 사진을 빼 주세요. 기록은 계속 저장돼요.'
      : `${Math.round(u.ratio * 100)}% 찼어요${u.left !== null ? ` · 약 ${u.left.toLocaleString('ko-KR')}장 더 넣을 수 있어요` : ''}. 가득 차면 새 사진은 넣을 수 없어요 (기록은 계속 저장돼요).`,
  }));
}

function storageSection() {
  const { status, data, code } = photoStats;
  const d = data || {};
  const count = Number(d.count) || 0;
  const bytes = Number(d.bytes) || 0;
  const limitBytes = Number(d.limitBytes) || 0;
  const limitCount = Number(d.limitCount) || 0;
  const ratio = limitBytes ? Math.min(1, bytes / limitBytes) : 0;
  const countRatio = limitCount ? Math.min(1, count / limitCount) : 0;
  const worst = Math.max(ratio, countRatio);
  const fill = h('span', { class: 'store-fill' });
  fill.style.width = `${Math.max(worst > 0 ? 1.5 : 0, worst * 100)}%`;

  // 불러오는 동안에도 같은 모양(숫자 줄·막대·한도 줄)으로 — 숫자가 온 뒤 아래 버튼들이 밀려 잘못 누르지 않게
  let nums;
  if (data) {
    nums = h('div', { class: 'store-nums' },
      h('p', { class: 'store-main' }, h('strong', { text: `사진 ${count.toLocaleString('ko-KR')}장` }),
        h('span', { text: ` · ${fmtBytes(bytes)}${limitBytes ? ` / ${fmtBytes(limitBytes)}` : ''}` })),
      h('span', { class: 'store-pct', text: worst > 0 && worst < 0.01 ? '1% 미만' : `${Math.round(worst * 100)}%` }));
  } else if (status === 'error') {
    nums = h('div', { class: 'store-nums' },
      h('p', { class: 'store-main store-wait', text: code === 'offline' ? '오프라인이라 확인할 수 없어요' : '저장 공간을 확인하지 못했어요' }));
  } else {
    nums = h('div', { class: 'store-nums' },
      h('p', { class: 'store-main' }, h('strong', { class: 'store-skel', 'aria-hidden': 'true', text: '\u00a0' }), h('span', { class: 'sr-only', text: '확인하는 중…' })));
  }
  const body = [
    nums,
    h('div', {
      class: `store-meter${worst >= 0.95 ? ' is-full' : worst >= 0.8 ? ' is-warn' : ''}`, role: 'meter',
      'aria-label': '사진 저장 공간 사용량', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(worst * 100)),
      'aria-valuetext': data ? `${fmtBytes(bytes)} 사용${limitBytes ? `, 한도 ${fmtBytes(limitBytes)}` : ''}` : '확인하는 중',
    }, fill),
    h('p', { class: 'store-sub', text: limitCount ? `한도: ${limitCount.toLocaleString('ko-KR')}장 또는 ${fmtBytes(limitBytes)}` : '한도 확인 중…' }),
    storeWarning(data),
  ];
  const gcBtn = h('button', {
    type: 'button', class: 'btn btn-soft btn-block', disabled: status === 'loading' && !data,
    onClick: async () => {
      const ok = await confirmDialog('사용하지 않는 사진을 정리할까요?',
        '어떤 기록에도 쓰이지 않고, 올린 지(또는 기록에서 빠진 지) 하루가 지난 사진을 지워요. 기록에 붙은 사진과 이 기기에서 쓰던 초안의 사진은 남겨요. 다른 기기에서 하루 넘게 저장하지 않은 초안이 있다면 그 사진은 지워질 수 있어요.',
        { ok: '정리하기' });
      if (!ok) return;
      gcBtn.disabled = true;
      try {
        // 이 기기의 초안이 쓰는 사진은 남김 (서버는 초안을 모름)
        const draft = getDraft();
        const res = await api.gcImages(draft && draft.model ? photosOf(draft.model) : []);
        const n = Number(res && res.deleted) || 0;
        toast(n ? `사용하지 않는 사진 ${n}장을 정리했어요` : '정리할 사진이 없어요', 'ok');
      } catch (e) {
        toast(api.errorMessage(e, '정리'), 'error');
      }
      gcBtn.disabled = false;
      loadPhotoStats();
    },
  }, icon('sparkle'), h('span', { text: '사용하지 않는 사진 정리' }));
  return h('section', { class: 'card set-sec set-store', 'aria-busy': status === 'loading' ? 'true' : 'false' },
    h('div', { class: 'set-head' },
      h('h2', { class: 'set-title', text: '사진 저장 공간' }),
      h('button', {
        type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': '저장 공간 다시 확인', disabled: status === 'loading',
        onClick: () => loadPhotoStats(),
      }, icon('refresh'))),
    body,
    h('p', { class: 'set-desc', text: '사진도 입장 코드로 보호되고, 위치 정보(GPS) 같은 촬영 정보는 지워서 저장해요. 기록을 지우거나 기록에서 뺀 사진은 다른 기록이 쓰지 않으면 하루 뒤에 지워져요.' }),
    gcBtn);
}

/** 서버의 사진 정보 id → meta (없으면 빈 Map — 백업·가져오기는 그래도 진행) */
async function imageMetaMap() {
  try {
    const res = await api.imageList();
    return new Map((Array.isArray(res.images) ? res.images : []).filter((m) => m && typeof m.id === 'string').map((m) => [m.id, m]));
  } catch {
    return new Map();
  }
}

/** 사진 한 장 → 백업 항목 {id, mime, full, thumb, createdAt} */
async function backupImage(id, meta) {
  const [f, t] = await Promise.all([api.fetchImageBlob(id, 'f'), api.fetchImageBlob(id, 't')]);
  const [full, thumb] = await Promise.all([blobToBase64(f), blobToBase64(t)]);
  return {
    id, mime: (meta && meta.mime) || f.type || 'image/jpeg', full, thumb,
    createdAt: (meta && typeof meta.createdAt === 'string' && meta.createdAt) || null,
  };
}

function statusInfo() {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (!online || state.status === 'offline') return { cls: 'is-off', label: '오프라인', desc: '이 기기에 저장된 기록을 보여 주고 있어요 (읽기 전용)' };
  if (state.status === 'loading') return { cls: 'is-wait', label: '불러오는 중', desc: '서버에서 최신 기록을 받아오고 있어요' };
  if (state.status === 'error') {
    const desc = ['network', 'timeout', 'server_error'].includes(state.errorCode)
      ? '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요'
      : api.errorMessage({ code: state.errorCode }, '연결');
    return { cls: 'is-err', label: '연결 문제', desc };
  }
  if (state.status === 'ok') return { cls: 'is-ok', label: '연결됨', desc: '모든 변경이 바로 모두에게 저장돼요' };
  return { cls: 'is-wait', label: '확인 중', desc: '' };
}

/** 진행 표시 다이얼로그 (중단 버튼) */
function progressDialog(title) {
  const text = h('p', { class: 'dlg-text', text: '준비 중…' });
  const bar = h('span', { class: 'progress-fill' });
  const st = { cancelled: false, close: () => {} };
  openDialog({
    title,
    body: h('div', {}, text, h('div', { class: 'progress' }, bar)),
    dismissible: false,
    bind: (c) => { st.close = c; },
    actions: [{ label: '중단', value: 'stop', kind: 'ghost', handler: () => { st.cancelled = true; return true; } }],
  });
  st.set = (msg, ratio) => {
    text.textContent = msg;
    bar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  };
  return st;
}

async function exportData() {
  const ids = exportPhotos ? referencedPhotos() : [];
  const images = [];
  let failed = 0;
  if (ids.length) {
    if (navigator.onLine === false) { toast('오프라인이라 사진을 받을 수 없어요. ‘사진 포함’을 끄면 기록만 내보낼 수 있어요', 'error', 4500); return; }
    const pg = progressDialog('사진을 모으는 중');
    const metas = await imageMetaMap();
    for (let i = 0; i < ids.length; i++) {
      if (pg.cancelled) break;
      pg.set(`사진 ${i + 1} / ${ids.length}`, i / ids.length);
      try {
        images.push(await backupImage(ids[i], metas.get(ids[i])));
      } catch (e) {
        failed++;
        if (['unauthorized', 'too_many_attempts', 'offline'].includes(e.code)) { pg.cancelled = true; break; }
      }
    }
    pg.close(null);
    if (pg.cancelled) { toast('내보내기를 중단했어요', 'info'); return; }
  }
  const payload = {
    app: 'ddoddohouse-record',
    version: 1,
    exportedAt: new Date().toISOString(),
    records: state.records,
    members: state.members,
    games: state.games,
  };
  // 사진은 크기가 커서 한 덩어리 문자열로 만들지 않고 Blob 조각으로 이어 붙임
  const head = JSON.stringify(payload, null, 2);
  const parts = [head.slice(0, -2)];
  if (exportPhotos) {
    parts.push(',\n  "images": [');
    images.forEach((im, i) => parts.push(`${i ? ',' : ''}\n    `, JSON.stringify(im)));
    parts.push(images.length ? '\n  ]' : ']');
  }
  parts.push('\n}');
  const blob = new Blob(parts, { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `ddoddohouse-backup-${dateStamp()}.json`, class: 'sr-only' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  const photoPart = exportPhotos ? `, 사진 ${images.length}장` : '';
  const gamePart = state.games.length ? `, 게임 ${state.games.length}개` : '';
  toast(`기록 ${state.records.length}개, 멤버 ${state.members.length}명${gamePart}${photoPart}을 내보냈어요${failed ? ` (사진 ${failed}장은 받지 못했어요)` : ''}`, failed ? 'error' : 'ok', 4000);
}

function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (data && data.data && typeof data.data === 'object') data = data.data;
  if (!data || typeof data !== 'object') return null;
  const records = Array.isArray(data.records) ? data.records.filter((r) => r && typeof r === 'object' && TYPE_KEYS.includes(r.type)) : [];
  const members = Array.isArray(data.members) ? data.members.filter((m) => m && typeof m === 'object' && typeof m.name === 'string') : [];
  const games = Array.isArray(data.games) ? data.games.filter((g) => g && typeof g === 'object' && TYPE_KEYS.includes(g.type) && typeof g.title === 'string' && g.title.trim()) : [];
  const seen = new Set();
  const images = Array.isArray(data.images) ? data.images.filter((im) => {
    const ok = im && typeof im === 'object' && typeof im.id === 'string' && ID_RE.test(im.id) && !seen.has(im.id) &&
      typeof im.full === 'string' && typeof im.thumb === 'string' && B64_RE.test(im.full.slice(0, 64)) && B64_RE.test(im.thumb.slice(0, 64));
    if (ok) seen.add(im.id);
    return ok;
  }) : [];
  if (!records.length && !members.length && !games.length) return null;
  return { records, members, games, images };
}

const TRANSIENT = ['timeout', 'network', 'server_error', 'not_configured'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 가져오기의 사진 한 장 — 잠깐의 연결 문제·서버 오류는 두 번 더 (같은 id 라 두 번 저장되지 않음) */
async function uploadWithRetry(im, isCancelled) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.uploadImage({ id: im.id, full: im.full, thumb: im.thumb }).promise;
    } catch (e) {
      if (attempt >= 2 || !TRANSIENT.includes(e.code) || isCancelled()) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}

/**
 * 가져오기의 기록 한 개 저장. 서버가 알려 주는 문제를 순서와 상관없이 몇 번까지 풀어 가며 다시:
 * 없는 사진(그 사진만 뺌) · 충돌(덮어쓰기면 최신본 위에, 건너뛰기면 건너뜀) · 서버에서 지워짐(되살림)
 * 반환: 저장 응답 | null(건너뜀)
 */
async function saveImported(record, base, mode) {
  let rec = record;
  let expected = base;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await api.saveRecord(rec, expected);
    } catch (e) {
      if (e.code === 'invalid' && e.data && /^photos/.test(String(e.data.field || '')) && photosOf(rec).length) {
        // 백업에 없거나 올리지 못한 사진 가운데 서버에도 없는 것만 빼고 다시
        const missing = Array.isArray(e.data.missing) ? e.data.missing : null;
        const photos = missing ? photosOf(rec).filter((id) => !missing.includes(id)) : await existingPhotos(photosOf(rec));
        if (photos.length === photosOf(rec).length) throw e;
        rec = { ...rec, photos };
      } else if (e.code === 'conflict') {
        if (mode !== 'overwrite') return null; // 다른 기기에서 이미 추가됨 → 건너뜀
        if (!e.data || !e.data.current) throw e;
        expected = e.data.current.updatedAt || null;
      } else if (e.code === 'not_found') {
        expected = null; // 이 기기엔 있지만 서버에선 지워진 기록 → 백업 내용으로 되살림
      } else throw e;
    }
  }
  throw new api.ApiError('conflict', 409);
}

async function importFlow(file) {
  if (!file) return;
  if (file.size > 400 * 1024 * 1024) { toast('파일이 너무 커요', 'error'); return; }
  const text = await file.text();
  const data = parseBackup(text);
  if (!data) { toast('또또하우스 기록장 백업 파일이 아니에요', 'error'); return; }

  const recIds = new Set(state.records.map((r) => r.id));
  const memIds = new Set(state.members.map((m) => m.id));
  // 이름이 같은 멤버가 이미 있으면(id 만 다름) 새로 만들지 않고 기존 멤버로 합침
  // → 서버의 '같은 이름' 거부로 실패하거나 기록에 '(떠난 멤버)'로 남는 것 방지
  const byName = new Map(state.members.map((m) => [nameKey(m.name), m.id]));
  const remap = new Map(); // 백업 멤버 id → 기존 멤버 id
  const sameName = new Set(); // id 없이 이름만 같은 백업 멤버
  for (const m of data.members) {
    const ex = byName.get(nameKey(m.name));
    if (!ex) continue;
    if (!m.id) sameName.add(m);
    else if (m.id !== ex && !memIds.has(m.id)) remap.set(m.id, ex);
  }
  const isMerged = (m) => (m.id ? remap.has(m.id) : sameName.has(m));
  // 게임 정보: 같은 id 면 '이미 있음'. 이름만 같은 다른 id 는 그 id 에 연결된 기록이 있으면 따로 (다른 판본일 수 있음),
  // 연결된 기록이 없는 예전 백업의 소장 게임이면 '이미 있음'으로 봄 (같은 게임이 두 번 생기지 않게)
  const gameIds = new Set(state.games.map((g) => g.id));
  const gameKey = (g) => `${g.type}:${nameKey(g.title)}`;
  const gameKeys = new Set(state.games.map(gameKey));
  const linkedIds = new Set(data.records.map((r) => r.gameId).filter(Boolean));
  const sameGame = (g) => (!!g.id && gameIds.has(g.id)) || (!linkedIds.has(g.id) && gameKeys.has(gameKey(g)));
  const newGames = data.games.filter((g) => !sameGame(g)).length;
  const newRecs = data.records.filter((r) => !r.id || !recIds.has(r.id)).length;
  const newMems = data.members.filter((m) => (!m.id || !memIds.has(m.id)) && !isMerged(m)).length;
  const mergedN = data.members.filter(isMerged).length;

  let mode = 'add';
  const body = h('div', { class: 'import-preview' },
    h('ul', { class: 'import-counts' },
      h('li', {}, h('strong', { text: `기록 ${data.records.length}개` }), h('span', { text: ` — 새로 ${newRecs} · 이미 있음 ${data.records.length - newRecs}` })),
      h('li', {}, h('strong', { text: `멤버 ${data.members.length}명` }), h('span', { text: ` — 새로 ${newMems} · 이미 있음 ${data.members.length - newMems}` })),
      data.games.length ? h('li', {}, h('strong', { text: `게임 ${data.games.length}개` }), h('span', { text: ` — 새로 ${newGames} · 이미 있음 ${data.games.length - newGames}` })) : null,
      data.images.length ? h('li', {}, h('strong', { text: `사진 ${data.images.length}장` }), h('span', { text: ' — 가져오는 기록의 사진만 올리고, 서버에 이미 있으면 건너뛰어요' })) : null,
      mergedN ? h('li', { class: 'import-merge' }, h('span', { text: `이름이 같은 멤버 ${mergedN}명은 지금 있는 멤버로 합쳐서 기록을 이어 붙여요` })) : null),
    h('p', { class: 'field-label', text: '이미 있는 항목은' }),
    segmented({
      label: '가져오기 방식', value: mode,
      options: [{ key: 'add', label: '건너뛰기 (없는 것만 추가)' }, { key: 'overwrite', label: '덮어쓰기' }],
      onChange: (v) => { mode = v; },
      cls: 'seg-stack',
    }),
    h('p', { class: 'fhint', text: '같은 id를 기준으로 비교해요. 가져온 내용은 모두에게 저장돼요.' }));
  const ok = await openDialog({
    title: '백업 가져오기',
    body,
    actions: [{ label: '취소', value: false, kind: 'ghost' }, { label: '가져오기', value: true, kind: 'primary' }],
  });
  if (!ok) return;
  if (navigator.onLine === false) { toast('오프라인이라 가져올 수 없어요', 'error'); return; }

  const progress = h('p', { class: 'dlg-text', text: '준비 중…' });
  const bar = h('span', { class: 'progress-fill' });
  let cancelled = false;
  let closeProgress = () => {};
  openDialog({
    title: '가져오는 중',
    body: h('div', {}, progress, h('div', { class: 'progress' }, bar)),
    dismissible: false,
    bind: (c) => { closeProgress = c; },
    actions: [{ label: '중단', value: 'stop', kind: 'ghost', handler: () => { cancelled = true; return true; } }],
  });

  const members = data.members.filter((m) => !isMerged(m) && (mode === 'overwrite' || !m.id || !memIds.has(m.id)));
  const mapId = (id) => remap.get(id) || id;
  const remapRecord = (r) => {
    if (!remap.size) return r;
    const out = { ...r };
    if (Array.isArray(r.members)) out.members = [...new Set(r.members.map(mapId))];
    if (r.bg && typeof r.bg === 'object' && Array.isArray(r.bg.results)) {
      out.bg = { ...r.bg, results: r.bg.results.map((x) => (x && typeof x === 'object' ? { ...x, memberId: mapId(x.memberId) } : x)) };
    }
    if (r.mm && typeof r.mm === 'object' && Array.isArray(r.mm.roles)) {
      out.mm = { ...r.mm, roles: r.mm.roles.map((x) => (x && typeof x === 'object' ? { ...x, memberId: mapId(x.memberId) } : x)) };
    }
    return out;
  };
  const records = data.records.filter((r) => mode === 'overwrite' || !r.id || !recIds.has(r.id)).map(remapRecord);
  // 덮어쓰기는 같은 id 만 덮음 (이름만 같은 건 위 규칙대로)
  const games = data.games.filter((g) => (mode === 'overwrite' && g.id && gameIds.has(g.id)) || !sameGame(g));
  // 가져오는 기록·게임이 쓰는 사진(대표 이미지 포함)만 올림 (건너뛰는 것의 사진까지 올리면 어디에도 안 쓰이는 사진만 쌓임)
  const needed = new Set([...records.flatMap((r) => photosOf(r)), ...games.map((g) => g.cover).filter((c) => typeof c === 'string')]);
  const images = data.images.filter((im) => needed.has(im.id));
  const total = members.length + games.length + images.length + records.length;
  let done = 0, okN = 0, failN = 0;
  const tick = () => {
    done++;
    progress.textContent = `${done} / ${total}`;
    bar.style.width = `${total ? (done / total) * 100 : 100}%`;
  };
  const STOP = ['unauthorized', 'too_many_attempts', 'offline', 'network'];

  for (const m of members) {
    if (cancelled) break;
    try {
      const res = await api.saveMember({ id: m.id, name: m.name, emoji: m.emoji || '', color: m.color, createdAt: m.createdAt });
      upsertMember(res.member);
      okN++;
    } catch (e) {
      failN++;
      if (STOP.includes(e.code)) { cancelled = true; }
    }
    tick();
  }
  // 사진을 먼저 (같은 id 로; 서버에 이미 다 있으면 서버가 그대로 둠) → 그다음 기록
  const lostImages = new Set(); // 서버가 받지 않는 사진(형식·크기·공간 부족) → 기록에서 미리 뺌
  let photoIssue = null;
  const onServer = images.length ? await imageMetaMap() : new Map();
  for (const im of images) {
    if (cancelled) break;
    const meta = onServer.get(im.id);
    if (meta && !meta.pending) { tick(); continue; } // 다 올라가 있음 (올리다 끊긴 사진은 다시 보내 채움)
    if (photoIssue === 'limit') { lostImages.add(im.id); failN++; tick(); continue; }
    try {
      await uploadWithRetry(im, () => cancelled);
      okN++;
    } catch (e) {
      failN++;
      // 잠깐의 연결 문제·시간 초과는 기록에서 미리 빼지 않음 — 서버에 저장됐을 수도 있고, 없으면 기록을 저장할 때 서버가 알려 줌
      if (['too_large', 'invalid', 'limit'].includes(e.code)) lostImages.add(im.id);
      if (e.code === 'limit') photoIssue = 'limit';
      if (STOP.includes(e.code)) { cancelled = true; }
    }
    tick();
  }
  // 게임 정보는 대표 이미지를 올린 뒤에 (서버가 대표 이미지가 있는지 확인함)
  const GAME_FIELDS = ['memo', 'owned', 'playersMin', 'playersMax', 'timeMin', 'timeMax', 'genres', 'brand', 'branch', 'createdAt'];
  for (const g of games) {
    if (cancelled) break;
    const payload = { id: g.id, type: g.type, title: g.title };
    for (const k of GAME_FIELDS) if (g[k] !== undefined) payload[k] = g[k];
    if (typeof g.cover === 'string' && !lostImages.has(g.cover)) payload.cover = g.cover;
    try {
      let res;
      try {
        res = await api.saveGame(payload, { allowDuplicate: true });
      } catch (e) {
        // 대표 이미지를 올리지 못했으면 이미지 없이
        if (!(e.code === 'invalid' && e.data && e.data.field === 'cover')) throw e;
        res = await api.saveGame({ ...payload, cover: null }, { allowDuplicate: true });
      }
      upsertGame(res.game);
      okN++;
    } catch (e) {
      failN++;
      if (STOP.includes(e.code)) { cancelled = true; }
    }
    tick();
  }
  for (const r0 of records) {
    if (cancelled) break;
    const r = lostImages.size && Array.isArray(r0.photos) ? { ...r0, photos: r0.photos.filter((id) => !lostImages.has(id)) } : r0;
    const existing = r.id ? recordById(r.id) : null;
    const { updatedAt, ...rest } = r;
    try {
      const res = await saveImported(rest, existing ? existing.updatedAt : null, mode);
      if (res && res.record) { upsertRecord(res.record); okN++; }
    } catch (e) {
      failN++;
      if ([...STOP, 'limit'].includes(e.code)) { cancelled = true; }
    }
    tick();
  }
  closeProgress(null);
  toast(`가져오기 완료: 성공 ${okN}${failN ? ` · 실패 ${failN}` : ''}${cancelled ? ' (중단됨)' : ''}`, failN ? 'error' : 'ok', 4500);
  if (photoIssue === 'limit') toast(photoErrorMessage({ code: 'limit' }), 'error', 5000);
  if (data.images.length) loadPhotoStats();
}

function render(root) {
  const st = statusInfo();
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-file', tabindex: '-1' });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    try { await importFlow(f); } catch { toast('가져오기 중 문제가 생겼어요', 'error'); }
  });

  const refreshBtn = h('button', {
    type: 'button', class: 'btn btn-soft btn-sm',
    onClick: async () => {
      if (!ctxRef) return;
      refreshBtn.disabled = true;
      try { await ctxRef.refresh(true); toast('최신 기록을 받아왔어요', 'ok'); } catch (e) { toast(api.errorMessage(e, '새로고침'), 'error'); }
      refreshBtn.disabled = false;
    },
  }, icon('refresh'), h('span', { text: '새로고침' }));

  const themeSeg = segmented({
    label: '테마', value: getTheme(),
    options: [{ key: 'system', label: '시스템' }, { key: 'light', label: '라이트' }, { key: 'dark', label: '다크' }],
    onChange: (v) => { setTheme(v); if (ctxRef) ctxRef.applyTheme(); },
  });

  const connSec = h('section', { class: 'card set-sec' },
    h('h2', { class: 'set-title', text: '연결 상태' }),
    h('div', { class: `conn ${st.cls}` },
      h('span', { class: 'conn-dot', 'aria-hidden': 'true' }),
      h('div', { class: 'conn-text' },
        h('p', { class: 'conn-label', text: st.label }),
        h('p', { class: 'conn-desc', text: st.desc }),
        h('p', { class: 'conn-meta', text: `기록 ${state.records.length}개 · 멤버 ${state.members.length}명${state.games.length ? ` · 게임 ${state.games.length}개` : ''}${state.lastSync ? ` · ${relTime(state.lastSync)} 동기화` : ''}` })),
      refreshBtn));
  const backupSec = h('section', { class: 'card set-sec' },
    h('h2', { class: 'set-title', text: '백업' }),
    h('p', { class: 'set-desc', text: '모든 기록·멤버·게임 정보를 JSON 파일로 저장하거나, 백업 파일에서 다시 불러올 수 있어요.' }),
    switchRow({
      checked: exportPhotos, label: '사진 포함', icon: 'image',
      desc: referencedPhotos().length ? `사진 ${referencedPhotos().length}장 · 파일이 커질 수 있어요` : '기록 사진과 게임 대표 이미지도 파일에 넣어요',
      onChange: (v) => { exportPhotos = v; },
    }),
    h('div', { class: 'set-actions' },
      h('button', {
        type: 'button', class: 'btn btn-soft',
        onClick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try { await exportData(); } catch { toast('내보내기 중 문제가 생겼어요', 'error'); }
          b.disabled = false;
        },
      }, icon('download'), h('span', { text: '내보내기' })),
      // 진짜 버튼이어야 키보드(Tab)로도 닿음 — 숨긴 파일 입력을 대신 열어 줌
      h('button', { type: 'button', class: 'btn btn-soft', onClick: () => fileIn.click() }, icon('upload'), h('span', { text: '가져오기' })),
      fileIn));
  const themeSec = h('section', { class: 'card set-sec' },
    h('h2', { class: 'set-title', text: '화면 테마' }),
    themeSeg);
  const deviceSec = h('section', { class: 'card set-sec' },
    h('h2', { class: 'set-title', text: '이 기기' }),
    h('p', { class: 'set-desc', text: '입장 코드와 기기에 저장된 기록 사본·사진을 지워요. 다시 들어오려면 공유 링크가 필요해요. 서버의 기록은 지워지지 않아요.' }),
    h('button', {
      type: 'button', class: 'btn btn-danger-soft btn-block',
      onClick: async () => {
        const ok = await confirmDialog('잠금 해제 정보를 지울까요?',
          '이 기기에서 입장 코드와 저장된 사본, 받아 둔 사진이 지워지고 잠금 화면으로 돌아가요. 공용·가족 기기라면 브라우저 방문 기록에서도 이 사이트를 지워 주세요 — 공유 링크에 코드가 들어 있어서 방문 기록·주소 자동완성에 남아 있을 수 있어요.',
          { ok: '지우기', danger: true });
        if (!ok) return;
        wipeLocal();
        clearHttpImageCache(); // 브라우저 캐시에 남은 사진까지
        if (ctxRef) ctxRef.lock('이 기기에서 잠금 해제 정보를 지웠어요');
      },
    }, icon('lock'), h('span', { text: '이 기기에서 잠금 해제 정보 지우기' })));

  root.replaceChildren(h('div', { class: 'page page-settings' },
    appBar({ title: '설정', back: '#/' }),
    // 넓은 화면은 두 단: (연결 상태·사진 저장 공간) | (백업·테마·이 기기). 휴대폰은 같은 순서로 한 줄
    h('div', { class: 'set-grid' },
      h('div', { class: 'set-col' }, connSec, storageSection()),
      h('div', { class: 'set-col' }, backupSec, themeSec, deviceSec)),
    h('footer', { class: 'set-foot' },
      h('span', { class: 'logo-mark set-logo', 'aria-hidden': 'true' }, icon('ticket')),
      h('p', { text: `${APP_NAME} · v${APP_VERSION}` }),
      h('p', { class: 'muted small', text: '우리끼리만 보는 비공개 기록장이에요' }))));
}

export function mount(root, ctx) {
  ctxRef = ctx;
  rootRef = root;
  render(root);
  loadPhotoStats();
  return { update: () => render(root), destroy() { ctxRef = null; rootRef = null; } };
}
