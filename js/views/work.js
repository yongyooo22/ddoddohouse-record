// 작품 — 같은 작품을 여러 번 플레이한 기록을 모아 봄. 작품 정보와 날짜별 플레이 기록을 나눠서 보여 줌
import { h, icon } from '../dom.js';
import * as repo from '../repo.js';
import { placeLabel, workLabel } from '../model.js';
import { sameTitleWorks, avgRating } from '../query.js';
import { fmtDate, dateParts, fmtMinutes, fmtRemaining } from '../format.js';
import { MM_FORMATS } from '../constants.js';
import { appBar, genreTag, genreIcon, resultTag, sampleTag, starsView, emptyState } from '../ui.js';
import { photo } from '../images.js';

/** 한 줄 감상이 없을 때 대신 보여 줄 짧은 요약 (스포일러 아닌 장르별 항목만) */
function detailSummary(p, genre) {
  const d = p.details || {};
  const has = (v) => v !== null && v !== undefined && v !== '';
  const parts = [];
  if (genre === 'boardgame') {
    if (has(d.players)) parts.push(`${d.players}명`);
    if (has(d.myScore)) parts.push(`내 점수 ${d.myScore}점`);
    if (has(d.myRank)) parts.push(`${d.myRank}위`);
    if (has(d.durationMin)) parts.push(fmtMinutes(d.durationMin));
  } else if (genre === 'murdermystery') {
    const f = MM_FORMATS.find((x) => x.key === d.format);
    if (f) parts.push(f.label);
    if (has(d.durationMin)) parts.push(fmtMinutes(d.durationMin));
  } else if (genre === 'escaperoom') {
    if (has(d.remainingSec) && d.result !== 'fail') parts.push(`${fmtRemaining(d.remainingSec)} 남김`);
    if (has(d.hints)) parts.push(`힌트 ${d.hints}개`);
  }
  return parts.join(' · ');
}

function playItem(p, n, work) {
  const { md, wd, year } = dateParts(p.date);
  const d = p.details || {};
  return h('li', {},
    h('a', { class: 'row tl-row', href: `#/play/${encodeURIComponent(p.id)}`, dataset: { id: p.id } },
      h('span', { class: 'row-date' }, h('span', { class: 'row-year', text: year }), h('time', { class: 'row-md', datetime: p.date, text: md }), h('span', { class: 'row-wd', text: wd })),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, h('span', { class: 'tl-n', text: `${n}회차` }),
          p.oneLiner ? h('span', { class: 'tl-line', text: p.oneLiner }) : h('span', { class: 'tl-line is-empty', text: detailSummary(p, work.genre) || '감상 없이 남긴 기록' })),
        h('span', { class: 'row-meta' },
          work.genre === 'escaperoom' ? resultTag(d.result) : null,
          p.photos && p.photos.length ? h('span', { class: 'mini' }, icon('image'), h('span', { text: `${p.photos.length}` })) : null,
          p.companions && p.companions.length ? h('span', { class: 'mini' }, icon('users'), h('span', { text: p.companions.join(', ') })) : null,
          p.sample ? sampleTag() : null)),
      h('span', { class: 'row-rating' }, starsView(p.rating, { size: 'sm', compact: true }))));
}

function render(root, id) {
  const work = repo.getWork(id);
  if (!work) {
    root.replaceChildren(appBar({ title: '작품', back: '#/' }), h('div', { class: 'container narrow' },
      emptyState({ icon: 'stack', title: '작품을 찾을 수 없어요', text: '지워졌거나 다른 작품과 합쳐졌을 수 있어요.', actions: [h('a', { class: 'btn btn-ghost', href: '#/' }, '처음 화면으로')] })));
    return;
  }
  const plays = repo.playsOfWork(id); // 최근순
  const ords = repo.ordinals();
  const cover = repo.workCover(work);
  const place = placeLabel(work);
  const avg = avgRating(plays);
  const first = plays[plays.length - 1];
  const latest = plays[0];
  const others = sameTitleWorks(repo.worksList(), work.genre, work.title, { excludeId: work.id });

  const head = h('section', { class: `ticket ticket-work${cover ? '' : ' no-cover'}`, dataset: { genre: work.genre } },
    h('div', { class: 'tw-top' },
      cover ? h('div', { class: 'tw-cover' }, photo(cover, { size: 'f', progressive: true, lazy: false, alt: `${work.title} 표지` })) : h('div', { class: 'tw-cover is-empty', 'aria-hidden': 'true' }, genreIcon(work.genre, 'gicon-lg')),
      h('div', { class: 'tw-main' },
        h('div', { class: 'tk-tags' }, genreTag(work.genre), work.sample ? sampleTag() : null),
        h('h2', { class: 'td-title', text: work.title }),
        place ? h('p', { class: 'td-sub', text: place }) : null)),
    h('div', { class: 'perf perf-lg', 'aria-hidden': 'true' }),
    h('dl', { class: 'tw-stats' },
      h('div', {}, h('dt', { text: '플레이' }), h('dd', { text: `${plays.length}회` })),
      h('div', {}, h('dt', { text: '평균 평점' }), h('dd', {}, starsView(avg, { size: 'sm', compact: true, label: '평균 평점' }))),
      h('div', {}, h('dt', { text: '처음' }), h('dd', { text: first ? fmtDate(first.date, { weekday: false }) : '–' })),
      h('div', {}, h('dt', { text: '최근' }), h('dd', { text: latest ? fmtDate(latest.date, { weekday: false }) : '–' }))));

  const actions = h('div', { class: 'tw-actions' },
    h('a', { class: 'btn btn-primary', href: `#/new?work=${encodeURIComponent(work.id)}` }, icon('plus'), h('span', { text: '이 작품 플레이 기록 추가' })),
    h('a', { class: 'btn btn-ghost', href: `#/work/${encodeURIComponent(work.id)}/edit` }, icon('edit'), h('span', { text: '작품 정보 수정' })));

  const list = h('section', { class: 'tw-plays' },
    h('h3', { class: 'section-title' }, '플레이 기록 ', h('span', { class: 'section-count', text: String(plays.length) })),
    h('ol', { class: 'rows tl' }, plays.map((p) => playItem(p, ords.get(p.id) || 1, work))));

  const sibling = others.length
    ? h('section', { class: 'tw-others' },
      h('h3', { class: 'section-title', text: '이름이 같은 다른 작품' }),
      h('p', { class: 'td-hint', text: '매장이 다르거나 따로 기록한 작품이라 합치지 않았어요. 같은 작품이라면 ‘작품 정보 수정’에서 합칠 수 있어요.' }),
      h('ul', { class: 'rows' }, others.map((o) => {
        const s = repo.stats().get(o.id);
        return h('li', {}, h('a', { class: 'row', href: `#/work/${encodeURIComponent(o.id)}` },
          h('span', { class: 'row-thumb', 'aria-hidden': 'true' }, genreIcon(o.genre)),
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title', text: workLabel(o) }),
            h('span', { class: 'row-meta' }, h('span', { class: 'otag', text: `${s ? s.count : 0}회 플레이` }))),
          icon('chevron')));
      })))
    : null;

  root.replaceChildren(
    appBar({ title: '작품', back: '#/' }),
    h('div', { class: 'container narrow detail-body' }, head, actions, list, sibling));
}

export function mount(root, ctx) {
  const id = ctx.params[0];
  render(root, id);
  return { update() { render(root, id); } };
}
