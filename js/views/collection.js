// 소장 — 등록한 게임과 '내 소장'으로 남긴 보드게임·머미를 게임별로 모아 보기 (+ 대여한 게임)
// 게임 등록: 기록을 쓰지 않고 가지고 있는 게임 이름만 소장 목록에 올림
import { h, icon, starShape } from '../dom.js';
import { TYPES, LIMITS } from '../constants.js';
import { state, isFirstLoad, loadFailed, recordsSorted, upsertGame, removeGame } from '../store.js';
import { collectionOf } from '../stats.js';
import { fmtDateDot, todayStr, nameKey, codePoints } from '../format.js';
import * as api from '../api.js';
import { navigate } from '../nav.js';
import { segmented, typeBadge, emptyState, loadingState, loadErrorState, openDialog, confirmDialog, toast, nextId } from '../ui.js';
import { sectionHead } from './bits.js';
import { cardPhoto } from './photos.js';

const KINDS = ['boardgame', 'murdermystery'];

// 화면을 떠났다 돌아와도 고른 종류·정렬 유지
const view = { type: 'all', sort: 'recent' };
// 게임 등록 창에서 마지막으로 고른 종류 (이어서 여러 개 넣을 때 다시 고르지 않게)
let lastType = 'boardgame';

const SORTS = [
  ['recent', '최근 순'],
  ['plays', '많이 한 순'],
  ['rating', '별점순'],
  ['name', '이름순'],
];

/** 등록한 날 (이 기기 시간대 기준 YYYY-MM-DD, 없으면 '') */
function addedOn(g) {
  const t = g.addedAt ? Date.parse(g.addedAt) : NaN;
  return Number.isFinite(t) ? todayStr(new Date(t)) : '';
}

/** 최근 순 기준: 마지막으로 한 날과 등록한 날 중 늦은 날 (방금 등록한 게임이 위에 오게) */
function activity(g) {
  const added = addedOn(g);
  return g.lastDate > added ? g.lastDate : added;
}

function sorted(games) {
  const list = [...games];
  // 같은 값이면 collectionOf 순서(최근에 한 순 → 안 해 본 게임은 최근 등록 순)를 그대로 둠 (안정 정렬)
  if (view.sort === 'recent') list.sort((a, b) => activity(b).localeCompare(activity(a)));
  else if (view.sort === 'plays') list.sort((a, b) => b.plays - a.plays || activity(b).localeCompare(activity(a)));
  else if (view.sort === 'rating') list.sort((a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1) || b.plays - a.plays);
  else if (view.sort === 'name') list.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  return list;
}

/** 그 게임의 기록만 모아 보는 목록 주소 */
const gameHref = (g) => `#/records?type=${g.type}&title=${encodeURIComponent(g.title)}`;

const kindLabel = (type) => (type === 'murdermystery' ? '머미 (보드게임형)' : TYPES[type].label);

// ── 게임 등록 · 수정 ──

/** 이 종류에서 기록한 적은 있지만 아직 소장 목록에 없는 제목 (등록할 때 고르기 쉽게) */
function suggestTitles(type) {
  const owned = new Set(collectionOf(state.records, state.games).owned.filter((g) => g.type === type).map((g) => nameKey(g.title)));
  const seen = new Set();
  const out = [];
  for (const r of recordsSorted()) {
    if (r.type !== type || !r.title) continue;
    // 머미는 집에서 하는 보드게임형만 가지고 있을 수 있음
    if (type === 'murdermystery' && !(r.mm && r.mm.format === 'box')) continue;
    const k = nameKey(r.title);
    if (!k || seen.has(k) || owned.has(k)) continue;
    seen.add(k);
    out.push(r.title.trim());
  }
  return out.slice(0, 80);
}

/**
 * 소장 게임 등록(game 없음)·수정 창. 새로 등록할 때는 '계속 등록'으로 창을 닫지 않고 여러 개를 이어서 넣을 수 있음
 * @returns {Promise<object|null>} 마지막으로 저장한 게임
 */
export async function openGameEditor(game = null, { type: startType } = {}) {
  const isNew = !game;
  let type = game ? game.type : (KINDS.includes(startType) ? startType : lastType);
  let saved = null;
  let savedCount = 0;
  const added = []; // '계속 등록'으로 이번에 넣은 이름

  const listId = nextId('gtitles');
  const datalist = h('datalist', { id: listId });
  const titleIn = h('input', {
    type: 'text', class: 'input input-title', maxlength: String(LIMITS.title), value: game ? game.title : '',
    autocomplete: 'off', enterkeyhint: 'done', list: listId, id: nextId('gtitle'), 'data-field': 'game-title',
  });
  const memoIn = h('input', {
    type: 'text', class: 'input', maxlength: String(LIMITS.gameMemo), value: game ? game.memo || '' : '',
    placeholder: '예) 확장 포함, 2~4인', autocomplete: 'off', enterkeyhint: 'done', id: nextId('gmemo'), 'data-field': 'game-memo',
  });
  const titleLabel = h('label', { class: 'field-label', htmlFor: titleIn.id });
  const err = h('p', { class: 'form-err', role: 'alert' });
  const addedLine = h('p', { class: 'gform-added', hidden: true, role: 'status' });

  function paintType() {
    titleLabel.textContent = TYPES[type].titleLabel;
    titleIn.placeholder = TYPES[type].titlePlaceholder;
    datalist.replaceChildren(...suggestTitles(type).map((x) => h('option', { value: x })));
  }
  paintType();
  const clearErr = () => { err.textContent = ''; titleIn.removeAttribute('aria-invalid'); };
  titleIn.addEventListener('input', clearErr);
  memoIn.addEventListener('input', clearErr);

  const body = h('div', { class: 'gform' },
    h('p', { class: 'gform-lead', text: isNew ? '기록 없이 가지고 있는 게임만 소장 목록에 올려요.' : '이름을 바꿔도 지난 기록은 그대로예요.' }),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: '종류' }),
      segmented({
        label: '종류', value: type, cls: 'seg-type',
        options: KINDS.map((k) => ({ key: k, label: kindLabel(k), cls: TYPES[k].cls })),
        onChange: (v) => { type = v; paintType(); clearErr(); },
      })),
    h('div', { class: 'field' }, titleLabel, titleIn, datalist),
    h('div', { class: 'field' }, h('label', { class: 'field-label', htmlFor: memoIn.id, text: '메모 (선택)' }), memoIn),
    err,
    addedLine);

  const fail = (msg, el = titleIn) => {
    err.textContent = msg;
    if (el === titleIn) titleIn.setAttribute('aria-invalid', 'true');
    el.focus();
    return false;
  };

  /** 저장. 성공하면 true */
  async function save() {
    const title = titleIn.value.trim().replace(/\s+/g, ' ');
    const memo = memoIn.value.trim();
    if (!title) return fail(`${TYPES[type].titleLabel}을 적어 주세요`);
    if (codePoints(title).length > LIMITS.title) return fail(`이름은 ${LIMITS.title}자까지예요`);
    if (codePoints(memo).length > LIMITS.gameMemo) return fail(`메모는 ${LIMITS.gameMemo}자까지예요`, memoIn);
    const id = game ? game.id : null;
    if (state.games.some((g) => g.id !== id && g.type === type && nameKey(g.title) === nameKey(title))) {
      return fail('이미 등록한 게임이에요');
    }
    try {
      const res = await api.saveGame({ ...(id ? { id } : {}), type, title, memo });
      saved = res.game;
      savedCount++;
      upsertGame(saved);
      lastType = type;
      return true;
    } catch (e) {
      const f = e.code === 'invalid' && e.data ? e.data.field : null;
      if (f === 'title' && e.data.reason === 'duplicate') {
        if (e.data.current) upsertGame(e.data.current); // 다른 기기에서 먼저 등록함 → 목록에도 보이게
        return fail('이미 등록한 게임이에요');
      }
      if (f === 'title') return fail('이름을 확인해 주세요');
      if (f === 'memo') return fail(`메모는 ${LIMITS.gameMemo}자까지예요`, memoIn);
      if (e.code === 'limit') return fail('소장 게임은 1,000개까지 등록할 수 있어요');
      if (e.code === 'not_found') return fail('이미 삭제된 게임이에요');
      return fail(api.errorMessage(e, '저장'));
    }
  }

  /** '계속 등록': 저장한 뒤 칸을 비우고 다음 게임을 기다림 */
  async function saveAndNext() {
    if (!(await save())) return false;
    added.push(saved.title);
    const shown = added.slice(-3).map((x) => `‘${x}’`).join(', ');
    addedLine.textContent = `등록했어요: ${added.length > 3 ? `${shown} 외 ${added.length - 3}개` : shown} · 이어서 적어 주세요`;
    addedLine.hidden = false;
    titleIn.value = '';
    memoIn.value = '';
    paintType(); // 방금 넣은 이름은 추천에서 뺌
    titleIn.focus();
    return false;
  }

  const actions = isNew
    ? [
      { label: '닫기', value: null, kind: 'ghost' },
      { label: '계속 등록', value: 'more', kind: 'soft', handler: saveAndNext },
      // 이어서 넣다가 빈 칸으로 누르면 그냥 닫음
      { label: '등록', value: 'ok', kind: 'primary', handler: () => (added.length && !titleIn.value.trim() && !memoIn.value.trim() ? true : save()) },
    ]
    : [
      { label: '취소', value: null, kind: 'ghost' },
      { label: '저장', value: 'ok', kind: 'primary', handler: save },
    ];

  const v = await openDialog({
    title: isNew ? '소장 게임 등록' : '소장 게임 수정',
    body,
    cls: 'dlg-game-form',
    actions,
    onOpen: (dlg) => {
      // Enter = 등록/저장 (한글 조합 중 Enter 는 글자를 마무리할 뿐이라 무시)
      const primary = dlg.querySelector('.dlg-actions .btn-primary');
      for (const el of [titleIn, memoIn]) {
        el.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          if (primary && !primary.disabled) primary.click();
        });
      }
      if (isNew) titleIn.focus();
    },
  });
  if (!isNew) {
    if (v === 'ok') toast('소장 게임을 고쳤어요', 'ok');
  } else {
    if (savedCount > 1) toast(`소장 게임 ${savedCount}개를 등록했어요`, 'ok');
    else if (savedCount === 1) toast(`‘${saved.title}’ 소장에 등록했어요`, 'ok');
  }
  return saved;
}

/** 소장에서 빼기 (등록만 지움 — 기록은 그대로) */
async function removeFromCollection(g) {
  const ok = await confirmDialog('이 게임을 소장에서 뺄까요?',
    `‘${g.title}’ 등록만 지워요. 이 게임으로 쓴 기록은 그대로 남아요.`, { ok: '빼기', danger: true });
  if (!ok) return;
  try {
    await api.deleteGame(g.gameId);
  } catch (e) {
    if (e.code !== 'not_found') { toast(api.errorMessage(e, '삭제'), 'error'); return; }
  }
  removeGame(g.gameId);
  // '내 소장'으로 남긴 기록이 있으면 목록에는 계속 보임
  const still = collectionOf(state.records, state.games).owned.some((x) => x.key === g.key);
  toast(still ? '소장 등록을 지웠어요. ‘내 소장’으로 남긴 기록이 있어서 목록에는 계속 보여요' : '소장에서 뺐어요', 'ok', still ? 4500 : 2800);
}

/** 등록한 게임의 메뉴: 기록 보기 · 기록 쓰기 · 고치기 · 소장에서 빼기 */
async function openGameMenu(g) {
  let close = () => {};
  const item = (value, ic, label, cls = '') => h('button', { type: 'button', class: ['gmenu-item', cls], onClick: () => close(value) },
    icon(ic), h('span', { text: label }), icon('chevron', 'gmenu-go'));
  const stat = g.plays
    ? `${g.plays}번 했어요 · 최근 ${fmtDateDot(g.lastDate)}${g.avgRating ? ` · 평균 ★ ${g.avgRating.toFixed(1)}` : ''}`
    : `아직 안 해 봤어요${addedOn(g) ? ` · ${fmtDateDot(addedOn(g))} 등록` : ''}`;
  const body = h('div', { class: 'gmenu' },
    h('div', { class: 'gmenu-info' }, typeBadge(g.type), h('p', { class: 'gmenu-stat', text: stat })),
    g.memo ? h('p', { class: 'gmenu-memo', text: g.memo }) : null,
    h('div', { class: 'gmenu-list' },
      g.plays ? item('records', 'book', `기록 ${g.plays}개 보기`) : null,
      item('write', 'plus', '이 게임으로 새 기록 쓰기'),
      g.gameId ? item('edit', 'edit', '이름·메모 고치기') : null,
      g.gameId ? item('remove', 'trash', '소장에서 빼기', 'is-danger') : null));
  const v = await openDialog({
    title: g.title, body, cls: 'dlg-game',
    bind: (c) => { close = c; },
    actions: [{ label: '닫기', value: null, kind: 'ghost' }],
  });
  if (v === 'records') navigate(gameHref(g));
  else if (v === 'write') navigate(`#/new/${g.type}?title=${encodeURIComponent(g.title)}&own=1`);
  else if (v === 'edit') {
    const reg = state.games.find((x) => x.id === g.gameId);
    if (reg) await openGameEditor(reg);
  } else if (v === 'remove') await removeFromCollection(g);
}

// ── 목록 ──

function gameCard(g) {
  const t = TYPES[g.type];
  const photo = g.cover ? cardPhoto({ photos: [g.cover] }) : null;
  const added = addedOn(g);
  // 해 본 게임은 그 게임 기록으로, 아직 안 해 본 등록 게임은 메뉴로
  const main = g.plays
    ? h('a', { class: 'card-link', href: gameHref(g), 'aria-label': `${g.title}, ${t.short}, ${g.plays}번 했어요` }, g.title)
    : h('button', { type: 'button', class: 'card-link', 'aria-label': `${g.title}, ${t.short}, 아직 안 해 봤어요`, onClick: () => openGameMenu(g) }, g.title);
  const rating = g.avgRating
    ? h('span', { class: 'gcard-rating', role: 'img', 'aria-label': `평균 별점 ${g.avgRating.toFixed(1)}점` },
      starShape('rcard-star'), h('span', { text: g.avgRating.toFixed(1) }))
    : null;
  const more = g.gameId
    ? h('button', { type: 'button', class: 'icon-btn gcard-more', 'aria-label': `${g.title} 메뉴`, onClick: () => openGameMenu(g) }, icon('more'))
    : null;
  return h('li', { class: ['gcard', t.cls, g.plays ? null : 'is-unplayed'], dataset: g.gameId ? { gameId: g.gameId } : {} },
    h('div', { class: 'gcard-thumb', 'aria-hidden': 'true' },
      photo || h('span', { class: 'rcard-noimg' }, icon(t.icon))),
    h('div', { class: 'gcard-body' },
      h('div', { class: 'gcard-top' }, typeBadge(g.type)),
      h('h3', { class: 'gcard-title' }, main),
      h('p', { class: 'gcard-meta' },
        g.plays
          ? [h('span', { class: 'gcard-plays', text: `${g.plays}번 했어요` }), h('span', { class: 'gcard-last', text: `최근 ${fmtDateDot(g.lastDate)}` })]
          : [h('span', { class: 'gcard-plays', text: '아직 안 해 봤어요' }), added ? h('span', { class: 'gcard-last', text: `${fmtDateDot(added)} 등록` }) : null]),
      g.memo ? h('p', { class: 'gcard-memo', text: g.memo }) : null),
    more || rating ? h('div', { class: 'gcard-side' }, more, rating) : null);
}

function borrowedRow(g) {
  const t = TYPES[g.type];
  return h('li', {},
    h('a', { class: 'brow', href: gameHref(g) },
      h('span', { class: 'brow-text' },
        h('span', { class: 'brow-title', text: g.title }),
        h('span', { class: 'brow-sub', text: [t.short, `${g.plays}번`, g.lenders.length ? `빌려준 사람 ${g.lenders.join(', ')}` : ''].filter(Boolean).join(' · ') })),
      icon('chevron', 'brow-go')));
}

export function mount(root, ctx) {
  const register = () => openGameEditor(null, { type: view.type === 'all' ? undefined : view.type });
  const seg = segmented({
    label: '종류', value: view.type, cls: 'seg-type',
    options: [{ key: 'all', label: '전체' }, ...KINDS.map((k) => ({ key: k, label: TYPES[k].short, cls: TYPES[k].cls }))],
    onChange: (v) => { view.type = v; paint(); },
  });
  const sortSel = h('select', { class: 'select select-sm', 'aria-label': '정렬' },
    SORTS.map(([v, l]) => h('option', { value: v, selected: view.sort === v }, l)));
  sortSel.addEventListener('change', () => { view.sort = sortSel.value; paint(); });
  const count = h('p', { class: 'list-count', 'aria-live': 'polite' });
  const tools = h('div', { class: 'list-tools-row' }, count, h('div', { class: 'list-tools-right' }, sortSel));
  const results = h('div', { class: 'coll-results' });
  const addBtn = h('button', { type: 'button', class: 'icon-btn icon-btn-soft head-add', 'aria-label': '게임 등록', onClick: register },
    icon('plus'), h('span', { class: 'head-label', text: '게임 등록' }));
  const page = h('div', { class: 'page page-collection' },
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: '소장' }), addBtn),
    h('p', { class: 'page-sub', text: '가지고 있는 보드게임·머미를 모아 봤어요' }),
    seg, tools, results);

  // 종류·정렬을 바꿔도 고르던 칸에 초점이 남도록 아래 결과만 다시 그림
  function paint() {
    const waiting = !state.records.length && !state.games.length && (isFirstLoad() || loadFailed());
    seg.hidden = waiting;
    tools.hidden = waiting;
    addBtn.hidden = waiting;
    if (waiting) {
      results.replaceChildren(isFirstLoad() ? loadingState() : loadErrorState(ctx && ctx.refresh));
      return;
    }
    const { owned, borrowed } = collectionOf(state.records, state.games);
    const ofType = (list) => (view.type === 'all' ? list : list.filter((g) => g.type === view.type));
    const shown = sorted(ofType(owned));
    const shownBorrowed = ofType(borrowed);
    count.textContent = `${view.type === 'all' ? '보드게임·머미' : TYPES[view.type].short} ${shown.length}개`;

    const addAction = (label) => h('button', { type: 'button', class: 'btn btn-primary', onClick: register }, icon('plus'), h('span', { text: label }));
    let body;
    if (!owned.length) {
      body = emptyState({
        icon: 'box', title: '아직 소장한 게임이 없어요',
        text: '‘게임 등록’으로 가지고 있는 게임 이름만 바로 넣을 수 있어요. 보드게임·보드게임형 머미 기록에서 소장 여부를 ‘내 소장’으로 골라도 여기에 모여요.',
        action: addAction('게임 등록'),
      });
    } else if (!shown.length) {
      body = emptyState({ icon: 'box', title: '이 종류는 소장한 게임이 없어요', text: '가지고 있는 게임을 등록하거나 다른 종류를 골라 보세요.', action: addAction('게임 등록') });
    } else {
      body = h('ul', { class: 'glist' }, shown.map(gameCard));
    }
    const borrowedSec = shownBorrowed.length
      ? h('section', { class: 'borrowed' },
        sectionHead('대여한 게임', {
          action: h('a', { class: 'link-more', href: '#/records?own=borrowed' }, '대여 기록 보기', icon('chevron')),
        }),
        h('ul', { class: 'blist card' }, shownBorrowed.map(borrowedRow)))
      : null;
    results.replaceChildren(body, ...(borrowedSec ? [borrowedSec] : []));
  }

  paint();
  root.replaceChildren(page);
  return { update: paint };
}
