// 기록 상세 — 왼쪽(휴대폰은 위): 게임 표지 · 종류 · 제목 · 날짜·인원 · 내 별점 · 내 결과 | 감상 | 게임 정보
//               오른쪽(휴대폰은 아래): 플레이 결과 (함께한 사람 모두 — 결과가 없는 사람도)
import { h, icon } from '../dom.js';
import { TYPES, BG_MODES, MM_FORMATS, MM_OUTCOMES, MM_SCORES, ER_SCORES } from '../constants.js';
import { state, recordById, removeRecord, memberInfo, isFirstLoad, loadFailed, titleOf, gameOfRecord, recordsOfGame, isOwnedGame, getMeId, gameSummaries } from '../store.js';
import { participants, bgResultRows, myBgResult, bgWinners, titleKey } from '../stats.js';
import { fmtDate, fmtMinutes, fmtRemaining, fmtDateTime, gameInfoText } from '../format.js';
import * as api from '../api.js';
import { navigate } from '../nav.js';
import { appBar, typeBadge, starsView, stamp, scoreBars, spoilerBlock, confirmDialog, toast, emptyState, loadingState, loadErrorState, moreMenu } from '../ui.js';
import { ordinalLabel, bgOf, mmOf, erOf, spoilerKey, ownershipText, gamePageHref, gameWriteHref } from './bits.js';
import { gallery, closeViewer } from './photos.js';
import { gameThumb, openGameEditor } from './game-form.js';

// 상세를 다시 그려도(새로고침·다른 기기의 변경) 보던 사진 그대로: 기록 id → 사진 번호
const galleryAt = new Map();

const arr = (v) => (Array.isArray(v) ? v : []);

/** '게임으로' · '작품으로' · '테마로' (받침이 없거나 ㄹ 받침이면 '로') */
function withRo(word) {
  const c = String(word).charCodeAt(String(word).length - 1) - 0xAC00;
  const jong = c >= 0 && c <= 11171 ? c % 28 : 0;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

/** 게임 정보로 등록하기 전의 예전 기록이면 같은 종류·같은 이름의 요약 (기록 모아 보기용), 아니면 null */
function legacyEntry(r) {
  if (gameOfRecord(r)) return null;
  const key = titleKey(r.title);
  return key ? gameSummaries().find((e) => !e.gameId && e.type === r.type && titleKey(e.title) === key) || null : null;
}

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

/** 같은 카드 안의 한 칸 (얇은 선으로 나눔) */
function part(label, ...children) {
  return h('div', { class: 'dpart' }, h('h2', { class: 'dpart-label', text: label }), children);
}

function memberLink(id) {
  const m = memberInfo(id);
  const inner = [h('span', { class: 'mrow-name', text: m.name }), id === getMeId() ? h('span', { class: 'me-badge', text: '나' }) : null];
  return m.missing
    ? h('span', { class: 'mrow is-gone' }, inner)
    : h('a', { class: 'mrow', href: `#/member/${encodeURIComponent(id)}` }, inner);
}

// ── 그날의 정보 · 세부 평가 (예전 기록에만 있는 값 — 있을 때만) ──

function dayInfo(r) {
  if (r.type === 'boardgame') {
    const bg = bgOf(r);
    const mode = BG_MODES.find((m) => m.key === bg.mode);
    // 방식은 기본값(경쟁)이면 적은 정보로 보지 않음
    return infoGrid([
      ['방식', mode && bg.mode !== 'competitive' ? mode.label : '', 'users'],
      ['장소', bg.place, 'pin'],
      ['플레이 시간', fmtMinutes(bg.playTimeMin), 'clock'],
      ['확장판', bg.expansion, 'sparkle'],
      ['소장 여부', gameOfRecord(r) ? '' : ownershipText(r), 'box'],
    ]);
  }
  if (r.type === 'murdermystery') {
    const mm = mmOf(r);
    const fmt = MM_FORMATS.find((f) => f.key === mm.format);
    // 형태는 '매장형'이 기본값이라, 매장 이름이 있거나 다른 형태일 때만 보여 줌
    const showFormat = fmt && (mm.format !== 'store' || mm.store);
    return infoGrid([
      ['제작사', mm.publisher, 'book'],
      ['형태', showFormat ? fmt.label : '', 'dice'],
      ['매장·지점', mm.format === 'store' ? mm.store : '', 'pin'],
      ['GM', mm.gm, 'mask'],
      ['인원', mm.playerCount ? `${mm.playerCount}인` : '', 'users'],
      ['플레이 시간', fmtMinutes(mm.playTimeMin), 'clock'],
      ['소장 여부', gameOfRecord(r) ? '' : ownershipText(r), 'box'],
    ]);
  }
  if (r.type === 'escaperoom') {
    const er = erOf(r);
    return infoGrid([
      ['브랜드', er.brand, 'door'],
      ['지점', er.branch, 'pin'],
      ['장르', er.genre, 'tag'],
      ['인원', er.playerCount ? `${er.playerCount}인` : '', 'users'],
      ['제한 시간', er.timeLimitMin ? `${er.timeLimitMin}분` : '', 'clock'],
    ]);
  }
  return null;
}

function detailScores(r) {
  if (r.type === 'murdermystery') {
    const mm = mmOf(r);
    const hasScores = MM_SCORES.some((s) => Number(mm.scores && mm.scores[s.key]) > 0);
    if (!hasScores && !(Number(mm.difficulty) > 0) && !mm.replay) return null;
    return [
      hasScores ? scoreBars(MM_SCORES.map((s) => ({ label: s.label, value: mm.scores ? mm.scores[s.key] : 0 }))) : null,
      h('div', { class: 'gauges' }, gauge('추리 난이도', mm.difficulty)),
      mm.replay ? h('p', { class: 'replay' }, icon('heart'), h('span', { text: '다시 하고 싶어요 · 추천해요' })) : null,
    ];
  }
  if (r.type === 'escaperoom') {
    const er = erOf(r);
    const hasScores = ER_SCORES.some((s) => Number(er.scores && er.scores[s.key]) > 0);
    if (!hasScores && !(Number(er.difficulty) > 0) && !(Number(er.fear) > 0) && !(Number(er.activity) > 0) && !er.replay) return null;
    return [
      hasScores ? scoreBars(ER_SCORES.map((s) => ({ label: s.label, value: er.scores ? er.scores[s.key] : 0 }))) : null,
      h('div', { class: 'gauges' }, gauge('난이도', er.difficulty), gauge('공포도', er.fear), gauge('활동성', er.activity)),
      er.replay ? h('p', { class: 'replay' }, icon('heart'), h('span', { text: '추천해요' })) : null,
    ];
  }
  return null;
}

// ── 맨 위 한 줄 결과 ──

/**
 * 제목 아래의 '내 결과' 한 줄 (보드게임): '내 결과 · 2위 / 4명' · '내 결과 · 협력 승리'.
 * 나를 모르거나, 함께하지 않았거나, 내 결과가 없으면 없음 — 판 전체의 결과(우승자·탈출 성공 등)는 플레이 결과 칸에서.
 * 머더미스터리의 범인 검거·도주는 결말 스포일러라 여기 내지 않음
 */
function headResult(r) {
  if (r.type === 'boardgame') {
    const bg = bgOf(r);
    const mine = myBgResult(r, getMeId());
    if (!mine) return null;
    if (mine.kind === 'coop') {
      return h('p', { class: `dres-line is-mine${mine.win ? ' is-win' : ''}` }, h('span', { text: `내 결과 · 협력 ${mine.win ? '승리' : '패배'}` }));
    }
    const team = bg.mode === 'team';
    let text;
    if (mine.kind === 'rank') text = `${mine.tied ? '공동 ' : ''}${mine.rank}위 / ${mine.of}명`;
    else text = team ? '승리' : mine.shared ? '공동 우승' : '우승';
    const win = mine.kind === 'win' || mine.winner;
    return h('p', { class: `dres-line is-mine${win ? ' is-win' : ''}` },
      win ? icon('crown') : null, h('span', { text: `내 결과 · ${text}` }));
  }
  return null;
}

// ── 플레이 결과 (오른쪽 단) ──

function resultsCard(title, n, ...children) {
  return h('section', { class: 'card dres' },
    h('div', { class: 'dres-head' },
      h('h2', { class: 'dres-title', text: title }),
      n ? h('span', { class: 'dres-sub', text: `${n}명` }) : null),
    children);
}

const noPeople = () => h('p', { class: 'dres-empty', text: '함께한 사람을 기록하지 않았어요' });

/** 이름만 있는 줄 (협력·방탈출·머미, 결과 미입력): 나는 연한 초록 줄 + ‘나’ */
function peopleRows(ids) {
  return h('ul', { class: 'dres-list' }, ids.map((id) =>
    h('li', { class: `dres-row${id === getMeId() ? ' is-me' : ''}`, 'data-member-id': id }, memberLink(id))));
}

function bgResults(r) {
  const bg = bgOf(r);
  const ids = [...participants(r)];
  if (bg.mode === 'coop') {
    const outcome = bg.coopWin === true ? stamp('협력 승리', 'win', { tilt: false })
      : bg.coopWin === false ? stamp('협력 패배', 'fail', { tilt: false })
      : h('span', { class: 'dres-pending', text: '결과 미입력' });
    return resultsCard('플레이 결과', ids.length, h('div', { class: 'dres-outcome' }, outcome), ids.length ? peopleRows(ids) : noPeople());
  }
  const rows = bgResultRows(r);
  if (!rows.length) return resultsCard('플레이 결과', 0, noPeople());
  const any = rows.some((x) => x.hasResult);
  const ranked = rows.some((x) => x.rank !== null);
  const team = bg.mode === 'team';
  const shared = bgWinners(r).size > 1;
  const winText = team ? '승리' : shared ? '공동 우승' : '우승';
  return resultsCard(team ? '팀전 결과' : '플레이 결과', rows.length,
    any ? null : h('div', { class: 'dres-outcome' }, h('span', { class: 'dres-pending', text: '결과 미입력' })),
    h('ol', { class: `dres-list${ranked ? ' has-ranks' : any ? ' has-results' : ''}` }, rows.map((x) => {
      const me = x.memberId === getMeId();
      return h('li', { class: ['dres-row', x.winner ? 'is-winner' : '', me ? 'is-me' : '', x.hasResult ? '' : 'is-blank'], 'data-member-id': x.memberId },
        ranked ? h('span', {
          class: 'rank-no', text: x.rank ? String(x.rank) : '–',
          'aria-label': x.rank ? `${x.tied ? '공동 ' : ''}${x.rank}등` : '순위 없음',
        }) : null,
        memberLink(x.memberId),
        x.winner ? h('span', { class: 'rank-win' }, icon('crown'), h('span', { text: winText })) : null,
        any ? h('span', { class: `rank-score${x.hasResult ? '' : ' is-blank'}`, text: x.score !== null ? `${x.score}점` : x.hasResult ? '' : '결과 없음' }) : null);
    })));
}

function erResults(r) {
  const er = erOf(r);
  const ids = [...participants(r)];
  const hasHints = er.hints !== null && er.hints !== undefined && er.hints !== '' && Number.isFinite(Number(er.hints));
  const remain = er.cleared && er.remainingSec !== null && er.remainingSec !== undefined && er.remainingSec !== '' ? fmtRemaining(er.remainingSec) : '';
  const outcome = er.cleared === true ? stamp('탈출 성공', 'clear', { tilt: false })
    : er.cleared === false ? stamp('탈출 실패', 'fail', { tilt: false })
    : h('span', { class: 'dres-pending', text: '결과 미입력' });
  return resultsCard('플레이 결과', ids.length,
    h('div', { class: 'dres-outcome' }, outcome,
      remain || hasHints ? h('div', { class: 'er-nums' },
        h('div', { class: 'er-num' }, h('span', { class: 'er-num-v', text: remain || '–' }), h('span', { class: 'er-num-l', text: '남은 시간' })),
        h('div', { class: 'er-num' }, h('span', { class: 'er-num-v', text: hasHints ? String(Number(er.hints)) : '–' }), h('span', { class: 'er-num-l', text: '힌트' }))) : null),
    ids.length ? peopleRows(ids) : noPeople());
}

/**
 * 머더미스터리: 함께한 사람 이름은 보이고, 누가 어떤 역할·범인이었는지와 범인 검거·도주(결말)는
 * 작품 스포일러라 늘 접어 두고 ‘보기’를 눌렀을 때만 펼침 (펼친 상태는 이 실행 동안 기억)
 */
function mmResults(r) {
  const mm = mmOf(r);
  const roles = arr(mm.roles).filter((x) => x && x.memberId);
  const ids = [...participants(r)];
  const byId = new Map(roles.map((x) => [x.memberId, x]));
  const culprit = mm.culpritResult === 'caught' ? stamp('범인 검거', 'caught', { tilt: false })
    : mm.culpritResult === 'escaped' ? stamp('범인 도주', 'escaped', { tilt: false }) : null;
  const secretRoles = roles.filter((x) => x.culprit || x.character || x.outcome || x.mvp);
  const row = (x) => {
    const oc = MM_OUTCOMES.find((o) => o.key === x.outcome);
    return h('li', { class: `role-row${x.culprit ? ' is-culprit' : ''}${x.memberId === getMeId() ? ' is-me' : ''}`, 'data-member-id': x.memberId },
      memberLink(x.memberId),
      x.character ? h('span', { class: 'role-char', text: x.character }) : null,
      h('span', { class: 'role-flags' },
        x.culprit ? stamp('범인', 'culprit', { tilt: false }) : null,
        oc ? h('span', { class: `outcome outcome-${oc.key}`, text: oc.label }) : null,
        x.mvp ? h('span', { class: 'mvp' }, icon('crown'), h('span', { text: 'MVP' })) : null));
  };
  const secret = culprit || secretRoles.length
    ? spoilerBlock(h('div', { class: 'mm-secret' },
      culprit ? h('div', { class: 'dres-outcome' }, culprit) : null,
      secretRoles.length ? h('ul', { class: 'roles' }, ids.filter((id) => byId.has(id) && secretRoles.includes(byId.get(id))).map((id) => row(byId.get(id)))) : null),
    { label: secretRoles.some((x) => x.culprit) || culprit ? '범인·역할 보기' : '역할 보기', key: spoilerKey(r, 'roles') })
    : null;
  return resultsCard('함께한 멤버', ids.length, ids.length ? peopleRows(ids) : noPeople(), secret);
}

function resultsOf(r) {
  if (r.type === 'boardgame') return bgResults(r);
  if (r.type === 'murdermystery') return mmResults(r);
  if (r.type === 'escaperoom') return erResults(r);
  return null;
}

// ── 게임 정보 (게임 자체의 정보 — 작은 보조 칸) ──

function gameInfoPart(r) {
  const t = TYPES[r.type];
  const noun = t ? t.noun : '게임';
  const game = gameOfRecord(r);
  if (game) {
    const info = gameInfoText(game, { genres: 3 });
    const n = recordsOfGame(game.id).length;
    return h('div', { class: 'dgame' },
      h('div', { class: 'dgame-text' },
        h('p', { class: 'dgame-label' }, h('span', { text: `${noun} 정보` }), isOwnedGame(game) ? h('span', { class: 'rbadge rbadge-own', text: '내 소장' }) : null),
        h('p', { class: `dgame-meta${info ? '' : ' is-empty'}`, text: info || '인원·시간 같은 정보를 아직 적지 않았어요' })),
      h('div', { class: 'dgame-acts' },
        h('a', { class: 'link-more', href: gamePageHref({ gameId: game.id }) }, `이 ${noun}의 기록 보기 · ${n}개`, icon('chevron')),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm dgame-edit', onClick: () => openGameEditor(game) }, icon('edit'), h('span', { text: `${noun} 정보 수정` }))));
  }
  // 게임 정보로 등록하기 전의 예전 기록: 같은 이름의 기록 모아 보기만
  const entry = legacyEntry(r);
  if (!entry) return null;
  return h('div', { class: 'dgame' },
    h('div', { class: 'dgame-text' },
      h('p', { class: 'dgame-label' }, h('span', { text: `${noun} 정보` })),
      h('p', { class: 'dgame-meta is-empty', text: `아직 ${noun} 정보로 등록하지 않았어요` })),
    h('div', { class: 'dgame-acts' },
      h('a', { class: 'link-more', href: gamePageHref(entry) }, `이 ${noun}의 기록 보기 · ${entry.plays}개`, icon('chevron'))));
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

  let deleting = false;
  async function onDelete() {
    if (deleting) return;
    const ok = await confirmDialog('이 기록을 삭제할까요?', `“${titleOf(r)}” 기록이 모두에게서 사라져요. 되돌릴 수 없어요.`, { ok: '삭제', danger: true });
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

  const title = titleOf(r) || '(제목 없음)';
  const game = gameOfRecord(r);
  const people = participants(r).size;

  // 맨 위: 표지 | 종류 → 제목 → 날짜·인원 → 내 별점 → (내 결과)
  const head = h('div', { class: 'dhead' },
    gameThumb({ type: r.type, cover: game ? game.cover : null }, 'gthumb dhead-cover'),
    h('div', { class: 'dhead-text' },
      h('div', { class: 'dhead-top' }, typeBadge(r.type), ordinalLabel(r)),
      h('h1', { class: 'dhead-title', text: title }),
      h('p', { class: 'dhead-meta' },
        h('span', { class: 'dhead-date', text: fmtDate(r.date) }),
        people ? h('span', { class: 'dhead-people', text: `${people}명` }) : null),
      h('div', { class: 'dhead-rating' }, Number(r.rating) > 0
        ? starsView(r.rating, { size: 'md', label: '내 별점' })
        : h('span', { class: 'dhead-norate', text: '별점 없음' })),
      headResult(r)));

  // 감상: 예전 기록의 한줄평과 후기를 모두 보여 줌. 스포일러 기록은 열기 전까지 가림
  const reviewBody = (r.oneLiner || r.review)
    ? h('div', { class: 'review-body' },
      r.oneLiner ? h('p', { class: 'review-one', text: r.oneLiner }) : null,
      r.review ? h('p', { class: 'review-text', text: r.review }) : null)
    : null;
  const review = reviewBody
    ? part('감상', r.spoiler ? spoilerBlock(reviewBody, { label: '감상 보기', key: spoilerKey(r, 'review') }) : reviewBody)
    : null;

  // 내 역할 (머더미스터리): 작품 스포일러라 늘 접어 두고 눌렀을 때만 보여 줌
  const myRole = r.type === 'murdermystery' ? String(mmOf(r).myRole || '').trim() : '';
  const roleSec = myRole
    ? part('내 역할', spoilerBlock(h('p', { class: 'my-role', text: myRole }), { label: '내 역할 보기', key: spoilerKey(r, 'myrole') }))
    : null;
  const scores = detailScores(r);
  const info = dayInfo(r);

  const main = h('section', { class: ['card', 'dmain', t ? t.cls : ''] },
    head,
    review,
    roleSec,
    scores ? part('세부 평가', scores) : null,
    info ? part('그날의 정보', info) : null,
    gameInfoPart(r));

  const photos = gallery(r, { start: galleryAt.get(r.id) || 0, onIndex: (i) => galleryAt.set(r.id, i) });
  const noun = t ? t.noun : '게임';
  const view = h('div', { class: ['page', 'page-detail', t ? t.cls : ''] },
    appBar({
      title: t ? t.label : '기록', back: '#/records', cls: 'appbar-detail',
      actions: [
        h('a', { class: 'btn btn-soft btn-sm dedit', href: `#/edit/${encodeURIComponent(r.id)}`, 'aria-label': '이 기록 수정' }, icon('edit'), h('span', { text: '기록 수정' })),
        moreMenu({
          label: '기록 메뉴',
          items: [
            { label: `이 ${withRo(noun)} 새 기록`, icon: 'plus', onSelect: () => navigate(gameWriteHref(game ? { gameId: game.id, type: r.type } : { type: r.type, title: titleOf(r) })) },
            { label: '기록 삭제', icon: 'trash', danger: true, onSelect: onDelete },
          ],
        }),
      ],
    }),
    // 휴대폰은 한 줄로 (게임 정보와 감상 → 플레이 결과), 넓은 화면은 (사진 · 정보와 감상) | (플레이 결과) 두 단
    h('div', { class: ['detail-grid', photos ? 'has-photos' : 'is-plain'] },
      h('div', { class: 'detail-col detail-col-a' }, photos, main),
      h('div', { class: 'detail-col detail-col-b' },
        resultsOf(r),
        h('p', { class: 'dmeta' },
          r.createdAt ? h('span', { text: `작성 ${fmtDateTime(r.createdAt)}` }) : null,
          r.updatedAt && r.updatedAt !== r.createdAt ? h('span', { text: `수정 ${fmtDateTime(r.updatedAt)}` }) : null))));
  root.replaceChildren(view);
}

/** 이 화면에 보이는 내용의 요약 — 같으면 다시 그리지 않음 (넘기던 사진·열린 뷰어·스크롤이 흔들리지 않게) */
function signature(id) {
  const r = recordById(id);
  if (!r) return JSON.stringify([null, state.status, isFirstLoad(), loadFailed(), state.records.length]);
  const ord = ordinalLabel(r);
  const game = gameOfRecord(r);
  const legacy = legacyEntry(r);
  return JSON.stringify([r, state.members, ord ? ord.textContent : null, game, game ? recordsOfGame(game.id).length : legacy && legacy.plays, getMeId()]);
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
