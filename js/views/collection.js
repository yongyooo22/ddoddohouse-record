// 소장 — '내 소장'으로 남긴 보드게임·머미를 게임별로 모아 보기 (+ 빌려서 해 본 게임)
import { h, icon, starShape } from '../dom.js';
import { TYPES } from '../constants.js';
import { state, isFirstLoad, loadFailed } from '../store.js';
import { collectionOf } from '../stats.js';
import { fmtDateDot } from '../format.js';
import { segmented, typeBadge, emptyState, loadingState, loadErrorState } from '../ui.js';
import { sectionHead } from './bits.js';
import { cardPhoto } from './photos.js';

const KINDS = ['boardgame', 'murdermystery'];

// 화면을 떠났다 돌아와도 고른 종류·정렬 유지
const view = { type: 'all', sort: 'recent' };

const SORTS = [
  ['recent', '최근에 한 순'],
  ['plays', '많이 한 순'],
  ['rating', '별점순'],
  ['name', '이름순'],
];

function sorted(games) {
  const list = [...games];
  if (view.sort === 'plays') list.sort((a, b) => b.plays - a.plays || b.lastDate.localeCompare(a.lastDate));
  else if (view.sort === 'rating') list.sort((a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1) || b.plays - a.plays);
  else if (view.sort === 'name') list.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  return list; // recent: collectionOf 가 이미 최근 순
}

/** 그 게임의 기록만 모아 보는 목록 주소 */
const gameHref = (g) => `#/records?type=${g.type}&title=${encodeURIComponent(g.title)}`;

function gameCard(g) {
  const t = TYPES[g.type];
  const photo = g.cover ? cardPhoto({ photos: [g.cover] }) : null;
  return h('li', { class: ['gcard', t.cls] },
    h('div', { class: 'gcard-thumb', 'aria-hidden': 'true' },
      photo || h('span', { class: 'rcard-noimg' }, icon(t.icon))),
    h('div', { class: 'gcard-body' },
      h('div', { class: 'gcard-top' }, typeBadge(g.type)),
      h('h3', { class: 'gcard-title' },
        h('a', { class: 'card-link', href: gameHref(g), 'aria-label': `${g.title}, ${t.short}, ${g.plays}번 했어요` }, g.title)),
      h('p', { class: 'gcard-meta' },
        h('span', { class: 'gcard-plays', text: `${g.plays}번 했어요` }),
        h('span', { class: 'gcard-last', text: `최근 ${fmtDateDot(g.lastDate)}` }))),
    g.avgRating
      ? h('span', { class: 'gcard-rating', role: 'img', 'aria-label': `평균 별점 ${g.avgRating.toFixed(1)}점` },
        starShape('rcard-star'), h('span', { text: g.avgRating.toFixed(1) }))
      : null);
}

function borrowedRow(g) {
  const t = TYPES[g.type];
  return h('li', {},
    h('a', { class: 'brow', href: gameHref(g) },
      h('span', { class: 'brow-text' },
        h('span', { class: 'brow-title', text: g.title }),
        h('span', { class: 'brow-sub', text: [t.short, g.lenders.length ? `${g.lenders.join(', ')}에게 빌림` : '빌림', `${g.plays}번`].join(' · ') })),
      icon('chevron', 'brow-go')));
}

export function mount(root, ctx) {
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
  const page = h('div', { class: 'page page-collection' },
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: '소장' })),
    h('p', { class: 'page-sub', text: '‘내 소장’으로 남긴 게임을 모아 봤어요' }),
    seg, tools, results);

  // 종류·정렬을 바꿔도 고르던 칸에 초점이 남도록 아래 결과만 다시 그림
  function paint() {
    const waiting = !state.records.length && (isFirstLoad() || loadFailed());
    seg.hidden = waiting;
    tools.hidden = waiting;
    if (waiting) {
      results.replaceChildren(isFirstLoad() ? loadingState() : loadErrorState(ctx && ctx.refresh));
      return;
    }
    const { owned, borrowed } = collectionOf(state.records);
    const ofType = (list) => (view.type === 'all' ? list : list.filter((g) => g.type === view.type));
    const shown = sorted(ofType(owned));
    const shownBorrowed = ofType(borrowed);
    count.textContent = `${view.type === 'all' ? '보드게임·머미' : TYPES[view.type].short} ${shown.length}개`;

    let body;
    if (!owned.length) {
      body = emptyState({
        icon: 'box', title: '아직 소장한 게임이 없어요',
        text: '보드게임이나 보드게임형 머미 기록에서 소장 여부를 ‘내 소장’으로 고르면 여기에 게임별로 모여요.',
        action: h('a', { class: 'btn btn-soft', href: '#/records' }, icon('book'), h('span', { text: '기록 보러 가기' })),
      });
    } else if (!shown.length) {
      body = emptyState({ icon: 'box', title: '이 종류는 소장한 게임이 없어요', text: '다른 종류를 골라 보세요.' });
    } else {
      body = h('ul', { class: 'glist' }, shown.map(gameCard));
    }
    const borrowedSec = shownBorrowed.length
      ? h('section', { class: 'borrowed' },
        sectionHead('빌려서 해 본 게임', {
          action: h('a', { class: 'link-more', href: '#/records?own=borrowed' }, '빌린 기록 보기', icon('chevron')),
        }),
        h('ul', { class: 'blist card' }, shownBorrowed.map(borrowedRow)))
      : null;
    results.replaceChildren(body, ...(borrowedSec ? [borrowedSec] : []));
  }

  paint();
  root.replaceChildren(page);
  return { update: paint };
}
