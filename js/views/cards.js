// 목록의 티켓 카드 · 목록형 줄 — 스포일러(spoiler)와 상세 후기는 절대 여기서 쓰지 않는다
import { h } from '../dom.js';
import * as repo from '../repo.js';
import { photo } from '../images.js';
import { genreTag, genreIcon, resultTag, sampleTag, starsView, avgView } from '../ui.js';
import { placeLabel } from '../model.js';
import { GENRES } from '../constants.js';
import { fmtDate, dateParts, fmtRating } from '../format.js';

/**
 * 표지 칸: 사진이 있으면 사진, 없으면 장르 아이콘.
 * (표지가 없으면 휴대폰 한 줄 화면에서는 제목 옆 작은 아이콘 칸, 여러 칸 격자에서는 같은 높이의 빈 표지로 — CSS)
 */
function cover(imageId, work) {
  if (imageId) return h('div', { class: 'tk-cover' }, photo(imageId, { size: 't', alt: '' }));
  return h('div', { class: 'tk-cover is-empty', 'aria-hidden': 'true' }, genreIcon(work.genre, 'gicon-cover'));
}

function ordinalTag(n) {
  return n > 1 ? h('span', { class: 'otag', text: `${n}회차` }) : null;
}

/** 스크린리더용 한 줄 요약 (카드 안 글자를 모두 읽지 않게) */
function playLabel(play, work, ordinal) {
  const d = play.details || {};
  return [
    work.title, placeLabel(work), GENRES[work.genre].label, fmtDate(play.date),
    play.rating ? `평점 ${fmtRating(play.rating)}` : '미평가',
    work.genre === 'escaperoom' && d.result ? (d.result === 'success' ? '탈출 성공' : '탈출 실패') : '',
    ordinal > 1 ? `${ordinal}회차` : '', play.oneLiner, play.sample ? '예시 기록' : '',
  ].filter(Boolean).join(', ');
}

function workAria(group) {
  const { work, latest, count, avg } = group;
  return [
    work.title, placeLabel(work), GENRES[work.genre].label, `${count}회 플레이`, `최근 ${fmtDate(latest.date)}`,
    avg ? `평균 평점 ${fmtRating(avg)}` : '미평가', work.sample ? '예시 기록' : '',
  ].filter(Boolean).join(', ');
}

/** 카드형: 플레이 기록 하나 */
export function playCard(play, work, { ordinal = 0 } = {}) {
  const imageId = repo.playCover(play);
  const d = play.details || {};
  const place = placeLabel(work);
  return h('a', { class: `ticket tk-card${imageId ? '' : ' no-cover'}`, href: `#/play/${encodeURIComponent(play.id)}`, dataset: { genre: work.genre, id: play.id }, 'aria-label': playLabel(play, work, ordinal) },
    cover(imageId, work),
    h('div', { class: 'tk-main' },
      h('div', { class: 'tk-tags' },
        genreTag(work.genre),
        work.genre === 'escaperoom' ? resultTag(d.result) : null,
        ordinalTag(ordinal),
        play.sample ? sampleTag() : null),
      h('h3', { class: 'tk-title', text: work.title }),
      place ? h('p', { class: 'tk-sub', text: place }) : null,
      play.oneLiner ? h('p', { class: 'tk-line', text: play.oneLiner }) : null),
    h('div', { class: 'perf', 'aria-hidden': 'true' }),
    h('div', { class: 'tk-stub' },
      h('time', { class: 'tk-date', datetime: play.date, text: fmtDate(play.date) }),
      starsView(play.rating, { size: 'sm', compact: true })));
}

/** 카드형: 작품별로 묶은 것 */
export function workCard(group) {
  const { work, latest, count, avg } = group;
  const imageId = repo.workCover(work);
  const place = placeLabel(work);
  return h('a', { class: `ticket tk-card tk-work${imageId ? '' : ' no-cover'}`, href: `#/work/${encodeURIComponent(work.id)}`, dataset: { genre: work.genre, id: work.id }, 'aria-label': workAria(group) },
    cover(imageId, work),
    h('div', { class: 'tk-main' },
      h('div', { class: 'tk-tags' },
        genreTag(work.genre),
        h('span', { class: 'otag', text: `${count}회 플레이` }),
        work.sample ? sampleTag() : null),
      h('h3', { class: 'tk-title', text: work.title }),
      place ? h('p', { class: 'tk-sub', text: place }) : null,
      latest.oneLiner ? h('p', { class: 'tk-line', text: latest.oneLiner }) : null),
    h('div', { class: 'perf', 'aria-hidden': 'true' }),
    h('div', { class: 'tk-stub' },
      h('span', { class: 'tk-date' }, h('span', { class: 'tk-date-label', text: '최근 ' }), h('time', { datetime: latest.date, text: fmtDate(latest.date) })),
      avgView(avg)));
}

function rowThumb(imageId, work) {
  return h('span', { class: 'row-thumb', 'aria-hidden': 'true' },
    imageId ? photo(imageId, { size: 't', alt: '' }) : genreIcon(work.genre));
}

/** 목록형 한 줄 정보: (예시) ● 장르 · 매장 · 결과 · n회차 (넘치면 말줄임) */
function rowMeta(work, parts, sample) {
  return h('span', { class: 'row-meta' },
    sample ? sampleTag() : null,
    h('span', { class: 'row-genre' }, h('span', { class: 'gdot', 'aria-hidden': 'true' }), GENRES[work.genre].label),
    parts.filter(Boolean));
}

function resultText(result) {
  if (result !== 'success' && result !== 'fail') return null;
  return h('span', { class: `rinline ${result === 'success' ? 'is-success' : 'is-fail'}` },
    h('span', { class: 'rtag-dot', 'aria-hidden': 'true' }), result === 'success' ? '탈출 성공' : '탈출 실패');
}


/** 목록형: 플레이 기록 한 줄 */
export function playRow(play, work, { ordinal = 0 } = {}) {
  const { md, wd } = dateParts(play.date);
  const d = play.details || {};
  const place = placeLabel(work);
  return h('a', { class: 'row', href: `#/play/${encodeURIComponent(play.id)}`, dataset: { genre: work.genre, id: play.id }, 'aria-label': playLabel(play, work, ordinal) },
    h('span', { class: 'row-date' }, h('time', { class: 'row-md', datetime: play.date, text: md }), h('span', { class: 'row-wd', text: wd })),
    rowThumb(repo.playCover(play), work),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title', text: work.title }),
      rowMeta(work, [
        place ? h('span', { class: 'row-place', text: place }) : null,
        work.genre === 'escaperoom' ? resultText(d.result) : null,
        ordinal > 1 ? h('span', { text: `${ordinal}회차` }) : null,
      ], play.sample),
      play.oneLiner ? h('span', { class: 'row-line', text: play.oneLiner }) : null),
    h('span', { class: 'row-rating' }, starsView(play.rating, { size: 'sm', compact: true })));
}

/** 목록형: 작품별로 묶은 것 한 줄 */
export function workRow(group) {
  const { work, latest, count, avg } = group;
  const { md, wd } = dateParts(latest.date);
  const place = placeLabel(work);
  return h('a', { class: 'row row-work', href: `#/work/${encodeURIComponent(work.id)}`, dataset: { genre: work.genre, id: work.id }, 'aria-label': workAria(group) },
    h('span', { class: 'row-date' }, h('time', { class: 'row-md', datetime: latest.date, text: md }), h('span', { class: 'row-wd', text: wd })),
    rowThumb(repo.workCover(work), work),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title', text: work.title }),
      rowMeta(work, [
        place ? h('span', { class: 'row-place', text: place }) : null,
        h('span', { text: `${count}회 플레이` }),
      ], work.sample)),
    h('span', { class: 'row-rating' }, avgView(avg)));
}
