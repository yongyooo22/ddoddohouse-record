// 홈 — 인사말, 낮은 요약 띠(전체·이번 달·종류별), 최근 기록
import { h, icon } from '../dom.js';
import { TYPES, TYPE_KEYS, APP_NAME, WEEKDAYS } from '../constants.js';
import { state, recordsSorted, isFirstLoad, loadFailed } from '../store.js';
import { overview } from '../stats.js';
import { emptyState, loadingState, loadErrorState } from '../ui.js';
import { recordCard, sectionHead } from './bits.js';

function greeting(d) {
  const hr = d.getHours();
  if (hr >= 5 && hr < 11) return '좋은 아침이에요';
  if (hr >= 11 && hr < 17) return '즐거운 오후예요';
  if (hr >= 17 && hr < 22) return '좋은 저녁이에요';
  return '늦은 밤이에요';
}

/** 요약 띠의 한 칸. href 가 있으면 그 조건의 목록으로 */
function sumItem(label, n, href, cls) {
  const inner = [
    h('span', { class: 'sum-label', text: label }),
    h('span', { class: 'sum-value' }, h('span', { class: 'sum-num', text: String(n) }), h('span', { class: 'sum-unit', text: '회' })),
  ];
  return h('li', { class: ['sum-item', cls] },
    href ? h('a', { class: 'sum-link', href }, inner) : h('span', { class: 'sum-link' }, inner));
}

function render(root, ctx) {
  const now = new Date();
  const records = state.records;
  let ov;
  try { ov = overview(records, state.members, now); } catch { ov = null; }
  const total = ov ? ov.total : records.length;
  const thisMonth = ov ? ov.thisMonth : 0;
  const byType = (ov && ov.byType) || {};

  // 설정은 메뉴(휴대폰 아래 탭 막대 · 넓은 화면 사이드바)에 있음
  const head = h('header', { class: 'home-head' },
    h('div', { class: 'home-hello' },
      h('p', { class: 'kicker', text: APP_NAME }),
      h('h1', { class: 'home-title', text: greeting(now) }),
      h('p', { class: 'home-date', text: `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEKDAYS[now.getDay()]}요일` })));

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
      TYPE_KEYS.map((k) => sumItem(TYPES[k].short, byType[k] || 0, `#/records?type=${k}`, `sum-type ${TYPES[k].cls}`))));

  const recent = recordsSorted().slice(0, 6);
  const recentSec = h('section', { class: 'home-recent' },
    sectionHead('최근 기록', { action: records.length ? h('a', { class: 'link-more', href: '#/records' }, '전체 보기', icon('chevron')) : null }),
    recent.length
      ? h('div', { class: 'rlist' }, recent.map((r) => recordCard(r)))
      : emptyState({
        icon: 'book', title: '아직 기록이 없어요',
        text: '보드게임, 머더미스터리, 방탈출 — 오늘 한 놀이를 첫 장에 적어 보세요.',
        action: h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), h('span', { text: '첫 기록 남기기' })),
      }));

  // 멤버 등록 안내는 최근 기록 아래에 (기록을 밀어내지 않게)
  const tip = !state.members.length
    ? h('a', { class: 'tip', href: '#/members' }, icon('users'),
      h('span', { text: '멤버를 먼저 등록하면 기록에서 함께한 사람을 고를 수 있어요' }), icon('chevron'))
    : null;

  root.replaceChildren(h('div', { class: 'page page-home' }, head, summary, recentSec, tip));
}

export function mount(root, ctx) {
  render(root, ctx);
  return { update: () => render(root, ctx) };
}
