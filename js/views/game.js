// 게임 상세 — 게임 정보(대표 이미지 · 인원·시간·장르 · 매장)와 그 게임의 플레이 기록. 여기서 바로 '플레이 기록하기'
// #/game/<id> : 등록한 게임 · #/game?type=…&title=… : 아직 게임 정보로 등록하지 않은 예전 기록 이름
import { h, icon } from '../dom.js';
import { TYPES } from '../constants.js';
import { state, isFirstLoad, loadFailed, gameById, gameSummaries, gameOfRecord, recordsOfGame, recordsSorted, isOwnedGame } from '../store.js';
import { titleKey } from '../stats.js';
import { gameInfoText } from '../format.js';
import { navigate } from '../nav.js';
import { appBar, typeBadge, emptyState, loadingState, loadErrorState } from '../ui.js';
import { recordCard, sectionHead, gamePageHref, gameWriteHref } from './bits.js';
import { gameThumb, openGameEditor, canDeleteGame, setOwned, deleteGameInfo } from './game-form.js';
import { statText } from './collection.js';

const OWNABLE = ['boardgame', 'murdermystery'];

/** 주소에 맞는 게임 요약 (gameEntries 의 한 줄) */
function findEntry(ctx) {
  const id = ctx.params[0];
  if (id) return gameSummaries().find((e) => e.gameId === id) || null;
  const type = ctx.query && ctx.query.type;
  const key = titleKey(ctx.query && ctx.query.title);
  if (!TYPES[type] || !key) return null;
  return gameSummaries().find((e) => !e.gameId && e.type === type && titleKey(e.title) === key) || null;
}

/** 이 게임의 기록 (최신순). 예전 기록 이름이면 게임에 묶이지 않은 같은 종류·같은 이름의 기록 */
function recordsOf(e) {
  if (e.gameId) return recordsOfGame(e.gameId);
  const key = titleKey(e.title);
  return recordsSorted().filter((r) => r.type === e.type && !gameOfRecord(r) && titleKey(r.title) === key);
}

function render(root, ctx) {
  const e = findEntry(ctx);
  const back = '#/collection';
  if (!e) {
    const waiting = isFirstLoad() || (loadFailed() && !state.games.length && !state.records.length);
    root.replaceChildren(h('div', { class: 'page page-game' }, appBar({ title: '게임', back }),
      waiting
        ? (isFirstLoad() ? loadingState() : loadErrorState(ctx && ctx.refresh))
        : emptyState({ icon: 'box', title: '게임을 찾을 수 없어요', text: '게임 정보가 지워졌을 수 있어요.', action: h('a', { class: 'btn btn-soft', href: back }, '소장으로') })));
    return;
  }

  const t = TYPES[e.type];
  const game = e.gameId ? gameById(e.gameId) : null;
  const owned = game ? isOwnedGame(game) : e.owned;
  const info = game ? gameInfoText(game, { genres: 10 }) : '';
  const records = recordsOf(e);

  // 정보 고치기 · 소장 표시 · 지우기 (예전 기록 이름은 '게임 정보로 등록')
  const editBtn = game
    ? h('button', { type: 'button', class: 'btn btn-soft', onClick: () => openGameEditor(game) }, icon('edit'), h('span', { text: '정보 수정' }))
    : h('button', {
      type: 'button', class: 'btn btn-soft',
      onClick: async () => {
        const res = await openGameEditor(null, { type: e.type, title: e.title, context: OWNABLE.includes(e.type) && e.owned ? 'collection' : 'record' });
        if (res && res.game) navigate(gamePageHref({ gameId: res.game.id }), { replace: true });
      },
    }, icon('box'), h('span', { text: '게임 정보로 등록' }));
  const ownBtn = game && OWNABLE.includes(game.type)
    ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => setOwned(game, !owned) }, owned ? '소장에서 빼기' : '내 소장으로 표시')
    : null;
  const delBtn = game && canDeleteGame(game)
    ? h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm btn-danger-text',
      onClick: async () => { if (await deleteGameInfo(game)) navigate(back, { replace: true }); },
    }, '게임 정보 삭제')
    : null;

  const hero = h('section', { class: ['card', 'ghero', t.cls] },
    gameThumb({ type: e.type, cover: e.cover }, 'gthumb ghero-thumb'),
    h('div', { class: 'ghero-text' },
      h('div', { class: 'ghero-badges' }, typeBadge(e.type), owned ? h('span', { class: 'rbadge rbadge-own', text: '내 소장' }) : null),
      h('h2', { class: 'ghero-title', text: e.title }),
      info ? h('p', { class: 'ghero-info', text: info }) : null,
      e.memo ? h('p', { class: 'ghero-memo', text: e.memo }) : null,
      // 항목('평균 ★ 4.3' 등)이 중간에서 줄바꿈되지 않게 하나씩 묶음
      h('p', { class: 'ghero-stat' }, statText(e).split(' · ').map((x, i) => [i ? ' · ' : null, h('span', { text: x })]))),
    h('div', { class: 'ghero-acts' },
      h('a', { class: 'btn btn-primary ghero-write', href: gameWriteHref(e) }, icon('plus'), h('span', { text: '플레이 기록하기' })),
      editBtn),
    ownBtn || delBtn ? h('div', { class: 'ghero-more' }, ownBtn, delBtn) : null);

  const list = h('section', { class: 'ghome-records' },
    sectionHead('플레이 기록', { sub: records.length ? `${records.length}개` : null }),
    records.length
      ? h('div', { class: 'rlist' }, records.map((r) => recordCard(r)))
      : h('p', { class: 'ghero-none', text: `아직 기록이 없어요. ‘플레이 기록하기’로 첫 판을 남겨 보세요.` }));

  root.replaceChildren(h('div', { class: ['page', 'page-game', t.cls] }, appBar({ title: t.noun, back }), hero, list));
}

export function mount(root, ctx) {
  render(root, ctx);
  return { update: () => render(root, ctx) };
}
