// 기록 목록 — 종류 세그먼트, 검색, 정렬, 멤버/태그 필터, 월별 그룹
import { h, icon } from '../dom.js';
import { TYPES, TYPE_KEYS } from '../constants.js';
import { state, recordsSorted, membersSorted, allTags, memberInfo, isFirstLoad, loadFailed } from '../store.js';
import { norm, monthKey, fmtMonth } from '../format.js';
import { segmented, chip, avatar, emptyState, loadingState, loadErrorState } from '../ui.js';
import { recordCard, bgOf, mmOf, erOf } from './bits.js';

const PAGE = 60;

// 화면을 떠났다 돌아와도 필터 유지
const filters = { type: 'all', q: '', sort: 'new', members: [], tags: [], open: false };

function haystack(r) {
  const parts = [r.title, r.oneLiner, r.review, ...(Array.isArray(r.tags) ? r.tags : [])];
  const bg = bgOf(r), mm = mmOf(r), er = erOf(r);
  parts.push(bg.place, bg.expansion, mm.publisher, mm.store, mm.gm, er.brand, er.branch, er.genre);
  for (const x of Array.isArray(mm.roles) ? mm.roles : []) parts.push(x && x.character);
  return norm(parts.filter(Boolean).join(' \n '));
}

const hayCache = new WeakMap();
function matches(r, q) {
  if (!q) return true;
  let s = hayCache.get(r);
  if (s === undefined) { s = haystack(r); hayCache.set(r, s); }
  return q.split(/\s+/).every((w) => s.includes(w.replace(/^#/, '')));
}

function applyFilters() {
  const q = norm(filters.q);
  let list = recordsSorted().filter((r) =>
    (filters.type === 'all' || r.type === filters.type) &&
    (!filters.members.length || filters.members.every((id) => Array.isArray(r.members) && r.members.includes(id))) &&
    (!filters.tags.length || filters.tags.every((t) => Array.isArray(r.tags) && r.tags.includes(t))) &&
    matches(r, q));
  if (filters.sort === 'old') list = [...list].reverse();
  else if (filters.sort === 'rating') {
    list = [...list].sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) ||
      String(b.date || '').localeCompare(String(a.date || '')));
  }
  return list;
}

export function mount(root, ctx) {
  const q = ctx.query || {};
  // 다른 화면의 링크(종류 바로가기·태그·멤버 '모두 보기')로 왔으면 예전 검색·필터를 비우고 그 조건만
  // (탭으로 돌아온 경우에는 쓰던 필터를 그대로 둠)
  const typeQ = q.type && (q.type === 'all' || TYPE_KEYS.includes(q.type)) ? q.type : null;
  if ((typeQ || q.tag || q.member) && !ctx.restored) {
    Object.assign(filters, { type: typeQ || 'all', q: '', sort: 'new', members: [], tags: [], open: false });
    if (q.tag) { filters.tags = [q.tag]; filters.open = true; }
    if (q.member) { filters.members = [q.member]; filters.open = true; }
  }

  let limit = PAGE;

  const seg = segmented({
    label: '종류', value: filters.type, cls: 'seg-type',
    options: [{ key: 'all', label: '전체' }, ...TYPE_KEYS.map((k) => ({ key: k, label: TYPES[k].short, cls: TYPES[k].cls }))],
    onChange: (v) => { filters.type = v; limit = PAGE; renderResults(); },
  });

  const search = h('input', {
    type: 'search', class: 'input search-input', placeholder: '제목, 태그, 매장, 후기 검색',
    'aria-label': '기록 검색', value: filters.q, enterkeyhint: 'search', autocomplete: 'off',
  });
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { filters.q = search.value; limit = PAGE; renderResults(); }, 160);
  });

  const sortSel = h('select', { class: 'select select-sm', 'aria-label': '정렬' },
    [['new', '최신순'], ['old', '오래된순'], ['rating', '별점순']].map(([v, l]) => h('option', { value: v, selected: filters.sort === v }, l)));
  sortSel.addEventListener('change', () => { filters.sort = sortSel.value; limit = PAGE; renderResults(); });

  const filterBadge = h('span', { class: 'fbadge', hidden: true });
  const filterBtn = h('button', { type: 'button', class: 'btn btn-soft btn-sm', 'aria-expanded': filters.open ? 'true' : 'false', 'aria-controls': 'list-filter' },
    icon('filter'), h('span', { text: '필터' }), filterBadge);
  const panel = h('div', { class: 'filter-panel', id: 'list-filter', hidden: !filters.open });
  filterBtn.addEventListener('click', () => {
    filters.open = !filters.open;
    panel.hidden = !filters.open;
    filterBtn.setAttribute('aria-expanded', filters.open ? 'true' : 'false');
  });

  const countEl = h('p', { class: 'list-count', 'aria-live': 'polite' });
  const results = h('div', { class: 'list-results' });

  function renderPanel() {
    const mems = membersSorted();
    const tags = allTags().slice(0, 30);
    for (const tg of filters.tags) if (!tags.includes(tg)) tags.unshift(tg);
    panel.replaceChildren(
      h('div', { class: 'fp-group' },
        h('p', { class: 'fp-label', text: '함께한 멤버 (모두 포함)' }),
        mems.length
          ? h('div', { class: 'chips' }, mems.map((m) => chip({
            label: m.name, pressed: filters.members.includes(m.id), cls: 'chip-member', lead: avatar(m.id, 'xs'),
            onToggle: (on) => {
              filters.members = on ? [...filters.members, m.id] : filters.members.filter((x) => x !== m.id);
              limit = PAGE; renderResults();
            },
          })))
          : h('p', { class: 'muted small', text: '등록된 멤버가 없어요' })),
      h('div', { class: 'fp-group' },
        h('p', { class: 'fp-label', text: '태그' }),
        tags.length
          ? h('div', { class: 'chips' }, tags.map((tg) => chip({
            label: `#${tg}`, pressed: filters.tags.includes(tg), cls: 'chip-tag',
            onToggle: (on) => {
              filters.tags = on ? [...filters.tags, tg] : filters.tags.filter((x) => x !== tg);
              limit = PAGE; renderResults();
            },
          })))
          : h('p', { class: 'muted small', text: '아직 쓴 태그가 없어요' })),
      h('div', { class: 'fp-actions' },
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm',
          onClick: () => { filters.members = []; filters.tags = []; limit = PAGE; renderPanel(); renderResults(); },
        }, '필터 초기화')));
  }

  function activeChips() {
    const items = [];
    for (const id of filters.members) {
      items.push(h('button', {
        type: 'button', class: 'achip', 'aria-label': `${memberInfo(id).name} 필터 해제`,
        onClick: () => { filters.members = filters.members.filter((x) => x !== id); renderPanel(); renderResults(); },
      }, avatar(id, 'xs'), h('span', { text: memberInfo(id).name }), icon('x')));
    }
    for (const tg of filters.tags) {
      items.push(h('button', {
        type: 'button', class: 'achip', 'aria-label': `#${tg} 필터 해제`,
        onClick: () => { filters.tags = filters.tags.filter((x) => x !== tg); renderPanel(); renderResults(); },
      }, h('span', { text: `#${tg}` }), icon('x')));
    }
    return items.length ? h('div', { class: 'achips' }, items) : null;
  }

  function renderResults() {
    const list = applyFilters();
    const nf = filters.members.length + filters.tags.length;
    filterBadge.hidden = nf === 0;
    filterBadge.textContent = String(nf);
    const scoped = filters.type === 'all' ? '전체' : TYPES[filters.type].short;
    countEl.textContent = filters.q || nf ? `${scoped} 중 ${list.length}개 찾았어요` : `${scoped} ${list.length}개`;

    const out = [];
    const ac = activeChips();
    if (ac) out.push(ac);

    if (!state.records.length && isFirstLoad()) {
      out.push(loadingState());
    } else if (!state.records.length && loadFailed()) {
      out.push(loadErrorState(ctx.refresh));
    } else if (!state.records.length) {
      out.push(emptyState({
        icon: 'book', title: '아직 기록이 없어요', text: '아래 ＋ 버튼으로 첫 기록을 남겨 보세요.',
        action: h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), h('span', { text: '새 기록' })),
      }));
    } else if (!list.length) {
      out.push(emptyState({ icon: 'search', title: '조건에 맞는 기록이 없어요', text: '검색어나 필터를 바꿔 보세요.' }));
    } else {
      const shown = list.slice(0, limit);
      if (filters.sort === 'rating') {
        out.push(h('div', { class: 'rlist' }, shown.map((r) => recordCard(r))));
      } else {
        let cur = null;
        let group = null;
        const counts = new Map();
        for (const r of list) counts.set(monthKey(r.date), (counts.get(monthKey(r.date)) || 0) + 1);
        for (const r of shown) {
          const mk = monthKey(r.date);
          if (mk !== cur) {
            cur = mk;
            const [y, m] = mk.split('-');
            group = h('div', { class: 'rlist' });
            out.push(h('section', { class: 'mgroup', 'aria-label': fmtMonth(mk) },
              h('h2', { class: 'mgroup-head' },
                h('span', { class: 'mg-month', text: m ? `${Number(m)}월` : '?' }),
                h('span', { class: 'mg-year', text: y || '' }),
                h('span', { class: 'mg-rule', 'aria-hidden': 'true' }),
                h('span', { class: 'mg-count', text: `${counts.get(mk)}개` })),
              group));
          }
          group.appendChild(recordCard(r));
        }
      }
      if (list.length > limit) {
        out.push(h('button', {
          type: 'button', class: 'btn btn-soft btn-block more-btn',
          onClick: () => { limit += PAGE; renderResults(); },
        }, `더 보기 (${list.length - limit}개 남음)`));
      }
    }
    results.replaceChildren(...out);
  }

  const view = h('div', { class: 'page page-list' },
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', text: '기록' }),
      h('a', { class: 'icon-btn icon-btn-soft', href: '#/new', 'aria-label': '새 기록' }, icon('plus'))),
    seg,
    h('div', { class: 'list-tools' },
      h('div', { class: 'search-wrap' }, icon('search', 'search-ico'), search),
      h('div', { class: 'list-tools-row' }, countEl, h('div', { class: 'list-tools-right' }, sortSel, filterBtn))),
    panel,
    results);

  renderPanel();
  renderResults();
  root.appendChild(view);

  return {
    update() { renderPanel(); renderResults(); },
  };
}
