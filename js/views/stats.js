// 통계 화면 — 순수 CSS/SVG 차트
import { h, icon } from '../dom.js';
import { TYPES, TYPE_KEYS, MM_SCORES, WEEKDAYS } from '../constants.js';
import { state, memberInfo, isFirstLoad, loadFailed, recordsForStats } from '../store.js';
import { overview, boardgameStats, mmStats, erStats } from '../stats.js';
import { fmtAvg, fmtPct, fmtRemaining } from '../format.js';
import { segmented, avatar, emptyState, scoreBars, loadingState, loadErrorState, typeName } from '../ui.js';

const ui = { seg: 'all', minPlays: 1, showAllMembers: false };

// ── 차트 조각 ──
/** 넓은 화면(12칸 격자)에서 차지할 칸 수 — span-5 · span-7 · span-12 (기본 6칸) */
function span(el, cls) {
  if (el && cls) el.classList.add(cls);
  return el;
}

function tiles(items, cls = '') {
  return h('div', { class: ['tiles', `tiles-${items.length}`, cls] }, items.map((it) =>
    h('div', { class: ['tile', it.cls] },
      h('span', { class: 'tile-label' }, it.label),
      h('span', { class: 'tile-value' }, it.value, it.unit ? h('span', { class: 'tile-unit', text: it.unit }) : null),
      it.sub ? h('span', { class: 'tile-sub', text: it.sub }) : null)));
}

function card(title, sub, ...children) {
  return h('section', { class: 'card chart-card' },
    h('div', { class: 'chart-head' }, h('h2', { class: 'chart-title', text: title }), sub ? h('span', { class: 'chart-sub', text: sub }) : null),
    children);
}

/** 가로 막대: items [{label, value, text, lead, cls, sub}] */
function hbars(items, { max, emptyText = '아직 데이터가 없어요' } = {}) {
  if (!items.length) return h('p', { class: 'muted small', text: emptyText });
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return h('ul', { class: 'hbars' }, items.map((it) => {
    const fill = h('span', { class: ['hb-fill', it.cls] });
    fill.style.width = `${Math.max(it.value > 0 ? 2 : 0, (it.value / top) * 100)}%`;
    return h('li', { class: 'hb-row' },
      h('span', { class: 'hb-label' }, it.lead || null, h('span', { class: 'hb-name', text: it.label })),
      h('span', { class: 'hb-track', 'aria-hidden': 'true' }, fill),
      h('span', { class: 'hb-val' }, h('span', { text: it.text ?? String(it.value) }), it.sub ? h('span', { class: 'hb-sub', text: it.sub }) : null));
  }));
}

/** 세로 막대(누적 가능): cols [{label, segs:[{value, cls, name}], tip}] */
function columns(cols, { readoutDefault, legend, highlightMax = false } = {}) {
  const totals = cols.map((c) => c.segs.reduce((a, s) => a + s.value, 0));
  const top = Math.max(1, ...totals);
  const maxVal = Math.max(...totals);
  const readout = h('p', { class: 'col-readout', 'aria-live': 'polite' });
  const btns = [];
  const select = (i) => {
    btns.forEach((b, j) => b.setAttribute('aria-pressed', i === j ? 'true' : 'false'));
    readout.textContent = cols[i].tip;
  };
  const grid = h('div', { class: 'cols' }, cols.map((c, i) => {
    const stack = h('span', { class: 'col-stack' });
    for (const s of c.segs) {
      if (!s.value) continue;
      const seg = h('span', { class: ['col-seg', s.cls] });
      seg.style.height = `${(s.value / top) * 100}%`;
      stack.appendChild(seg);
    }
    const total = totals[i];
    const b = h('button', {
      type: 'button', class: `col${highlightMax && total === maxVal && total > 0 ? ' is-max' : ''}`, 'aria-pressed': 'false', 'aria-label': c.tip,
    },
    h('span', { class: 'col-val', text: total ? String(total) : '' }),
    h('span', { class: 'col-bar' }, stack),
    h('span', { class: 'col-label', text: c.label }));
    b.addEventListener('click', () => select(i));
    btns.push(b);
    return b;
  }));
  grid.style.setProperty('--cols', String(cols.length));
  const wrap = h('div', { class: 'colchart' },
    legend ? h('ul', { class: 'legend' }, legend.map((l) => h('li', { class: 'legend-item' }, h('span', { class: ['legend-key', l.cls], 'aria-hidden': 'true' }), h('span', { text: l.label })))) : null,
    grid, readout);
  select(readoutDefault ?? cols.length - 1);
  return wrap;
}

/** 두 값 비율 막대 */
function splitMeter(a, b) {
  const total = a.value + b.value;
  const bar = h('div', { class: 'meter', role: 'img', 'aria-label': `${a.label} ${a.value}, ${b.label} ${b.value}` });
  if (total) {
    const sa = h('span', { class: ['meter-seg', a.cls] });
    sa.style.flexGrow = String(a.value);
    const sb = h('span', { class: ['meter-seg', b.cls] });
    sb.style.flexGrow = String(b.value);
    if (a.value) bar.appendChild(sa);
    if (b.value) bar.appendChild(sb);
  } else bar.classList.add('is-empty');
  return h('div', { class: 'meter-wrap' }, bar,
    h('ul', { class: 'legend' },
      [a, b].map((x) => h('li', { class: 'legend-item' }, h('span', { class: ['legend-key', x.cls], 'aria-hidden': 'true' }), h('span', { text: `${x.label} ${x.value}` })))));
}

const mLead = (id) => avatar(id, 'xs');
const mName = (id) => memberInfo(id).name;
const liveMembers = (list) => list.filter((x) => x && x.memberId);

// ── 섹션 ──
function overviewView(records) {
  const now = new Date();
  const ov = overview(records, state.members, now);
  if (!ov.total) return emptyState({ icon: 'chart', title: '통계를 낼 기록이 없어요', text: '기록이 쌓이면 여기에 그래프가 그려져요.' });

  const monthly = (ov.monthly || []).map((mo) => {
    const [y, m] = mo.ym.split('-');
    const parts = TYPE_KEYS.map((k) => `${TYPES[k].label} ${(mo.byType && mo.byType[k]) || 0}`).join(' · ');
    return {
      label: `${Number(m)}`,
      tip: `${y}년 ${Number(m)}월 — 총 ${mo.count}개 (${parts})`,
      segs: TYPE_KEYS.map((k) => ({ value: (mo.byType && mo.byType[k]) || 0, cls: `fill-${k}` })),
    };
  });
  const wd = (ov.weekday || []).map((n, i) => ({ label: WEEKDAYS[i], tip: `${WEEKDAYS[i]}요일 — ${n}개`, segs: [{ value: n, cls: 'fill-ink' }] }));
  const maxWd = Math.max(...(ov.weekday || [0]));
  const favWd = maxWd > 0 ? (ov.weekday || []).map((n, i) => (n === maxWd ? WEEKDAYS[i] : null)).filter(Boolean) : [];

  const mc = liveMembers(ov.memberCounts || []);
  const shown = ui.showAllMembers ? mc : mc.slice(0, 8);
  const moreBtn = mc.length > 8
    ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-block', onClick: () => { ui.showAllMembers = !ui.showAllMembers; rerender(); } }, ui.showAllMembers ? '접기' : `${mc.length - 8}명 더 보기`)
    : null;

  const typeTiles = TYPE_KEYS.map((k) => ({ label: typeName(k), value: String(ov.byType[k] || 0), unit: '회', cls: `tile-type ${TYPES[k].cls}` }));
  return [
    tiles([{ label: '전체 기록', value: String(ov.total), unit: '개', cls: 'tile-hero' }, { label: '이번 달', value: String(ov.thisMonth), unit: '개' }], 'span-5'),
    tiles(typeTiles, 'span-7'),
    span(card('월별 기록', '최근 12개월 · 막대를 누르면 자세히',
      columns(monthly, { legend: TYPE_KEYS.map((k) => ({ label: TYPES[k].label, cls: `fill-${k}` })) })), 'span-7'),
    span(card('요일별', favWd.length ? `주로 ${favWd.join('·')}요일에 모여요` : '',
      columns(wd, { readoutDefault: Math.max(0, (ov.weekday || []).indexOf(maxWd)), highlightMax: true })), 'span-5'),
    span(card('멤버별 참여', `총 ${mc.length}명`,
      hbars(shown.map((x) => ({ label: mName(x.memberId), value: x.count, text: `${x.count}회`, lead: mLead(x.memberId), cls: `mc-${memberInfo(x.memberId).color} fill-member` }))),
      moreBtn), 'span-12'),
  ];
}

function bgView(records) {
  const s = boardgameStats(records);
  if (!s.plays) return emptyState({ icon: 'dice', title: '보드게임 기록이 없어요', text: '보드게임을 기록하면 승률과 인기 게임을 보여 드려요.' });
  const tw = s.topWinner && s.topWinner.memberId ? s.topWinner : null;
  const minSel = h('div', { class: 'minplays', role: 'group', 'aria-label': '결과가 기록된 판 최소 수' },
    h('span', { class: 'minplays-label', text: '최소' }),
    [1, 3, 5, 10].map((n) => h('button', {
      type: 'button', class: 'chip chip-sm', 'aria-pressed': ui.minPlays === n ? 'true' : 'false',
      onClick: () => { ui.minPlays = n; rerender(); },
    }, `${n}판`)));
  const rates = liveMembers(s.memberWinRates || []);
  // 승률은 결과(승자·협력 승패)가 기록된 판만으로 계산 — '미기록' 판을 패배로 세지 않음
  const eligible = rates.filter((x) => (x.decided || 0) >= ui.minPlays)
    .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.decided - a.decided);
  const hidden = rates.length - eligible.length;

  return [
    tiles([
      { label: '플레이', value: String(s.plays), unit: '판', cls: 'tile-hero t-boardgame' },
      { label: '플레이한 게임', value: String((s.topGames || []).length), unit: '종' },
    ], tw ? 'span-5' : 'span-12'),
    tw ? h('section', { class: 'card champ t-boardgame span-7' },
      h('span', { class: 'champ-ico', 'aria-hidden': 'true' }, icon('trophy')),
      avatar(tw.memberId, 'lg'),
      h('div', { class: 'champ-text' },
        h('span', { class: 'champ-label', text: '최다 우승자' }),
        h('span', { class: 'champ-name', text: mName(tw.memberId) }),
        h('span', { class: 'champ-sub', text: `${tw.wins}번 우승` }))) : null,
    card('많이 한 게임', 'TOP 10',
      hbars((s.topGames || []).slice(0, 10).map((g) => ({ label: g.title, value: g.count, text: `${g.count}판`, cls: 'fill-boardgame' })))),
    card('멤버별 승률', '결과가 기록된 판 대비 승리',
      minSel,
      hbars(eligible.map((x) => ({
        label: mName(x.memberId), value: Math.round((x.rate || 0) * 100), text: fmtPct(x.rate), sub: `${x.wins}승/${x.decided}판`,
        lead: mLead(x.memberId), cls: `mc-${memberInfo(x.memberId).color} fill-member`,
      })), { max: 100, emptyText: '조건에 맞는 멤버가 없어요' }),
      hidden > 0 ? h('p', { class: 'chart-note', text: `결과가 기록된 판이 ${ui.minPlays}판 미만인 ${hidden}명은 빠져 있어요` }) : null),
  ];
}

function mmView(records) {
  const s = mmStats(records);
  if (!s.plays) return emptyState({ icon: 'magnifier', title: '머더미스터리 기록이 없어요', text: '머더미스터리를 기록하면 범인 검거율과 평점을 모아 보여 드려요.' });
  const c = s.culprit || { caught: 0, escaped: 0, rate: null };
  const ms = liveMembers(s.memberStats || []).filter((x) => x.plays > 0);
  const avg = s.avgScores || {};
  const hasAvg = MM_SCORES.some((x) => avg[x.key] !== null && avg[x.key] !== undefined);

  const table = ms.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'stable' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: '멤버' }), h('th', { scope: 'col', text: '플레이' }), h('th', { scope: 'col', text: '범인' }),
        h('th', { scope: 'col', text: '범인 생존' }), h('th', { scope: 'col', text: '승률' }), h('th', { scope: 'col', text: 'MVP' }))),
      h('tbody', {}, ms.map((x) => h('tr', {},
        h('th', { scope: 'row' }, h('span', { class: 'cell-m' }, mLead(x.memberId), h('span', { text: mName(x.memberId) }))),
        h('td', { text: String(x.plays) }),
        h('td', { text: x.culpritCount ? `${x.culpritCount}번` : '–' }),
        // 검거/도주 결과가 기록된 판만으로 (위의 범인 검거율과 같은 기준)
        h('td', { text: x.culpritDecided ? fmtPct(x.culpritEscapeRate) : '–' }),
        h('td', { text: x.decided ? fmtPct(x.winRate) : '–' }),
        h('td', { text: x.mvpCount ? `${x.mvpCount}번` : '–' }))))))
    : h('p', { class: 'muted small', text: '역할을 기록하면 멤버별 통계가 보여요' });

  return [
    tiles([
      { label: '플레이', value: String(s.plays), unit: '회', cls: 'tile-hero t-murdermystery' },
      { label: '시나리오', value: String(s.scenarios), unit: '편' },
      { label: '평균 별점', value: s.avgRating === null || s.avgRating === undefined ? '–' : fmtAvg(s.avgRating), sub: s.avgRating ? '5점 만점' : '평가 없음' },
      { label: '범인 검거율', value: fmtPct(c.rate), sub: `${c.caught + c.escaped}번 중 ${c.caught}번` },
    ]),
    span(card('범인 검거', '검거 성공 vs 범인 도주',
      splitMeter({ label: '검거', value: c.caught || 0, cls: 'fill-caught' }, { label: '도주', value: c.escaped || 0, cls: 'fill-escaped' })), 'span-5'),
    span(card('멤버별 기록', '범인 생존 = 범인일 때 도주율 (결과 기록된 판)', table), 'span-12'),
    span(card('제작사별', '',
      hbars((s.byPublisher || []).slice(0, 10).map((p) => ({ label: p.name, value: p.count, text: `${p.count}회`, cls: 'fill-murdermystery' })), { emptyText: '제작사를 기록하면 보여요' })), 'span-12'),
    span(card('세부 점수 평균', '',
      hasAvg
        ? scoreBars(MM_SCORES.map((x) => ({ label: x.label, value: avg[x.key] ? Math.round(avg[x.key] * 10) / 10 : 0 })), { cls: 'scorebars-mm' })
        : h('p', { class: 'muted small', text: '세부 점수를 남기면 평균을 보여 드려요' })), 'span-7'),
  ];
}

function distCols(dist, label) {
  const arr = Array.isArray(dist) ? dist : [];
  return columns([1, 2, 3, 4, 5].map((i) => ({ label: `${i}`, tip: `${label} ${i} — ${arr[i] || 0}회`, segs: [{ value: arr[i] || 0, cls: 'fill-escaperoom' }] })),
    { readoutDefault: Math.max(0, [1, 2, 3, 4, 5].reduce((best, i) => ((arr[i] || 0) > (arr[best] || 0) ? i : best), 1) - 1), highlightMax: true });
}

function erView(records) {
  const s = erStats(records);
  if (!s.plays) return emptyState({ icon: 'door', title: '방탈출 기록이 없어요', text: '방탈출을 기록하면 성공률과 남은 시간을 모아 보여 드려요.' });
  const ms = liveMembers(s.memberStats || []).filter((x) => x.plays > 0).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.plays - a.plays);
  const unratedD = (s.difficultyDist || [])[0] || 0;
  const unratedF = (s.fearDist || [])[0] || 0;
  return [
    tiles([
      { label: '방탈출', value: String(s.plays), unit: '개', cls: 'tile-hero t-escaperoom' },
      { label: '성공률', value: fmtPct(s.clearRate), sub: `${s.cleared}개 탈출` },
      { label: '평균 힌트', value: fmtAvg(s.avgHints), unit: '개' },
      { label: '평균 남은 시간', value: s.avgRemainingSec === null || s.avgRemainingSec === undefined ? '–' : fmtRemaining(s.avgRemainingSec), sub: '성공한 테마 기준' },
    ]),
    card('브랜드별', '',
      hbars((s.byBrand || []).slice(0, 10).map((b) => ({ label: b.name, value: b.count, text: `${b.count}개`, cls: 'fill-escaperoom' })), { emptyText: '브랜드를 기록하면 보여요' })),
    card('멤버별 성공률', '',
      hbars(ms.map((x) => ({
        label: mName(x.memberId), value: Math.round((x.rate || 0) * 100), text: fmtPct(x.rate), sub: `${x.cleared}/${x.plays}`,
        lead: mLead(x.memberId), cls: `mc-${memberInfo(x.memberId).color} fill-member`,
      })), { max: 100 })),
    card('체감 난이도', unratedD ? `미평가 ${unratedD}개 제외` : '', distCols(s.difficultyDist, '난이도')),
    card('공포도', unratedF ? `미평가 ${unratedF}개 제외` : '', distCols(s.fearDist, '공포도')),
  ];
}

// ── 마운트 ──
let rerender = () => {};

export function mount(root, ctx) {
  const q = ctx.query || {};
  if (q.type && (q.type === 'all' || TYPE_KEYS.includes(q.type))) ui.seg = q.type;
  const body = h('div', { class: 'stats-body' });
  const seg = segmented({
    label: '통계 종류', value: ui.seg, cls: 'seg-type',
    options: [{ key: 'all', label: '전체' }, ...TYPE_KEYS.map((k) => ({ key: k, label: typeName(k, 'tight'), cls: TYPES[k].cls }))],
    onChange: (v) => { ui.seg = v; ui.minPlays = 1; draw(); },
  });
  function draw() {
    // 연결한 게임 이름으로 셈 (게임 이름을 고쳐도 한 게임으로)
    const recs = recordsForStats();
    let content;
    try {
      // 아직 못 받았거나 받지 못한 상태를 "기록 없음"으로 보이지 않게
      if (!recs.length && isFirstLoad()) content = loadingState();
      else if (!recs.length && loadFailed()) content = loadErrorState(ctx.refresh);
      else content = ui.seg === 'boardgame' ? bgView(recs) : ui.seg === 'murdermystery' ? mmView(recs) : ui.seg === 'escaperoom' ? erView(recs) : overviewView(recs);
    } catch (e) {
      console.error(e);
      content = emptyState({ icon: 'info', title: '통계를 계산하지 못했어요', text: '잠시 후 다시 열어 주세요.' });
    }
    body.replaceChildren(...[content].flat().filter(Boolean));
  }
  rerender = draw;
  root.appendChild(h('div', { class: 'page page-stats' },
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: '통계' })),
    seg, body));
  draw();
  return { update: draw, destroy() { rerender = () => {}; } };
}
