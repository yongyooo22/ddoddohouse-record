// 소장 — '내 소장'으로 표시한 보드게임·머미를 게임별로 모아 보기 (방탈출 테마는 소장 개념 없음)
// 게임 등록은 여기서 '내 소장'이 기본으로 선택된 채 열림. 소장 해제는 소장 여부만 바꾸고 게임 정보·기록은 그대로
import { h, icon, starShape } from '../dom.js';
import { TYPES } from '../constants.js';
import { state, isFirstLoad, loadFailed, gameById, gameSummaries } from '../store.js';
import { fmtDateDot, todayStr, gameInfoText } from '../format.js';
import { navigate } from '../nav.js';
import { segmented, typeBadge, typeName, emptyState, loadingState, loadErrorState, openDialog } from '../ui.js';
import { cardPhoto } from './photos.js';
import { openGameEditor, canDeleteGame, setOwned, deleteGameInfo } from './game-form.js';
import { gamePageHref, gameWriteHref } from './bits.js';

const KINDS = ['boardgame', 'murdermystery'];

// 화면을 떠났다 돌아와도 고른 종류·정렬 유지
const view = { type: 'all', sort: 'recent' };

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

function sorted(games, sort = view.sort) {
  const list = [...games];
  // 같은 값이면 gameEntries 순서(최근에 한 순 → 안 해 본 게임은 최근 등록 순)를 그대로 둠 (안정 정렬)
  if (sort === 'recent') list.sort((a, b) => activity(b).localeCompare(activity(a)));
  else if (sort === 'plays') list.sort((a, b) => b.plays - a.plays || activity(b).localeCompare(activity(a)));
  else if (sort === 'rating') list.sort((a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1) || b.plays - a.plays);
  else if (sort === 'name') list.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  return list;
}

/** 그 게임의 기록만 모아 보는 목록 주소 */
const recordsHref = (g) => (g.gameId
  ? `#/records?game=${encodeURIComponent(g.gameId)}`
  : `#/records?type=${g.type}&title=${encodeURIComponent(g.title)}`);

/** 내 소장 게임 (보드게임·머미, 최근에 하거나 등록한 순) — 홈에서도 씀 */
export const ownedGames = () => sorted(gameSummaries().filter((e) => e.owned && KINDS.includes(e.type)), 'recent');

/** '3번 했어요 · 최근 2026.09.30 · 평균 ★ 4.5' 또는 '아직 안 해 봤어요 · 2026.10.01 등록' */
export function statText(g) {
  return g.plays
    ? `${g.plays}번 했어요 · 최근 ${fmtDateDot(g.lastDate)}${g.avgRating ? ` · 평균 ★ ${g.avgRating.toFixed(1)}` : ''}`
    : `아직 안 해 봤어요${addedOn(g) ? ` · ${fmtDateDot(addedOn(g))} 등록` : ''}`;
}

/** 소장 게임 등록 (내 소장 기본 선택, 계속 등록) */
export const registerOwned = (type) => openGameEditor(null, { type, context: 'collection' });

/** 게임 메뉴: 기록 보기 · 기록 쓰기 · 정보 고치기 · 소장에서 빼기 (등록 전 예전 기록은 '게임으로 등록') */
async function openGameMenu(g) {
  let close = () => {};
  const item = (value, ic, label, cls = '') => h('button', { type: 'button', class: ['gmenu-item', cls], onClick: () => close(value) },
    icon(ic), h('span', { text: label }), icon('chevron', 'gmenu-go'));
  const stat = statText(g);
  const info = g.game ? gameInfoText(g.game, { genres: 4 }) : '';
  const game = gameById(g.gameId);
  const body = h('div', { class: 'gmenu' },
    h('div', { class: 'gmenu-info' }, typeBadge(g.type), h('p', { class: 'gmenu-stat', text: stat })),
    info ? h('p', { class: 'gmenu-meta', text: info }) : null,
    g.memo ? h('p', { class: 'gmenu-memo', text: g.memo }) : null,
    h('div', { class: 'gmenu-list' },
      g.plays ? item('records', 'book', `기록 ${g.plays}개 보기`) : null,
      item('write', 'plus', '이 게임으로 새 기록 쓰기'),
      g.gameId ? item('edit', 'edit', '게임 정보 수정') : item('register', 'box', '게임 정보로 등록'),
      g.gameId ? item('unown', 'box', '소장에서 빼기', 'is-danger') : null,
      game && canDeleteGame(game) ? item('delete', 'trash', '게임 정보 삭제', 'is-danger') : null));
  const v = await openDialog({
    title: g.title, body, cls: 'dlg-game',
    bind: (c) => { close = c; },
    actions: [{ label: '닫기', value: null, kind: 'ghost' }],
  });
  if (v === 'records') navigate(recordsHref(g));
  else if (v === 'write') navigate(gameWriteHref(g));
  else if (v === 'edit') {
    if (game) await openGameEditor(game);
  } else if (v === 'register') {
    await openGameEditor(null, { type: g.type, title: g.title, context: 'collection' });
  } else if (v === 'unown') await setOwned(game, false);
  else if (v === 'delete') await deleteGameInfo(game);
}

// ── 목록 ──

function gameCard(g) {
  const t = TYPES[g.type];
  const photo = g.cover ? cardPhoto({ photos: [g.cover] }) : null;
  const added = addedOn(g);
  const info = g.game ? gameInfoText(g.game) : '';
  // 카드를 누르면 게임 상세 (정보 · 플레이 기록하기 · 그 게임 기록)
  const main = h('a', { class: 'card-link', href: gamePageHref(g), 'aria-label': `${g.title}, ${t.label}, ${g.plays ? `${g.plays}번 했어요` : '아직 안 해 봤어요'}` }, g.title);
  const rating = g.avgRating
    ? h('span', { class: 'gcard-rating', role: 'img', 'aria-label': `평균 별점 ${g.avgRating.toFixed(1)}점` },
      starShape('rcard-star'), h('span', { text: g.avgRating.toFixed(1) }))
    : null;
  const more = h('button', { type: 'button', class: 'icon-btn gcard-more', 'aria-label': `${g.title} 메뉴`, onClick: () => openGameMenu(g) }, icon('more'));
  return h('li', { class: ['gcard', t.cls, g.plays ? null : 'is-unplayed'], dataset: g.gameId ? { gameId: g.gameId } : {} },
    h('div', { class: 'gcard-thumb', 'aria-hidden': 'true' },
      photo || h('span', { class: 'rcard-noimg' }, icon(t.icon))),
    h('div', { class: 'gcard-body' },
      h('div', { class: 'gcard-top' }, typeBadge(g.type)),
      h('h3', { class: 'gcard-title' }, main),
      info ? h('p', { class: 'gcard-info', text: info }) : null,
      h('p', { class: 'gcard-meta' },
        g.plays
          ? [h('span', { class: 'gcard-plays', text: `${g.plays}번 했어요` }), h('span', { class: 'gcard-last', text: `최근 ${fmtDateDot(g.lastDate)}` })]
          : [h('span', { class: 'gcard-plays', text: '아직 안 해 봤어요' }), added ? h('span', { class: 'gcard-last', text: `${fmtDateDot(added)} 등록` }) : null]),
      g.memo ? h('p', { class: 'gcard-memo', text: g.memo }) : null),
    h('div', { class: 'gcard-side' }, more, rating));
}

export function mount(root, ctx) {
  const register = () => registerOwned(view.type === 'all' ? undefined : view.type);
  const seg = segmented({
    label: '종류', value: view.type, cls: 'seg-type',
    options: [{ key: 'all', label: '전체' }, ...KINDS.map((k) => ({ key: k, label: typeName(k), cls: TYPES[k].cls }))],
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
    const owned = gameSummaries().filter((e) => e.owned && KINDS.includes(e.type));
    const shown = sorted(view.type === 'all' ? owned : owned.filter((g) => g.type === view.type));
    count.textContent = `${view.type === 'all' ? '내 소장' : TYPES[view.type].label} ${shown.length}개`;

    const addAction = (label) => h('button', { type: 'button', class: 'btn btn-primary', onClick: register }, icon('plus'), h('span', { text: label }));
    let body;
    if (!owned.length) {
      body = emptyState({
        icon: 'box', title: '아직 소장한 게임이 없어요',
        text: '가지고 있는 게임을 등록해 두면 기록할 때 바로 골라 쓸 수 있어요.',
        action: addAction('게임 등록'),
      });
    } else if (!shown.length) {
      body = emptyState({ icon: 'box', title: '이 종류는 소장한 게임이 없어요', text: '가지고 있는 게임을 등록하거나 다른 종류를 골라 보세요.', action: addAction('게임 등록') });
    } else {
      body = h('ul', { class: 'glist' }, shown.map(gameCard));
    }
    results.replaceChildren(body);
  }

  paint();
  root.replaceChildren(page);
  return { update: paint };
}
