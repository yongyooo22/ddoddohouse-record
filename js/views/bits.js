// 기록 카드 등 여러 화면에서 쓰는 조각
import { h, icon } from '../dom.js';
import { TYPES, BG_MODES } from '../constants.js';
import { dayParts, fmtRemaining, fmtDate } from '../format.js';
import { erOrdinals, memberInfo, photosOf } from '../store.js';
import { typeBadge, starsView, avatarRow, stamp, memberTag, spoilerBlock } from '../ui.js';
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

/** 목록 카드 핵심 정보 한 줄 */
export function keyInfo(r) {
  const items = [];
  if (r.type === 'boardgame') {
    const bg = bgOf(r);
    const mode = BG_MODES.find((m) => m.key === bg.mode);
    if (bg.mode !== 'coop') {
      const winners = bgWinners(r);
      if (winners.length) {
        items.push(h('span', { class: 'ki ki-win' }, icon('trophy'),
          h('span', { class: 'ki-list' }, winners.slice(0, 3).map((id) => memberTag(id)),
            winners.length > 3 ? h('span', { class: 'ki-more', text: `외 ${winners.length - 3}명` }) : null)));
      }
    }
    if (mode && bg.mode !== 'competitive') items.push(h('span', { class: 'ki ki-soft', text: `${mode.label}` }));
  } else if (r.type === 'murdermystery') {
    const mm = mmOf(r);
    const roles = arr(mm.roles);
    const culprits = roles.filter((x) => x && x.culprit).map((x) => x.memberId);
    const withChar = roles.filter((x) => x && x.character);
    const culpritEl = culprits.length
      ? h('span', { class: 'ki ki-culprit' }, h('span', { class: 'ki-key', text: '범인' }),
        h('span', { class: 'ki-list' }, culprits.slice(0, 3).map((id) => memberTag(id))))
      : null;
    const txt = withChar.slice(0, 4).map((x) => `${memberInfo(x.memberId).name}·${x.character}`).join('  ') +
      (withChar.length > 4 ? ` 외 ${withChar.length - 4}` : '');
    const rolesEl = withChar.length
      ? h('span', { class: 'ki ki-roles' }, icon('mask'), h('span', { class: 'ki-text', text: txt }))
      : null;
    if (r.spoiler && (culpritEl || rolesEl)) {
      // 누가 범인이었고 무슨 배역이었는지 = 시나리오의 범인 캐릭터 → 스포일러 기록이면 가림
      const hidden = h('span', { class: 'ki-spoil' }, culpritEl, rolesEl);
      items.push(h('span', { class: 'ki ki-roles' },
        spoilerBlock(hidden, { label: '범인·배역 보기', inline: true, key: spoilerKey(r, 'roles') })));
    } else {
      if (culpritEl) items.push(culpritEl);
      if (rolesEl) items.push(rolesEl);
    }
  } else if (r.type === 'escaperoom') {
    const er = erOf(r);
    if (er.cleared && er.remainingSec !== null && er.remainingSec !== undefined && er.remainingSec !== '') {
      items.push(h('span', { class: 'ki' }, icon('clock'), h('span', { text: `${fmtRemaining(er.remainingSec)} 남김` })));
    }
    if (Number.isFinite(Number(er.hints))) {
      items.push(h('span', { class: 'ki' }, icon('bulb'), h('span', { text: Number(er.hints) === 0 ? '노힌트' : `힌트 ${Number(er.hints)}` })));
    }
    if (er.brand) items.push(h('span', { class: 'ki ki-soft', text: [er.brand, er.branch].filter(Boolean).join(' ') }));
  }
  return items.length ? h('div', { class: 'rcard-info' }, items) : null;
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

/** 목록/홈 기록 카드 */
export function recordCard(r, { showMonth = false } = {}) {
  const t = TYPES[r.type];
  const dp = dayParts(r.date);
  const one = r.oneLiner
    ? (r.spoiler
      ? spoilerBlock(h('span', { text: r.oneLiner }), { label: '스포일러', inline: true, key: spoilerKey(r, 'one') })
      : h('span', { class: 'rcard-one', text: r.oneLiner }))
    : null;
  const st = recordStamp(r);
  const photo = cardPhoto(r);
  const nPhotos = photosOf(r).length;
  return h('article', { class: ['rcard', t ? t.cls : '', st ? 'has-stamp' : '', photo ? 'has-photo' : ''] },
    h('div', { class: `rcard-date${dp.dow === 0 ? ' is-sun' : dp.dow === 6 ? ' is-sat' : ''}`, 'aria-hidden': 'true' },
      showMonth ? h('span', { class: 'd-mon', text: dp.month }) : null,
      h('span', { class: 'd-day', text: dp.day }),
      h('span', { class: 'd-wd', text: dp.wd ? `(${dp.wd})` : '' })),
    h('div', { class: 'rcard-body' },
      h('div', { class: 'rcard-top' }, typeBadge(r.type), ordinalLabel(r),
        r.spoiler ? h('span', { class: 'mini-flag', text: '스포' }) : null),
      h('h3', { class: 'rcard-title' },
        // 날짜 칸은 보기용(aria-hidden)이라 링크 이름에 날짜를 함께 넣어 스크린리더도 날짜를 듣게
        h('a', {
          class: 'card-link', href: `#/record/${encodeURIComponent(r.id)}`,
          'aria-label': `${r.title || '(제목 없음)'}, ${fmtDate(r.date)}${nPhotos ? `, 사진 ${nPhotos}장` : ''}`,
        }, r.title || '(제목 없음)')),
      (Number(r.rating) > 0 || one)
        ? h('div', { class: 'rcard-line' }, Number(r.rating) > 0 ? starsView(r.rating, { size: 'xs' }) : null, one)
        : null,
      keyInfo(r),
      arr(r.members).length ? h('div', { class: 'rcard-foot' }, avatarRow(r.members, { max: 7, size: 'xs' })) : null),
    // 사진이 있으면 오른쪽에 붙인 사진 위에 도장이 찍힘
    photo ? h('div', { class: 'rcard-side' }, photo, st ? h('div', { class: 'rcard-stamp' }, st) : null) : null,
    !photo && st ? h('div', { class: 'rcard-stamp' }, st) : null);
}

/** 섹션 제목 */
export function sectionHead(title, { action, sub } = {}) {
  return h('div', { class: 'sec-head' },
    h('h2', { class: 'sec-title', text: title }),
    sub ? h('span', { class: 'sec-sub', text: sub }) : null,
    action || null);
}
