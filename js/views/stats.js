// 통계 화면 — 기간(전체 기간 · 올해 · 이번 달)을 고르면 화면의 모든 통계에 똑같이 적용 (플레이 날짜 기준)
// 내 활동·취향을 먼저: 요약 숫자 → 많이 한·높게 평가한 게임·자주 함께한 멤버 → 멤버별 순위와 승률
// 결과·별점을 적지 않은 판은 0점·패배·실패로 세지 않고 '기록 없음'으로 따로 보여 줌
import { h, icon, starShape } from '../dom.js';
import { TYPES, TYPE_KEYS, MM_SCORES, WEEKDAYS } from '../constants.js';
import { state, memberInfo, isFirstLoad, loadFailed, recordsForStats, recordById, gameOfRecord, getMeId } from '../store.js';
import {
  overview, boardgameStats, bgMemberTable, mmStats, erStats, gameEntries, filterPeriod, mateRanking, monthlyOf,
} from '../stats.js';
import { fmtAvg, fmtPct, fmtRemaining, fmtDateDot } from '../format.js';
import { segmented, emptyState, scoreBars, loadingState, loadErrorState, typeName } from '../ui.js';
import { meChip, memberAvatar } from './members.js';
import { reviewExcerpt, gamePageHref } from './bits.js';
import { gameThumb } from './game-form.js';

const PERIODS = [
  { key: 'all', label: '전체 기간' },
  { key: 'year', label: '올해' },
  { key: 'month', label: '이번 달' },
];
const ui = { seg: 'all', period: 'all', showAllMembers: false, showAllWorks: false };

// ── 조각 ──
/** 넓은 화면(12칸 격자)에서 차지할 칸 수 — span-4 · span-5 · span-7 · span-12 (기본 6칸) */
function span(el, cls) {
  if (el && cls) el.classList.add(cls);
  return el;
}

function tiles(items, cls = '') {
  return h('div', { class: ['tiles', `tiles-${items.length}`, cls] }, items.map((it) =>
    h('div', { class: ['tile', it.cls, it.empty ? 'is-empty' : ''] },
      h('span', { class: 'tile-label' }, it.label),
      h('span', { class: 'tile-value' }, it.value, it.unit ? h('span', { class: 'tile-unit', text: it.unit }) : null),
      it.sub ? h('span', { class: 'tile-sub', text: it.sub }) : null)));
}

function card(title, sub, ...children) {
  return h('section', { class: 'card chart-card' },
    h('div', { class: 'chart-head' }, h('h2', { class: 'chart-title', text: title }), sub ? h('span', { class: 'chart-sub', text: sub }) : null),
    children);
}

/** 큰 빈 카드 대신 짧은 안내 한 줄 */
const note = (text) => h('p', { class: 'stat-note' }, icon('info'), h('span', { text }));

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

const mName = (id) => memberInfo(id).name;
const liveMembers = (list) => list.filter((x) => x && x.memberId && !memberInfo(x.memberId).missing);
const meBadge = (id) => (id === getMeId() ? h('span', { class: 'me-badge', text: '나' }) : null);
const stars = (v) => h('span', { class: 'srate', role: 'img', 'aria-label': `별점 ${v.toFixed(1)}점` }, starShape('rcard-star'), h('span', { text: v.toFixed(1) }));

/** 이 기간의 게임별 요약 (기록이 있는 것만, 최근에 한 순) */
function playedGames(recs, type) {
  return gameEntries(recs, state.games).filter((e) => e.type === type && e.plays > 0);
}

/** 게임 줄: 작은 표지 · 이름 · (보조 한 줄) | 오른쪽 값 */
function gameRows(list, right, { sub } = {}) {
  return h('ol', { class: 'glines' }, list.map((e) =>
    h('li', { class: 'gline' },
      h('a', { class: 'gline-link', href: gamePageHref(e) },
        gameThumb({ type: e.type, cover: e.cover }, 'gthumb gthumb-sm'),
        h('span', { class: 'gline-text' },
          h('span', { class: 'gline-name', text: e.title }),
          sub ? h('span', { class: 'gline-sub', text: sub(e) }) : null),
        h('span', { class: 'gline-right' }, right(e))))));
}

/** 자주 함께한 멤버 (나는 빼고, 기록 하나 = 한 번) */
function matesCard(recs, { title = '자주 함께한 멤버', max = 5 } = {}) {
  const list = mateRanking(recs, { exclude: getMeId(), keep: (id) => !memberInfo(id).missing }).slice(0, max);
  return card(title, getMeId() ? '나는 빼고 · 함께한 판 수' : '함께한 판 수',
    list.length
      ? h('ol', { class: 'mlines' }, list.map((x) => {
        const m = state.members.find((y) => y.id === x.memberId);
        return h('li', { class: 'mline' },
          h('a', { class: 'mline-link', href: `#/member/${encodeURIComponent(x.memberId)}` },
            memberAvatar(m || { name: mName(x.memberId) }),
            h('span', { class: 'mline-name', text: mName(x.memberId) }),
            h('span', { class: 'mline-n', text: `${x.count}번` })));
      }))
      : h('p', { class: 'muted small', text: '함께한 멤버를 기록하면 보여요' }));
}

/** 플레이한 작품·테마: 표지 · 이름 · 날짜 · 내 별점 · 감상 첫 부분 (스포일러 감상은 목록에 내지 않음) */
function worksCard(recs, type, { title, extra } = {}) {
  const works = playedGames(recs, type);
  const shown = ui.showAllWorks ? works : works.slice(0, 6);
  const more = works.length > 6
    ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-block', onClick: () => { ui.showAllWorks = !ui.showAllWorks; rerender(); } }, ui.showAllWorks ? '접기' : `${works.length - 6}개 더 보기`)
    : null;
  return card(title, `${works.length}${TYPES[type].noun === '테마' ? '개' : '편'}`,
    h('ul', { class: 'works' }, shown.map((e) => {
      const r = recordById(e.latestId);
      const excerpt = r && !r.spoiler ? reviewExcerpt(r) : '';
      return h('li', { class: 'work' },
        h('a', { class: 'work-link', href: r ? `#/record/${encodeURIComponent(r.id)}` : gamePageHref(e) },
          gameThumb({ type: e.type, cover: e.cover }, 'gthumb work-thumb'),
          h('span', { class: 'work-text' },
            h('span', { class: 'work-top' },
              h('span', { class: 'work-name', text: e.title }),
              e.avgRating ? stars(e.avgRating) : h('span', { class: 'srate is-empty', text: '별점 없음' })),
            h('span', { class: 'work-meta' },
              h('span', { text: fmtDateDot(e.lastDate) }),
              e.plays > 1 ? h('span', { text: `${e.plays}회${e.avgRating && e.rated > 1 ? ' · 평균 별점' : ''}` }) : null,
              extra ? extra(r) : null),
            excerpt ? h('span', { class: 'work-review', text: excerpt })
              : r && r.spoiler ? h('span', { class: 'work-review is-hidden', text: '스포일러로 가린 감상' }) : null)));
    })),
    more);
}

// ── 전체 ──
function overviewView(recs, period, now) {
  const ov = overview(recs, state.members, now);
  const months = [];
  if (period === 'year') {
    for (let m = 1; m <= 12; m++) months.push(`${now.getFullYear()}-${String(m).padStart(2, '0')}`);
  } else if (period === 'all') {
    for (const mo of ov.monthly || []) months.push(mo.ym);
  }
  const monthly = monthlyOf(recs, months).map((mo) => {
    const [y, m] = mo.ym.split('-');
    const parts = TYPE_KEYS.map((k) => `${TYPES[k].label} ${mo.byType[k] || 0}`).join(' · ');
    return {
      label: `${Number(m)}`,
      tip: `${y}년 ${Number(m)}월 — 총 ${mo.count}개 (${parts})`,
      segs: TYPE_KEYS.map((k) => ({ value: mo.byType[k] || 0, cls: `fill-${k}` })),
    };
  });
  const wd = (ov.weekday || []).map((n, i) => ({ label: WEEKDAYS[i], tip: `${WEEKDAYS[i]}요일 — ${n}개`, segs: [{ value: n, cls: 'fill-ink' }] }));
  const maxWd = Math.max(...(ov.weekday || [0]));
  const favWd = maxWd > 0 ? (ov.weekday || []).map((n, i) => (n === maxWd ? WEEKDAYS[i] : null)).filter(Boolean) : [];

  // 떠난 멤버도 '(떠난 멤버)'로 참여 횟수에는 남김 (순위·승률 표에서는 뺌)
  const mc = (ov.memberCounts || []).filter((x) => x && x.memberId && x.count > 0);
  const shown = ui.showAllMembers ? mc : mc.slice(0, 8);
  const moreBtn = mc.length > 8
    ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-block', onClick: () => { ui.showAllMembers = !ui.showAllMembers; rerender(); } }, ui.showAllMembers ? '접기' : `${mc.length - 8}명 더 보기`)
    : null;

  // 이번 달을 고르면 달별 막대는 한 칸뿐이라 그리지 않음
  return [
    tiles([
      { label: '기록', value: String(ov.total), unit: '개', cls: 'tile-hero' },
      ...TYPE_KEYS.map((k) => ({ label: typeName(k), value: String(ov.byType[k] || 0), unit: '회', cls: `tile-type ${TYPES[k].cls}` })),
    ]),
    months.length ? span(card('월별 기록', `${period === 'year' ? `${now.getFullYear()}년` : '최근 12개월'} · 막대를 누르면 자세히`,
      columns(monthly, { readoutDefault: period === 'year' ? now.getMonth() : undefined, legend: TYPE_KEYS.map((k) => ({ label: TYPES[k].label, cls: `fill-${k}` })) })), 'span-7') : null,
    span(card('요일별', favWd.length ? `주로 ${favWd.join('·')}요일에 모여요` : '',
      columns(wd, { readoutDefault: Math.max(0, (ov.weekday || []).indexOf(maxWd)), highlightMax: true })), months.length ? 'span-5' : 'span-6'),
    span(card('멤버별 참여', `${mc.length}명 · 기록 하나를 한 번으로`,
      hbars(shown.map((x) => ({ label: mName(x.memberId), value: x.count, text: `${x.count}회`, cls: `mc-${memberInfo(x.memberId).color} fill-member` })), { emptyText: '함께한 멤버를 기록하면 보여요' }),
      moreBtn), months.length ? 'span-12' : 'span-6'),
  ];
}

// ── 보드게임 ──
function bgView(recs) {
  const s = boardgameStats(recs);
  if (!s.plays) return emptyState({ icon: 'dice', title: '이 기간의 보드게임 기록이 없어요', text: '보드게임을 기록하면 많이 한 게임과 승률을 보여 드려요.' });
  const games = playedGames(recs, 'boardgame');
  const me = getMeId();
  const mine = me ? (s.memberWinRates || []).find((x) => x.memberId === me) : null;
  let myRate;
  if (!me) myRate = { label: '내 승률', value: '–', sub: '‘나’를 고르면 보여요', empty: true };
  else if (!mine) myRate = { label: '내 승률', value: '–', sub: '내가 함께한 판이 없어요', empty: true };
  else if (!mine.decided) myRate = { label: '내 승률', value: '–', sub: '결과 기록 없음', empty: true };
  else myRate = { label: '내 승률', value: fmtPct(mine.rate), sub: `결과를 기록한 ${mine.decided}판 기준` };

  const most = [...games].sort((a, b) => b.plays - a.plays || b.lastDate.localeCompare(a.lastDate)).slice(0, 5);
  const best = games.filter((e) => e.avgRating !== null).sort((a, b) => b.avgRating - a.avgRating || b.rated - a.rated).slice(0, 5);
  const unrated = games.length - games.filter((e) => e.avgRating !== null).length;

  const table = bgMemberTable(recs, { keep: (id) => !memberInfo(id).missing });
  const ranked = table.filter((x) => x.decided);
  const noResult = table.length - ranked.length;
  const rows = ranked.length
    ? h('div', { class: 'srank' },
      h('div', { class: 'srank-head', 'aria-hidden': 'true' },
        h('span', { text: '순위' }), h('span', { text: '멤버' }), h('span', { text: '승리' }), h('span', { text: '승률' })),
      h('ol', { class: 'srank-list' }, ranked.map((x) => h('li', { class: `srank-row${x.place <= 3 ? ` is-p${x.place}` : ''}${x.memberId === me ? ' is-me' : ''}` },
        h('span', { class: 'srank-place', text: String(x.place), 'aria-label': `${x.place}위` }),
        h('span', { class: 'srank-who' },
          h('span', { class: 'srank-name' }, h('span', { text: mName(x.memberId) }), meBadge(x.memberId)),
          x.avgRank !== null ? h('span', { class: 'srank-sub', text: `평균 ${fmtAvg(x.avgRank)}등` }) : null),
        h('span', { class: 'srank-wins', text: `${x.wins}승` }),
        h('span', { class: 'srank-rate' }, h('span', { class: 'srank-pct', text: fmtPct(x.rate) }), h('span', { class: 'srank-n', text: `${x.decided}판 기준` }))))))
    : h('p', { class: 'muted small', text: '결과(점수·순위·협력 승패)를 적은 판이 없어요' });

  return [
    tiles([
      { label: '플레이', value: String(s.plays), unit: '판', cls: 'tile-hero t-boardgame' },
      { label: '플레이한 게임', value: String(games.length), unit: '종' },
      myRate,
    ]),
    span(card('많이 한 게임', '',
      gameRows(most, (e) => h('span', { class: 'gline-n', text: `${e.plays}판` }))), 'span-4'),
    span(card('높게 평가한 게임', unrated ? `별점 없는 ${unrated}개는 빠져요` : '',
      best.length
        ? gameRows(best, (e) => stars(e.avgRating), { sub: (e) => (e.rated > 1 ? `${e.rated}판 평균` : '') })
        : h('p', { class: 'muted small', text: '별점을 남기면 보여요' })), 'span-4'),
    span(matesCard(recs.filter((r) => r.type === 'boardgame')), 'span-4'),
    span(card('멤버별 순위와 승률', '승리 수 순 · 결과를 기록한 판 기준',
      rows,
      h('p', { class: 'chart-note', text: `승리 = 1등(공동 포함)·팀 승리·협력 승리. 결과를 적지 않은 판은 승률에 넣지 않아요.${noResult ? ` 결과 기록이 없는 ${noResult}명은 빠져 있어요.` : ''} 평균 등수는 인원이 다른 판을 섞은 참고 값이에요.` })), 'span-12'),
  ];
}

// ── 머더미스터리 ──
function mmView(recs) {
  const s = mmStats(recs);
  if (!s.plays) return emptyState({ icon: 'magnifier', title: '이 기간의 머더미스터리 기록이 없어요', text: '머더미스터리를 기록하면 플레이한 작품과 별점을 모아 보여 드려요.' });
  const c = s.culprit || { caught: 0, escaped: 0, decided: 0, rate: null };
  const avg = s.avgScores || {};
  const hasAvg = MM_SCORES.some((x) => avg[x.key] !== null && avg[x.key] !== undefined);
  const ms = liveMembers(s.memberStats || []).filter((x) => x.plays > 0);
  const detailed = ms.filter((x) => x.culpritCount || x.decided || x.mvpCount);

  // 범인 검거: 검거율 숫자와 막대를 한 칸에. 결과가 없으면 0%가 아니라 '결과 기록 없음'
  const culprit = span(card('범인 검거', c.decided ? `결과를 기록한 ${c.decided}판 기준` : '',
    c.decided
      ? [h('p', { class: 'big-rate' }, h('span', { class: 'big-rate-v', text: fmtPct(c.rate) }), h('span', { class: 'big-rate-l', text: '검거율' })),
        splitMeter({ label: '검거', value: c.caught, cls: 'fill-caught' }, { label: '도주', value: c.escaped, cls: 'fill-escaped' })]
      : h('p', { class: 'big-none', text: '결과 기록 없음' })), 'span-5');

  // 멤버별: 대부분 비어 있으면 접어 둠
  const memberLines = h('ul', { class: 'flines' }, ms.map((x) => {
    const facts = [
      `${x.plays}회`,
      x.culpritCount ? `범인 ${x.culpritCount}번` : '',
      x.culpritDecided ? `범인 생존 ${fmtPct(x.culpritEscapeRate)}` : '',
      x.decided ? `승률 ${fmtPct(x.winRate)}` : '',
      x.mvpCount ? `MVP ${x.mvpCount}번` : '',
    ].filter(Boolean);
    return h('li', { class: 'fline', 'data-member-id': x.memberId },
      h('span', { class: 'fline-name' }, h('span', { text: mName(x.memberId) }), meBadge(x.memberId)),
      h('span', { class: 'fline-facts', text: facts.join(' · ') }));
  }));
  let members = null;
  if (ms.length) {
    const head = h('span', { class: 'fold-title' }, '멤버별 기록', h('span', { class: 'fold-sub', text: detailed.length ? `결과를 적은 멤버 ${detailed.length}명` : '역할·결과 기록 없음' }));
    members = detailed.length * 2 >= ms.length
      ? card('멤버별 기록', '범인 생존 = 범인일 때 도주율 (결과 기록된 판)', memberLines)
      : h('details', { class: 'card fold' }, h('summary', { class: 'fold-sum' }, head, icon('down', 'fold-ico')), h('div', { class: 'fold-body' }, memberLines));
  }

  const notes = [
    hasAvg ? null : note('세부 점수 기록이 없어요'),
  ].filter(Boolean);

  return [
    tiles([
      { label: '플레이', value: String(s.plays), unit: '회', cls: 'tile-hero t-murdermystery' },
      { label: '작품', value: String(s.scenarios), unit: '편' },
      s.avgRating === null || s.avgRating === undefined
        ? { label: '평균 별점', value: '–', sub: '별점 기록 없음', empty: true }
        : { label: '평균 별점', value: fmtAvg(s.avgRating), sub: '별점을 남긴 판만' },
    ]),
    span(worksCard(recs, 'murdermystery', { title: '플레이한 작품' }), 'span-7'),
    culprit,
    hasAvg ? span(card('세부 점수 평균', '',
      scoreBars(MM_SCORES.map((x) => ({ label: x.label, value: avg[x.key] ? Math.round(avg[x.key] * 10) / 10 : 0 })), { cls: 'scorebars-mm' })), 'span-5') : null,
    members ? span(members, 'span-7') : null,
    (s.byPublisher || []).length ? span(card('제작사별', '',
      hbars(s.byPublisher.slice(0, 10).map((p) => ({ label: p.name, value: p.count, text: `${p.count}회`, cls: 'fill-murdermystery' })))), 'span-5') : null,
    notes.length ? h('div', { class: 'stat-notes span-12' }, notes) : null,
  ];
}

// ── 방탈출 ──
function distCols(dist, label) {
  const arr = Array.isArray(dist) ? dist : [];
  return columns([1, 2, 3, 4, 5].map((i) => ({ label: `${i}`, tip: `${label} ${i} — ${arr[i] || 0}회`, segs: [{ value: arr[i] || 0, cls: 'fill-escaperoom' }] })),
    { readoutDefault: Math.max(0, [1, 2, 3, 4, 5].reduce((best, i) => ((arr[i] || 0) > (arr[best] || 0) ? i : best), 1) - 1), highlightMax: true });
}

const rated = (dist) => (Array.isArray(dist) ? dist.slice(1).reduce((a, b) => a + b, 0) : 0);

function erView(recs) {
  // 예전 기록의 브랜드가 비어 있으면 테마(게임 정보)의 브랜드로
  const withBrand = recs.map((r) => {
    if (r.type !== 'escaperoom' || (r.er && r.er.brand)) return r;
    const g = gameOfRecord(r);
    return g && g.brand ? { ...r, er: { ...(r.er || {}), brand: g.brand } } : r;
  });
  const s = erStats(withBrand);
  if (!s.plays) return emptyState({ icon: 'door', title: '이 기간의 방탈출 기록이 없어요', text: '방탈출을 기록하면 테마와 성공률을 모아 보여 드려요.' });
  const ms = liveMembers(s.memberStats || []).filter((x) => x.decided > 0).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.decided - a.decided);
  const undecided = s.plays - s.decided;
  const result = (r) => {
    const v = r && r.er ? r.er.cleared : null;
    return v === true ? h('span', { class: 'rbadge rbadge-clear', text: '성공' }) : v === false ? h('span', { class: 'rbadge rbadge-fail', text: '실패' }) : null;
  };
  const notes = [
    rated(s.difficultyDist) || rated(s.fearDist) ? null : note('난이도·공포도 기록이 없어요'),
  ].filter(Boolean);
  return [
    tiles([
      { label: '방탈출', value: String(s.plays), unit: '개', cls: 'tile-hero t-escaperoom' },
      s.decided
        ? { label: '성공률', value: fmtPct(s.clearRate), sub: `결과를 기록한 ${s.decided}개 기준` }
        : { label: '성공률', value: '–', sub: '결과 기록 없음', empty: true },
      s.avgHints === null || s.avgHints === undefined
        ? { label: '평균 힌트', value: '–', sub: '기록 없음', empty: true }
        : { label: '평균 힌트', value: fmtAvg(s.avgHints), unit: '개' },
      s.avgRemainingSec === null || s.avgRemainingSec === undefined
        ? { label: '평균 남은 시간', value: '–', sub: '기록 없음', empty: true }
        : { label: '평균 남은 시간', value: fmtRemaining(s.avgRemainingSec), sub: '성공한 테마 기준' },
    ]),
    span(worksCard(recs, 'escaperoom', { title: '플레이한 테마', extra: result }), 'span-7'),
    span(card('멤버별 성공률', undecided ? `결과를 적지 않은 ${undecided}개는 빠져요` : '결과를 기록한 테마 기준',
      hbars(ms.map((x) => ({
        label: mName(x.memberId), value: Math.round((x.rate || 0) * 100), text: fmtPct(x.rate), sub: `${x.cleared}/${x.decided}`,
        cls: `mc-${memberInfo(x.memberId).color} fill-member`,
      })), { max: 100, emptyText: '성공·실패를 기록하면 보여요' })), 'span-5'),
    (s.byBrand || []).length ? span(card('브랜드별', '',
      hbars(s.byBrand.slice(0, 10).map((b) => ({ label: b.name, value: b.count, text: `${b.count}개`, cls: 'fill-escaperoom' })))), 'span-6') : null,
    rated(s.difficultyDist) ? span(card('체감 난이도', s.difficultyDist[0] ? `미평가 ${s.difficultyDist[0]}개 제외` : '', distCols(s.difficultyDist, '난이도')), 'span-6') : null,
    rated(s.fearDist) ? span(card('공포도', s.fearDist[0] ? `미평가 ${s.fearDist[0]}개 제외` : '', distCols(s.fearDist, '공포도')), 'span-6') : null,
    notes.length ? h('div', { class: 'stat-notes span-12' }, notes) : null,
  ];
}

// ── 마운트 ──
let rerender = () => {};

export function mount(root, ctx) {
  const q = ctx.query || {};
  if (q.type && (q.type === 'all' || TYPE_KEYS.includes(q.type))) ui.seg = q.type;
  if (q.period && PERIODS.some((p) => p.key === q.period)) ui.period = q.period;
  const body = h('div', { class: 'stats-body' });
  const seg = segmented({
    label: '통계 종류', value: ui.seg, cls: 'seg-type',
    options: [{ key: 'all', label: '전체' }, ...TYPE_KEYS.map((k) => ({ key: k, label: typeName(k, 'tight'), cls: TYPES[k].cls }))],
    onChange: (v) => { ui.seg = v; ui.showAllWorks = false; draw(); },
  });
  const periodSeg = segmented({
    label: '기간', value: ui.period, cls: 'seg-period',
    options: PERIODS,
    onChange: (v) => { ui.period = v; ui.showAllWorks = false; draw(); },
  });
  function draw() {
    // 연결한 게임 이름으로 셈 (게임 이름을 고쳐도 한 게임으로)
    const all = recordsForStats();
    const now = new Date();
    const recs = filterPeriod(all, ui.period, now);
    let content;
    try {
      // 아직 못 받았거나 받지 못한 상태를 "기록 없음"으로 보이지 않게
      if (!all.length && isFirstLoad()) content = loadingState();
      else if (!all.length && loadFailed()) content = loadErrorState(ctx.refresh);
      else if (!all.length) content = emptyState({ icon: 'chart', title: '통계를 낼 기록이 없어요', text: '기록이 쌓이면 여기에 그래프가 그려져요.' });
      else if (!recs.length) {
        content = emptyState({
          icon: 'chart', title: `${PERIODS.find((p) => p.key === ui.period).label}에는 기록이 없어요`, text: '기간을 ‘전체 기간’으로 바꿔 보세요.',
          action: h('button', { type: 'button', class: 'btn btn-soft', onClick: () => { ui.period = 'all'; periodSeg.querySelector('input[value="all"]').checked = true; draw(); } }, '전체 기간 보기'),
        });
      } else content = ui.seg === 'boardgame' ? bgView(recs) : ui.seg === 'murdermystery' ? mmView(recs) : ui.seg === 'escaperoom' ? erView(recs) : overviewView(recs, ui.period, now);
    } catch (e) {
      console.error(e);
      content = emptyState({ icon: 'info', title: '통계를 계산하지 못했어요', text: '잠시 후 다시 열어 주세요.' });
    }
    body.replaceChildren(...[content].flat().filter(Boolean));
  }
  rerender = draw;
  root.appendChild(h('div', { class: 'page page-stats' },
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: '통계' }), meChip()),
    h('div', { class: 'stats-controls' }, seg, periodSeg),
    body));
  draw();
  return { update: draw, destroy() { rerender = () => {}; } };
}
