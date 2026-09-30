// 메인 화면 — 기록장 이름 + 새 기록, 분류 탭, 제목 검색, 연도·평점 필터, 카드형/목록형, 작품별 묶기
import { h, icon } from '../dom.js';
import * as repo from '../repo.js';
import * as prefs from '../prefs.js';
import { GENRES, GENRE_KEYS, RATING_FILTERS } from '../constants.js';
import { filterEntries, groupByWork, yearsOf } from '../query.js';
import { fmtMonth, monthKey } from '../format.js';
import { emptyState, nextId } from '../ui.js';
import { playCard, workCard, playRow, workRow } from './cards.js';
import { loadSamples, removeSamplesWithConfirm } from './sample-actions.js';

const PAGE = 48;

// 화면을 옮겨 다녀도 쓰던 조건을 그대로 (앱을 다시 열면 초기화)
const f = { genre: '', q: '', year: '', rating: '' };
let shown = PAGE;

const hasFilter = () => !!(f.q || f.year || f.rating);

export function mount(root) {
  let io = null;

  // ── 머리 ──
  const bookName = h('span', { class: 'brand-name' });
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner container' },
      h('a', { class: 'brand', href: '#/', 'aria-label': '처음 화면' },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('ticket')),
        h('h1', { class: 'brand-title' }, bookName)),
      h('div', { class: 'topbar-actions' },
        h('a', { class: 'icon-btn', href: '#/settings', 'aria-label': '설정', title: '설정' }, icon('gear')),
        h('a', { class: 'btn btn-primary btn-new', href: '#/new', id: 'new-record' }, icon('plus'), h('span', { text: '새 기록' })))));

  // ── 분류 탭 ──
  const tabDefs = [{ key: '', label: '전체' }, ...GENRE_KEYS.map((k) => ({ key: k, label: GENRES[k].label, cls: GENRES[k].cls }))];
  const tabs = tabDefs.map((t) => {
    const count = h('span', { class: 'gtab-count' });
    const b = h('button', { type: 'button', class: ['gtab', t.cls], dataset: { genre: t.key } },
      t.key ? h('span', { class: 'gtab-dot', 'aria-hidden': 'true' }) : null,
      h('span', { class: 'gtab-label', text: t.label }), count);
    b.addEventListener('click', () => {
      if (f.genre === t.key) return;
      f.genre = t.key;
      shown = PAGE;
      renderAll();
    });
    b.countEl = count;
    return b;
  });
  const tabBar = h('div', { class: 'gtabs', role: 'group', 'aria-label': '분류' }, tabs);

  // ── 검색 · 필터 ──
  const searchId = nextId('q');
  const search = h('input', {
    type: 'search', id: searchId, class: 'search-input', placeholder: '제목 검색 (초성도 돼요)', value: f.q,
    autocomplete: 'off', enterkeyhint: 'search', 'aria-label': '제목 검색', maxlength: '80',
  });
  const clearQ = h('button', { type: 'button', class: 'search-clear', 'aria-label': '검색어 지우기', hidden: !f.q }, icon('x'));
  let qTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(qTimer);
    clearQ.hidden = !search.value;
    qTimer = setTimeout(() => { f.q = search.value.trim(); shown = PAGE; renderFeed(); }, 120);
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') search.blur(); });
  clearQ.addEventListener('click', () => {
    search.value = '';
    clearQ.hidden = true;
    f.q = '';
    shown = PAGE;
    renderFeed();
    search.focus();
  });

  const yearSel = h('select', { class: 'select', 'aria-label': '연도로 거르기' });
  yearSel.addEventListener('change', () => { f.year = yearSel.value; shown = PAGE; renderFeed(); });
  const ratingSel = h('select', { class: 'select', 'aria-label': '평점으로 거르기' },
    RATING_FILTERS.map((r) => h('option', { value: r.key, text: r.label, selected: r.key === f.rating })));
  ratingSel.addEventListener('change', () => { f.rating = ratingSel.value; shown = PAGE; renderFeed(); });

  const groupBtn = h('button', { type: 'button', class: 'toggle', 'aria-pressed': String(prefs.getGroup()), title: '같은 작품의 기록을 하나로 묶어 봐요' },
    icon('stack'), h('span', { text: '작품별' }));
  groupBtn.addEventListener('click', () => {
    prefs.setGroup(!prefs.getGroup());
    groupBtn.setAttribute('aria-pressed', String(prefs.getGroup()));
    shown = PAGE;
    renderFeed();
  });

  const viewBtns = [['card', 'grid', '카드형'], ['list', 'list', '목록형']].map(([key, ic, label]) => {
    const b = h('button', { type: 'button', class: 'vt-btn', 'aria-label': label, title: label, dataset: { view: key } }, icon(ic), h('span', { class: 'vt-label', text: label }));
    b.addEventListener('click', () => { prefs.setView(key); syncView(); renderFeed(); });
    return b;
  });
  const viewToggle = h('div', { class: 'viewtoggle', role: 'group', 'aria-label': '보기 방식' }, viewBtns);
  function syncView() {
    for (const b of viewBtns) b.setAttribute('aria-pressed', String(b.dataset.view === prefs.getView()));
  }
  syncView();

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'search' }, h('label', { class: 'search-ico', htmlFor: searchId, 'aria-hidden': 'true' }, icon('search')), search, clearQ),
    h('div', { class: 'filters' }, yearSel, ratingSel));

  const sampleNote = h('div', { class: 'sample-note', hidden: true });
  const resultLine = h('div', { class: 'result-line', role: 'status' });
  const feedHead = h('div', { class: 'feed-head' }, resultLine, h('div', { class: 'feed-opts' }, groupBtn, viewToggle));
  const feed = h('div', { class: 'feed' });
  const more = h('div', { class: 'feed-more' });
  const controls = h('div', { class: 'controls' }, tabBar, toolbar);

  root.append(header, h('div', { class: 'container home-body' }, controls, sampleNote, feedHead, feed, more));

  function renderTabs() {
    const plays = repo.playsList();
    const counts = { '': plays.length };
    for (const k of GENRE_KEYS) counts[k] = 0;
    for (const p of plays) {
      const w = repo.getWork(p.workId);
      if (w) counts[w.genre] += 1;
    }
    for (const b of tabs) {
      const on = b.dataset.genre === f.genre;
      b.setAttribute('aria-pressed', String(on));
      b.countEl.textContent = String(counts[b.dataset.genre] || 0);
    }
  }

  function renderYears() {
    const plays = f.genre ? repo.playsList().filter((p) => (repo.getWork(p.workId) || {}).genre === f.genre) : repo.playsList();
    const years = yearsOf(plays);
    if (f.year && !years.includes(f.year)) years.unshift(f.year);
    yearSel.replaceChildren(h('option', { value: '', text: '전체 연도' }),
      ...years.map((y) => h('option', { value: y, text: `${y}년`, selected: y === f.year })));
    yearSel.value = f.year;
  }

  function renderSampleNote() {
    const n = repo.sampleCount();
    sampleNote.hidden = n === 0;
    if (!n) { sampleNote.replaceChildren(); return; }
    sampleNote.replaceChildren(
      icon('info'),
      h('span', { class: 'sample-note-text', text: `예시 기록 ${n}개가 섞여 있어요` }),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost', onClick: () => removeSamplesWithConfirm() }, '예시 지우기'));
  }

  function resetFilters() {
    f.q = ''; f.year = ''; f.rating = '';
    search.value = '';
    clearQ.hidden = true;
    ratingSel.value = '';
    shown = PAGE;
    renderAll();
  }

  function renderFeed() {
    if (io) { io.disconnect(); io = null; }
    const all = repo.playsList();
    const newLink = h('a', { class: 'btn btn-primary', href: f.genre ? `#/new?genre=${f.genre}` : '#/new' }, icon('plus'), h('span', { text: '첫 기록 남기기' }));
    document.getElementById('new-record')?.setAttribute('href', f.genre ? `#/new?genre=${f.genre}` : '#/new');

    // 기록이 하나도 없음 → 짧은 안내만
    if (!all.length) {
      controls.hidden = true;
      feedHead.hidden = true;
      more.replaceChildren();
      feed.className = 'feed';
      feed.replaceChildren(emptyState({
        icon: 'ticket',
        title: '아직 남긴 기록이 없어요',
        text: '보드게임·머더미스터리·방탈출을 하고 나서 제목과 날짜만 적어도 한 장의 티켓으로 남아요.',
        actions: [newLink, h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => loadSamples() }, '예시 기록 둘러보기')],
      }));
      return;
    }
    controls.hidden = false;
    feedHead.hidden = false;

    const entries = filterEntries(all, repo.workMap(), f);
    const group = prefs.getGroup();
    const view = prefs.getView();
    const items = group ? groupByWork(entries) : entries;
    const genreLabel = f.genre ? `${GENRES[f.genre].label} ` : '';
    const countText = group ? `작품 ${items.length}개 · 기록 ${entries.length}개` : `${genreLabel}기록 ${entries.length}개`;
    resultLine.replaceChildren(...[
      h('span', { text: hasFilter() ? `찾은 ${countText}` : countText }),
      hasFilter() ? h('button', { type: 'button', class: 'link-btn', onClick: resetFilters }, '조건 지우기') : null,
    ].filter(Boolean));

    if (!items.length) {
      feed.className = 'feed';
      more.replaceChildren();
      if (hasFilter()) {
        feed.replaceChildren(emptyState({
          icon: 'search', title: '조건에 맞는 기록이 없어요', text: '검색어나 연도·평점 조건을 바꿔 보세요.',
          actions: [h('button', { type: 'button', class: 'btn btn-ghost', onClick: resetFilters }, '조건 지우기')],
        }));
      } else {
        const g = GENRES[f.genre];
        feed.replaceChildren(emptyState({
          icon: g ? g.icon : 'ticket', title: `아직 ${g ? g.label : ''} 기록이 없어요`,
          actions: [h('a', { class: 'btn btn-primary', href: `#/new?genre=${f.genre}` }, icon('plus'), h('span', { text: `${g ? g.label : ''} 기록 남기기` }))],
        }));
      }
      return;
    }

    const slice = items.slice(0, shown);
    const ords = repo.ordinals();
    feed.className = `feed feed-${view}`;
    if (view === 'card') {
      feed.replaceChildren(...slice.map((it) => (group ? workCard(it) : playCard(it.play, it.work, { ordinal: ords.get(it.play.id) || 0 }))));
    } else {
      // 목록형은 달마다 묶어서 (날짜 칸에는 월.일만)
      const sections = [];
      let cur = null;
      for (const it of slice) {
        const date = group ? it.latest.date : it.play.date;
        const mk = monthKey(date);
        if (!cur || cur.key !== mk) {
          cur = { key: mk, rows: [] };
          sections.push(cur);
        }
        cur.rows.push(group ? workRow(it) : playRow(it.play, it.work, { ordinal: ords.get(it.play.id) || 0 }));
      }
      feed.replaceChildren(...sections.map((s) => h('section', { class: 'month' },
        h('h2', { class: 'month-head', text: fmtMonth(s.key) }),
        h('div', { class: 'rows' }, s.rows))));
    }

    more.replaceChildren();
    if (items.length > shown) {
      const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-more' }, `더 보기 (${items.length - shown}개 남음)`);
      const loadMore = () => { shown += PAGE; renderFeed(); };
      btn.addEventListener('click', loadMore);
      more.append(btn);
      if (typeof IntersectionObserver === 'function') {
        io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '600px 0px' });
        io.observe(btn);
      }
    }
  }

  function renderAll() {
    bookName.textContent = repo.state.bookName;
    renderTabs();
    renderYears();
    renderSampleNote();
    renderFeed();
  }

  renderAll();

  return {
    update() {
      document.title = repo.state.bookName;
      renderAll();
    },
    destroy() {
      if (io) io.disconnect();
      clearTimeout(qTimer);
    },
  };
}
