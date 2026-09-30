// 새 기록 / 수정 폼
import { h, icon } from '../dom.js';
import { TYPES, TYPE_KEYS, TAG_SUGGESTIONS, LIMITS, FIELD_LABELS, MM_SCORES, ER_SCORES } from '../constants.js';
import {
  state, recordById, upsertRecord, membersSorted, memberInfo, titlesFor, latestWithTitle, usedTags,
  getDraft, setDraft, clearDraftIf, isFirstLoad, playedBy, photosOf,
} from '../store.js';
import { todayStr, yesterdayStr, defaultRecordDate, fmtDate, relTime, parseDate, fmtDateTime } from '../format.js';
import * as api from '../api.js';
import { navigate, goBack } from '../nav.js';
import {
  appBar, chip, avatar, field, counterFor, ratingInput, switchRow, openDialog, confirmDialog, toast, emptyState, starsView, nextId,
} from '../ui.js';
import { bgSection, mmSection, erSection, textInput, recalcResults } from './form-sections.js';
import { openMemberEditor } from './members.js';
import { photoField, discardPhotos } from './photos.js';
import { existingPhotos } from '../images.js';

// ── 모델 ──
function blankModel(type) {
  return {
    type,
    date: defaultRecordDate(),
    title: '',
    members: [],
    rating: 0,
    oneLiner: '',
    review: '',
    spoiler: false,
    tags: [],
    photos: [],
    bg: { place: '', playTimeMin: '', mode: 'competitive', results: [], coopWin: null, expansion: '' },
    mm: {
      publisher: '', format: 'store', store: '', gm: '', playerCount: '', playTimeMin: '', roles: [], culpritResult: null,
      scores: { story: 0, deduction: 0, roleplay: 0, balance: 0, production: 0 }, difficulty: 0, replay: false,
    },
    er: {
      brand: '', branch: '', genre: '', playerCount: '', timeLimitMin: '', cleared: null, hints: 0,
      scores: { story: 0, interior: 0, puzzle: 0, device: 0 }, difficulty: 0, fear: 0, activity: 0, replay: false,
    },
    ui: { rankMode: 'high', winnerManual: false, pcAuto: true, remainMM: '', remainSS: '' },
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 저장된 기록 또는 초안 → 폼 모델 (구조 보장) */
function toModel(src, type) {
  const m = blankModel(type);
  if (!isObj(src)) return m;
  for (const k of ['date', 'title', 'oneLiner', 'review']) if (typeof src[k] === 'string') m[k] = src[k];
  if (Array.isArray(src.members)) m.members = src.members.filter((x) => typeof x === 'string');
  if (Array.isArray(src.tags)) m.tags = src.tags.filter((x) => typeof x === 'string');
  if (Array.isArray(src.photos)) m.photos = [...new Set(src.photos.filter((x) => typeof x === 'string'))].slice(0, LIMITS.photos);
  m.rating = Number(src.rating) || 0;
  m.spoiler = !!src.spoiler;
  if (isObj(src.bg)) {
    const b = src.bg;
    Object.assign(m.bg, {
      place: b.place || '', playTimeMin: b.playTimeMin ? String(b.playTimeMin) : '', mode: ['competitive', 'coop', 'team'].includes(b.mode) ? b.mode : 'competitive',
      coopWin: typeof b.coopWin === 'boolean' ? b.coopWin : null, expansion: b.expansion || '',
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
      difficulty: Number(b.difficulty) || 0, replay: !!b.replay,
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
      cleared: typeof b.cleared === 'boolean' ? b.cleared : null, hints: Number(b.hints) || 0,
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

/** 폼 모델 → 서버 전송용 레코드 */
function toPayload(m, id, createdAt) {
  const rec = {
    id, type: m.type, date: m.date, title: m.title.trim(), members: [...m.members], rating: m.rating,
    oneLiner: m.oneLiner.trim(), review: m.review.trim(), spoiler: !!m.spoiler, tags: [...m.tags], photos: [...m.photos],
  };
  if (createdAt) rec.createdAt = createdAt;
  const n = m.members.length;
  if (m.type === 'boardgame') {
    const b = m.bg;
    rec.bg = {
      place: b.place.trim(), playTimeMin: intOrNull(b.playTimeMin) ?? 0, mode: b.mode, expansion: b.expansion.trim(),
      coopWin: b.mode === 'coop' ? b.coopWin : null,
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
    rec.mm = {
      publisher: b.publisher.trim(), format: b.format, store: b.format === 'store' ? b.store.trim() : '', gm: b.gm.trim(),
      playerCount: pc, playTimeMin: intOrNull(b.playTimeMin) ?? 0,
      roles: b.roles.filter((r) => m.members.includes(r.memberId)).map((r) => ({
        memberId: r.memberId, character: r.character.trim(), culprit: !!r.culprit, outcome: r.outcome || null, mvp: !!r.mvp,
      })),
      culpritResult: b.culpritResult || null, scores: { ...b.scores }, difficulty: b.difficulty, replay: !!b.replay,
    };
  } else if (m.type === 'escaperoom') {
    const b = m.er;
    const hasTime = m.ui.remainMM !== '' || m.ui.remainSS !== '';
    const sec = hasTime ? (Number(m.ui.remainMM) || 0) * 60 + (Number(m.ui.remainSS) || 0) : null;
    rec.er = {
      brand: b.brand.trim(), branch: b.branch.trim(), genre: b.genre.trim(),
      playerCount: intOrNull(b.playerCount) ?? (n ? Math.min(10, n) : null), timeLimitMin: intOrNull(b.timeLimitMin),
      cleared: b.cleared === true, remainingSec: b.cleared === true ? sec : null, hints: Number(b.hints) || 0,
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

// ── 종류 선택 화면 ──
function renderPicker(root) {
  const draft = getDraft();
  let draftCard = null;
  if (draft && draft.model && TYPES[draft.model.type]) {
    const t = TYPES[draft.model.type];
    const isEdit = String(draft.key || '').startsWith('edit:');
    const target = isEdit ? `#/edit/${encodeURIComponent(draft.key.slice(5))}?draft=1` : `#/new/${draft.model.type}?draft=1`;
    draftCard = h('div', { class: `draft-card ${t.cls}` },
      h('div', { class: 'draft-text' },
        h('p', { class: 'draft-title', text: isEdit ? '수정하던 기록이 있어요' : '작성하던 기록이 있어요' }),
        h('p', { class: 'draft-sub', text: `${t.short} · ${draft.model.title || '제목 없음'} · ${relTime(draft.savedAt)}` })),
      h('button', { type: 'button', class: 'btn btn-soft btn-sm', onClick: () => navigate(target, { replace: true }) }, '이어 쓰기'));
  }
  root.replaceChildren(h('div', { class: 'page page-picker' },
    appBar({ title: '새 기록', back: '#/' }),
    h('p', { class: 'picker-lead', text: '어떤 놀이를 기록할까요?' }),
    draftCard,
    h('div', { class: 'picker' }, TYPE_KEYS.map((k) => {
      const t = TYPES[k];
      return h('button', { type: 'button', class: `pick ${t.cls}`, onClick: () => navigate(`#/new/${k}`, { replace: true }) },
        h('span', { class: 'pick-ico', 'aria-hidden': 'true' }, icon(t.icon)),
        h('span', { class: 'pick-text' },
          h('span', { class: 'pick-label', text: t.label }),
          h('span', { class: 'pick-desc', text: t.desc })),
        icon('chevron', 'pick-go'));
    }))));
  return {};
}

// ── 폼 ──
export function mount(root, ctx) {
  const [kind, arg] = [ctx.name, ctx.params[0]];
  if (kind === 'new' && !arg) return renderPicker(root);
  if (kind === 'new' && !TYPES[arg]) { navigate('#/new', { replace: true }); return {}; }

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
      // 첫 데이터를 받기 전에는 멤버·이전 제목·태그가 비어 있으므로 기다렸다가 그림
      if (isFirstLoad()) { loadingPage(`새 ${TYPES[arg].short} 기록`); return; }
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

function buildForm(root, { rec, type, query, orphanId = null }) {
  const isNew = !rec;
  const t = TYPES[type];
  // orphanId: 수정하던 기록이 다른 곳에서 삭제됨 → 같은 id 의 새 기록으로 저장
  const draftKey = orphanId ? `edit:${orphanId}` : isNew ? 'new' : `edit:${rec.id}`;
  let m = toModel(rec, type);
  let base = isNew ? null : rec.updatedAt || null;
  let recordId = orphanId || (isNew ? newId() : rec.id);
  let dirty = false;
  let saving = false;
  let draftTimer = null;
  let dismissedTitle = '';
  let recreateCreatedAt = null; // 삭제된 기록을 다시 만들 때 원래 작성 시각 유지 (N번째 순서 보존)
  let autoRetried = false;
  let alive = true;
  let formReady = false; // 저장 버튼까지 만들어진 뒤부터 사진 상태를 버튼에 반영

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
  const keptMsg = (ok) => (ok ? '입력한 내용은 이 기기에 보관돼요' : '기기 저장 공간이 부족해 입력 내용을 보관하지 못했어요. 후기는 따로 복사해 두세요');

  const existingDraft = getDraft();
  const draftMatches = existingDraft && existingDraft.key === draftKey && existingDraft.model && existingDraft.model.type === type;
  // 새 기록 초안을 이어 쓸 때는 처음 만든 id 를 그대로 씀
  // (저장 응답만 못 받은 경우 다시 저장해도 같은 기록이 두 개 생기지 않도록)
  const adoptDraftId = () => {
    if (isNew && !orphanId && typeof existingDraft.recordId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(existingDraft.recordId)) {
      recordId = existingDraft.recordId;
    }
  };
  // 초안의 기준 버전: 수정 초안은 물론, 새 기록도 (응답을 못 받은 첫 저장 뒤) 기준이 생겼을 수 있음.
  // 삭제된 기록을 살리는 경우(orphan)는 항상 새로 만듦
  const draftBase = () => (orphanId ? null : (existingDraft.baseUpdatedAt ?? base));
  if (draftMatches && query && query.draft === '1') {
    m = toModel(existingDraft.model, type);
    base = draftBase();
    adoptDraftId();
    dirty = true;
  }

  const ctl = {
    changed,
    rerender: (name) => rerender(name),
    editingId: isNew ? null : rec.id,
    createdAt: isNew ? '9999' : rec.createdAt,
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

  // ── 섹션 ──
  const sections = {};
  const holder = {};

  function sectionCommon() {
    const titles = titlesFor(type);
    const listId = nextId('titles');
    const titleInput = textInput(m.title, { max: LIMITS.title, placeholder: t.titlePlaceholder, list: listId, cls: 'input-title' });
    titleInput.required = true;
    titleInput.dataset.field = 'title';
    const suggest = h('div', { class: 'suggest', hidden: true, 'aria-live': 'polite' });
    let st = null;
    titleInput.addEventListener('input', () => {
      m.title = titleInput.value;
      titleInput.removeAttribute('aria-invalid');
      changed();
      clearTimeout(st);
      st = setTimeout(() => { showSuggest(suggest); photos.refreshSuggest(); }, 350);
    });
    titleInput.addEventListener('change', () => { showSuggest(suggest); photos.refreshSuggest(); });

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
      if (sections.type && sections.type.paintOrdinal) sections.type.paintOrdinal();
    }
    dateInput.addEventListener('change', onDate);
    paintQuick();
    const dateRow = h('div', { class: 'date-row' }, dateInput,
      h('div', { class: 'date-quick', role: 'group', 'aria-label': '빠른 날짜' }, quick.map(([b]) => b)));

    const one = textInput(m.oneLiner, { max: LIMITS.oneLiner, placeholder: '한 문장으로 남긴다면?' });
    one.addEventListener('input', () => { m.oneLiner = one.value; changed(); });

    return h('section', { class: `card fsec fsec-main ${t.cls}` },
      h('div', { class: 'fsec-body' },
        field(t.titleLabel, titleInput, { counter: counterFor(titleInput, LIMITS.title) }),
        h('datalist', { id: listId }, titles.slice(0, 80).map((x) => h('option', { value: x }))),
        suggest,
        h('div', { class: 'field' },
          h('div', { class: 'field-head' }, h('label', { class: 'field-label', htmlFor: dateInput.id, text: '날짜' })),
          dateRow),
        h('div', { class: 'field' },
          h('div', { class: 'field-head' }, h('span', { class: 'field-label', id: 'lbl-rating', text: '별점' })),
          ratingInput({ value: m.rating, label: '별점', size: 'lg', onChange: (v) => { m.rating = v; changed(); } })),
        field('한줄평', one, { counter: counterFor(one, LIMITS.oneLiner) })));
  }

  let suggestFor = null;
  function showSuggest(box) {
    const excludeId = isNew ? null : rec.id;
    const prev = latestWithTitle(type, m.title, excludeId);
    if (!prev || dismissedTitle === m.title.trim()) { box.hidden = true; box.replaceChildren(); suggestFor = null; return; }
    // 같은 제안이 이미 떠 있으면 다시 그리지 않음 (blur→change 때 버튼이 바뀌어 탭이 씹히는 것 방지)
    if (!box.hidden && suggestFor === prev.id) return;
    suggestFor = prev.id;
    const fill = fillFrom(prev, true);
    // 머미·방탈출은 한 번 하면 다시 못 하는 경우가 많아서, 이미 해 본 멤버를 알려 줌
    const replayless = type === 'murdermystery' || type === 'escaperoom';
    const players = replayless ? playedBy(type, m.title, excludeId).map((id) => memberInfo(id)).filter((x) => !x.missing) : [];
    if (!fill.labels.length && !players.length) { box.hidden = true; box.replaceChildren(); suggestFor = null; return; }
    box.hidden = false;
    const close = () => { dismissedTitle = m.title.trim(); box.hidden = true; };
    box.replaceChildren(
      h('div', { class: 'suggest-text' },
        icon('sparkle'),
        h('span', {},
          h('strong', { text: `${fmtDate(prev.date, { weekday: false })}에 기록한 적이 있어요. ` }),
          fill.labels.length ? `${fill.labels.join(' · ')} 정보를 불러올까요?` : null)),
      players.length
        ? h('p', { class: 'suggest-played' }, icon('users'),
          h('span', { text: `이미 해 본 멤버: ${players.map((x) => x.name).join(', ')}` }))
        : null,
      h('div', { class: 'suggest-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: close }, fill.labels.length ? '괜찮아요' : '닫기'),
        fill.labels.length
          ? h('button', {
            type: 'button', class: 'btn btn-primary btn-sm',
            onClick: () => { fillFrom(prev, false); close(); changed(); rerender('type'); toast('이전 기록에서 정보를 불러왔어요', 'ok'); },
          }, '불러오기')
          : null));
  }

  /** dry=true 면 채울 수 있는 항목 라벨만 계산 */
  function fillFrom(prev, dry) {
    const labels = [];
    const set = (obj, key, val, label) => {
      if (val === undefined || val === null || val === '' || val === 0) return;
      if (String(obj[key] ?? '') === String(val)) return;
      labels.push(label);
      if (!dry) obj[key] = typeof val === 'number' ? String(val) : val;
    };
    if (type === 'boardgame' && prev.bg) {
      set(m.bg, 'mode', prev.bg.mode, '방식');
      set(m.bg, 'expansion', prev.bg.expansion, '확장판');
      set(m.bg, 'place', prev.bg.place, '장소');
    } else if (type === 'murdermystery' && prev.mm) {
      set(m.mm, 'publisher', prev.mm.publisher, '제작사');
      set(m.mm, 'format', prev.mm.format, '형태');
      set(m.mm, 'store', prev.mm.store, '매장');
      set(m.mm, 'playerCount', prev.mm.playerCount, '인원');
      set(m.mm, 'playTimeMin', prev.mm.playTimeMin, '시간');
      if (!dry && prev.mm.playerCount) m.ui.pcAuto = false;
    } else if (type === 'escaperoom' && prev.er) {
      set(m.er, 'brand', prev.er.brand, '브랜드');
      set(m.er, 'branch', prev.er.branch, '지점');
      set(m.er, 'genre', prev.er.genre, '장르');
      set(m.er, 'timeLimitMin', prev.er.timeLimitMin, '제한 시간');
    }
    return { labels };
  }

  function sectionMembers() {
    const mems = membersSorted();
    const known = new Set(mems.map((x) => x.id));
    const gone = m.members.filter((id) => !known.has(id));
    const count = h('span', { class: 'counter', text: `${m.members.length}명` });
    const toggle = (id, on) => {
      if (on) {
        if (m.members.length >= LIMITS.members) { toast(`멤버는 최대 ${LIMITS.members}명까지 고를 수 있어요`, 'error'); return false; }
        if (!m.members.includes(id)) m.members = [...m.members, id];
      } else {
        m.members = m.members.filter((x) => x !== id);
      }
      count.textContent = `${m.members.length}명`;
      syncMembers();
      changed();
      rerender('type');
      return true;
    };
    const chips = h('div', { class: 'chips chips-members', role: 'group', 'aria-label': '함께한 멤버' },
      mems.map((mb) => chip({ label: mb.name, pressed: m.members.includes(mb.id), cls: 'chip-member', lead: avatar(mb.id, 'xs'), onToggle: (on) => toggle(mb.id, on) })),
      gone.map((id) => chip({ label: memberInfo(id).name, pressed: true, cls: 'chip-member is-gone', lead: avatar(id, 'xs'), onToggle: (on) => toggle(id, on) })),
      h('button', {
        type: 'button', class: 'chip chip-add',
        onClick: async () => {
          const saved = await openMemberEditor(null);
          if (saved) { toggle(saved.id, true); rerender('members'); }
        },
      }, icon('plus'), h('span', { class: 'chip-label', text: '새 멤버' })));
    return h('section', { class: 'card fsec' },
      h('div', { class: 'fsec-head' }, h('h2', { class: 'fsec-title', text: '함께한 멤버' }), count),
      h('div', { class: 'fsec-body' }, chips,
        !mems.length ? h('p', { class: 'fhint', text: '아직 등록된 멤버가 없어요. ‘새 멤버’로 바로 추가할 수 있어요.' }) : null));
  }

  function sectionType() {
    const builder = type === 'boardgame' ? bgSection : type === 'murdermystery' ? mmSection : erSection;
    const body = builder(m, ctl);
    const title = type === 'boardgame' ? '게임 결과' : type === 'murdermystery' ? '머더미스터리 기록' : '방탈출 기록';
    const secEl = h('section', { class: `card fsec fsec-type ${t.cls}` },
      h('div', { class: 'fsec-head' }, h('span', { class: 'fsec-ico', 'aria-hidden': 'true' }, icon(t.icon)), h('h2', { class: 'fsec-title', text: title })),
      body);
    secEl.paintOrdinal = body.paintOrdinal;
    return secEl;
  }

  function sectionReview() {
    const ta = h('textarea', { class: 'input textarea', rows: '6', maxlength: String(LIMITS.review), placeholder: '자유롭게 후기를 남겨 주세요. 스포일러가 있다면 아래 스위치를 켜 주세요.' });
    ta.value = m.review;
    ta.addEventListener('input', () => { m.review = ta.value; changed(); });
    return h('section', { class: 'card fsec' },
      h('div', { class: 'fsec-head' }, h('h2', { class: 'fsec-title', text: '후기' }), counterFor(ta, LIMITS.review)),
      h('div', { class: 'fsec-body' },
        ta,
        switchRow({
          checked: m.spoiler, label: '스포일러 포함',
          desc: type === 'murdermystery' ? '목록과 상세에서 한줄평·후기·범인/배역을 가려 둬요' : '목록과 상세에서 한줄평·후기를 가려 둬요',
          icon: 'eye', onChange: (v) => { m.spoiler = v; changed(); },
        })));
  }

  function sectionTags() {
    const count = h('span', { class: 'counter' });
    const chipsBox = h('div', { class: 'chips', role: 'group', 'aria-label': '태그' });
    const paintCount = () => { count.textContent = `${m.tags.length}/${LIMITS.tags}`; };
    const toggle = (tg, on) => {
      if (on) {
        if (m.tags.length >= LIMITS.tags) { toast(`태그는 최대 ${LIMITS.tags}개까지예요`, 'error'); return false; }
        if (!m.tags.includes(tg)) m.tags = [...m.tags, tg];
      } else m.tags = m.tags.filter((x) => x !== tg);
      paintCount();
      changed();
      return true;
    };
    const paintChips = () => {
      const pool = [...m.tags];
      for (const tg of [...TAG_SUGGESTIONS[type], ...usedTags(type)]) if (!pool.includes(tg)) pool.push(tg);
      chipsBox.replaceChildren(...pool.slice(0, 30).map((tg) => chip({ label: `#${tg}`, pressed: m.tags.includes(tg), cls: 'chip-tag', onToggle: (on) => toggle(tg, on) })));
    };
    const input = h('input', { type: 'text', class: 'input', maxlength: String(LIMITS.tag + 1), placeholder: '직접 입력 (예: 인생테마)', enterkeyhint: 'done', 'aria-label': '태그 직접 입력', autocomplete: 'off' });
    /** 입력칸의 태그 추가. 반환: 추가됨/이미 있음 true, 문제 있음 false, 빈칸 null */
    const add = () => {
      const v = input.value.replace(/^#+/, '').replace(/\s+/g, '').trim();
      if (!v) { input.value = ''; return null; }
      if (Array.from(v).length > LIMITS.tag) { toast(`태그는 ${LIMITS.tag}자까지예요`, 'error'); input.focus(); return false; }
      if (!m.tags.includes(v) && !toggle(v, true)) { input.focus(); return false; }
      input.value = '';
      paintChips();
      return true;
    };
    // 입력만 하고 ‘추가’를 안 누른 채 저장해도 태그가 사라지지 않게
    holder.commitTag = add;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });
    paintCount();
    paintChips();
    return h('section', { class: 'card fsec' },
      h('div', { class: 'fsec-head' }, h('h2', { class: 'fsec-title', text: '태그' }), count),
      h('div', { class: 'fsec-body' }, chipsBox,
        h('div', { class: 'tag-add' }, input, h('button', { type: 'button', class: 'btn btn-soft', onClick: add }, '추가'))));
  }

  // 사진 칸은 올리는 중인 상태를 들고 있어서 한 번만 만들고 계속 씀
  const photos = photoField({
    model: () => m,
    onChange: changed,
    onBusy: () => { if (formReady) paintSaveLabel(); },
    type,
    excludeId: isNew ? null : rec.id,
  });
  const builders = { common: sectionCommon, photos: () => photos.el, members: sectionMembers, type: sectionType, review: sectionReview, tags: sectionTags };
  function rerender(name) {
    const old = sections[name];
    const next = builders[name]();
    sections[name] = next;
    if (old && old.parentNode) old.replaceWith(next);
  }
  function buildAll() {
    for (const k of Object.keys(builders)) sections[k] = builders[k]();
    // 넓은 화면에서는 두 단: 왼쪽 [기본 · 사진 · 멤버], 오른쪽 [종류별 · 후기 · 태그] (휴대폰에서는 차례대로 쌓임)
    holder.body.replaceChildren(banner,
      h('div', { class: 'form-col' }, sections.common, sections.photos, sections.members),
      h('div', { class: 'form-col' }, sections.type, sections.review, sections.tags));
  }

  // ── 초안 배너 ──
  const banner = h('div', { class: 'draft-banner', hidden: true, role: 'status' });
  if (draftMatches && !(query && query.draft === '1')) {
    banner.hidden = false;
    banner.append(
      h('p', {}, icon('note'), h('span', { text: `저장하지 않은 작성 내용이 있어요 (${relTime(existingDraft.savedAt)})` })),
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
            m = toModel(existingDraft.model, type);
            base = draftBase();
            adoptDraftId();
            syncMembers();
            dirty = true;
            banner.hidden = true;
            photos.reset(m.photos);
            buildAll();
            toast('작성하던 내용을 불러왔어요', 'ok');
          },
        }, '불러오기')));
  }

  // ── 저장 ──
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-lg save-btn' }, icon('check'), h('span', { text: isNew ? '기록 저장' : '수정 저장' }));
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-lg' }, '취소');
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

  const idleLabel = isNew ? '기록 저장' : '수정 저장';
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

  function invalid(msg, sel) {
    toast(msg, 'error');
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
  function checkRange(value, min, max, label, sel, unit = '') {
    if (value === '' || value === null || value === undefined) return true;
    const n = Math.round(Number(value));
    if (Number.isFinite(Number(value)) && n >= min && n <= max) return true;
    invalid(`${label}은 ${min}~${max}${unit} 사이로 적어 주세요`, sel);
    return false;
  }

  function validate() {
    if (!m.title.trim()) return invalid(`${t.titleLabel}을 적어 주세요`, '[data-field="title"]'), false;
    if (!parseDate(m.date)) return invalid('날짜를 확인해 주세요', '[data-field="date"]'), false;
    if (type === 'boardgame') {
      if (!checkRange(m.bg.playTimeMin, 0, 1440, '플레이 시간', 'input[aria-label="플레이 시간(분)"]', '분')) return false;
    } else if (type === 'murdermystery') {
      if (!checkRange(m.mm.playerCount, 1, 20, '인원', 'input[aria-label="인원"]', '명')) return false;
      if (!checkRange(m.mm.playTimeMin, 0, 1440, '플레이 시간', 'input[aria-label="플레이 시간(분)"]', '분')) return false;
    } else if (type === 'escaperoom') {
      if (!checkRange(m.er.playerCount, 1, 10, '인원', 'input[aria-label="인원"]', '명')) return false;
      if (!checkRange(m.er.timeLimitMin, 1, 300, '제한 시간', 'input[aria-label="제한 시간(분)"]', '분')) return false;
      if (m.er.cleared !== true && m.er.cleared !== false) return invalid('탈출 성공/실패를 골라 주세요', '[data-field="er.cleared"]'), false;
      if (m.er.cleared) {
        const mm = m.ui.remainMM, ss = m.ui.remainSS;
        const bad = (mm !== '' && !(Number(mm) >= 0 && Number(mm) <= 300 && Number.isInteger(Number(mm)))) ||
          (ss !== '' && !(Number(ss) >= 0 && Number(ss) <= 59 && Number.isInteger(Number(ss)))) ||
          (Number(mm) || 0) * 60 + (Number(ss) || 0) > 18000;
        if (bad) return invalid('남은 시간은 300분 이하로, 분과 초(0~59)로 적어 주세요', '[data-field="er.remainingSec"]'), false;
      }
    }
    return true;
  }

  async function finish(saved) {
    clearTimeout(draftTimer);
    draftTimer = null;
    dirty = false;
    clearMyDraft();
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
    const cmp = ['title', 'date', 'rating', 'oneLiner', 'review', 'spoiler', 'tags', 'members', 'photos'];
    const cmpVal = (rec, k) => (k === 'photos' ? rec.photos || [] : rec[k] ?? null); // 사진이 없던 예전 기록 = []
    for (const k of cmp) if (JSON.stringify(cmpVal(current, k)) !== JSON.stringify(cmpVal(mine, k))) diffKeys.push(FIELD_LABELS[k] || k);
    const blk = { boardgame: 'bg', murdermystery: 'mm', escaperoom: 'er' }[type];
    if (JSON.stringify(current[blk] ?? null) !== JSON.stringify(mine[blk] ?? null)) diffKeys.push('상세 기록');

    const body = h('div', { class: 'conflict' },
      h('p', { class: 'dlg-text', text: '내가 수정하는 동안 다른 사람이 이 기록을 먼저 바꿨어요. 최신본은 이래요:' }),
      h('div', { class: `conflict-card ${t.cls}` },
        h('p', { class: 'conflict-title', text: current.title || '(제목 없음)' }),
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

  const form = h('form', { class: 'form', novalidate: true });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  holder.body = h('div', { class: 'form-body' });
  form.append(holder.body, h('div', { class: 'savebar' }, cancelBtn, saveBtn));

  formReady = true;
  buildAll();
  root.replaceChildren(h('div', { class: `page page-form ${t.cls}` },
    appBar({ title: isNew ? `새 ${t.short} 기록` : `${t.short} 기록 수정`, back: isNew ? '#/' : `#/record/${encodeURIComponent(rec.id)}` }),
    form));

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
