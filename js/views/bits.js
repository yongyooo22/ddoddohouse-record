// 기록 카드 등 여러 화면에서 쓰는 조각
import { h } from '../dom.js';
import { TYPES } from '../constants.js';
import { fmtDate, fmtDateDot } from '../format.js';
import { erOrdinals, photosOf } from '../store.js';
import { typeBadge, starsView, stamp, spoilerBlock } from '../ui.js';
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

/**
 * 목록/홈 기록 카드 — 티켓 한 장
 * 위: [대표 사진] 종류 → 제목 → 날짜 (사진이 없으면 사진 칸 없이 글자가 넓게), 결과 도장은 오른쪽 위
 * 양옆 반원 홈과 점선 아래: ★ 별점 | 한줄평 (카드 전체 너비)
 * 승자·범인·남은 시간·함께한 멤버 같은 자세한 내용은 상세 화면에서
 */
export function recordCard(r) {
  const t = TYPES[r.type];
  const rating = Number(r.rating) > 0 ? starsView(r.rating, { size: 'xs', compact: true }) : null;
  const one = r.oneLiner
    ? (r.spoiler
      ? spoilerBlock(h('span', { text: r.oneLiner }), { label: '스포일러 보기', inline: true, key: spoilerKey(r, 'one') })
      : h('span', { class: 'rcard-one', text: r.oneLiner }))
    : null;
  const st = recordStamp(r);
  const photo = cardPhoto(r);
  const nPhotos = photosOf(r).length;
  return h('article', { class: ['rcard', t ? t.cls : '', photo ? 'has-photo' : ''] },
    h('div', { class: 'rcard-head' },
      photo,
      h('div', { class: 'rcard-main' },
        h('div', { class: 'rcard-top' },
          h('div', { class: 'rcard-tags' }, typeBadge(r.type, { short: false }),
            r.spoiler ? h('span', { class: 'mini-flag', text: '스포' }) : null),
          st ? h('div', { class: 'rcard-stamp' }, st) : null),
        h('h3', { class: 'rcard-title' },
          // 날짜 줄은 보기용(aria-hidden)이라 링크 이름에 날짜를 함께 넣어 스크린리더도 날짜를 듣게
          h('a', {
            class: 'card-link', href: `#/record/${encodeURIComponent(r.id)}`,
            'aria-label': `${r.title || '(제목 없음)'}, ${fmtDate(r.date)}${nPhotos ? `, 사진 ${nPhotos}장` : ''}`,
          }, r.title || '(제목 없음)')),
        h('p', { class: 'rcard-date', 'aria-hidden': 'true', text: fmtDateDot(r.date) || '날짜 없음' }))),
    rating || one ? h('div', { class: 'rcard-body' }, h('div', { class: 'rcard-line' }, rating, one)) : null);
}

/** 섹션 제목 */
export function sectionHead(title, { action, sub } = {}) {
  return h('div', { class: 'sec-head' },
    h('h2', { class: 'sec-title', text: title }),
    sub ? h('span', { class: 'sec-sub', text: sub }) : null,
    action || null);
}
