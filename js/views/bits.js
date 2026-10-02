// 기록 카드 등 여러 화면에서 쓰는 조각
import { h, icon, starShape } from '../dom.js';
import { TYPES } from '../constants.js';
import { fmtDate, fmtDateDot } from '../format.js';
import { erOrdinals, photosOf } from '../store.js';
import { typeBadge, stamp } from '../ui.js';
import { ownershipOf, lenderOf } from '../stats.js';
import { cardPhoto } from './photos.js';

export const bgOf = (r) => (r && r.bg && typeof r.bg === 'object' ? r.bg : {});
export const mmOf = (r) => (r && r.mm && typeof r.mm === 'object' ? r.mm : {});
export const erOf = (r) => (r && r.er && typeof r.er === 'object' ? r.er : {});
const arr = (v) => (Array.isArray(v) ? v : []);

export function bgWinners(r) {
  const bg = bgOf(r);
  if (bg.mode === 'coop') return [];
  return arr(bg.results).filter((x) => x && x.winner).map((x) => x.memberId);
}

/** 종류별 도장 (성공/실패/우승/검거 등) */
export function recordStamp(r) {
  if (r.type === 'escaperoom') {
    const er = erOf(r);
    if (er.cleared === true) return stamp('탈출 성공', 'clear');
    if (er.cleared === false) return stamp('탈출 실패', 'fail');
    return null;
  }
  if (r.type === 'murdermystery') {
    const mm = mmOf(r);
    if (mm.culpritResult === 'caught') return stamp('범인 검거', 'caught');
    if (mm.culpritResult === 'escaped') return stamp('범인 도주', 'escaped');
    return null;
  }
  if (r.type === 'boardgame') {
    const bg = bgOf(r);
    if (bg.mode === 'coop') {
      if (bg.coopWin === true) return stamp('협력 승리', 'win');
      if (bg.coopWin === false) return stamp('협력 패배', 'fail');
      return null;
    }
    return bgWinners(r).length ? stamp('우승', 'win') : null;
  }
  return null;
}

/** 스포일러 펼침 기억용 키 (내용이 수정되면 다시 가림) */
export function spoilerKey(r, part) {
  return `${r.id}:${part}:${r.updatedAt || ''}`;
}

/** N번째 방탈출 라벨 */
export function ordinalLabel(r) {
  if (r.type !== 'escaperoom') return null;
  const n = erOrdinals().get(r.id);
  return n ? h('span', { class: 'ordinal', text: `${n}번째 방탈출` }) : null;
}

/** 방탈출 성공·실패만 카드에 작은 가로 배지로 (우승자·범인 등 자세한 결과는 상세에서) */
function resultBadge(r) {
  if (r.type !== 'escaperoom') return null;
  const er = erOf(r);
  if (er.cleared === true) return h('span', { class: 'rbadge rbadge-clear', text: '탈출 성공' });
  if (er.cleared === false) return h('span', { class: 'rbadge rbadge-fail', text: '탈출 실패' });
  return null;
}

/** 소장 여부 글자: '내 소장' · '대여 · 영식' · '' (미기록·해당 없음) */
export function ownershipText(r) {
  const own = ownershipOf(r);
  if (own === 'mine') return '내 소장';
  if (own !== 'borrowed') return '';
  const who = lenderOf(r);
  return who ? `대여 · ${who}` : '대여';
}

/** 보드게임·머미: 내 소장 / 대여를 같은 자리에 작은 배지로 */
function ownershipBadge(r) {
  const own = ownershipOf(r);
  if (own === 'mine') return h('span', { class: 'rbadge rbadge-own', text: '내 소장' });
  if (own === 'borrowed') return h('span', { class: 'rbadge rbadge-borrow', text: '대여' });
  return null;
}

/**
 * 목록/홈 기록 카드 — 티켓 모양: 위(대표 사진 · 종류 · 제목 · 날짜) | 점선 | 아래(평점 · 한줄평)
 * 우승자·멤버·배역·범인·스포일러 내용은 카드에 싣지 않고 상세 화면에서 보여 줌
 */
export function recordCard(r) {
  const t = TYPES[r.type];
  const photo = cardPhoto(r);
  const nPhotos = photosOf(r).length;
  const rating = Number(r.rating) || 0;
  // 스포일러가 있는 기록의 한줄평은 카드에 싣지 않음 (대신 다른 내용을 보여 주지도 않음)
  const one = r.oneLiner && !r.spoiler ? r.oneLiner : '';
  return h('article', { class: ['rcard', t ? t.cls : '', photo ? 'has-photo' : ''] },
    h('div', { class: 'rcard-main' },
      h('div', { class: 'rcard-thumb', 'aria-hidden': 'true' },
        photo || h('span', { class: 'rcard-noimg' }, icon(t ? t.icon : 'book'))),
      h('div', { class: 'rcard-head' },
        h('div', { class: 'rcard-top' }, typeBadge(r.type), resultBadge(r) || ownershipBadge(r)),
        h('h3', { class: 'rcard-title' },
          h('a', {
            class: 'card-link', href: `#/record/${encodeURIComponent(r.id)}`,
            'aria-label': `${r.title || '(제목 없음)'}, ${fmtDate(r.date)}${nPhotos ? `, 사진 ${nPhotos}장` : ''}`,
          }, r.title || '(제목 없음)')),
        h('p', { class: 'rcard-date', text: fmtDateDot(r.date) }))),
    h('div', { class: 'rcard-stub' },
      rating > 0
        ? h('span', { class: 'rcard-rating', role: 'img', 'aria-label': `별점 ${rating}점` }, starShape('rcard-star'), h('span', { text: rating.toFixed(1) }))
        : h('span', { class: 'rcard-rating is-empty', text: '평점 없음' }),
      one ? h('p', { class: 'rcard-one', text: one }) : null));
}

/** 섹션 제목 */
export function sectionHead(title, { action, sub } = {}) {
  return h('div', { class: 'sec-head' },
    h('h2', { class: 'sec-title', text: title }),
    sub ? h('span', { class: 'sec-sub', text: sub }) : null,
    action || null);
}
