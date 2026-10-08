// 기록 카드 등 여러 화면에서 쓰는 조각
import { h, icon, starShape } from '../dom.js';
import { TYPES } from '../constants.js';
import { fmtDate, fmtDateDot } from '../format.js';
import { erOrdinals, photosOf, titleOf, gameOfRecord, coverOf, isOwnedGame } from '../store.js';
import { typeBadge, spoilerBlock } from '../ui.js';
import { ownershipOf, lenderOf } from '../stats.js';
import { cardPhoto } from './photos.js';

export const bgOf = (r) => (r && r.bg && typeof r.bg === 'object' ? r.bg : {});
export const mmOf = (r) => (r && r.mm && typeof r.mm === 'object' ? r.mm : {});
export const erOf = (r) => (r && r.er && typeof r.er === 'object' ? r.er : {});
const arr = (v) => (Array.isArray(v) ? v : []);

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

/** 예전 기록의 소장 여부 글자: '내 소장' · '대여 · 영식' · '' (미기록·해당 없음) */
export function ownershipText(r) {
  const own = ownershipOf(r);
  if (own === 'mine') return '내 소장';
  if (own !== 'borrowed') return '';
  const who = lenderOf(r);
  return who ? `대여 · ${who}` : '대여';
}

/** 보드게임·머미: 게임 정보가 '내 소장'이면(없으면 예전 기록의 소장 여부) 작은 배지로 */
function ownershipBadge(r) {
  const g = gameOfRecord(r);
  if (g) return isOwnedGame(g) ? h('span', { class: 'rbadge rbadge-own', text: '내 소장' }) : null;
  const own = ownershipOf(r);
  if (own === 'mine') return h('span', { class: 'rbadge rbadge-own', text: '내 소장' });
  if (own === 'borrowed') return h('span', { class: 'rbadge rbadge-borrow', text: '대여' });
  return null;
}

/** 감상의 첫 부분 (한줄평이 있던 예전 기록은 한줄평) — 카드에서 1~2줄로 잘라 보여 줌 */
export function reviewExcerpt(r) {
  const one = typeof r.oneLiner === 'string' ? r.oneLiner.trim() : '';
  if (one) return one;
  const rev = typeof r.review === 'string' ? r.review.trim() : '';
  return rev.length > 160 ? `${rev.slice(0, 160)}…` : rev;
}

/**
 * 목록/홈 기록 카드 — 티켓 모양: 위(대표 이미지 · 종류 · 제목 · 날짜) | 점선 | 아래(별점 · 짧은 감상)
 * 대표 이미지는 그날 찍은 첫 사진, 없으면 게임의 대표 이미지. 스포일러 기록의 감상은 열기 전까지 가림.
 * 머더미스터리의 범인·역할·결말은 작품 스포일러라 카드(목록·미리보기)에는 내지 않음 — 상세에서 열어 봄
 */
export function recordCard(r) {
  const t = TYPES[r.type];
  const nPhotos = photosOf(r).length;
  const cover = nPhotos ? null : coverOf(gameOfRecord(r));
  const photo = nPhotos ? cardPhoto(r) : cover ? cardPhoto({ photos: [cover] }) : null;
  const rating = Number(r.rating) || 0;
  const title = titleOf(r) || '(제목 없음)';
  const excerpt = reviewExcerpt(r);
  let one = null;
  if (excerpt) {
    const text = h('p', { class: 'rcard-one', text: excerpt });
    one = r.spoiler ? spoilerBlock(text, { inline: true, label: '스포일러 보기', key: spoilerKey(r, 'one') }) : text;
  }
  return h('article', { class: ['rcard', t ? t.cls : '', photo ? 'has-photo' : ''] },
    h('div', { class: 'rcard-main' },
      h('div', { class: 'rcard-thumb', 'aria-hidden': 'true' },
        photo || h('span', { class: 'rcard-noimg' }, icon(t ? t.icon : 'book'))),
      h('div', { class: 'rcard-head' },
        h('div', { class: 'rcard-top' }, typeBadge(r.type), resultBadge(r) || ownershipBadge(r)),
        h('h3', { class: 'rcard-title' },
          h('a', {
            class: 'card-link', href: `#/record/${encodeURIComponent(r.id)}`,
            'aria-label': `${title}, ${fmtDate(r.date)}${nPhotos ? `, 사진 ${nPhotos}장` : ''}`,
          }, title)),
        h('p', { class: 'rcard-date', text: fmtDateDot(r.date) }))),
    h('div', { class: 'rcard-stub' },
      rating > 0
        ? h('span', { class: 'rcard-rating', role: 'img', 'aria-label': `별점 ${rating}점` }, starShape('rcard-star'), h('span', { text: rating.toFixed(1) }))
        : h('span', { class: 'rcard-rating is-empty', text: '별점 없음' }),
      one));
}

/** 섹션 제목 */
export function sectionHead(title, { action, sub } = {}) {
  return h('div', { class: 'sec-head' },
    h('h2', { class: 'sec-title', text: title }),
    sub ? h('span', { class: 'sec-sub', text: sub }) : null,
    action || null);
}

/** 게임 상세 주소: 게임 정보가 있으면 그 게임, 등록 전 예전 기록 이름이면 종류·이름으로 */
export function gamePageHref(e) {
  if (e && e.gameId) return `#/game/${encodeURIComponent(e.gameId)}`;
  return `#/game?type=${encodeURIComponent(e.type)}&title=${encodeURIComponent(e.title)}`;
}

/** 이 게임으로 새 기록 쓰기 주소 (게임이 골라진 폼) */
export function gameWriteHref(e) {
  return e && e.gameId
    ? `#/new/${e.type}?game=${encodeURIComponent(e.gameId)}`
    : `#/new/${e.type}?title=${encodeURIComponent(e.title)}`;
}
