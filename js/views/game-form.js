// 게임 정보 등록 · 수정 창 (게임·작품·테마). 소장 탭과 기록 폼의 '＋ 새 게임 등록'이 같은 창을 씀
// 이름만 필수. 대표 이미지 · 내가 소장한 게임 · (보드게임) 인원·예상 시간·장르 · (방탈출) 매장·지점 · 메모는 선택
import { h, icon } from '../dom.js';
import { TYPES, TYPE_KEYS, LIMITS, GENRE_SUGGESTIONS } from '../constants.js';
import { state, upsertGame, gamesOfType, isOwnedGame, coverOf, recordsOfGame } from '../store.js';
import { nameKey, codePoints, gameInfoText } from '../format.js';
import * as api from '../api.js';
import { segmented, chip, openDialog, toast, nextId } from '../ui.js';
import { photoImg } from '../images.js';
import { coverField } from './photos.js';

const OWNABLE = ['boardgame', 'murdermystery'];
// 소장 탭에서 마지막으로 고른 종류 (이어서 여러 개 넣을 때 다시 고르지 않게)
let lastCollectionType = 'boardgame';

/** 게임 썸네일 (대표 이미지 또는 종류 아이콘) */
export function gameThumb(g, cls = 'gthumb') {
  const t = TYPES[g && g.type] || TYPES.boardgame;
  const cover = coverOf(g);
  return h('span', { class: [cls, cover ? 'has-img' : 'is-empty', t.cls], 'aria-hidden': 'true' },
    cover ? photoImg(cover, { size: 't' }) : icon(t.icon));
}

/** 한 줄 요약: '2~4명 · 60~90분 · 전략' 또는 '키이스케이프 홍대점' (없으면 '') */
export const gameMeta = (g) => gameInfoText(g);

function numIn(value, { label, min, max, placeholder }) {
  return h('input', {
    type: 'number', inputmode: 'numeric', class: 'input input-num gf-num', min: String(min), max: String(max),
    value: Number.isInteger(value) ? String(value) : '', placeholder, 'aria-label': label,
  });
}

/** 숫자 칸 값: '' → null, 정수가 아니거나 범위 밖이면 NaN */
function readInt(el, min, max) {
  const v = el.value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
}

/**
 * 게임 정보 창.
 * @param {object|null} game  고칠 게임 (없으면 새로 등록)
 * @param {object} opts
 *   type: 처음 고른 종류 · title: 이름 칸에 미리 채울 글자
 *   context: 'collection'(소장 탭: 보드게임·머미만, '내 소장' 기본 선택, 계속 등록) | 'record'(기록 폼: 세 종류, 기본 선택 안 함)
 * @returns {Promise<{game: object, existing?: boolean}|null>}  저장한(또는 같은 이름 목록에서 고른) 게임
 */
export async function openGameEditor(game = null, { type: startType, title: startTitle = '', context = 'record' } = {}) {
  const isNew = !game;
  const inCollection = context === 'collection';
  const kinds = inCollection ? OWNABLE : TYPE_KEYS;
  let type = game ? game.type : (kinds.includes(startType) ? startType : (inCollection ? lastCollectionType : 'boardgame'));
  let result = null;
  let savedCount = 0;
  const added = [];
  let genres = game && Array.isArray(game.genres) ? [...game.genres] : [];
  let ownedOn = game ? isOwnedGame(game) : inCollection;
  let dupShownFor = null; // 같은 이름 목록을 보여 준 이름 → 그 이름으로 다시 누르면 따로 등록
  let closeDlg = () => {};

  const titleIn = h('input', {
    type: 'text', class: 'input', maxlength: String(LIMITS.title), value: game ? game.title : Array.from(String(startTitle || '').trim()).slice(0, LIMITS.title).join(''),
    autocomplete: 'off', enterkeyhint: 'done', id: nextId('gtitle'), 'data-field': 'game-title',
  });
  const titleLabel = h('label', { class: 'field-label', htmlFor: titleIn.id });
  const dupBox = h('div', { class: 'gf-dup', hidden: true, role: 'status' });
  const err = h('p', { class: 'form-err', role: 'alert' });
  const addedLine = h('p', { class: 'gform-added', hidden: true, role: 'status' });

  const cover = coverField({ value: game ? coverOf(game) : null, label: '대표 이미지' });

  // 보드게임: 인원 · 예상 시간 (나란히) → 장르
  const pMin = numIn(game && game.playersMin, { label: '최소 인원', min: 1, max: LIMITS.gamePlayers, placeholder: '2' });
  const pMax = numIn(game && game.playersMax, { label: '최대 인원', min: 1, max: LIMITS.gamePlayers, placeholder: '4' });
  const tMin = numIn(game && game.timeMin, { label: '최소 예상 시간(분)', min: 1, max: LIMITS.gameTime, placeholder: '60' });
  const tMax = numIn(game && game.timeMax, { label: '최대 예상 시간(분)', min: 1, max: LIMITS.gameTime, placeholder: '90' });
  const rangeRow = (labelText, a, b, unit) => h('div', { class: 'field gf-range' },
    h('span', { class: 'field-label', text: labelText }),
    h('div', { class: 'gf-range-in' }, a, h('span', { class: 'gf-tilde', text: '~' }), b, h('span', { class: 'unit', text: unit })));
  const genreChips = h('div', { class: 'chips gf-genres', role: 'group', 'aria-label': '장르' });
  const genreIn = h('input', { type: 'text', class: 'input', maxlength: String(LIMITS.gameGenre + 1), placeholder: '직접 추가', 'aria-label': '장르 직접 추가', autocomplete: 'off', enterkeyhint: 'done' });
  function paintGenres() {
    const pool = [...genres];
    for (const g of GENRE_SUGGESTIONS) if (!pool.includes(g)) pool.push(g);
    genreChips.replaceChildren(...pool.map((g) => chip({
      label: g, pressed: genres.includes(g), cls: 'chip-sm',
      onToggle: (on) => {
        if (on && genres.length >= LIMITS.gameGenres) { toast(`장르는 ${LIMITS.gameGenres}개까지예요`, 'error'); return false; }
        genres = on ? [...genres, g] : genres.filter((x) => x !== g);
        return true;
      },
    })));
  }
  /** 직접 적은 장르 넣기. 반환: 넣음/빈칸 true, 문제 false */
  function addGenre() {
    const v = genreIn.value.trim().replace(/\s+/g, ' ');
    if (!v) return true;
    if (codePoints(v).length > LIMITS.gameGenre) { err.textContent = `장르는 ${LIMITS.gameGenre}자까지예요`; genreIn.focus(); return false; }
    if (!genres.includes(v)) {
      if (genres.length >= LIMITS.gameGenres) { err.textContent = `장르는 ${LIMITS.gameGenres}개까지예요`; return false; }
      genres = [...genres, v];
    }
    genreIn.value = '';
    paintGenres();
    return true;
  }
  genreIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); addGenre(); }
  });
  paintGenres();
  const bgBox = h('div', { class: 'gf-bg' },
    h('div', { class: 'gf-row gf-ranges' },
      rangeRow('인원', pMin, pMax, '명'),
      rangeRow('예상 시간', tMin, tMax, '분')),
    h('p', { class: 'field-hint gf-range-hint', text: '1인 게임이나 인원·시간이 정해져 있으면 한 칸만 적어요' }),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: '장르' }), genreChips,
      h('div', { class: 'tag-add' }, genreIn, h('button', { type: 'button', class: 'btn btn-soft', onClick: addGenre }, '추가'))));

  // 방탈출: 매장 · 지점
  const brandIn = h('input', { type: 'text', class: 'input', maxlength: String(LIMITS.brand), value: game ? game.brand || '' : '', placeholder: '예) 키이스케이프', autocomplete: 'off', 'aria-label': '매장(브랜드)' });
  const branchIn = h('input', { type: 'text', class: 'input', maxlength: String(LIMITS.branch), value: game ? game.branch || '' : '', placeholder: '예) 홍대점', autocomplete: 'off', 'aria-label': '지점' });
  const erBox = h('div', { class: 'gf-row' },
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: '매장' }), brandIn),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: '지점' }), branchIn));

  const ownIn = h('input', { type: 'checkbox', class: 'gf-own-input', checked: ownedOn, id: nextId('gown') });
  ownIn.addEventListener('change', () => { ownedOn = ownIn.checked; });
  const ownRow = h('label', { class: 'gf-own', htmlFor: ownIn.id }, ownIn,
    h('span', { class: 'gf-own-text' }, h('span', { class: 'gf-own-label', text: '내가 소장한 게임' }),
      h('span', { class: 'gf-own-desc', text: '소장 탭에 보여요' })));

  const memoIn = h('input', {
    type: 'text', class: 'input', maxlength: String(LIMITS.gameMemo), value: game ? game.memo || '' : '',
    placeholder: '예) 확장 포함', autocomplete: 'off', enterkeyhint: 'done', id: nextId('gmemo'), 'data-field': 'game-memo',
  });

  function paintType() {
    const t = TYPES[type];
    titleLabel.textContent = t.titleLabel;
    titleIn.placeholder = t.titlePlaceholder;
    memoIn.placeholder = { boardgame: '예) 확장 포함', murdermystery: '예) 보드게임형 · 6인', escaperoom: '예) 공포 2단계' }[type];
    bgBox.hidden = type !== 'boardgame';
    erBox.hidden = type !== 'escaperoom';
    ownRow.hidden = !OWNABLE.includes(type); // 방탈출 테마에는 소장 여부 없음
    paintDup();
  }

  /** 같은 종류에 같은 이름이 이미 있으면 먼저 보여 줌 (합치지 않고 고르게) */
  function paintDup() {
    const key = nameKey(titleIn.value);
    const same = key ? gamesOfType(type).filter((e) => e.game && e.gameId !== (game && game.id) && nameKey(e.title) === key) : [];
    if (!same.length) { dupBox.hidden = true; dupBox.replaceChildren(); dupShownFor = null; return; }
    dupShownFor = `${type}:${key}`;
    dupBox.hidden = false;
    dupBox.replaceChildren(
      h('p', { class: 'gf-dup-title' }, icon('info'), h('span', { text: '같은 이름이 이미 있어요' })),
      h('ul', { class: 'gf-dup-list' }, same.map((e) => {
        const meta = [isOwnedGame(e.game) ? '내 소장' : '', gameMeta(e.game), e.plays ? `기록 ${e.plays}개` : '아직 기록 없음'].filter(Boolean).join(' · ');
        let action = null;
        if (!isNew) {
          action = null;
        } else if (!inCollection) {
          action = h('button', { type: 'button', class: 'btn btn-soft btn-sm', onClick: () => { result = { game: e.game, existing: true }; closeDlg('picked'); } }, '이 게임 선택');
        } else if (!isOwnedGame(e.game)) {
          action = h('button', { type: 'button', class: 'btn btn-soft btn-sm', onClick: () => markOwned(e.game) }, '내 소장으로');
        } else {
          action = h('span', { class: 'gf-dup-note', text: '이미 내 소장' });
        }
        return h('li', { class: 'gf-dup-item' }, gameThumb(e.game),
          h('span', { class: 'gf-dup-text' }, h('span', { class: 'gf-dup-name', text: e.title }), h('span', { class: 'gf-dup-meta', text: meta })),
          action);
      })),
      h('p', { class: 'field-hint', text: isNew ? '다른 판본이면 그대로 등록하면 따로 저장돼요.' : '이름이 같아도 따로 저장돼요.' }));
  }

  async function markOwned(g) {
    try {
      const res = await api.saveGame({ id: g.id, type: g.type, title: g.title, memo: g.memo || '', owned: true });
      upsertGame(res.game);
      result = { game: res.game, existing: true };
      toast(`‘${res.game.title}’ 내 소장으로 표시했어요`, 'ok');
      closeDlg('picked');
    } catch (e) {
      err.textContent = api.errorMessage(e, '저장');
    }
  }

  let dupTimer = null;
  titleIn.addEventListener('input', () => {
    err.textContent = '';
    titleIn.removeAttribute('aria-invalid');
    clearTimeout(dupTimer);
    dupTimer = setTimeout(paintDup, 200);
  });
  for (const el of [pMin, pMax, tMin, tMax]) el.addEventListener('input', () => { el.removeAttribute('aria-invalid'); err.textContent = ''; });

  const fail = (msg, el = titleIn) => {
    err.textContent = msg;
    if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
    return false;
  };

  /** 저장. 성공하면 true */
  async function save() {
    paintDup();
    const title = titleIn.value.trim().replace(/\s+/g, ' ');
    const memo = memoIn.value.trim();
    const t = TYPES[type];
    if (!title) return fail(`${t.titleLabel}을 적어 주세요`);
    if (codePoints(title).length > LIMITS.title) return fail(`이름은 ${LIMITS.title}자까지예요`);
    if (codePoints(memo).length > LIMITS.gameMemo) return fail(`메모는 ${LIMITS.gameMemo}자까지예요`, memoIn);
    const payload = { ...(game ? { id: game.id } : {}), type, title, memo };
    if (OWNABLE.includes(type)) payload.owned = ownedOn;
    if (type === 'boardgame') {
      if (!addGenre()) return false;
      const a = readInt(pMin, 1, LIMITS.gamePlayers), b = readInt(pMax, 1, LIMITS.gamePlayers);
      if (Number.isNaN(a)) return fail(`인원은 1~${LIMITS.gamePlayers}명으로 적어 주세요`, pMin);
      if (Number.isNaN(b)) return fail(`인원은 1~${LIMITS.gamePlayers}명으로 적어 주세요`, pMax);
      if (a !== null && b !== null && a > b) return fail('최대 인원이 최소 인원보다 적어요', pMax);
      const c = readInt(tMin, 1, LIMITS.gameTime), d = readInt(tMax, 1, LIMITS.gameTime);
      if (Number.isNaN(c)) return fail('예상 시간은 1~1440분으로 적어 주세요', tMin);
      if (Number.isNaN(d)) return fail('예상 시간은 1~1440분으로 적어 주세요', tMax);
      if (c !== null && d !== null && c > d) return fail('최대 시간이 최소 시간보다 짧아요', tMax);
      // 한 칸만 적으면 고정값 (예: 2명, 60분)
      Object.assign(payload, { playersMin: a ?? b, playersMax: b ?? a, timeMin: c ?? d, timeMax: d ?? c, genres });
    } else if (type === 'escaperoom') {
      Object.assign(payload, { brand: brandIn.value.trim(), branch: branchIn.value.trim() });
    }
    if (cover.busy()) {
      err.textContent = '대표 이미지를 올리는 중이에요…';
      await cover.whenIdle();
      err.textContent = '';
    }
    payload.cover = cover.value();
    const allowDuplicate = dupShownFor === `${type}:${nameKey(title)}`;
    try {
      const res = await api.saveGame(payload, { allowDuplicate });
      upsertGame(res.game);
      cover.finish(res.game.cover || null);
      result = { game: res.game };
      savedCount++;
      if (inCollection) lastCollectionType = type;
      return true;
    } catch (e) {
      const f = e.code === 'invalid' && e.data ? e.data.field : null;
      if (f === 'title' && e.data.reason === 'duplicate') {
        if (e.data.current) upsertGame(e.data.current); // 다른 기기에서 먼저 등록함 → 목록에 보이고 고를 수 있게
        paintDup();
        return fail('같은 이름이 이미 있어요. 그 게임을 고르거나, 다른 판본이면 한 번 더 눌러 따로 등록해요');
      }
      if (f === 'cover') return fail('대표 이미지를 찾을 수 없어요. 다시 골라 주세요', null);
      if (f === 'title') return fail('이름을 확인해 주세요');
      if (f === 'memo') return fail(`메모는 ${LIMITS.gameMemo}자까지예요`, memoIn);
      if (f && /^(players|time|genres|brand|branch)/.test(f)) return fail('입력한 정보를 확인해 주세요', null);
      if (e.code === 'limit') return fail('게임은 1,000개까지 등록할 수 있어요');
      if (e.code === 'not_found') return fail('이미 삭제된 게임이에요');
      return fail(api.errorMessage(e, '저장'), null);
    }
  }

  /** 소장 탭의 '계속 등록': 저장한 뒤 칸을 비우고 다음 게임을 기다림 */
  async function saveAndNext() {
    if (!(await save())) return false;
    added.push(result.game.title);
    const shown = added.slice(-3).map((x) => `‘${x}’`).join(', ');
    addedLine.textContent = `등록했어요: ${added.length > 3 ? `${shown} 외 ${added.length - 3}개` : shown} · 이어서 적어 주세요`;
    addedLine.hidden = false;
    for (const el of [titleIn, memoIn, pMin, pMax, tMin, tMax, genreIn, brandIn, branchIn]) el.value = '';
    genres = [];
    paintGenres();
    cover.reset();
    paintDup();
    titleIn.focus();
    return false;
  }

  const typeField = isNew
    ? h('div', { class: 'field' }, h('span', { class: 'field-label', text: '종류' }),
      segmented({
        label: '종류', value: type, cls: 'seg-type',
        options: kinds.map((k) => ({ key: k, label: inCollection && k === 'murdermystery' ? '머미' : TYPES[k].short, cls: TYPES[k].cls })),
        onChange: (v) => { type = v; err.textContent = ''; paintType(); },
      }))
    : null;

  const body = h('div', { class: 'gform' },
    typeField,
    h('div', { class: 'field' }, titleLabel, titleIn),
    dupBox,
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: '대표 이미지 (선택)' }), cover.el),
    bgBox,
    erBox,
    ownRow,
    h('div', { class: 'field' }, h('label', { class: 'field-label', htmlFor: memoIn.id, text: '메모 (선택)' }), memoIn),
    err,
    addedLine);
  paintType();

  const actions = !isNew
    ? [{ label: '취소', value: null, kind: 'ghost' }, { label: '저장', value: 'ok', kind: 'primary', handler: save }]
    : inCollection
      ? [
        { label: '닫기', value: null, kind: 'ghost' },
        { label: '계속 등록', value: 'more', kind: 'soft', handler: saveAndNext },
        // 이어서 넣다가 빈 칸으로 누르면 그냥 닫음
        { label: '등록', value: 'ok', kind: 'primary', handler: () => (added.length && !titleIn.value.trim() ? true : save()) },
      ]
      : [{ label: '취소', value: null, kind: 'ghost' }, { label: '등록', value: 'ok', kind: 'primary', handler: save }];

  const v = await openDialog({
    title: isNew ? (inCollection ? '소장 게임 등록' : `새 ${TYPES[type].noun} 등록`) : `${TYPES[type].noun} 정보 수정`,
    body,
    cls: 'dlg-game-form',
    actions,
    bind: (c) => { closeDlg = c; },
    onOpen: (dlg) => {
      // Enter = 등록/저장 (한글 조합 중 Enter 는 글자를 마무리할 뿐이라 무시)
      const primary = dlg.querySelector('.dlg-actions .btn-primary');
      for (const el of [titleIn, memoIn, brandIn, branchIn]) {
        el.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          if (primary && !primary.disabled) primary.click();
        });
      }
      if (isNew) titleIn.focus();
      if (titleIn.value) paintDup();
    },
  });
  // 저장하지 않고 닫았으면 이 창에서 올린 대표 이미지는 지움
  if (!result || result.existing) cover.finish(null);
  if (!isNew) {
    if (v === 'ok') toast('게임 정보를 고쳤어요', 'ok');
  } else if (inCollection) {
    if (savedCount > 1) toast(`소장 게임 ${savedCount}개를 등록했어요`, 'ok');
    else if (savedCount === 1) toast(`‘${result.game.title}’ 소장에 등록했어요`, 'ok');
  }
  return result;
}

/** 게임 정보 삭제 (기록이 없는 게임만) */
export function canDeleteGame(g) {
  return !!g && !recordsOfGame(g.id).length && !state.records.some((r) => r.gameId === g.id);
}
