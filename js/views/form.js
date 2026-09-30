// 기록 쓰기·수정 — 장르·제목·날짜만 필수. 나머지는 '추가 기록'을 펼쳐서.
// 작품은 자동으로 합치지 않는다: 기존 작품은 제안 목록에서 직접 고르거나, 저장할 때 같은 이름이 있으면 물어본다.
import { h, icon } from '../dom.js';
import * as repo from '../repo.js';
import * as prefs from '../prefs.js';
import { GENRES, GENRE_KEYS, LIMITS, MM_FORMATS, ER_RESULTS } from '../constants.js';
import { hasExtra, hasSpoiler, placeLabel, workLabel, isValidDate } from '../model.js';
import { sameTitleWorks, suggestWorks } from '../query.js';
import { todayStr, yesterdayStr, fmtDate, fmtMinutes } from '../format.js';
import { navigate, goBack, markJustSaved, returnTo } from '../nav.js';
import {
  field, setFieldError, counterFor, autoGrow, segmented, ratingInput, levelPicker, stepper, fold,
  toast, openDialog, choiceSheet, genreIcon, nextId, emptyState, appBar,
} from '../ui.js';
import { photoField } from './photos.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

function blankModel(genre = '') {
  return {
    genre: GENRE_KEYS.includes(genre) ? genre : '',
    workId: null, title: '', store: '', branch: '',
    date: todayStr(), rating: null, oneLiner: '', review: '',
    companions: [], photos: [], details: {}, spoiler: {}, forceNew: false,
  };
}

function modelFromPlay(play, work) {
  return {
    genre: work.genre, workId: work.id, title: work.title, store: work.store || '', branch: work.branch || '',
    date: play.date, rating: play.rating, oneLiner: play.oneLiner, review: play.review,
    companions: [...play.companions], photos: [...play.photos],
    details: { ...play.details }, spoiler: { ...play.spoiler }, forceNew: false,
  };
}

/** 초안(localStorage)에서 읽은 값 다듬기 — 형식이 틀린 값은 버림 */
function sanitize(m) {
  const b = blankModel(m.genre);
  const w = typeof m.workId === 'string' ? repo.getWork(m.workId) : null;
  return {
    ...b,
    genre: w ? w.genre : b.genre,
    workId: w ? w.id : null,
    title: w ? w.title : str(m.title),
    store: str(m.store), branch: str(m.branch),
    date: isValidDate(m.date) ? m.date : b.date,
    rating: typeof m.rating === 'number' ? m.rating : null,
    oneLiner: str(m.oneLiner), review: str(m.review),
    companions: Array.isArray(m.companions) ? m.companions.filter((x) => typeof x === 'string') : [],
    photos: Array.isArray(m.photos) ? m.photos.filter((x) => typeof x === 'string') : [],
    details: isObj(m.details) ? m.details : {},
    spoiler: isObj(m.spoiler) ? m.spoiler : {},
    forceNew: m.forceNew === true,
  };
}

/** 새 기록에 뭔가 적었는지 (기존 작품을 고르기만 한 것은 적은 것이 아님) */
function hasContent(m) {
  const filled = (o) => Object.values(o || {}).some((v) => v !== null && v !== undefined && v !== '');
  return !!((!m.workId && m.title.trim()) || m.oneLiner || m.review || m.rating || m.store || m.branch ||
    m.companions.length || m.photos.length || filled(m.details) || filled(m.spoiler));
}

// ── 작은 입력 부품 ──

function textInput(value, { placeholder = '', max, onInput, inputmode, enterkeyhint } = {}) {
  const el = h('input', { type: 'text', class: 'input', value: str(value), placeholder, autocomplete: 'off', inputmode, enterkeyhint });
  if (max) el.maxLength = max * 2; // 한글 조합 중 잘리지 않게 넉넉히 — 실제 한도는 저장할 때 확인
  if (onInput) el.addEventListener('input', () => onInput(el.value));
  return el;
}

function textArea(value, { placeholder = '', rows = 3, onInput } = {}) {
  const el = h('textarea', { class: 'input textarea', placeholder });
  el.value = str(value);
  autoGrow(el, { min: rows });
  if (onInput) el.addEventListener('input', () => onInput(el.value));
  return el;
}

/** 분 입력 + '1시간 30분' 풀이 */
function minutesInput(value, onChange, label) {
  const input = h('input', { type: 'text', class: 'input input-num', inputmode: 'numeric', pattern: '[0-9]*', value: str(value), placeholder: '0', 'aria-label': `${label}(분)`, autocomplete: 'off' });
  const read = h('span', { class: 'unit-read', 'aria-hidden': 'true' });
  const upd = () => { const t = fmtMinutes(input.value); read.textContent = t && Number(input.value) >= 60 ? `= ${t}` : ''; };
  input.addEventListener('input', () => { upd(); onChange(input.value.trim()); });
  upd();
  return h('div', { class: 'with-unit' }, input, h('span', { class: 'unit', text: '분' }), read);
}

/** 남은 시간 (분:초) */
function remainingInput(sec, onChange) {
  const n = Number.isFinite(Number(sec)) && sec !== null && sec !== '' ? Math.round(Number(sec)) : null;
  const mm = h('input', { type: 'text', class: 'input input-num', inputmode: 'numeric', pattern: '[0-9]*', value: n === null ? '' : String(Math.floor(n / 60)), placeholder: '0', 'aria-label': '남은 시간 분', autocomplete: 'off' });
  const ss = h('input', { type: 'text', class: 'input input-num', inputmode: 'numeric', pattern: '[0-9]*', value: n === null ? '' : String(n % 60).padStart(2, '0'), placeholder: '00', 'aria-label': '남은 시간 초', autocomplete: 'off' });
  const emit = () => {
    const a = mm.value.trim();
    const b = ss.value.trim();
    if (!a && !b) { onChange(null); return; }
    const m = /^\d+$/.test(a || '0') ? Number(a || 0) : NaN;
    const s = /^\d+$/.test(b || '0') ? Number(b || 0) : NaN;
    onChange(Number.isFinite(m) && Number.isFinite(s) && s < 60 ? m * 60 + s : 'invalid');
  };
  mm.addEventListener('input', emit);
  ss.addEventListener('input', emit);
  return h('div', { class: 'with-unit' }, mm, h('span', { class: 'unit', text: '분' }), ss, h('span', { class: 'unit', text: '초' }));
}

/** 함께한 사람: 이름 칩 + 입력 (Enter·쉼표로 추가) + 자주 함께한 사람 제안 */
function peopleInput(list, onChange) {
  let names = [...list];
  const chips = h('div', { class: 'people-chips' });
  const input = h('input', { type: 'text', class: 'input people-input', placeholder: '이름 입력 후 Enter', autocomplete: 'off', enterkeyhint: 'enter', 'aria-label': '함께한 사람 이름' });
  const sugg = h('div', { class: 'people-sugg' });
  function add(raw) {
    const parts = String(raw).split(/[,，]/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    let changed = false;
    for (const n of parts) {
      if (names.length >= LIMITS.companions) { toast(`함께한 사람은 ${LIMITS.companions}명까지예요`, 'error'); break; }
      if ([...n].length > LIMITS.companion) { toast(`이름은 ${LIMITS.companion}자까지예요`, 'error'); continue; }
      if (names.some((x) => x.toLowerCase() === n.toLowerCase())) continue;
      names.push(n);
      changed = true;
    }
    if (changed) { paint(); onChange([...names]); }
  }
  function paint() {
    chips.replaceChildren(...names.map((n, i) => h('span', { class: 'pchip' },
      h('span', { text: n }),
      h('button', { type: 'button', class: 'pchip-x', 'aria-label': `${n} 빼기`, onClick: () => { names = names.filter((_, j) => j !== i); paint(); onChange([...names]); } }, icon('x')))));
    const known = repo.companions().filter((n) => !names.some((x) => x.toLowerCase() === n.toLowerCase())).slice(0, 8);
    sugg.replaceChildren(...known.map((n) => h('button', { type: 'button', class: 'chip', onClick: () => add(n) }, icon('plus'), h('span', { text: n }))));
    sugg.hidden = !known.length;
  }
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && !e.isComposing) {
      e.preventDefault();
      if (input.value.trim()) { add(input.value); input.value = ''; }
    } else if (e.key === 'Backspace' && !input.value && names.length) {
      names = names.slice(0, -1);
      paint();
      onChange([...names]);
    }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) { add(input.value); input.value = ''; } });
  paint();
  return h('div', { class: 'people-box' }, chips, input, sugg);
}

// ── 화면 ──

export function mount(root, ctx) {
  const editing = ctx.name === 'edit';
  const play = editing ? repo.getPlay(ctx.params[0]) : null;
  const origWork = play ? repo.getWork(play.workId) : null;
  if (editing && (!play || !origWork)) {
    root.append(appBar({ title: '기록 수정', back: '#/' }), h('div', { class: 'container narrow' },
      emptyState({ icon: 'ticket', title: '기록을 찾을 수 없어요', actions: [h('a', { class: 'btn btn-ghost', href: '#/' }, '처음 화면으로')] })));
    return {};
  }
  const presetWork = !editing && ctx.query.work ? repo.getWork(ctx.query.work) : null;
  // 초안은 폼을 연 곳마다 따로 (다른 곳에서 쓰던 초안을 덮어쓰거나 지우지 않게)
  const draftKey = editing ? `edit:${play.id}` : presetWork ? `new:work:${presetWork.id}` : 'new';
  const draft = prefs.getDraft(draftKey);
  let restored = false;
  let model;
  if (draft) {
    model = sanitize(draft.model);
    restored = true;
  } else if (editing) {
    model = modelFromPlay(play, origWork);
  } else {
    model = blankModel(ctx.query.genre || prefs.getLastGenre());
    if (presetWork) Object.assign(model, { genre: presetWork.genre, workId: presetWork.id, title: presetWork.title });
  }
  const initialJSON = JSON.stringify(editing ? modelFromPlay(play, origWork) : blankModel(model.genre));
  const added = new Set(); // 이번에 새로 저장한 사진 (그만두면 지움)
  let saving = false;
  let finished = false;
  const fields = {}; // 오류 표시용: 경로 → field 요소

  const isDirty = () => (editing ? JSON.stringify(model) !== initialJSON : hasContent(model));
  let draftTimer = 0;
  function changed() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 300);
  }
  function saveDraft() {
    if (finished) return;
    if (isDirty()) prefs.setDraft(draftKey, { model, savedAt: new Date().toISOString() });
    else prefs.clearDraft(draftKey);
  }

  // ── 장르 ──
  const genreSeg = segmented({
    options: GENRE_KEYS.map((k) => ({ key: k, label: GENRES[k].label, icon: GENRES[k].icon, cls: GENRES[k].cls })),
    value: model.genre, label: '장르', cls: 'seg-genre',
    onChange: (g) => { model.genre = g; setFieldError(fields.genre, ''); syncGenre(); changed(); },
  });
  fields.genre = field('장르', genreSeg, { cls: 'is-required' });

  // ── 제목 (기존 작품 제안 · 연결) ──
  const listId = nextId('sugg');
  const titleInput = h('input', {
    type: 'text', class: 'input input-title', id: nextId('title'), autocomplete: 'off', enterkeyhint: 'next',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
  });
  titleInput.maxLength = LIMITS.title * 2;
  titleInput.value = model.workId ? '' : model.title;
  const suggList = h('ul', { class: 'suggest', id: listId, role: 'listbox', 'aria-label': '기존 작품', hidden: true });
  const linkedBox = h('div', { class: 'linked', hidden: true });
  const titleHint = h('p', { class: 'field-hint' });
  const titleLabel = h('label', { class: 'field-label', htmlFor: titleInput.id });
  const titleErr = h('p', { class: 'field-error', role: 'alert', hidden: true });
  fields.title = h('div', { class: 'field is-required field-title' },
    h('div', { class: 'field-head' }, titleLabel),
    h('div', { class: 'title-box' }, titleInput, suggList, linkedBox),
    titleHint, titleErr);

  let sugg = [];
  let active = -1;
  function hideSuggest() {
    suggList.hidden = true;
    titleInput.setAttribute('aria-expanded', 'false');
    titleInput.removeAttribute('aria-activedescendant');
    active = -1;
  }
  function paintActive() {
    [...suggList.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) titleInput.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else titleInput.removeAttribute('aria-activedescendant');
  }
  function showSuggest() {
    const q = titleInput.value.trim();
    if (!q || model.workId) { hideSuggest(); return; }
    sugg = suggestWorks(repo.worksList(), repo.stats(), { genre: model.genre, q, limit: 6 });
    if (!sugg.length) { hideSuggest(); return; }
    const stats = repo.stats();
    suggList.replaceChildren(...sugg.map((w, i) => {
      const s = stats.get(w.id);
      const li = h('li', { class: 'suggest-item', role: 'option', id: `${listId}-${i}`, 'aria-selected': 'false' },
        genreIcon(w.genre, 'gicon-sm'),
        h('span', { class: 'suggest-text' },
          h('span', { class: 'suggest-title', text: workLabel(w) }),
          h('span', { class: 'suggest-sub', text: `${GENRES[w.genre].label} · ${s ? `${s.count}회 플레이 · 최근 ${fmtDate(s.latest.date, { weekday: false })}` : '기록 없음'}` })),
        h('span', { class: 'suggest-act', text: '이 작품에 추가' }));
      // 입력칸이 먼저 blur 되지 않게 mousedown 기본 동작을 막음
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => linkWork(w));
      return li;
    }));
    suggList.hidden = false;
    titleInput.setAttribute('aria-expanded', 'true');
    active = -1;
    paintActive();
  }
  titleInput.addEventListener('input', () => {
    model.title = titleInput.value;
    model.forceNew = false;
    setFieldError(fields.title, '');
    showSuggest();
    changed();
  });
  titleInput.addEventListener('keydown', (e) => {
    if (suggList.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(sugg.length - 1, active + 1); paintActive(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(-1, active - 1); paintActive(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0 && !e.isComposing) { linkWork(sugg[active]); e.preventDefault(); }
    else if (e.key === 'Escape') { hideSuggest(); e.preventDefault(); e.stopPropagation(); }
  });
  titleInput.addEventListener('blur', () => setTimeout(hideSuggest, 120));
  titleInput.addEventListener('focus', showSuggest);

  function linkWork(w) {
    model.workId = w.id;
    model.genre = w.genre;
    model.title = w.title;
    model.forceNew = false;
    hideSuggest();
    genreSeg.setValue(w.genre);
    setFieldError(fields.title, '');
    setFieldError(fields.genre, '');
    syncGenre();
    changed();
  }
  function unlink() {
    const w = repo.getWork(model.workId);
    model.workId = null;
    model.title = w ? w.title : model.title;
    titleInput.value = model.title;
    syncGenre();
    changed();
    titleInput.focus();
    titleInput.select();
  }
  function paintLinked() {
    const w = model.workId ? repo.getWork(model.workId) : null;
    linkedBox.hidden = !w;
    titleInput.hidden = !!w;
    if (!w) {
      linkedBox.replaceChildren();
      titleHint.textContent = editing && origWork
        ? '다른 작품을 고르거나 새 제목을 적으면 이 기록을 그 작품으로 옮겨요.'
        : '이미 기록한 작품이면 제안 목록에서 골라 주세요. 이름만 같은 작품은 자동으로 합치지 않아요.';
      return;
    }
    const s = repo.stats().get(w.id);
    const n = s ? s.count - (editing && play.workId === w.id ? 1 : 0) : 0;
    linkedBox.replaceChildren(
      genreIcon(w.genre, 'gicon-sm'),
      h('span', { class: 'linked-text' },
        h('span', { class: 'linked-title', text: workLabel(w) }),
        h('span', { class: 'linked-sub', text: editing && play.workId === w.id ? `지금 이 작품의 기록이에요${n ? ` · 다른 기록 ${n}개` : ''}` : `기존 작품에 기록 추가 · 지금까지 ${n}회 플레이` })),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost', onClick: unlink }, '변경'));
    titleHint.textContent = '작품 이름·매장을 고치려면 작품 화면의 ‘작품 정보 수정’을 써 주세요.';
  }

  // ── 방탈출 매장·지점 (새 작품일 때만 — 같은 테마명이라도 매장이 다르면 다른 작품) ──
  const storeInput = textInput(model.store, { placeholder: '예) 달빛방탈출', max: LIMITS.store, onInput: (v) => { model.store = v; changed(); } });
  const branchInput = textInput(model.branch, { placeholder: '예) 강남점', max: LIMITS.branch, onInput: (v) => { model.branch = v; changed(); } });
  storeInput.setAttribute('aria-label', '매장');
  branchInput.setAttribute('aria-label', '지점');
  fields.store = h('div', { class: 'field field-place' },
    h('div', { class: 'field-head' }, h('span', { class: 'field-label' }, '매장 · 지점', h('span', { class: 'field-opt', text: ' 선택' }))),
    h('div', { class: 'two' }, storeInput, branchInput),
    h('p', { class: 'field-hint', text: '같은 테마명이라도 매장·지점이 다르면 다른 작품으로 모아요.' }),
    h('p', { class: 'field-error', role: 'alert', hidden: true }));
  fields.branch = fields.store;

  // ── 날짜 ──
  const dateInput = h('input', { type: 'date', class: 'input input-date', value: model.date, min: '1900-01-01', max: '2100-12-31', required: true });
  const setDate = (v) => { model.date = v; dateInput.value = v; setFieldError(fields.date, ''); paintQuick(); changed(); };
  dateInput.addEventListener('input', () => setDate(dateInput.value));
  dateInput.addEventListener('change', () => setDate(dateInput.value));
  const quick = [['오늘', todayStr], ['어제', yesterdayStr]].map(([label, fn]) => {
    const b = h('button', { type: 'button', class: 'chip chip-sm' }, label);
    b.addEventListener('click', () => setDate(fn()));
    b.dateFn = fn;
    return b;
  });
  function paintQuick() { for (const b of quick) b.setAttribute('aria-pressed', String(model.date === b.dateFn())); }
  paintQuick();
  fields.date = field('플레이 날짜', dateInput, { cls: 'is-required field-date' });
  dateInput.after(h('div', { class: 'date-quick' }, quick));

  // ── 평점 ──
  const ratingId = nextId('rating');
  const rating = ratingInput({ value: model.rating, label: '평점', id: ratingId, onChange: (v) => { model.rating = v; changed(); } });
  fields.rating = field('평점', rating, { optional: true, hint: '별을 누르거나 끌어서 0.5점 단위로. 다시 누르면 미평가예요.' });

  // ── 한 줄 감상 ──
  const oneLiner = textInput(model.oneLiner, { placeholder: '스포일러 없이 한 줄로', max: LIMITS.oneLiner, enterkeyhint: 'done', onInput: (v) => { model.oneLiner = v; setFieldError(fields.oneLiner, ''); changed(); } });
  fields.oneLiner = field('한 줄 감상', oneLiner, { optional: true, counter: counterFor(oneLiner, LIMITS.oneLiner), hint: '목록 카드에 보여요.' });

  // ── 사진 ──
  const photos = photoField({
    ids: model.photos,
    label: '사진',
    onChange: (ids) => { model.photos = ids; setFieldError(fields.photos, ''); changed(); },
    onAdded: (id) => added.add(id),
  });
  fields.photos = field('표지·사진', photos, { optional: true, hint: `첫 장이 카드 표지가 돼요 (${LIMITS.photos}장까지). 기기 안에서 줄이고 위치 정보는 지워요.` });

  // ── 추가 기록 ──
  const genreBox = h('div', { class: 'genre-box' });
  const spoilerBox = h('div', { class: 'spoiler-box' });
  function buildExtra() {
    const people = peopleInput(model.companions, (list) => { model.companions = list; changed(); });
    fields.companions = field('함께한 사람', people, { optional: true });
    const review = textArea(model.review, { placeholder: '어땠는지 자유롭게 (스포일러 없이)', rows: 4, onInput: (v) => { model.review = v; setFieldError(fields.review, ''); changed(); } });
    fields.review = field('상세 후기', review, { optional: true, counter: counterFor(review, LIMITS.review), hint: '범인·결말·풀이 같은 스포일러는 아래 ‘스포일러 메모’에 적어 주세요.' });
    renderGenreBox();
    renderSpoilerBox();
    return h('div', { class: 'extra' }, fields.companions, fields.review, genreBox, spoilerBox);
  }

  const d = () => model.details;
  function renderGenreBox() {
    const g = model.genre;
    if (!g) {
      genreBox.replaceChildren(h('p', { class: 'form-note', text: '장르를 고르면 장르별 항목이 나와요.' }));
      return;
    }
    const setD = (k) => (v) => { d()[k] = v; setFieldError(fields[`details.${k}`], ''); changed(); };
    const rows = [];
    if (g === 'boardgame') {
      fields['details.players'] = field('플레이 인원', stepper({ value: d().players ?? null, min: 1, max: 99, label: '플레이 인원', unit: '명', onChange: setD('players') }), { optional: true });
      fields['details.durationMin'] = field('플레이 시간', minutesInput(d().durationMin, setD('durationMin'), '플레이 시간'), { optional: true });
      const exp = textInput(d().expansions, { placeholder: '예) 프렐류드, 식민지', max: LIMITS.expansions, onInput: setD('expansions') });
      fields['details.expansions'] = field('사용한 확장', exp, { optional: true });
      const score = textInput(d().myScore, { placeholder: '예) 86', inputmode: 'decimal', onInput: setD('myScore') });
      fields['details.myScore'] = field('내 점수', h('div', { class: 'with-unit' }, score, h('span', { class: 'unit', text: '점' })), { optional: true });
      fields['details.myRank'] = field('내 순위', stepper({ value: d().myRank ?? null, min: 1, max: 99, label: '내 순위', unit: '위', onChange: setD('myRank') }), { optional: true });
      rows.push(h('div', { class: 'grid2' }, fields['details.players'], fields['details.durationMin']),
        h('div', { class: 'grid2' }, fields['details.myScore'], fields['details.myRank']),
        fields['details.expansions']);
    } else if (g === 'murdermystery') {
      fields['details.format'] = field('플레이 방식', segmented({ options: MM_FORMATS, value: d().format || null, label: '플레이 방식', allowNone: true, onChange: setD('format') }), { optional: true });
      fields['details.durationMin'] = field('플레이 시간', minutesInput(d().durationMin, setD('durationMin'), '플레이 시간'), { optional: true });
      fields['details.story'] = field('스토리', ratingInput({ value: d().story ?? null, label: '스토리', size: 'sm', onChange: setD('story') }), { optional: true });
      fields['details.immersion'] = field('몰입도', ratingInput({ value: d().immersion ?? null, label: '몰입도', size: 'sm', onChange: setD('immersion') }), { optional: true });
      const imp = textArea(d().impression, { placeholder: '이야기와 몰입감은 어땠나요? (스포일러 없이)', rows: 2, onInput: setD('impression') });
      fields['details.impression'] = field('스토리·몰입 감상', imp, { optional: true, counter: counterFor(imp, LIMITS.impression) });
      rows.push(fields['details.format'], fields['details.durationMin'],
        h('div', { class: 'grid2' }, fields['details.story'], fields['details.immersion']),
        fields['details.impression']);
    } else if (g === 'escaperoom') {
      const remain = remainingInput(d().remainingSec, setD('remainingSec'));
      fields['details.remainingSec'] = field('남은 시간', remain, { optional: true });
      fields['details.result'] = field('탈출 결과', segmented({
        options: ER_RESULTS, value: d().result || null, label: '탈출 결과', allowNone: true, cls: 'seg-result',
        onChange: (v) => {
          setD('result')(v);
          fields['details.remainingSec'].hidden = v === 'fail';
          if (v === 'fail' && d().remainingSec === 'invalid') d().remainingSec = null;
        },
      }), { optional: true });
      fields['details.remainingSec'].hidden = d().result === 'fail';
      fields['details.hints'] = field('힌트 수', stepper({ value: d().hints ?? null, min: 0, max: 99, label: '힌트 수', unit: '개', onChange: setD('hints') }), { optional: true });
      fields['details.difficulty'] = field('체감 난이도', levelPicker({ value: d().difficulty ?? null, label: '체감 난이도', kind: 'difficulty', onChange: setD('difficulty') }), { optional: true });
      fields['details.fear'] = field('공포도', levelPicker({ value: d().fear ?? null, label: '공포도', kind: 'fear', onChange: setD('fear') }), { optional: true });
      rows.push(fields['details.result'], h('div', { class: 'grid2' }, fields['details.remainingSec'], fields['details.hints']),
        fields['details.difficulty'], fields['details.fear']);
    }
    genreBox.replaceChildren(h('section', { class: 'form-group' },
      h('h3', { class: 'form-group-title' }, genreIcon(g, 'gicon-sm'), h('span', { text: GENRES[g].section })),
      rows));
  }

  let spoilerFold = null;
  function renderSpoilerBox() {
    const g = model.genre;
    const sp = model.spoiler;
    const names = g === 'murdermystery' ? '맡은 역할 · 범인 · 결말' : g === 'escaperoom' ? '문제·풀이' : '스포일러가 있는 메모';
    const has = g ? hasSpoiler({ spoiler: sp }, g) : !!sp.memo;
    spoilerFold = fold({
      label: '스포일러 메모',
      sub: `${names}${has ? ' · 적은 내용 있음' : ''}`,
      icon: 'eyeOff',
      cls: 'spoiler-zone',
      build: () => {
        const setS = (k) => (v) => { sp[k] = v; setFieldError(fields[`spoiler.${k}`], ''); changed(); };
        const parts = [h('p', { class: 'form-note' }, icon('lock'), h('span', { text: '상세 화면에서 접힌 채로 보여요. 목록 카드와 검색 결과에는 나오지 않아요. (화면에서 가리는 기능이고 암호화는 아니에요)' }))];
        if (g === 'murdermystery') {
          fields['spoiler.role'] = field('맡은 역할', textInput(sp.role, { placeholder: '예) 집사 로웰', max: LIMITS.role, onInput: setS('role') }), { optional: true });
          fields['spoiler.culprit'] = field('범인', textInput(sp.culprit, { placeholder: '범인은 누구였나요?', max: LIMITS.culprit, onInput: setS('culprit') }), { optional: true });
          fields['spoiler.ending'] = field('결말', textArea(sp.ending, { placeholder: '결말과 반전', rows: 2, onInput: setS('ending') }), { optional: true });
          parts.push(h('div', { class: 'grid2' }, fields['spoiler.role'], fields['spoiler.culprit']), fields['spoiler.ending']);
        } else if (g === 'escaperoom') {
          fields['spoiler.puzzles'] = field('문제·풀이 메모', textArea(sp.puzzles, { placeholder: '기억에 남는 문제와 풀이', rows: 3, onInput: setS('puzzles') }), { optional: true });
          parts.push(fields['spoiler.puzzles']);
        }
        fields['spoiler.memo'] = field(g === 'murdermystery' || g === 'escaperoom' ? '그 밖의 스포일러 메모' : '스포일러 메모', textArea(sp.memo, { placeholder: '다음에 할 사람에게는 비밀인 이야기', rows: 2, onInput: setS('memo') }), { optional: true });
        parts.push(fields['spoiler.memo']);
        return h('div', { class: 'spoiler-fields' }, parts);
      },
    });
    spoilerBox.replaceChildren(spoilerFold);
  }

  const extraSub = () => {
    const g = GENRES[model.genre];
    return `함께한 사람 · 상세 후기 · ${g ? `${g.label} 항목` : '장르별 항목'} · 스포일러 메모`;
  };
  const extraOpen = editing ? hasExtra(play, origWork.genre) : restored && (model.review || model.companions.length || Object.keys(model.details).length || Object.keys(model.spoiler).length);
  const extra = fold({ label: '추가 기록', sub: extraSub, icon: 'plus', cls: 'extra-fold', open: !!extraOpen, build: buildExtra });

  // ── 장르가 바뀌면: 제목 라벨·매장 칸·장르별 항목 ──
  function syncGenre() {
    const g = GENRES[model.genre];
    // 장르 색 포인트(난이도 점 등)를 폼 안에서도 쓰도록
    if (model.genre) form.dataset.genre = model.genre;
    else delete form.dataset.genre;
    titleLabel.textContent = g ? g.titleLabel : '제목';
    titleInput.placeholder = g ? g.titlePlaceholder : '먼저 장르를 고르면 편해요';
    genreSeg.setDisabled(!!model.workId);
    fields.store.hidden = model.genre !== 'escaperoom' || !!model.workId;
    paintLinked();
    extra.setSub(extraSub);
    if (extra.isBuilt()) {
      renderGenreBox();
      const wasOpen = spoilerFold && spoilerFold.isOpen();
      renderSpoilerBox();
      if (wasOpen) spoilerFold.setOpen(true);
    }
  }

  // ── 저장 · 취소 ──
  const saveTop = h('button', { type: 'button', class: 'btn btn-primary btn-save', onClick: () => save() }, h('span', { text: '저장' }));
  const saveBottom = h('button', { type: 'submit', class: 'btn btn-primary btn-block btn-save' }, icon('check'), h('span', { text: editing ? '고친 내용 저장' : '기록 저장' }));
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => leave() }, '취소');

  function showErrors(errors) {
    let first = null;
    for (const [path, msg] of Object.entries(errors)) {
      const inExtra = path.startsWith('details.') || path.startsWith('spoiler.') || path === 'companions' || path === 'review';
      if (inExtra) extra.setOpen(true);
      if (path.startsWith('spoiler.') && spoilerFold) spoilerFold.setOpen(true);
      let el = fields[path];
      if (path === 'workId' || (path === 'genre' && model.workId)) el = fields.title;
      if (!el) el = fields.title;
      setFieldError(el, msg);
      if (!first) first = el;
    }
    if (first) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const focusable = first.querySelector('input:not([hidden]):not(.seg-input), textarea, [role="slider"], .seg-input');
      if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), 250);
    }
    toast('입력한 내용을 확인해 주세요', 'error');
  }

  async function askSameTitle() {
    const cands = sameTitleWorks(repo.worksList(), model.genre, model.title);
    if (!cands.length) return 'new';
    const stats = repo.stats();
    const samePlace = (w) => model.genre === 'escaperoom' && (w.store || '') === model.store.trim() && (w.branch || '') === model.branch.trim();
    cands.sort((a, b) => Number(samePlace(b)) - Number(samePlace(a)));
    const items = cands.map((w) => {
      const s = stats.get(w.id);
      return {
        value: w.id, icon: 'link',
        label: `기존 작품에 추가 — ${workLabel(w)}`,
        desc: `${s ? `${s.count}회 플레이 · 최근 ${fmtDate(s.latest.date)}` : ''}${samePlace(w) ? ' · 매장·지점 같음' : ''}`,
      };
    });
    items.push({ value: '__new', icon: 'plus', label: '새 작품으로 저장', desc: model.genre === 'escaperoom' ? '다른 매장의 같은 이름 테마처럼, 이름만 같은 다른 작품' : '이름만 같은 다른 작품' });
    const v = await choiceSheet('같은 이름의 작품이 있어요', items, { text: '같은 작품이면 기존 작품에 기록을 더하고, 다른 작품이면 새로 만들어요. 자동으로 합치지 않아요.' });
    return v;
  }

  async function save() {
    if (saving) return;
    if (photos.isBusy()) { toast('사진을 저장하는 중이에요. 잠시 뒤에 다시 눌러 주세요', 'info'); return; }
    const errs = {};
    if (!model.workId && !model.genre) errs.genre = '장르를 골라 주세요';
    if (!model.workId && !model.title.trim()) errs.title = '제목을 적어 주세요';
    if (!isValidDate(model.date)) errs.date = '플레이 날짜를 골라 주세요';
    if (model.genre === 'escaperoom' && model.details.result !== 'fail' && model.details.remainingSec === 'invalid') errs['details.remainingSec'] = '남은 시간을 분·초 숫자로 적어 주세요 (초는 0~59)';
    if (Object.keys(errs).length) { showErrors(errs); return; }

    saving = true;
    for (const b of [saveTop, saveBottom]) b.disabled = true;
    try {
      if (!model.workId && !model.forceNew) {
        const v = await askSameTitle();
        if (v === null) return; // 취소
        if (v === '__new') model.forceNew = true;
        else if (v !== 'new') {
          const w = repo.getWork(v);
          if (w) linkWork(w);
        }
      }
      const input = {
        id: play ? play.id : undefined,
        workId: model.workId,
        date: model.date,
        rating: model.rating,
        oneLiner: model.oneLiner,
        review: model.review,
        companions: model.companions,
        photos: model.photos,
        details: model.details,
        spoiler: model.spoiler,
      };
      const newWork = model.workId ? null : { genre: model.genre, title: model.title, store: model.store, branch: model.branch };
      const firstReal = repo.realCount() === 0;
      const r = await repo.savePlay(input, { newWork });
      finished = true;
      clearTimeout(draftTimer);
      prefs.clearDraft(draftKey);
      prefs.setLastGenre(r.work.genre);
      // 이번에 올렸다가 뺀 사진 정리
      const leftover = [...added].filter((id) => !r.play.photos.includes(id));
      if (leftover.length) repo.discardImages(leftover).catch(() => {});
      markJustSaved(r.play.id);
      // 수정: 상세에서 왔으면 그 화면으로 돌아감 (같은 상세가 history 에 두 번 쌓이지 않게)
      if (editing) returnTo(`#/play/${encodeURIComponent(r.play.id)}`);
      else navigate(`#/play/${encodeURIComponent(r.play.id)}`, { replace: true });
      toast(editing ? '기록을 고쳤어요' : '기록했어요', 'ok');
      if (r.removedWorkId) toast('기록이 없어진 작품은 정리했어요', 'info', 3200);
      // 첫 기록: 브라우저가 공간이 모자랄 때 이 사이트 데이터를 먼저 지우지 않도록 요청
      if (firstReal && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) {
      if (e && e.errors) showErrors(e.errors);
      else toast(e && e.code === 'quota' ? '이 브라우저의 저장 공간이 부족해요' : '저장하지 못했어요. 다시 시도해 주세요', 'error', 4000);
    } finally {
      saving = false;
      for (const b of [saveTop, saveBottom]) b.disabled = false;
    }
  }

  async function discardAll() {
    finished = true;
    clearTimeout(draftTimer);
    prefs.clearDraft(draftKey);
    // 저장된 기록이 쓰는 사진은 repo 가 남기므로, 폼에 있던 사진을 모두 넘겨도 안전
    const ids = [...added, ...model.photos];
    if (ids.length) await repo.discardImages(ids).catch(() => {});
  }

  async function leave() {
    const back = editing ? `#/play/${encodeURIComponent(play.id)}` : (presetWork ? `#/work/${encodeURIComponent(presetWork.id)}` : '#/');
    if (!isDirty()) { await discardAll(); goBack(back); return; }
    const v = await openDialog({
      title: editing ? '고친 내용을 버릴까요?' : '작성을 그만둘까요?',
      body: h('p', { class: 'dlg-text', text: editing ? '저장하지 않은 수정 내용이 있어요.' : `지금까지 쓴 내용은 이 기기에 임시로 남겨 둘 수 있어요. 다음에 ${presetWork ? '이 작품 화면에서 ‘플레이 기록 추가’를' : '‘새 기록’을'} 누르면 이어서 써요.` }),
      actions: editing
        ? [{ label: '계속 고치기', value: 'stay', kind: 'ghost' }, { label: '버리기', value: 'discard', kind: 'danger' }]
        : [{ label: '계속 쓰기', value: 'stay', kind: 'ghost' }, { label: '임시 저장하고 나가기', value: 'keep', kind: 'ghost' }, { label: '버리기', value: 'discard', kind: 'danger' }],
    });
    if (v === 'discard') { await discardAll(); goBack(back); }
    else if (v === 'keep') { saveDraft(); finished = true; goBack(back); }
  }

  async function restart() {
    await discardAll();
    const again = editing ? `#/play/${encodeURIComponent(play.id)}/edit` : presetWork ? `#/new?work=${encodeURIComponent(presetWork.id)}` : '#/new';
    navigate(again, { replace: true });
  }

  // ── 조립 ──
  const form = h('form', { class: 'form', novalidate: true },
    restored ? h('div', { class: 'form-restored' }, icon('info'),
      h('span', { text: editing ? '고치던 내용을 불러왔어요.' : '작성하던 기록을 불러왔어요.' }),
      h('button', { type: 'button', class: 'link-btn', onClick: restart }, editing ? '원래대로' : '처음부터 다시')) : null,
    h('section', { class: 'form-card' }, fields.genre, fields.title, fields.store, fields.date, fields.rating, fields.oneLiner, fields.photos),
    extra,
    h('div', { class: 'form-actions' }, cancelBtn, saveBottom));
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  // Enter 로 폼이 저장되지 않게 (입력 칸에서 Enter 는 다음 칸으로)
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'submit' && !e.isComposing) {
      if (e.target === titleInput && !suggList.hidden && active >= 0) return;
      e.preventDefault();
    }
  });
  // 붙여넣은 사진
  form.addEventListener('paste', (e) => {
    const files = e.clipboardData ? [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')) : [];
    if (files.length) { e.preventDefault(); photos.addFiles(files); }
  });

  const bar = h('header', { class: 'appbar form-bar' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫기', onClick: () => leave() }, icon('x')),
    h('h1', { class: 'appbar-title', text: editing ? '기록 수정' : '새 기록' }),
    h('div', { class: 'appbar-actions' }, saveTop));
  root.append(bar, h('div', { class: 'container narrow form-wrap' }, form));
  syncGenre();
  if (!editing && !restored && !presetWork) {
    // 첫 칸으로 바로: 장르를 이미 골랐으면 제목, 아니면 그대로(장르부터)
    if (model.genre) setTimeout(() => titleInput.focus({ preventScroll: true }), 50);
  }

  return {
    destroy() {
      clearTimeout(draftTimer);
      // 화면을 떠나도(뒤로가기 등) 쓰던 내용은 초안으로 남김 → 다시 열면 이어 쓰기
      if (!finished) saveDraft();
    },
  };
}
