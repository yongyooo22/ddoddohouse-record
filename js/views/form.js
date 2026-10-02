// 새 기록 / 수정 폼 — 가운데 1열. 처음엔 종류 · 게임 · 날짜 · 별점 · 감상만,
// 사진 · 함께한 사람 · 결과 · 자세한 정보 · 태그는 작은 버튼으로 펼쳐서 (접어도 값은 그대로)
import { h, icon } from '../dom.js';
import { TYPES, TYPE_KEYS, TAG_SUGGESTIONS, LIMITS, FIELD_LABELS, MM_SCORES, ER_SCORES } from '../constants.js';
import {
  state, recordById, upsertRecord, membersSorted, memberInfo, usedTags, getDraft, setDraft, clearDraftIf, isFirstLoad, photosOf,
  gameById, recordsOfGame, titleOf, getLastType, setLastType,
} from '../store.js';
import { todayStr, yesterdayStr, defaultRecordDate, fmtDate, relTime, parseDate, fmtDateTime } from '../format.js';
import * as api from '../api.js';
import { navigate, goBack } from '../nav.js';
import {
  appBar, chip, segmented, counterFor, ratingInput, openDialog, confirmDialog, toast, emptyState, starsView, nextId, typeBadge,
} from '../ui.js';
import { resultSection, detailSection, resultSummary, detailSummary, recalcResults, memberChips, miniCheck } from './form-sections.js';
import { openMemberEditor } from './members.js';
import { photoField, discardPhotos } from './photos.js';
import { gamePicker } from './game-picker.js';
import { existingPhotos } from '../images.js';

// ── 모델 ──
function blankModel(type) {
  return {
    type,
    date: defaultRecordDate(),
    gameId: null,
    title: '',
    members: [],
    rating: 0,
    oneLiner: '',
    review: '',
    spoiler: false,
    tags: [],
    photos: [],
    bg: { place: '', playTimeMin: '', mode: 'competitive', results: [], coopWin: null, expansion: '', ownership: null, lender: '' },
    mm: {
      publisher: '', format: 'store', store: '', gm: '', playerCount: '', playTimeMin: '', roles: [], roleSpoiler: false, culpritResult: null,
      scores: { story: 0, deduction: 0, roleplay: 0, balance: 0, production: 0 }, difficulty: 0, replay: false,
      ownership: null, lender: '',
    },
    er: {
      brand: '', branch: '', genre: '', playerCount: '', timeLimitMin: '', cleared: null, hints: null,
      scores: { story: 0, interior: 0, puzzle: 0, device: 0 }, difficulty: 0, fear: 0, activity: 0, replay: false,
    },
    ui: { rankMode: 'high', winnerManual: false, pcAuto: true, remainMM: '', remainSS: '' },
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const ownOrNull = (v) => (v === 'mine' || v === 'borrowed' ? v : null);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 한줄평과 후기를 '감상' 하나로: 둘 다 있으면 한줄평 · 빈 줄 · 후기 순으로 합침 (어느 쪽도 버리지 않음).
 * 합치면 후기 한도를 넘는 아주 긴 예전 기록만 한줄평을 따로 둠
 */
function mergeReview(oneLiner, review) {
  const one = (oneLiner || '').trim();
  const rev = review || '';
  if (!one) return { oneLiner: '', review: rev };
  if (!rev.trim()) return { oneLiner: '', review: one };
  const both = `${one}\n\n${rev}`;
  return Array.from(both).length <= LIMITS.review ? { oneLiner: '', review: both } : { oneLiner: one, review: rev };
}

/** 저장된 기록 또는 초안 → 폼 모델 (구조 보장) */
function toModel(src, type) {
  const m = blankModel(type);
  if (!isObj(src)) return m;
  for (const k of ['date', 'title']) if (typeof src[k] === 'string') m[k] = src[k];
  Object.assign(m, mergeReview(src.oneLiner, typeof src.review === 'string' ? src.review : ''));
  if (typeof src.gameId === 'string' && ID_RE.test(src.gameId)) m.gameId = src.gameId;
  if (Array.isArray(src.members)) m.members = src.members.filter((x) => typeof x === 'string');
  if (Array.isArray(src.tags)) m.tags = src.tags.filter((x) => typeof x === 'string');
  if (Array.isArray(src.photos)) m.photos = [...new Set(src.photos.filter((x) => typeof x === 'string'))].slice(0, LIMITS.photos);
  m.rating = Number(src.rating) || 0;
  m.spoiler = !!src.spoiler;
  const str = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
  if (isObj(src.bg)) {
    const b = src.bg;
    Object.assign(m.bg, {
      place: b.place || '', playTimeMin: b.playTimeMin ? String(b.playTimeMin) : '', mode: ['competitive', 'coop', 'team'].includes(b.mode) ? b.mode : 'competitive',
      coopWin: typeof b.coopWin === 'boolean' ? b.coopWin : null, expansion: b.expansion || '',
      // 예전 기록의 소장 여부는 그대로 둠 (지금은 게임 정보의 '내 소장'으로 관리)
      ownership: ownOrNull(b.ownership), lender: typeof b.lender === 'string' ? b.lender : '',
      results: Array.isArray(b.results) ? b.results.filter(isObj).map((r) => ({
        memberId: r.memberId, score: r.score === null || r.score === undefined || r.score === '' ? null : Number(r.score),
        rank: r.rank ? Number(r.rank) : null, winner: !!r.winner,
      })) : [],
    });
  }
  if (isObj(src.mm)) {
    const b = src.mm;
    Object.assign(m.mm, {
      publisher: b.publisher || '', format: ['box', 'store', 'online'].includes(b.format) ? b.format : 'store', store: b.store || '', gm: b.gm || '',
      playerCount: b.playerCount ? String(b.playerCount) : '', playTimeMin: b.playTimeMin ? String(b.playTimeMin) : '',
      culpritResult: ['caught', 'escaped'].includes(b.culpritResult) ? b.culpritResult : null,
      difficulty: Number(b.difficulty) || 0, replay: !!b.replay, roleSpoiler: !!b.roleSpoiler,
      ownership: ownOrNull(b.ownership), lender: typeof b.lender === 'string' ? b.lender : '',
      roles: Array.isArray(b.roles) ? b.roles.filter(isObj).map((r) => ({
        memberId: r.memberId, character: r.character || '', culprit: !!r.culprit,
        outcome: ['win', 'lose', 'draw'].includes(r.outcome) ? r.outcome : null, mvp: !!r.mvp,
      })) : [],
    });
    if (isObj(b.scores)) for (const s of MM_SCORES) m.mm.scores[s.key] = Number(b.scores[s.key]) || 0;
  }
  if (isObj(src.er)) {
    const b = src.er;
    Object.assign(m.er, {
      brand: b.brand || '', branch: b.branch || '', genre: b.genre || '',
      playerCount: b.playerCount ? String(b.playerCount) : '', timeLimitMin: b.timeLimitMin ? String(b.timeLimitMin) : '',
      cleared: typeof b.cleared === 'boolean' ? b.cleared : null,
      hints: str(b.hints) === '' || !Number.isFinite(Number(b.hints)) ? null : Number(b.hints),
      difficulty: Number(b.difficulty) || 0, fear: Number(b.fear) || 0, activity: Number(b.activity) || 0, replay: !!b.replay,
    });
    if (isObj(b.scores)) for (const s of ER_SCORES) m.er.scores[s.key] = Number(b.scores[s.key]) || 0;
    const sec = b.remainingSec;
    if (sec !== null && sec !== undefined && sec !== '' && Number.isFinite(Number(sec))) {
      m.ui.remainMM = String(Math.floor(Number(sec) / 60));
      m.ui.remainSS = String(Number(sec) % 60).padStart(2, '0');
    }
  }
  if (isObj(src.ui)) {
    const u = src.ui;
    m.ui.rankMode = ['high', 'low', 'manual'].includes(u.rankMode) ? u.rankMode : 'high';
    m.ui.winnerManual = !!u.winnerManual;
    m.ui.pcAuto = u.pcAuto !== false;
    if (typeof u.remainMM === 'string') m.ui.remainMM = u.remainMM;
    if (typeof u.remainSS === 'string') m.ui.remainSS = u.remainSS;
  } else if (src.bg && Array.isArray(src.bg.results) && src.bg.results.length) {
    // 기존 기록 편집: 저장된 순위를 존중하도록 직접 입력 모드
    m.ui.rankMode = 'manual';
    m.ui.winnerManual = true;
  }
  if (src.id) m.ui.pcAuto = false;
  return m;
}

const newId = api.newId;

const intOrNull = (v) => (v === '' || v === null || v === undefined ? null : Math.round(Number(v)));

/** 폼 모델 → 서버 전송용 레코드 (적지 않은 점수·시간·결과는 null — 0점·0분·실패로 보내지 않음) */
function toPayload(m, id, createdAt) {
  const rec = {
    id, type: m.type, date: m.date, title: m.title.trim(), gameId: m.gameId || null, members: [...m.members], rating: m.rating,
    oneLiner: m.oneLiner.trim(), review: m.review.trim(), spoiler: !!m.spoiler, tags: [...m.tags], photos: [...m.photos],
  };
  if (createdAt) rec.createdAt = createdAt;
  const n = m.members.length;
  if (m.type === 'boardgame') {
    const b = m.bg;
    rec.bg = {
      place: b.place.trim(), playTimeMin: intOrNull(b.playTimeMin), mode: b.mode, expansion: b.expansion.trim(),
      coopWin: b.mode === 'coop' ? b.coopWin : null,
      ownership: ownOrNull(b.ownership), lender: b.ownership === 'borrowed' ? b.lender.trim() : '',
      results: b.mode === 'coop' ? [] : b.results.filter((r) => m.members.includes(r.memberId)).map((r) => ({
        memberId: r.memberId,
        score: r.score === null || r.score === '' || !Number.isFinite(Number(r.score)) ? null : Number(r.score),
        rank: r.rank ? Number(r.rank) : null,
        winner: !!r.winner,
      })),
    };
  } else if (m.type === 'murdermystery') {
    const b = m.mm;
    const pc = intOrNull(b.playerCount) ?? (n ? Math.min(20, n) : null);
    const own = b.format === 'box' ? ownOrNull(b.ownership) : null; // 예전 기록의 소장 여부 (보드게임형만)
    rec.mm = {
      publisher: b.publisher.trim(), format: b.format, store: b.format === 'store' ? b.store.trim() : '', gm: b.gm.trim(),
      playerCount: pc, playTimeMin: intOrNull(b.playTimeMin),
      roles: b.roles.filter((r) => m.members.includes(r.memberId)).map((r) => ({
        memberId: r.memberId, character: r.character.trim(), culprit: !!r.culprit, outcome: r.outcome || null, mvp: !!r.mvp,
      })),
      roleSpoiler: !!b.roleSpoiler,
      culpritResult: b.culpritResult || null, scores: { ...b.scores }, difficulty: b.difficulty, replay: !!b.replay,
      ownership: own, lender: own === 'borrowed' ? b.lender.trim() : '',
    };
  } else if (m.type === 'escaperoom') {
    const b = m.er;
    const hasTime = m.ui.remainMM !== '' || m.ui.remainSS !== '';
    const sec = hasTime ? (Number(m.ui.remainMM) || 0) * 60 + (Number(m.ui.remainSS) || 0) : null;
    rec.er = {
      brand: b.brand.trim(), branch: b.branch.trim(), genre: b.genre.trim(),
      playerCount: intOrNull(b.playerCount) ?? (n ? Math.min(10, n) : null), timeLimitMin: intOrNull(b.timeLimitMin),
      cleared: typeof b.cleared === 'boolean' ? b.cleared : null, remainingSec: b.cleared === true ? sec : null,
      hints: b.hints === null || b.hints === '' || !Number.isFinite(Number(b.hints)) ? null : Number(b.hints),
      scores: { ...b.scores }, difficulty: b.difficulty, fear: b.fear, activity: b.activity, replay: !!b.replay,
    };
  }
  return rec;
}

function fieldLabel(path) {
  const parts = String(path || '').split('.');
  for (let i = parts.length - 1; i >= 0; i--) if (FIELD_LABELS[parts[i]]) return FIELD_LABELS[parts[i]];
  return '입력값';
}

// ── 폼 ──
export function mount(root, ctx) {
  const [kind, arg] = [ctx.name, ctx.params[0]];
  if (kind === 'new' && !TYPES[arg]) {
    // 종류 없이 들어오면: 작성하던 새 기록의 종류 → 마지막으로 기록한 종류 → 보드게임 (폼 안에서 바꿀 수 있음)
    const d = getDraft();
    const draftType = d && d.key === 'new' && d.model && TYPES[d.model.type] ? d.model.type : null;
    const q = new URLSearchParams(Object.entries(ctx.query || {})).toString();
    // mount 안에서 바로 다시 그리면 라우터의 현재 화면 정보가 꼬이므로 한 박자 뒤에 옮김
    const timer = setTimeout(() => navigate(`#/new/${draftType || getLastType() || 'boardgame'}${q ? `?${q}` : ''}`, { replace: true }), 0);
    return { destroy() { clearTimeout(timer); } };
  }

  let built = false;
  let destroyFn = null;

  const loadingPage = (title) => root.replaceChildren(h('div', { class: 'page' }, appBar({ title, back: '#/records' }),
    h('p', { class: 'loading', text: '불러오는 중…' })));

  function tryBuild() {
    if (built) return;
    if (kind === 'edit') {
      const rec = recordById(arg);
      if (!rec) {
        const loading = isFirstLoad() || (state.status === 'loading' && !state.records.length);
        if (loading) { loadingPage('기록 수정'); return; }
        // 다른 사람이 지운 기록의 수정 초안 → 새 기록으로 살릴 수 있게
        const draft = getDraft();
        if (draft && draft.key === `edit:${arg}` && draft.model && TYPES[draft.model.type]) {
          built = true;
          destroyFn = buildForm(root, { rec: null, type: draft.model.type, query: { draft: '1' }, orphanId: arg });
          return;
        }
        root.replaceChildren(h('div', { class: 'page' }, appBar({ title: '기록 수정', back: '#/records' }),
          emptyState({ icon: 'book', title: '기록을 찾을 수 없어요', text: '삭제되었을 수 있어요.', action: h('a', { class: 'btn btn-soft', href: '#/records' }, '목록으로') })));
        return;
      }
      built = true;
      destroyFn = buildForm(root, { rec, type: rec.type, query: ctx.query });
    } else {
      // 첫 데이터를 받기 전에는 멤버·게임·태그가 비어 있으므로 기다렸다가 그림
      if (isFirstLoad()) { loadingPage('새 기록'); return; }
      built = true;
      destroyFn = buildForm(root, { rec: null, type: arg, query: ctx.query });
    }
  }
  tryBuild();
  return {
    update() { if (!built) tryBuild(); },
    destroy() { if (destroyFn) destroyFn(); },
  };
}

const PANELS = [
  { key: 'photos', label: '사진', icon: 'camera' },
  { key: 'members', label: '함께한 사람', icon: 'users' },
  { key: 'result', label: '결과', icon: 'trophy' },
  { key: 'details', label: '자세한 정보', icon: 'note' },
  { key: 'tags', label: '태그', icon: 'tag' },
];

function buildForm(root, { rec, type: startType, query, orphanId = null }) {
  const isNew = !rec;
  let type = startType;
  let t = TYPES[type];
  // orphanId: 수정하던 기록이 다른 곳에서 삭제됨 → 같은 id 의 새 기록으로 저장
  const draftKey = orphanId ? `edit:${orphanId}` : isNew ? 'new' : `edit:${rec.id}`;
  let m = toModel(rec, type);
  let base = isNew ? null : rec.updatedAt || null;
  let recordId = orphanId || (isNew ? newId() : rec.id);
  let dirty = false;
  let saving = false;
  let draftTimer = null;
  let recreateCreatedAt = null; // 삭제된 기록을 다시 만들 때 원래 작성 시각 유지 (N번째 순서 보존)
  let autoRetried = false;
  let alive = true;
  let formReady = false; // 저장 버튼까지 만들어진 뒤부터 사진 상태를 버튼에 반영
  const editingId = isNew ? null : rec.id;
  // 연결한 게임의 이름이 바뀌었으면 지금 이름으로
  if (rec && m.gameId) m.title = titleOf(rec) || m.title;

  // ── 초안 ──
  /** 초안 저장. 기기 저장 공간 문제로 실패하면 false */
  function writeDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    const prev = getDraft();
    const ok = setDraft({ key: draftKey, model: m, baseUpdatedAt: base, savedAt: new Date().toISOString(), recordId });
    // 불러오지 않은 다른 초안을 덮어썼으면 그 초안에만 있던 사진은 서버에서도 지움 (어디에도 안 쓰인 채 남지 않게)
    if (ok && prev && !(prev.key === draftKey && (draftKey !== 'new' || prev.recordId === recordId))) {
      discardPhotos(photosOf(prev.model).filter((id) => !m.photos.includes(id)));
    }
    return ok;
  }
  function changed() {
    dirty = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraft, 400);
    paintAddons();
  }
  /** 보관할 게 있으면 지금 저장. 반환: 보관됐는지 (보관할 게 없으면 true) */
  function flushDraft() {
    if (draftTimer || dirty) return writeDraft();
    return true;
  }
  /** 이 폼의 초안일 때만 지움 (다른 기록의 초안은 그대로) */
  function clearMyDraft() {
    clearDraftIf((d) => d.key === draftKey && (draftKey !== 'new' || d.recordId === recordId));
  }
  const keptMsg = (ok) => (ok ? '입력한 내용은 이 기기에 보관돼요' : '기기 저장 공간이 부족해 입력 내용을 보관하지 못했어요. 감상은 따로 복사해 두세요');

  const existingDraft = getDraft();
  // 새 기록 초안은 종류와 상관없이 (폼 안에서 종류를 바꿀 수 있으므로), 수정 초안은 같은 기록일 때
  const draftMatches = existingDraft && existingDraft.key === draftKey && existingDraft.model && TYPES[existingDraft.model.type] &&
    (isNew || existingDraft.model.type === type);
  // 새 기록 초안을 이어 쓸 때는 처음 만든 id 를 그대로 씀
  // (저장 응답만 못 받은 경우 다시 저장해도 같은 기록이 두 개 생기지 않도록)
  const adoptDraftId = () => {
    if (isNew && !orphanId && typeof existingDraft.recordId === 'string' && ID_RE.test(existingDraft.recordId)) {
      recordId = existingDraft.recordId;
    }
  };
  // 초안의 기준 버전: 수정 초안은 물론, 새 기록도 (응답을 못 받은 첫 저장 뒤) 기준이 생겼을 수 있음.
  // 삭제된 기록을 살리는 경우(orphan)는 항상 새로 만듦
  const draftBase = () => (orphanId ? null : (existingDraft.baseUpdatedAt ?? base));
  if (draftMatches && query && query.draft === '1') {
    type = existingDraft.model.type;
    t = TYPES[type];
    m = toModel(existingDraft.model, type);
    base = draftBase();
    adoptDraftId();
    dirty = true;
  }
  // 소장 탭의 '이 게임으로 새 기록 쓰기': #/new/<종류>?game=<id> → 게임을 골라 둠. (예전 링크 ?title= 은 이름만)
  if (isNew && !dirty && query) {
    const g = gameById(query.game);
    if (g && g.type === type) {
      m.gameId = g.id;
      m.title = g.title;
    } else if (typeof query.title === 'string' && query.title.trim()) {
      m.title = Array.from(query.title.trim()).slice(0, LIMITS.title).join('');
    }
  }

  const ctl = {
    changed,
    rerender: (name) => rerender(name),
    editingId,
    createdAt: isNew ? '9999' : rec.createdAt,
    toggleMember,
    addMember,
  };

  // ── 멤버 ↔ 결과/역할 동기화 ──
  function syncMembers() {
    const b = m.bg;
    b.results = m.members.map((id) => b.results.find((r) => r.memberId === id) || { memberId: id, score: null, rank: null, winner: false });
    recalcResults(b, m.ui); // 순위와 자동 승자를 함께 다시 계산
    const mm = m.mm;
    mm.roles = m.members.map((id) => mm.roles.find((r) => r.memberId === id) || { memberId: id, character: '', culprit: false, outcome: null, mvp: false });
  }
  syncMembers();

  /** 사람 고르기 (함께한 사람 영역·결과 영역 어디서든). origin: 누른 칩이 있는 영역 — 그 칩은 스스로 바뀜 */
  function toggleMember(id, on, origin) {
    if (on) {
      if (m.members.length >= LIMITS.members) { toast(`멤버는 최대 ${LIMITS.members}명까지 고를 수 있어요`, 'error'); return false; }
      if (!m.members.includes(id)) m.members = [...m.members, id];
    } else {
      m.members = m.members.filter((x) => x !== id);
    }
    syncMembers();
    changed();
    for (const name of ['members', 'result']) {
      if (name === origin && name === 'members') continue;
      rerender(name);
    }
    if (origin === 'result') {
      // 결과 영역은 다시 그려지므로 누른 사람 칩으로 초점을 돌려줌
      const c = panels.result.body && panels.result.body.querySelector(`.chip-member[data-member-id="${CSS.escape(id)}"]`);
      if (c) c.focus({ preventScroll: true });
    }
    return true;
  }
  async function addMember(origin) {
    const saved = await openMemberEditor(null);
    if (saved && alive) toggleMember(saved.id, true, null);
    if (origin === 'members') rerender('members');
  }

  // ── 기본 입력: 종류 · 게임 · 날짜 · 별점 · 감상 ──
  const typeSlot = h('div', { class: 'rec-field rec-type' });
  function paintTypeSlot() {
    // 종류는 새 기록에서만 바꿀 수 있음 (수정할 때는 그 기록의 종류)
    typeSlot.replaceChildren(h('span', { class: 'field-label', id: 'lbl-type', text: '종류' }),
      isNew
        ? segmented({
          label: '종류', value: type, cls: 'seg-type',
          options: TYPE_KEYS.map((k) => ({ key: k, label: TYPES[k].short, cls: TYPES[k].cls })),
          onChange: (v) => setType(v),
        })
        : h('div', {}, typeBadge(type, { short: false })));
  }

  const picker = gamePicker({
    type, gameId: m.gameId, title: m.title, excludeId: editingId,
    onChange: ({ game, title }) => {
      if (game && game.type !== type) setType(game.type);
      m.gameId = game ? game.id : null;
      m.title = title || '';
      if (game && isNew) prefillFrom(game);
      changed();
    },
  });
  const gameLabel = h('span', { class: 'field-label', text: t.noun });
  const gameSlot = h('div', { class: 'rec-field rec-game' }, gameLabel, picker.el);

  const dateInput = h('input', { type: 'date', class: 'input', value: m.date, max: '2100-12-31', min: '1900-01-01', required: true, 'data-field': 'date', id: nextId('date') });
  const quick = [['오늘', todayStr], ['어제', yesterdayStr]].map(([label, fn]) => {
    const b = h('button', { type: 'button', class: 'chip chip-sm date-chip', 'aria-pressed': 'false' }, label);
    b.addEventListener('click', () => { dateInput.value = fn(); onDate(); });
    return [b, fn];
  });
  const paintQuick = () => quick.forEach(([b, fn]) => b.setAttribute('aria-pressed', m.date === fn() ? 'true' : 'false'));
  function onDate() {
    m.date = dateInput.value;
    dateInput.removeAttribute('aria-invalid');
    paintQuick();
    changed();
    const body = panels.result.body;
    if (body && body.firstChild && body.firstChild.paintOrdinal) body.firstChild.paintOrdinal();
  }
  dateInput.addEventListener('change', onDate);
  const ratingEl = ratingInput({ value: m.rating, label: '별점', size: 'lg', onChange: (v) => { m.rating = v; changed(); } });
  const dateRate = h('div', { class: 'rec-row rec-date-rate' },
    h('div', { class: 'rec-field' },
      h('label', { class: 'field-label', htmlFor: dateInput.id, text: '날짜' }),
      h('div', { class: 'date-row' }, dateInput, h('div', { class: 'date-quick', role: 'group', 'aria-label': '빠른 날짜' }, quick.map(([b]) => b)))),
    h('div', { class: 'rec-field rec-rating' }, h('span', { class: 'field-label', id: 'lbl-rating', text: '별점' }), ratingEl));

  // 감상: 한줄평·후기를 하나로. 처음엔 3줄, 쓰는 만큼 늘어남. 스포일러는 바로 옆에 작게
  const reviewIn = h('textarea', { class: 'input textarea rec-review', rows: '3', maxlength: String(LIMITS.review), placeholder: '어땠나요? 한 줄도, 길게도 좋아요', id: nextId('review'), 'data-field': 'review' });
  const grow = () => {
    reviewIn.style.height = 'auto';
    reviewIn.style.height = `${Math.max(reviewIn.scrollHeight + 2, 0)}px`;
  };
  reviewIn.addEventListener('input', () => { m.review = reviewIn.value; grow(); changed(); });
  const spoilerSlot = h('span', { class: 'rec-spoiler' });
  const oneSlot = h('div', { class: 'rec-legacy-one' });
  function paintReview() {
    reviewIn.value = m.review;
    spoilerSlot.replaceChildren(miniCheck('스포일러', !!m.spoiler, (v) => { m.spoiler = v; changed(); },
      type === 'murdermystery' ? '목록과 상세에서 감상·역할을 열기 전까지 가려요' : '목록과 상세에서 감상을 열기 전까지 가려요'));
    // 합치면 너무 긴 아주 예전 기록만: 한줄평을 따로 보여 줌 (지우지 않게)
    if (m.oneLiner) {
      const one = h('input', { type: 'text', class: 'input', value: m.oneLiner, maxlength: String(LIMITS.oneLiner), 'aria-label': '한줄평 (예전 기록)' });
      one.addEventListener('input', () => { m.oneLiner = one.value; changed(); });
      oneSlot.replaceChildren(h('span', { class: 'field-label', text: '한줄평 (예전 기록)' }), one);
      oneSlot.hidden = false;
    } else {
      oneSlot.hidden = true;
      oneSlot.replaceChildren();
    }
    requestAnimationFrame(grow);
  }
  const reviewSlot = h('div', { class: 'rec-field rec-review-field' },
    h('div', { class: 'field-head' }, h('label', { class: 'field-label', htmlFor: reviewIn.id, text: '감상' }), spoilerSlot),
    reviewIn,
    h('div', { class: 'rec-review-foot' }, counterFor(reviewIn, LIMITS.review)),
    oneSlot);

  // ── 추가 입력: 작은 버튼으로 펼치기 (접어도 값은 그대로, 지우기는 따로) ──
  const panels = {};
  const addonBar = h('div', { class: 'rec-addons', role: 'group', 'aria-label': '더 적기' });
  const panelBox = h('div', { class: 'rec-panels' });

  // 사진 칸은 올리는 중인 상태를 들고 있어서 한 번만 만들고 계속 씀
  const photos = photoField({
    model: () => m,
    onChange: changed,
    onBusy: () => { if (formReady) { paintSaveLabel(); paintAddons(); } },
    onAdd: () => openPanel('photos'),
  });

  const memberNames = () => {
    const ns = m.members.map((id) => memberInfo(id).name);
    return ns.length > 2 ? `${ns.slice(0, 2).join(', ')} 외 ${ns.length - 2}명` : ns.join(', ');
  };
  const summaries = {
    photos: () => {
      const n = photos.count();
      const busy = photos.busy();
      return n ? `${n}장${busy ? ' · 올리는 중' : ''}` : '';
    },
    members: memberNames,
    result: () => resultSummary(m),
    details: () => detailSummary(m),
    tags: () => (m.tags.length > 3 ? `${m.tags.slice(0, 3).map((x) => `#${x}`).join(' ')} +${m.tags.length - 3}` : m.tags.map((x) => `#${x}`).join(' ')),
  };

  const builders = {
    photos: () => photos.el,
    members: () => {
      const mems = membersSorted();
      return h('div', { class: 'rp-fields' }, memberChips(m, ctl, 'members'),
        !mems.length ? h('p', { class: 'fhint', text: '아직 등록된 멤버가 없어요. ‘새 멤버’로 바로 추가할 수 있어요.' }) : null);
    },
    result: () => resultSection(m, ctl),
    details: () => detailSection(m, ctl),
    tags: () => tagsBody(),
  };

  for (const p of PANELS) {
    const id = `panel-${p.key}`;
    const sum = h('span', { class: 'rp-sum' });
    const body = h('div', { class: 'rp-body' });
    const el = h('section', { class: 'rec-panel', id, 'data-panel': p.key, hidden: true, 'aria-label': p.label },
      h('div', { class: 'rp-head' },
        h('h2', { class: 'rp-title' }, icon(p.icon), h('span', { text: p.label })),
        sum,
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm rp-fold', 'aria-controls': id, onClick: () => closePanel(p.key, true) }, '접기')),
      body);
    const btnLabel = h('span', { class: 'addon-label', text: p.label });
    const btnSum = h('span', { class: 'addon-sum' });
    const btn = h('button', { type: 'button', class: 'addon', 'data-panel': p.key, 'aria-expanded': 'false', 'aria-controls': id },
      h('span', { class: 'addon-ico', 'aria-hidden': 'true' }), btnLabel, btnSum);
    btn.addEventListener('click', () => (panels[p.key].open ? closePanel(p.key) : openPanel(p.key, { focus: true })));
    panels[p.key] = { ...p, el, body, sum, btn, btnSum, open: false, built: false };
    addonBar.append(btn);
    panelBox.append(el);
  }
  // 사진 칸은 미리 만들어 둠: 접혀 있어도 붙여넣기·파일 선택이 바로 되도록
  buildPanel('photos');

  function buildPanel(name) {
    const pn = panels[name];
    pn.body.replaceChildren(builders[name]());
    pn.built = true;
  }
  function openPanel(name, { focus = false } = {}) {
    const pn = panels[name];
    if (!pn.built) buildPanel(name);
    if (!pn.open) {
      pn.open = true;
      pn.el.hidden = false;
      paintAddons();
    }
    if (focus) {
      pn.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const first = pn.body.querySelector('input:not([type="hidden"]):not(.sr-only), button, select, textarea');
      if (first) first.focus({ preventScroll: true });
    }
  }
  function closePanel(name, fromHead = false) {
    const pn = panels[name];
    if (!pn.open) return;
    pn.open = false;
    pn.el.hidden = true;
    paintAddons();
    if (fromHead) pn.btn.focus({ preventScroll: true });
  }
  function paintAddons() {
    for (const p of PANELS) {
      const pn = panels[p.key];
      if (!pn) continue;
      const sum = summaries[p.key]();
      pn.btn.classList.toggle('has-value', !!sum);
      pn.btn.classList.toggle('is-open', pn.open);
      pn.btn.setAttribute('aria-expanded', pn.open ? 'true' : 'false');
      pn.btn.firstChild.replaceChildren(icon(sum ? 'check' : 'plus'));
      pn.btnSum.textContent = sum && !pn.open ? sum : '';
      pn.btn.setAttribute('aria-label', `${p.label}${sum ? ` — ${sum}` : ''}${pn.open ? ' 접기' : ' 펼치기'}`);
      pn.sum.textContent = sum;
    }
  }
  function rerender(name) {
    const pn = panels[name];
    if (pn && pn.built) buildPanel(name);
    paintAddons();
  }

  function tagsBody() {
    const chipsBox = h('div', { class: 'chips', role: 'group', 'aria-label': '태그' });
    const toggle = (tg, on) => {
      if (on) {
        if (m.tags.length >= LIMITS.tags) { toast(`태그는 최대 ${LIMITS.tags}개까지예요`, 'error'); return false; }
        if (!m.tags.includes(tg)) m.tags = [...m.tags, tg];
      } else m.tags = m.tags.filter((x) => x !== tg);
      changed();
      return true;
    };
    // 추천 태그는 이 영역을 열었을 때만 보임
    const paintChips = () => {
      const pool = [...m.tags];
      for (const tg of [...TAG_SUGGESTIONS[type], ...usedTags(type)]) if (!pool.includes(tg)) pool.push(tg);
      chipsBox.replaceChildren(...pool.slice(0, 30).map((tg) => chip({ label: `#${tg}`, pressed: m.tags.includes(tg), cls: 'chip-tag chip-sm', onToggle: (on) => toggle(tg, on) })));
    };
    const input = h('input', { type: 'text', class: 'input', maxlength: String(LIMITS.tag + 1), placeholder: '직접 입력 (예: 인생테마)', enterkeyhint: 'done', 'aria-label': '태그 직접 입력', autocomplete: 'off' });
    /** 입력칸의 태그 추가. 반환: 추가됨/이미 있음 true, 문제 있음 false, 빈칸 null */
    const add = () => {
      const v = input.value.replace(/^#+/, '').replace(/\s+/g, '').trim();
      if (!v) { input.value = ''; return null; }
      if (Array.from(v).length > LIMITS.tag) { toast(`태그는 ${LIMITS.tag}자까지예요`, 'error'); openPanel('tags'); input.focus(); return false; }
      if (!m.tags.includes(v) && !toggle(v, true)) { openPanel('tags'); input.focus(); return false; }
      input.value = '';
      paintChips();
      return true;
    };
    // 입력만 하고 ‘추가’를 안 누른 채 저장해도 태그가 사라지지 않게
    holder.commitTag = add;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });
    paintChips();
    return h('div', { class: 'rp-fields' }, chipsBox,
      h('div', { class: 'tag-add' }, input, h('button', { type: 'button', class: 'btn btn-soft', onClick: add }, '추가')));
  }
  const holder = {};

  /** 게임을 고르면 그 게임의 정보를 비어 있는 칸에만 이어서 채움 (방탈출 매장·지점, 머미 제작사·형태, 보드게임 방식) */
  function prefillFrom(g) {
    const last = recordsOfGame(g.id).find((r) => r.id !== editingId) || null;
    const fill = (obj, key, val, isEmpty = (v) => v === '' || v === null) => {
      if (val === undefined || val === null || val === '' || !isEmpty(obj[key])) return false;
      obj[key] = typeof val === 'number' ? String(val) : val;
      return true;
    };
    let touched = false;
    if (type === 'escaperoom') {
      const e = last && last.er ? last.er : {};
      touched = fill(m.er, 'brand', (g.brand || '').trim() || e.brand) || touched;
      touched = fill(m.er, 'branch', (g.branch || '').trim() || e.branch) || touched;
      touched = fill(m.er, 'genre', e.genre) || touched;
      touched = fill(m.er, 'timeLimitMin', e.timeLimitMin) || touched;
    } else if (type === 'murdermystery' && last && last.mm) {
      touched = fill(m.mm, 'publisher', last.mm.publisher) || touched;
      if (m.mm.format === 'store' && last.mm.format && last.mm.format !== 'store') { m.mm.format = last.mm.format; touched = true; }
      if (m.mm.format === 'store') touched = fill(m.mm, 'store', last.mm.store) || touched;
    } else if (type === 'boardgame' && last && last.bg) {
      if (m.bg.mode === 'competitive' && last.bg.mode && last.bg.mode !== 'competitive' && !m.bg.results.some((r) => r.score !== null)) {
        m.bg.mode = last.bg.mode;
        touched = true;
      }
    }
    if (touched) { rerender('result'); rerender('details'); }
  }

  /** 종류 바꾸기 (새 기록만). 날짜·별점·감상·사진·사람·태그는 그대로, 다른 종류의 게임은 다시 고름 */
  function setType(v) {
    if (v === type || !TYPES[v]) return;
    type = v;
    t = TYPES[v];
    m.type = v;
    picker.setType(v); // 다른 종류의 게임은 비움 (창에서 다른 종류로 등록한 게임이면 이미 그 종류)
    gameLabel.textContent = t.noun;
    pageEl.className = `page page-form ${t.cls}`;
    const ttl = pageEl.querySelector('.appbar-title');
    if (ttl) ttl.textContent = isNew ? '새 기록' : `${t.short} 기록 수정`;
    paintTypeSlot();
    for (const name of ['result', 'details', 'tags']) rerender(name);
    paintReview();
    try { history.replaceState(history.state, '', `#/new/${v}`); } catch { /* 무시 */ }
    changed();
  }

  /** 값이 있는 영역은 펼쳐서 보여 줌 (기존 기록 수정·초안 불러오기) */
  function openFilled() {
    for (const p of PANELS) if (summaries[p.key]() || (p.key === 'photos' && m.photos.length)) openPanel(p.key);
  }

  function buildAll() {
    paintTypeSlot();
    dateInput.value = m.date;
    paintQuick();
    ratingEl.setValue(m.rating);
    paintReview();
    for (const p of PANELS) { if (panels[p.key].built) buildPanel(p.key); }
    paintAddons();
  }

  // ── 초안 배너 ──
  const banner = h('div', { class: 'draft-banner', hidden: true, role: 'status' });
  if (draftMatches && !(query && query.draft === '1')) {
    banner.hidden = false;
    const dt = TYPES[existingDraft.model.type];
    banner.append(
      h('p', {}, icon('note'), h('span', { text: `저장하지 않은 작성 내용이 있어요 (${isNew ? `${dt.short} · ${existingDraft.model.title || '게임 미선택'} · ` : ''}${relTime(existingDraft.savedAt)})` })),
      h('div', { class: 'draft-actions' },
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm',
          onClick: () => {
            clearDraftIf((d) => d.key === draftKey);
            banner.hidden = true;
            discardPhotos(photosOf(existingDraft.model)); // 초안에만 있던 사진도 지움
          },
        }, '버리기'),
        h('button', {
          type: 'button', class: 'btn btn-primary btn-sm',
          onClick: () => {
            const dType = existingDraft.model.type;
            if (dType !== type) setType(dType);
            m = toModel(existingDraft.model, type);
            base = draftBase();
            adoptDraftId();
            syncMembers();
            dirty = true;
            banner.hidden = true;
            photos.reset(m.photos);
            const g = gameById(m.gameId);
            if (g) picker.select(g);
            buildAll();
            openFilled();
            toast('작성하던 내용을 불러왔어요', 'ok');
          },
        }, '불러오기')));
  } else if (isNew && existingDraft && String(existingDraft.key || '').startsWith('edit:') && existingDraft.model && TYPES[existingDraft.model.type]) {
    // 수정하다 만 기록이 있으면 이어 쓰러 갈 수 있게
    banner.hidden = false;
    banner.append(
      h('p', {}, icon('note'), h('span', { text: `수정하던 기록이 있어요 (${existingDraft.model.title || '제목 없음'} · ${relTime(existingDraft.savedAt)})` })),
      h('div', { class: 'draft-actions' },
        h('a', { class: 'btn btn-soft btn-sm', href: `#/edit/${encodeURIComponent(existingDraft.key.slice(5))}?draft=1` }, '이어 쓰기')));
  }

  // ── 저장 ──
  const idleLabel = isNew ? '기록 저장' : '수정 저장';
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary save-btn' }, icon('check'), h('span', { text: idleLabel }));
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, '취소');
  cancelBtn.addEventListener('click', async () => {
    if (dirty) {
      const ok = await confirmDialog('작성을 그만할까요?', '지금까지 쓴 내용은 사라져요.', { ok: '그만 쓰기', cancel: '계속 쓰기', danger: true });
      if (!ok) return;
      clearTimeout(draftTimer);
      draftTimer = null;
      dirty = false;
      clearMyDraft();
      photos.discardUnsaved();
    }
    goBack(isNew ? '#/' : `#/record/${encodeURIComponent(rec.id)}`);
  });

  function setBusy(on, label = '저장 중…') {
    saveBtn.disabled = on;
    saveBtn.classList.toggle('is-busy', on);
    saveBtn.lastChild.textContent = on ? label : idleLabel;
    if (!on) paintSaveLabel();
  }
  /** 사진을 올리는 동안은 저장 버튼에 알림 (누르면 다 올린 뒤 저장) */
  function paintSaveLabel() {
    if (saving) return;
    const n = photos.busy();
    saveBtn.classList.toggle('is-waiting', n > 0);
    saveBtn.lastChild.textContent = n > 0 ? `사진 올리는 중… (${n})` : idleLabel;
  }

  function invalid(msg, sel, panel) {
    toast(msg, 'error');
    if (panel) openPanel(panel);
    const el = sel ? root.querySelector(sel) : null;
    if (el) {
      el.setAttribute('aria-invalid', 'true');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // 묶음(라디오 그룹 등)이면 안의 첫 입력으로 초점
      const target = el.matches('input, select, textarea, button') ? el : el.querySelector('input, select, textarea, button');
      if (target) target.focus({ preventScroll: true });
    }
  }

  /** 숫자 칸 범위 확인 (빈 칸은 통과). 틀리면 안내하고 false */
  function checkRange(value, min, max, label, sel, unit = '', panel = 'details') {
    if (value === '' || value === null || value === undefined) return true;
    const n = Math.round(Number(value));
    if (Number.isFinite(Number(value)) && n >= min && n <= max) return true;
    invalid(`${label}은 ${min}~${max}${unit} 사이로 적어 주세요`, sel, panel);
    return false;
  }

  /** 게임과 날짜만 있으면 저장 (별점·감상·결과는 선택) */
  function validate() {
    if (!m.gameId && !m.title.trim()) return invalid(`${t.noun}을 골라 주세요`, '[data-field="game"]'), false;
    if (!parseDate(m.date)) return invalid('날짜를 확인해 주세요', '[data-field="date"]'), false;
    if (type === 'boardgame') {
      if (!checkRange(m.bg.playTimeMin, 0, 1440, '플레이 시간', 'input[aria-label="플레이 시간(분)"]', '분')) return false;
    } else if (type === 'murdermystery') {
      if (!checkRange(m.mm.playerCount, 1, 20, '인원', 'input[aria-label="인원"]', '명')) return false;
      if (!checkRange(m.mm.playTimeMin, 0, 1440, '플레이 시간', 'input[aria-label="플레이 시간(분)"]', '분')) return false;
    } else if (type === 'escaperoom') {
      if (!checkRange(m.er.playerCount, 1, 10, '인원', 'input[aria-label="인원"]', '명')) return false;
      if (!checkRange(m.er.timeLimitMin, 1, 300, '제한 시간', 'input[aria-label="제한 시간(분)"]', '분')) return false;
      if (m.er.cleared) {
        const mm = m.ui.remainMM, ss = m.ui.remainSS;
        const bad = (mm !== '' && !(Number(mm) >= 0 && Number(mm) <= 300 && Number.isInteger(Number(mm)))) ||
          (ss !== '' && !(Number(ss) >= 0 && Number(ss) <= 59 && Number.isInteger(Number(ss)))) ||
          (Number(mm) || 0) * 60 + (Number(ss) || 0) > 18000;
        if (bad) return invalid('남은 시간은 300분 이하로, 분과 초(0~59)로 적어 주세요', '[data-field="er.remainingSec"]', 'result'), false;
      }
    }
    return true;
  }

  async function finish(saved) {
    clearTimeout(draftTimer);
    draftTimer = null;
    dirty = false;
    clearMyDraft();
    setLastType(saved.type);
    upsertRecord(saved);
    toast(isNew ? '기록을 저장했어요' : '수정했어요', 'ok');
    navigate(`#/record/${encodeURIComponent(saved.id)}`, { replace: true });
  }

  /** 서버 사본이 지금 폼 내용과 같은지 (같은 규칙으로 정리해서 비교; 다르다고 잘못 보면 한 번 더 저장할 뿐) */
  function sameAsPayload(cur, payload) {
    if (!cur || cur.type !== payload.type) return false;
    const strip = (p) => { const { id, createdAt, updatedAt, ...rest } = p; return JSON.stringify(rest); };
    return strip(toPayload(toModel(cur, cur.type), cur.id, null)) === strip(payload);
  }

  async function save() {
    if (saving) return;
    if (holder.commitTag && holder.commitTag() === false) return;
    if (!validate()) return;
    if (photos.busy()) {
      // 사진을 다 올린 다음에 저장 (올리는 중인 사진이 빠진 채 저장되지 않게)
      saving = true;
      setBusy(true, '사진 올리는 중…');
      toast('사진을 다 올리면 바로 저장할게요', 'info');
      await photos.whenIdle();
      saving = false;
      setBusy(false);
      if (!alive) return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const kept = flushDraft();
      toast(`오프라인이라 저장할 수 없어요. ${keptMsg(kept)}`, 'error', 4000);
      return;
    }
    if (photos.failed()) {
      toast('올리지 못한 사진이 있어요. 사진을 눌러 다시 올리거나 ✕로 빼 주세요', 'error', 4500);
      photos.focus();
      return;
    }
    saving = true;
    setBusy(true);
    const payload = toPayload(m, recordId, recreateCreatedAt);
    try {
      const res = await api.saveRecord(payload, base);
      await finish(res.record);
    } catch (e) {
      const cur = e && e.data && e.data.current;
      if (e.code === 'conflict' && cur && isNew && !autoRetried && cur.createdAt && cur.createdAt === cur.updatedAt) {
        // 새 기록 재시도인데 이미 저장돼 있음 = 응답만 못 받은 내 첫 저장 (이 폼이 만든 id)
        if (sameAsPayload(cur, payload)) {
          await finish(cur);
        } else {
          // 그 뒤에 고친 내용이 있으면 첫 저장본 위에 이어서 저장 (고친 내용을 버리지 않음)
          autoRetried = true;
          base = cur.updatedAt;
          saving = false;
          await save();
        }
      } else if (e.code === 'conflict' && cur) {
        flushDraft();
        saving = false;
        setBusy(false);
        await handleConflict(cur, payload);
      } else if (e.code === 'not_found' && base) {
        flushDraft();
        saving = false;
        setBusy(false);
        await handleDeleted();
      } else if (e.code === 'invalid' && /^photos/.test(String((e.data && e.data.field) || ''))) {
        // 오래된 초안의 사진이 그사이 정리된 경우 → 없는 사진만 빼고 다시 저장하게
        // (서버가 알려 준 목록을 먼저 씀 — 메모리에 받아 둔 사진은 서버에서 지워졌어도 있는 것처럼 보이므로)
        flushDraft();
        const missing = e.data && Array.isArray(e.data.missing) ? e.data.missing : null;
        const ok = missing ? m.photos.filter((id) => !missing.includes(id)) : await existingPhotos(m.photos);
        const gone = m.photos.filter((id) => !ok.includes(id));
        if (gone.length) {
          photos.drop(gone);
          toast(`사라진 사진 ${gone.length}장을 뺐어요. 다시 저장해 주세요`, 'error', 4500);
        } else {
          toast('사진 항목을 확인해 주세요', 'error', 4000);
        }
      } else if (e.code === 'invalid') {
        flushDraft();
        toast(`${fieldLabel(e.data && e.data.field)} 항목을 확인해 주세요`, 'error', 4000);
      } else if (e.code === 'unauthorized') {
        flushDraft();
      } else {
        const kept = flushDraft();
        toast(`${api.errorMessage(e)} ${keptMsg(kept)}`, 'error', 4500);
      }
    } finally {
      saving = false;
      setBusy(false);
    }
  }

  /** 수정하는 동안 다른 사람이 이 기록을 삭제한 경우 */
  async function handleDeleted() {
    const again = await confirmDialog('다른 사람이 삭제한 기록이에요',
      '내가 수정하는 동안 이 기록이 삭제됐어요. 내가 쓴 내용으로 새 기록을 다시 저장할까요? 취소하면 내용은 초안으로 보관돼요.',
      { ok: '새 기록으로 다시 저장', cancel: '취소' });
    if (!again) {
      toast('내가 쓴 내용은 초안으로 보관돼요', 'info', 4000);
      return;
    }
    base = null;
    recreateCreatedAt = rec && rec.createdAt ? rec.createdAt : null;
    await save();
  }

  async function handleConflict(current, mine) {
    const diffKeys = [];
    // 최신본도 폼과 같은 규칙으로 정리해서 비교 (한줄평·후기를 합친 것 등은 다른 부분으로 치지 않음)
    const theirs = toPayload(toModel(current, current.type), current.id, null);
    const cmp = [['title', '게임'], ['date', '날짜'], ['rating', '별점'], ['review', '감상'], ['oneLiner', '감상'], ['spoiler', '스포일러'], ['tags', '태그'], ['members', '함께한 사람'], ['photos', '사진']];
    for (const [k, label] of cmp) {
      if (JSON.stringify(theirs[k] ?? null) !== JSON.stringify(mine[k] ?? null) && !diffKeys.includes(label)) diffKeys.push(label);
    }
    const blk = { boardgame: 'bg', murdermystery: 'mm', escaperoom: 'er' }[type];
    if (JSON.stringify(theirs[blk] ?? null) !== JSON.stringify(mine[blk] ?? null)) diffKeys.push('결과·자세한 정보');

    const body = h('div', { class: 'conflict' },
      h('p', { class: 'dlg-text', text: '내가 수정하는 동안 다른 사람이 이 기록을 먼저 바꿨어요. 최신본은 이래요:' }),
      h('div', { class: `conflict-card ${t.cls}` },
        h('p', { class: 'conflict-title', text: titleOf(current) || '(제목 없음)' }),
        h('p', { class: 'conflict-meta', text: `${fmtDate(current.date)} · ${current.updatedAt ? `${fmtDateTime(current.updatedAt)} 수정` : ''}` }),
        Number(current.rating) > 0 ? starsView(current.rating, { size: 'xs' }) : null,
        current.oneLiner ? h('p', { class: 'conflict-one', text: `“${current.oneLiner}”` }) : null,
        current.review ? h('p', { class: 'conflict-review', text: current.review.slice(0, 160) + (current.review.length > 160 ? '…' : '') }) : null),
      diffKeys.length ? h('p', { class: 'conflict-diff', text: `내 내용과 다른 부분: ${diffKeys.join(', ')}` }) : null,
      h('p', { class: 'fhint', text: '덮어쓰면 최신본 대신 내 내용이 저장돼요. 취소하면 최신본을 보여 주고, 내가 쓴 내용은 초안으로 보관해요.' }));
    const choice = await openDialog({
      title: '다른 사람이 먼저 수정했어요',
      body,
      actions: [
        { label: '취소', value: 'cancel', kind: 'ghost' },
        { label: '내 내용으로 덮어쓰기', value: 'overwrite', kind: 'danger' },
      ],
    });
    if (choice === 'overwrite') {
      base = current.updatedAt || null;
      await save();
    } else {
      upsertRecord(current);
      const kept = flushDraft();
      dirty = false;
      toast(kept ? '최신 내용을 불러왔어요. 내가 쓴 내용은 초안으로 보관돼요' : '최신 내용을 불러왔어요. (기기 저장 공간이 부족해 내 내용은 보관하지 못했어요)', 'info', 4000);
      navigate(`#/record/${encodeURIComponent(current.id || recordId)}`, { replace: true });
    }
  }

  if (orphanId) {
    banner.hidden = false;
    banner.replaceChildren(h('p', {}, icon('info'),
      h('span', { text: '수정하던 기록이 그사이 삭제됐어요. 저장하면 새 기록으로 다시 만들어져요. 필요 없으면 취소를 눌러 초안을 지우세요.' })));
    dirty = true;
  }

  const form = h('form', { class: 'form rec-form', novalidate: true });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  const sheet = h('div', { class: 'rec-sheet' },
    h('div', { class: 'rec-main' }, typeSlot, gameSlot, dateRate, reviewSlot),
    h('div', { class: 'rec-more' }, addonBar, panelBox));
  form.append(banner, sheet, h('div', { class: 'savebar' }, cancelBtn, saveBtn));

  formReady = true;
  buildAll();
  if (!isNew || dirty) openFilled();
  const pageEl = h('div', { class: `page page-form ${t.cls}` },
    appBar({ title: isNew ? '새 기록' : `${t.short} 기록 수정`, back: isNew ? '#/' : `#/record/${encodeURIComponent(rec.id)}` }),
    form);
  root.replaceChildren(pageEl);
  requestAnimationFrame(grow);

  // 휴대폰에서 글을 쓰는 동안(키보드가 올라온 동안)은 저장 줄을 붙여 두지 않음 — 입력칸·키보드를 가리지 않게
  const narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 767px)') : null;
  const isTyping = (el) => el && el.matches && el.matches('textarea, select, input:not([type="checkbox"]):not([type="radio"]):not([type="file"])');
  const onFocusIn = (e) => { if (narrow && narrow.matches && isTyping(e.target)) form.classList.add('is-typing'); };
  const onFocusOut = () => setTimeout(() => { if (!isTyping(document.activeElement) || !form.contains(document.activeElement)) form.classList.remove('is-typing'); }, 60);
  form.addEventListener('focusin', onFocusIn);
  form.addEventListener('focusout', onFocusOut);

  const onHide = () => flushDraft();
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onHide);
  return () => {
    alive = false;
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onHide);
    photos.destroy();
    if (dirty && draftTimer) writeDraft();
  };
}
