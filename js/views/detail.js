// 기록 상세
import { h, icon } from '../dom.js';
import { TYPES, BG_MODES, MM_FORMATS, MM_OUTCOMES, MM_SCORES, ER_SCORES } from '../constants.js';
import { state, recordById, removeRecord, memberInfo, isFirstLoad, loadFailed } from '../store.js';
import { fmtDate, fmtMinutes, fmtRemaining, fmtDateTime } from '../format.js';
import * as api from '../api.js';
import { navigate } from '../nav.js';
import { appBar, typeBadge, starsView, stamp, avatar, scoreBars, spoilerBlock, confirmDialog, toast, emptyState, loadingState, loadErrorState } from '../ui.js';
import { recordStamp, ordinalLabel, bgOf, mmOf, erOf, spoilerKey } from './bits.js';
import { gallery, closeViewer } from './photos.js';

// 상세를 다시 그려도(새로고침·다른 기기의 변경) 보던 사진 그대로: 기록 id → 사진 번호
const galleryAt = new Map();

const arr = (v) => (Array.isArray(v) ? v : []);

function infoGrid(pairs) {
  const rows = pairs.filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false);
  if (!rows.length) return null;
  return h('dl', { class: 'info-grid' }, rows.map(([k, v, ic]) =>
    h('div', { class: 'info-item' },
      h('dt', {}, ic ? icon(ic) : null, h('span', { text: k })),
      h('dd', { text: String(v) }))));
}

function gauge(label, value) {
  return h('div', { class: 'gauge-item' },
    h('span', { class: 'gauge-label', text: label }),
    starsView(value, { size: 'xs', kind: 'dot', label }));
}

function sec(title, ...children) {
  return h('section', { class: 'card dsec' }, h('h2', { class: 'dsec-title', text: title }), children);
}

function memberLink(id, extra) {
  const m = memberInfo(id);
  const inner = [avatar(m, 'sm'), h('span', { class: 'mrow-name', text: m.name })];
  return m.missing
    ? h('span', { class: 'mrow is-gone' }, inner, extra || null)
    : h('a', { class: 'mrow', href: `#/member/${encodeURIComponent(id)}` }, inner, extra || null);
}

function bgSection(r) {
  const bg = bgOf(r);
  const mode = BG_MODES.find((m) => m.key === bg.mode);
  const out = [];
  out.push(sec('게임 정보', infoGrid([
    ['방식', mode ? mode.label : '', 'users'],
    ['장소', bg.place, 'pin'],
    ['플레이 시간', fmtMinutes(bg.playTimeMin), 'clock'],
    ['확장판', bg.expansion, 'sparkle'],
  ]) || h('p', { class: 'muted small', text: '추가 정보 없음' })));

  if (bg.mode === 'coop') {
    out.push(sec('결과',
      h('div', { class: 'result-big' },
        bg.coopWin === true ? stamp('협력 승리', 'win') : bg.coopWin === false ? stamp('협력 패배', 'fail') : h('p', { class: 'muted', text: '결과 미기록' }),
        h('div', { class: 'result-members' }, arr(r.members).map((id) => memberLink(id))))));
  } else {
    const results = arr(bg.results).filter((x) => x && x.memberId);
    if (results.length) {
      const sorted = [...results].sort((a, b) =>
        (a.rank ?? 99) - (b.rank ?? 99) || (Number(b.score) || 0) - (Number(a.score) || 0));
      out.push(sec(bg.mode === 'team' ? '팀전 결과' : '순위',
        h('ol', { class: 'ranking' }, sorted.map((x) =>
          h('li', { class: `rank-row${x.winner ? ' is-winner' : ''}` },
            h('span', { class: 'rank-no', text: x.rank ? `${x.rank}` : '–', 'aria-label': x.rank ? `${x.rank}등` : '순위 없음' }),
            memberLink(x.memberId),
            x.winner ? h('span', { class: 'rank-win' }, icon('crown'), h('span', { text: '승리' })) : null,
            h('span', { class: 'rank-score', text: x.score === null || x.score === undefined || x.score === '' ? '' : `${x.score}점` }))))));
    }
  }
  return out;
}

function mmSection(r) {
  const mm = mmOf(r);
  const fmt = MM_FORMATS.find((f) => f.key === mm.format);
  const out = [];
  out.push(sec('시나리오 정보', infoGrid([
    ['제작사', mm.publisher, 'book'],
    ['형태', fmt ? fmt.label : '', 'dice'],
    ['매장·지점', mm.format === 'store' ? mm.store : '', 'pin'],
    ['GM', mm.gm, 'mask'],
    ['인원', mm.playerCount ? `${mm.playerCount}인` : '', 'users'],
    ['플레이 시간', fmtMinutes(mm.playTimeMin), 'clock'],
  ]) || h('p', { class: 'muted small', text: '추가 정보 없음' })));

  const roles = arr(mm.roles).filter((x) => x && x.memberId);
  const resultStamp = mm.culpritResult === 'caught' ? stamp('범인 검거', 'caught') : mm.culpritResult === 'escaped' ? stamp('범인 도주', 'escaped') : null;
  if (roles.length || resultStamp) {
    const list = roles.length ? h('ul', { class: 'roles' }, roles.map((x) => {
        const oc = MM_OUTCOMES.find((o) => o.key === x.outcome);
        return h('li', { class: `role-row${x.culprit ? ' is-culprit' : ''}` },
          memberLink(x.memberId),
          h('span', { class: 'role-char', text: x.character || '캐릭터 미기록' }),
          h('span', { class: 'role-flags' },
            x.culprit ? stamp('범인', 'culprit', { tilt: false }) : null,
            oc ? h('span', { class: `outcome outcome-${oc.key}`, text: oc.label }) : null,
            x.mvp ? h('span', { class: 'mvp' }, icon('crown'), h('span', { text: 'MVP' })) : null));
      })) : null;
    // 누가 어떤 배역·범인이었는지는 시나리오 스포일러 → 스포일러 기록이면 가림 (목록 카드와 펼침 상태 공유)
    const hasSecret = roles.some((x) => x.culprit || x.character);
    out.push(sec('역할과 결과',
      resultStamp ? h('div', { class: 'result-big' }, resultStamp) : null,
      list && r.spoiler && hasSecret ? spoilerBlock(list, { label: '범인·배역 보기', key: spoilerKey(r, 'roles') }) : list));
  }

  const hasScores = MM_SCORES.some((s) => Number(mm.scores && mm.scores[s.key]) > 0);
  out.push(sec('세부 평가',
    hasScores ? scoreBars(MM_SCORES.map((s) => ({ label: s.label, value: mm.scores ? mm.scores[s.key] : 0 }))) : h('p', { class: 'muted small', text: '세부 점수 없음' }),
    h('div', { class: 'gauges' }, gauge('추리 난이도', mm.difficulty)),
    mm.replay ? h('p', { class: 'replay' }, icon('heart'), h('span', { text: '다시 하고 싶어요 · 추천해요' })) : null));
  return out;
}

function erSection(r) {
  const er = erOf(r);
  const out = [];
  out.push(sec('테마 정보', infoGrid([
    ['브랜드', er.brand, 'door'],
    ['지점', er.branch, 'pin'],
    ['장르', er.genre, 'tag'],
    ['인원', er.playerCount ? `${er.playerCount}인` : '', 'users'],
    ['제한 시간', er.timeLimitMin ? `${er.timeLimitMin}분` : '', 'clock'],
  ]) || h('p', { class: 'muted small', text: '추가 정보 없음' })));

  const remain = er.cleared && er.remainingSec !== null && er.remainingSec !== undefined ? fmtRemaining(er.remainingSec) : '';
  out.push(sec('탈출 결과',
    h('div', { class: 'result-big result-er' },
      er.cleared === true ? stamp('탈출 성공', 'clear') : er.cleared === false ? stamp('탈출 실패', 'fail') : h('span', { class: 'muted', text: '결과 미기록' }),
      h('div', { class: 'er-nums' },
        h('div', { class: 'er-num' }, h('span', { class: 'er-num-v', text: remain || '–' }), h('span', { class: 'er-num-l', text: '남은 시간' })),
        h('div', { class: 'er-num' }, h('span', { class: 'er-num-v', text: Number.isFinite(Number(er.hints)) ? String(Number(er.hints)) : '–' }), h('span', { class: 'er-num-l', text: '힌트' }))))));

  const hasScores = ER_SCORES.some((s) => Number(er.scores && er.scores[s.key]) > 0);
  out.push(sec('세부 평가',
    hasScores ? scoreBars(ER_SCORES.map((s) => ({ label: s.label, value: er.scores ? er.scores[s.key] : 0 }))) : h('p', { class: 'muted small', text: '세부 점수 없음' }),
    h('div', { class: 'gauges' }, gauge('난이도', er.difficulty), gauge('공포도', er.fear), gauge('활동성', er.activity)),
    er.replay ? h('p', { class: 'replay' }, icon('heart'), h('span', { text: '추천해요' })) : null));
  return out;
}

function render(root, id, ctx) {
  const r = recordById(id);
  if (!r) {
    const loading = isFirstLoad() || (state.status === 'loading' && !state.records.length);
    root.replaceChildren(h('div', { class: 'page' },
      appBar({ title: '기록', back: '#/records' }),
      loading
        ? loadingState('불러오는 중…')
        : loadFailed() ? loadErrorState(ctx && ctx.refresh)
        : emptyState({ icon: 'book', title: '기록을 찾을 수 없어요', text: '삭제되었거나 아직 불러오지 못했어요.', action: h('a', { class: 'btn btn-soft', href: '#/records' }, '목록으로') })));
    return;
  }
  const t = TYPES[r.type];
  const st = recordStamp(r);

  let deleting = false;
  async function onDelete() {
    if (deleting) return;
    const ok = await confirmDialog('이 기록을 삭제할까요?', `“${r.title}” 기록이 모두에게서 사라져요. 되돌릴 수 없어요.`, { ok: '삭제', danger: true });
    if (!ok) return;
    deleting = true;
    try {
      await api.deleteRecord(r.id);
      removeRecord(r.id);
      toast('기록을 삭제했어요', 'ok');
      navigate('#/records', { replace: true });
    } catch (e) {
      if (e.code === 'not_found') {
        removeRecord(r.id);
        navigate('#/records', { replace: true });
      } else {
        toast(api.errorMessage(e, '삭제'), 'error');
      }
    } finally {
      deleting = false;
    }
  }

  const one = r.oneLiner
    ? (r.spoiler
      ? spoilerBlock(h('p', { class: 'hero-one', text: `“${r.oneLiner}”` }), { key: spoilerKey(r, 'one') })
      : h('p', { class: 'hero-one', text: `“${r.oneLiner}”` }))
    : null;

  const hero = h('section', { class: `dhero ${t ? t.cls : ''}` },
    h('div', { class: 'dhero-top' }, typeBadge(r.type, { short: false }), ordinalLabel(r)),
    h('h1', { class: 'dhero-title', text: r.title || '(제목 없음)' }),
    h('p', { class: 'dhero-date' }, icon('calendar'), h('span', { text: fmtDate(r.date) })),
    h('div', { class: 'dhero-rating' }, starsView(r.rating, { size: 'md' })),
    one,
    st ? h('div', { class: 'dhero-stamp' }, st) : null);

  const members = arr(r.members);
  const typeSecs = r.type === 'boardgame' ? bgSection(r) : r.type === 'murdermystery' ? mmSection(r) : r.type === 'escaperoom' ? erSection(r) : [];

  const review = r.review
    ? sec('후기', r.spoiler
      ? spoilerBlock(h('p', { class: 'review-text', text: r.review }), { key: spoilerKey(r, 'review') })
      : h('p', { class: 'review-text', text: r.review }))
    : null;

  const tags = arr(r.tags);
  const photos = gallery(r, { start: galleryAt.get(r.id) || 0, onIndex: (i) => galleryAt.set(r.id, i) });
  // 휴대폰은 한 줄로, 넓은 화면은 (사진·요약·멤버) | (종류별 기록·후기) 두 단으로
  const view = h('div', { class: ['page', 'page-detail', t ? t.cls : ''] },
    appBar({
      title: t ? t.label : '기록', back: '#/records',
      actions: [
        h('a', { class: 'icon-btn', href: `#/edit/${encodeURIComponent(r.id)}`, 'aria-label': '수정' }, icon('edit')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': '삭제', onClick: onDelete }, icon('trash')),
      ],
    }),
    h('div', { class: ['detail-grid', photos ? 'has-photos' : 'is-plain'] },
      h('div', { class: 'detail-col detail-col-a' },
        photos,
        hero,
        members.length ? sec(`함께한 멤버 ${members.length}명`, h('div', { class: 'mrows' }, members.map((id) => memberLink(id)))) : null),
      h('div', { class: 'detail-col detail-col-b' },
        typeSecs,
        review,
        tags.length ? h('div', { class: 'dtags' }, tags.map((tg) => h('a', { class: 'tag', href: `#/records?tag=${encodeURIComponent(tg)}`, text: `#${tg}` }))) : null,
        h('p', { class: 'dmeta' },
          r.createdAt ? h('span', { text: `작성 ${fmtDateTime(r.createdAt)}` }) : null,
          r.updatedAt && r.updatedAt !== r.createdAt ? h('span', { text: `수정 ${fmtDateTime(r.updatedAt)}` }) : null),
        h('div', { class: 'dactions' },
          h('a', { class: 'btn btn-soft', href: `#/edit/${encodeURIComponent(r.id)}` }, icon('edit'), h('span', { text: '수정하기' })),
          h('button', { type: 'button', class: 'btn btn-ghost btn-danger-text', onClick: onDelete }, icon('trash'), h('span', { text: '삭제' }))))));
  root.replaceChildren(view);
}

/** 이 화면에 보이는 내용의 요약 — 같으면 다시 그리지 않음 (넘기던 사진·열린 뷰어·스크롤이 흔들리지 않게) */
function signature(id) {
  const r = recordById(id);
  if (!r) return JSON.stringify([null, state.status, isFirstLoad(), loadFailed(), state.records.length]);
  const ord = ordinalLabel(r);
  return JSON.stringify([r, state.members, ord ? ord.textContent : null]);
}

export function mount(root, ctx) {
  const id = ctx.params[0];
  if (!ctx.restored) galleryAt.delete(id); // 새로 열면 첫 사진부터 (뒤로가기로 돌아오면 보던 사진)
  let shown = signature(id);
  render(root, id, ctx);
  return {
    update() {
      const sig = signature(id);
      if (sig === shown) return;
      shown = sig;
      render(root, id, ctx);
    },
    destroy: () => closeViewer(),
  };
}
