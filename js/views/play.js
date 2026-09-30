// 플레이 기록 상세 — 목록보다 티켓 느낌을 조금 더: 머리(제목·날짜·평점) | 절취선 | 사진·후기·기록 | 절취선 | 스포일러(접힘)
import { h, icon } from '../dom.js';
import * as repo from '../repo.js';
import { GENRES, MM_FORMATS } from '../constants.js';
import { SPOILER_KEYS, SPOILER_LABELS, hasSpoiler, placeLabel, workLabel } from '../model.js';
import { sameTitleWorks } from '../query.js';
import { fmtDateLong, fmtDate, fmtMinutes, fmtRemaining } from '../format.js';
import { navigate, takeJustSaved } from '../nav.js';
import { appBar, genreTag, resultTag, sampleTag, starsView, levelView, fold, confirmDialog, toast, emptyState, stampOnce } from '../ui.js';
import { gallery } from './photos.js';

const filled = (v) => v !== null && v !== undefined && v !== '';

function info(label, value, cls = '') {
  if (value === null || value === undefined || value === '' || value === false) return null;
  return h('div', { class: ['info', cls] }, h('dt', { text: label }), h('dd', {}, value));
}

/** 장르별 기록 (스포일러가 아닌 것만) */
function detailsBlock(play, work) {
  const d = play.details || {};
  let rows = [];
  let note = null;
  if (work.genre === 'boardgame') {
    const rank = filled(d.myRank) ? `${d.myRank}위${filled(d.players) ? ` / ${d.players}명` : ''}` : '';
    rows = [
      info('플레이 인원', filled(d.players) ? `${d.players}명` : ''),
      info('플레이 시간', fmtMinutes(d.durationMin)),
      info('내 점수', filled(d.myScore) ? `${d.myScore}점` : ''),
      info('순위', rank),
      info('사용한 확장', d.expansions || '', 'is-wide'),
    ];
  } else if (work.genre === 'murdermystery') {
    const fmt = MM_FORMATS.find((x) => x.key === d.format);
    rows = [
      info('플레이 방식', fmt ? fmt.label : ''),
      info('플레이 시간', fmtMinutes(d.durationMin)),
      info('스토리', filled(d.story) ? starsView(d.story, { size: 'sm', label: '스토리' }) : ''),
      info('몰입도', filled(d.immersion) ? starsView(d.immersion, { size: 'sm', label: '몰입도' }) : ''),
    ];
    if (d.impression) note = h('div', { class: 'td-note' }, h('h4', { class: 'td-h', text: '스토리·몰입 감상' }), h('p', { class: 'td-text', text: d.impression }));
  } else if (work.genre === 'escaperoom') {
    rows = [
      info('결과', resultTag(d.result)),
      info('남은 시간', fmtRemaining(d.remainingSec)),
      info('힌트', filled(d.hints) ? `${d.hints}개` : ''),
      info('체감 난이도', levelView(d.difficulty, { kind: 'difficulty', label: '체감 난이도' })),
      info('공포도', levelView(d.fear, { kind: 'fear', label: '공포도' })),
    ];
  }
  rows = rows.filter(Boolean);
  if (!rows.length && !note) return null;
  return h('section', { class: 'td-section' },
    h('h3', { class: 'td-h', text: GENRES[work.genre].section }),
    rows.length ? h('dl', { class: 'infos' }, rows) : null,
    note);
}

/** 스포일러 — 기본으로 접혀 있고, 펼치기 전에는 내용이 화면(DOM)에 없음 */
function spoilerBlock(play, work) {
  if (!hasSpoiler(play, work.genre)) return null;
  const s = play.spoiler || {};
  const keys = (SPOILER_KEYS[work.genre] || []).filter((k) => filled(s[k]));
  const names = keys.map((k) => SPOILER_LABELS[k]).join(' · ');
  return fold({
    label: '스포일러 메모',
    sub: (open) => `${names} — ${open ? '눌러서 접기' : '눌러서 펼치기'}`,
    icon: 'eyeOff',
    cls: 'spoiler-fold',
    build: () => h('dl', { class: 'spoilers' }, keys.map((k) => h('div', { class: 'spoiler-item' },
      h('dt', { text: SPOILER_LABELS[k] }),
      h('dd', { class: 'td-text', text: s[k] })))),
  });
}

async function remove(play, work) {
  const last = repo.playsOfWork(work.id).length <= 1;
  const ok = await confirmDialog('이 기록을 지울까요?',
    last
      ? `${fmtDate(play.date)} ‘${work.title}’ 기록을 지워요. 이 작품의 마지막 기록이라 작품 정보(표지 포함)도 함께 지워져요.`
      : `${fmtDate(play.date)} ‘${work.title}’ 기록과 이 기록의 사진을 지워요. 같은 작품의 다른 기록은 그대로예요.`,
    { ok: '지우기', danger: true });
  if (!ok) return;
  try {
    const r = await repo.deletePlay(play.id);
    toast('기록을 지웠어요', 'ok');
    if (r.workRemoved) navigate('#/', { replace: true });
    else navigate(`#/work/${encodeURIComponent(work.id)}`, { replace: true });
  } catch {
    toast('기록을 지우지 못했어요', 'error');
  }
}

function render(root, id) {
  const play = repo.getPlay(id);
  const work = play ? repo.getWork(play.workId) : null;
  if (!play || !work) {
    root.replaceChildren(appBar({ title: '기록', back: '#/' }), h('div', { class: 'container narrow' },
      emptyState({ icon: 'ticket', title: '기록을 찾을 수 없어요', text: '지워졌거나 다른 탭에서 바뀌었을 수 있어요.', actions: [h('a', { class: 'btn btn-ghost', href: '#/' }, '처음 화면으로')] })));
    return null;
  }
  const d = play.details || {};
  const ordinal = repo.ordinals().get(play.id) || 1;
  const count = repo.playsOfWork(work.id).length;
  const place = placeLabel(work);

  const head = h('div', { class: 'td-head' },
    h('div', { class: 'tk-tags' },
      genreTag(work.genre),
      work.genre === 'escaperoom' ? resultTag(d.result) : null,
      count > 1 ? h('span', { class: 'otag', text: `${ordinal}번째 플레이` }) : null,
      play.sample ? sampleTag() : null),
    h('h2', { class: 'td-title', text: work.title }),
    place ? h('p', { class: 'td-sub', text: place }) : null,
    h('dl', { class: 'td-meta' },
      h('div', { class: 'td-meta-item' }, h('dt', { text: '플레이 날짜' }), h('dd', {}, h('time', { datetime: play.date, text: fmtDateLong(play.date) }))),
      h('div', { class: 'td-meta-item' }, h('dt', { text: '평점' }), h('dd', {}, starsView(play.rating, { size: 'md' })))));

  const photos = gallery(play.photos);
  const body = [
    photos,
    play.oneLiner ? h('p', { class: 'td-oneliner' }, h('span', { class: 'sr-only', text: '한 줄 감상: ' }), play.oneLiner) : null,
    play.review ? h('section', { class: 'td-section' }, h('h3', { class: 'td-h', text: '상세 후기' }), h('p', { class: 'td-text', text: play.review })) : null,
    detailsBlock(play, work),
    play.companions && play.companions.length
      ? h('section', { class: 'td-section' }, h('h3', { class: 'td-h', text: '함께한 사람' }),
        h('ul', { class: 'people' }, play.companions.map((n) => h('li', { class: 'person', text: n }))))
      : null,
  ].filter(Boolean);
  const spoiler = spoilerBlock(play, work);

  const ticket = h('article', { class: 'ticket ticket-detail', dataset: { genre: work.genre }, 'aria-label': `${work.title} 기록` },
    head,
    h('div', { class: 'perf perf-lg', 'aria-hidden': 'true' }),
    h('div', { class: 'td-body' }, body.length ? body : h('p', { class: 'td-empty', text: '아직 적은 감상이 없어요. ‘수정’에서 사진·후기·장르별 기록을 더할 수 있어요.' })),
    spoiler ? h('div', { class: 'perf perf-lg', 'aria-hidden': 'true' }) : null,
    spoiler ? h('div', { class: 'td-spoiler' }, spoiler) : null);

  const others = sameTitleWorks(repo.worksList(), work.genre, work.title, { excludeId: work.id });
  const workLink = h('div', { class: 'td-work' },
    h('a', { class: 'work-link', href: `#/work/${encodeURIComponent(work.id)}` },
      icon('stack'),
      h('span', { class: 'work-link-text' },
        h('span', { class: 'work-link-title', text: count > 1 ? `이 작품의 기록 ${count}개 모아 보기` : '작품 정보 보기' }),
        h('span', { class: 'work-link-sub', text: workLabel(work) })),
      icon('chevron')),
    h('a', { class: 'btn btn-ghost', href: `#/new?work=${encodeURIComponent(work.id)}` }, icon('plus'), h('span', { text: '이 작품 다시 기록' })),
    others.length ? h('p', { class: 'td-hint', text: `이름이 같은 다른 작품 ${others.length}개는 따로 모아요 (예: 다른 매장의 같은 테마).` }) : null);

  root.replaceChildren(
    appBar({
      title: '기록',
      back: '#/',
      actions: [
        h('a', { class: 'icon-btn has-label', href: `#/play/${encodeURIComponent(play.id)}/edit`, 'aria-label': '수정' }, icon('edit'), h('span', { class: 'ib-label', text: '수정' })),
        h('button', { type: 'button', class: 'icon-btn has-label', 'aria-label': '삭제', onClick: () => remove(play, work) }, icon('trash'), h('span', { class: 'ib-label', text: '삭제' })),
      ],
    }),
    h('div', { class: 'container narrow detail-body' }, ticket, workLink));
  return { ticket, play, work };
}

export function mount(root, ctx) {
  const id = ctx.params[0];
  let r = render(root, id);
  // 저장 직후 한 번만: 방탈출 결과 도장
  if (r && takeJustSaved(id) && r.work.genre === 'escaperoom') {
    const res = (r.play.details || {}).result;
    if (res === 'success') stampOnce(r.ticket, '탈출 성공', 'success');
    else if (res === 'fail') stampOnce(r.ticket, '탈출 실패', 'fail');
  }
  let sig = r ? `${r.play.updatedAt}|${r.work.updatedAt}|${repo.playsOfWork(r.work.id).length}` : '';
  return {
    update() {
      // 다른 탭에서 바뀌었을 때만 다시 그림 (펼친 스포일러가 괜히 접히지 않게)
      const p = repo.getPlay(id);
      const w = p && repo.getWork(p.workId);
      const next = p && w ? `${p.updatedAt}|${w.updatedAt}|${repo.playsOfWork(w.id).length}` : '';
      if (next === sig) return;
      sig = next;
      r = render(root, id);
    },
  };
}
