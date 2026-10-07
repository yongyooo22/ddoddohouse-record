// 홈 — '플레이 기록' 제목 → 낮은 요약 띠(전체·이번 달·종류별) → 최근 기록 → 내 소장 게임
import { h, icon } from '../dom.js';
import { TYPES, TYPE_KEYS } from '../constants.js';
import { state, recordsSorted, isFirstLoad, loadFailed } from '../store.js';
import { overview } from '../stats.js';
import { emptyState, loadingState, loadErrorState, typeName } from '../ui.js';
import { recordCard, sectionHead, gamePageHref } from './bits.js';
import { cardPhoto } from './photos.js';
import { ownedGames, registerOwned } from './collection.js';

const OWNED_MAX = 6;

/** 요약 띠의 한 칸 ('보드게임 12회'). href 가 있으면 그 조건의 목록으로 */
function sumItem(label, n, href, cls) {
  const inner = [
    h('span', { class: 'sum-label' }, label),
    h('span', { class: 'sum-value' }, h('span', { class: 'sum-num', text: String(n) }), h('span', { class: 'sum-unit', text: '회' })),
  ];
  return h('li', { class: ['sum-item', cls] },
    href ? h('a', { class: 'sum-link', href }, inner) : h('span', { class: 'sum-link' }, inner));
}

/** 소장 게임 작은 표지: 대표 이미지(없으면 종류 아이콘) · 이름 · 몇 번 했는지 */
function ownedTile(e) {
  const t = TYPES[e.type];
  const photo = e.cover ? cardPhoto({ photos: [e.cover] }) : null;
  return h('li', { class: ['otile', t.cls] },
    h('a', { class: 'otile-link', href: gamePageHref(e), 'aria-label': `${e.title}, ${e.plays ? `${e.plays}번 했어요` : '아직 안 해 봤어요'}` },
      h('span', { class: 'otile-cover', 'aria-hidden': 'true' }, photo || h('span', { class: 'rcard-noimg' }, icon(t.icon))),
      h('span', { class: 'otile-name', text: e.title }),
      h('span', { class: 'otile-sub', text: e.plays ? `${e.plays}회` : '아직 안 해 봄' })));
}

function render(root, ctx) {
  const records = state.records;
  let ov;
  try { ov = overview(records, state.members, new Date()); } catch { ov = null; }
  const total = ov ? ov.total : records.length;
  const thisMonth = ov ? ov.thisMonth : 0;
  const byType = (ov && ov.byType) || {};

  const head = h('header', { class: 'home-head' }, h('h1', { class: 'home-title', text: '플레이 기록' }));

  // 첫 로딩 중이거나 불러오기에 실패했으면 0회 요약·빈 안내 대신 그 상태를 보여 줌 (기록이 사라진 것처럼 보이지 않게)
  if (!records.length && (isFirstLoad() || loadFailed())) {
    root.replaceChildren(h('div', { class: 'page page-home' }, head,
      isFirstLoad() ? loadingState() : loadErrorState(ctx && ctx.refresh)));
    return;
  }

  // 큰 표지 대신 낮은 요약 띠 하나 — 최근 기록이 위로 올라오게
  const summary = h('section', { class: 'summary', 'aria-label': '기록 요약' },
    h('ul', { class: 'sum-list' },
      sumItem('전체', total, '#/records?type=all', 'sum-total'),
      sumItem('이번 달', thisMonth, null, 'sum-month'),
      TYPE_KEYS.map((k) => sumItem(typeName(k, 'tight'), byType[k] || 0, `#/records?type=${k}`, `sum-type ${TYPES[k].cls}`))));

  const recent = recordsSorted().slice(0, 6);
  const recentSec = h('section', { class: 'home-recent' },
    sectionHead('최근 기록', { action: records.length ? h('a', { class: 'link-more', href: '#/records' }, '전체 보기', icon('chevron')) : null }),
    recent.length
      ? h('div', { class: 'rlist' }, recent.map((r) => recordCard(r)))
      : emptyState({
        icon: 'card', title: '첫 플레이를 기록해 보세요', cls: 'empty-home',
        action: h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), h('span', { text: '기록 남기기' })),
      }));

  // 내 소장 게임 몇 개를 작은 표지로 — 누르면 게임 상세(플레이 기록하기)로. 없으면 작은 등록 버튼만
  const owned = ownedGames();
  const ownedSec = h('section', { class: 'home-owned' },
    sectionHead('내 소장 게임', { action: owned.length ? h('a', { class: 'link-more', href: '#/collection' }, '전체 보기', icon('chevron')) : null }),
    owned.length
      ? h('ul', { class: 'otiles' }, owned.slice(0, OWNED_MAX).map(ownedTile))
      : h('div', { class: 'home-own-empty' },
        h('button', { type: 'button', class: 'btn btn-soft btn-sm', onClick: () => registerOwned() }, icon('plus'), h('span', { text: '소장 게임 등록' }))));

  root.replaceChildren(h('div', { class: 'page page-home' }, head, summary, recentSec, ownedSec));
}

export function mount(root, ctx) {
  render(root, ctx);
  return { update: () => render(root, ctx) };
}
