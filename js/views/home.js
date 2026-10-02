// 홈 — 요약, 종류별 바로가기, 이번 달 멤버, 최근 기록
import { h, icon } from '../dom.js';
import { TYPES, TYPE_KEYS, APP_NAME, WEEKDAYS } from '../constants.js';
import { fmtDate } from '../format.js';
import { state, recordsSorted, memberInfo, isFirstLoad, loadFailed } from '../store.js';
import { overview } from '../stats.js';
import { avatar, emptyState, loadingState, loadErrorState } from '../ui.js';
import { recordCard, sectionHead } from './bits.js';

function greeting(d) {
  const hr = d.getHours();
  if (hr >= 5 && hr < 11) return '좋은 아침이에요';
  if (hr >= 11 && hr < 17) return '즐거운 오후예요';
  if (hr >= 17 && hr < 22) return '좋은 저녁이에요';
  return '늦은 밤이에요';
}

function monthTopMembers(records, now) {
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const counts = new Map();
  for (const r of records) {
    if (!r || String(r.date || '').slice(0, 7) !== ym) continue;
    for (const id of Array.isArray(r.members) ? r.members : []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([id]) => !memberInfo(id).missing)
    .sort((a, b) => b[1] - a[1])
    .map(([memberId, count]) => ({ memberId, count }));
}

function render(root, ctx) {
  const now = new Date();
  const records = state.records;
  let ov;
  try { ov = overview(records, state.members, now); } catch { ov = null; }
  const total = ov ? ov.total : records.length;
  const thisMonth = ov ? ov.thisMonth : 0;
  const byType = (ov && ov.byType) || {};

  const head = h('header', { class: 'home-head' },
    h('div', { class: 'home-hello' },
      h('p', { class: 'kicker', text: APP_NAME }),
      h('h1', { class: 'home-title', text: greeting(now) }),
      h('p', { class: 'home-date', text: `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEKDAYS[now.getDay()]}요일` })),
    h('a', { class: 'icon-btn icon-btn-soft', href: '#/settings', 'aria-label': '설정' }, icon('gear')));

  // 첫 로딩 중이거나 불러오기에 실패했으면 0개·빈 안내 대신 그 상태를 보여 줌 (기록이 사라진 것처럼 보이지 않게)
  if (!records.length && (isFirstLoad() || loadFailed())) {
    root.replaceChildren(h('div', { class: 'page page-home' }, head,
      isFirstLoad() ? loadingState() : loadErrorState(ctx && ctx.refresh)));
    return;
  }

  // 종류별 비율 막대 (앱 아이콘의 세 갈래 책갈피 끈과 같은 색)
  const bar = h('div', { class: 'cover-bar', 'aria-hidden': 'true' });
  for (const k of TYPE_KEYS) {
    const n = byType[k] || 0;
    if (!n) continue;
    const seg = h('span', { class: `cover-bar-seg ${TYPES[k].cls}` });
    seg.style.flexGrow = String(n);
    bar.appendChild(seg);
  }
  const cover = h('section', { class: 'cover', 'aria-label': '기록 요약' },
    h('span', { class: 'cover-ribbons', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('div', { class: 'cover-main' },
      h('p', { class: 'cover-label', text: '지금까지 함께 남긴 기록' }),
      h('p', { class: 'cover-num' }, h('span', { class: 'cover-big', text: String(total) }), h('span', { class: 'cover-unit', text: '개' })),
      h('p', { class: 'cover-month' }, h('span', { class: 'cover-pill', text: `이번 달 ${thisMonth}개` }))),
    h('ul', { class: 'cover-types' }, TYPE_KEYS.map((k) =>
      h('li', { class: `cover-type ${TYPES[k].cls}` },
        h('span', { class: 'cover-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'cover-tlabel', text: TYPES[k].short }),
        h('span', { class: 'cover-tnum', text: String(byType[k] || 0) })))),
    bar);

  const sorted = recordsSorted();
  const shortcuts = h('nav', { class: 'shortcuts', 'aria-label': '종류별 기록' }, TYPE_KEYS.map((k) => {
    const last = sorted.find((r) => r.type === k);
    return h('a', { class: `shortcut ${TYPES[k].cls}`, href: `#/records?type=${k}` },
      h('span', { class: 'shortcut-ico', 'aria-hidden': 'true' }, icon(TYPES[k].icon)),
      h('span', { class: 'shortcut-label', text: TYPES[k].short }),
      h('span', { class: 'shortcut-count', text: `${byType[k] || 0}회` }),
      h('span', { class: 'shortcut-sub', text: last ? `최근 ${fmtDate(last.date, { weekday: false, year: false })}` : '첫 기록을 기다려요' }),
      icon('chevron', 'shortcut-go'));
  }));

  // 이번 달 가장 많이 함께한 멤버
  const tops = monthTopMembers(records, now);
  let mate;
  if (tops.length) {
    const best = tops[0];
    const ties = tops.filter((t) => t.count === best.count);
    const info = memberInfo(best.memberId);
    mate = h('section', { class: 'card mate' },
      h('p', { class: 'mate-label', text: '이번 달 가장 많이 함께한 멤버' }),
      h('div', { class: 'mate-row' },
        h('a', { class: 'mate-main', href: `#/member/${encodeURIComponent(best.memberId)}` },
          avatar(info, 'lg'),
          h('span', { class: 'mate-text' },
            h('span', { class: 'mate-name', text: ties.length > 1 ? `${info.name} 외 ${ties.length - 1}명` : info.name }),
            h('span', { class: 'mate-count', text: `${best.count}번 함께했어요` }))),
        tops.length > 1
          ? h('ol', { class: 'mate-others', 'aria-label': '다음 순위' }, tops.slice(1, 4).map((t) =>
            h('li', { class: 'mate-other' }, avatar(t.memberId, 'xs'),
              h('span', { class: 'mate-other-name', text: memberInfo(t.memberId).name }),
              h('span', { class: 'mate-other-n', text: `${t.count}` }))))
          : null));
  } else {
    mate = h('section', { class: 'card mate mate-empty' },
      h('p', { class: 'mate-label', text: '이번 달 가장 많이 함께한 멤버' }),
      h('span', { class: 'mate-empty-ico', 'aria-hidden': 'true' }, icon('users')),
      h('p', { class: 'muted', text: '이번 달 기록이 아직 없어요. 첫 기록을 남겨 볼까요?' }));
  }

  const recent = sorted.slice(0, 6);
  const recentSec = h('section', { class: 'home-recent' },
    sectionHead('최근 기록', { action: records.length ? h('a', { class: 'link-more', href: '#/records' }, '전체 보기', icon('chevron')) : null }),
    recent.length
      ? h('div', { class: 'rlist' }, recent.map((r) => recordCard(r, { showMonth: true })))
      : emptyState({
        icon: 'book', title: '아직 기록이 없어요',
        text: '보드게임, 머더미스터리, 방탈출 — 오늘 한 놀이를 첫 장에 적어 보세요.',
        action: h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), h('span', { text: '첫 기록 남기기' })),
      }));

  const tip = !state.members.length
    ? h('a', { class: 'tip', href: '#/members' }, icon('users'),
      h('span', { text: '멤버를 먼저 등록하면 기록에서 함께한 사람을 고를 수 있어요' }), icon('chevron'))
    : null;

  root.replaceChildren(h('div', { class: 'page page-home' }, head, cover, tip, shortcuts, mate, recentSec));
}

export function mount(root, ctx) {
  render(root, ctx);
  return { update: () => render(root, ctx) };
}
