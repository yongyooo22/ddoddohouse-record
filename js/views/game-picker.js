// 기록 폼의 게임 고르기 — 고른 종류의 게임·작품·테마를 검색해서 선택. 없으면 같은 자리에서 '＋ 새 게임 등록'
// 고른 뒤에는 작은 요약(대표 이미지 · 이름 · 인원·시간·장르)과 '변경'
import { h, icon } from '../dom.js';
import { TYPES } from '../constants.js';
import { gameById, gamesOfType, legacyTitles, isOwnedGame, playedBy, memberInfo } from '../store.js';
import { nameKey } from '../format.js';
import { nextId } from '../ui.js';
import { openGameEditor, gameThumb, gameMeta } from './game-form.js';

const SHOW_IDLE = 5;
const SHOW_QUERY = 8;

/**
 * @param {object} opts
 *   type · gameId(고른 게임) · title(게임 정보 없이 이름만 있는 예전 기록) · excludeId(수정 중인 기록 — '해 본 멤버'에서 뺌)
 *   onChange({ game, title }): 고르거나 바꾸거나 비움 (game 없이 title 만 = 예전 기록의 이름 그대로)
 * @returns {{ el, setType(type), focus(), select(game) }}
 */
export function gamePicker({ type: startType, gameId = null, title = '', excludeId = null, onChange }) {
  let type = startType;
  let selected = gameById(gameId);
  if (selected && selected.type !== type) selected = null;
  let legacy = !selected && title ? title : ''; // 게임 정보와 연결되지 않은 예전 기록의 이름
  let searching = !selected && !legacy;
  let query = '';
  let active = -1;
  let items = [];

  const el = h('div', { class: 'gp', 'data-field': 'game' });
  const listId = nextId('gplist');
  const input = h('input', {
    type: 'search', class: 'input gp-input', autocomplete: 'off', enterkeyhint: 'search',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': listId,
  });
  const list = h('ul', { class: 'gp-list', id: listId, role: 'listbox' });
  const search = h('div', { class: 'gp-search' },
    h('div', { class: 'search-wrap' }, icon('search', 'search-ico'), input),
    list);

  const noun = () => TYPES[type].noun;

  function emit() {
    if (onChange) onChange({ game: selected, title: selected ? selected.title : legacy });
  }

  function select(g) {
    selected = g;
    legacy = '';
    searching = false;
    query = '';
    input.value = '';
    emit();
    render();
    const btn = el.querySelector('.gp-change');
    if (btn) btn.focus({ preventScroll: true });
  }

  async function register(name) {
    const res = await openGameEditor(null, { type, title: name, context: 'record' });
    if (res && res.game) {
      type = res.game.type; // 창에서 종류를 바꿔 등록했으면 그 종류로 (폼도 onChange 에서 맞춤)
      select(res.game);
    } else if (searching) {
      input.focus();
    }
  }

  function option(id, content, onPick, cls = '') {
    const b = h('li', { class: ['gp-opt', cls], role: 'option', id, 'aria-selected': 'false' }, content);
    b.addEventListener('click', onPick);
    // 누를 때 입력칸 초점이 빠져 목록이 흔들리지 않게
    b.addEventListener('mousedown', (e) => e.preventDefault());
    return b;
  }

  function paintList() {
    const k = nameKey(query);
    const games = gamesOfType(type).filter((e) => !k || nameKey(e.title).includes(k));
    const shown = games.slice(0, k ? SHOW_QUERY : SHOW_IDLE);
    const exact = games.some((e) => nameKey(e.title) === k);
    // 게임 정보로 아직 등록하지 않은, 예전 기록에만 있는 이름 (누르면 그 이름으로 등록)
    const olds = (k || !games.length) ? legacyTitles(type).filter((e) => !k || nameKey(e.title).includes(k)).slice(0, 3) : [];
    items = [];
    const rows = [];
    for (const e of shown) {
      const g = e.game;
      const meta = [isOwnedGame(g) ? '내 소장' : '', gameMeta(g), e.plays ? `${e.plays}회` : ''].filter(Boolean).join(' · ');
      const id = nextId('gpo');
      items.push({ id, pick: () => select(g) });
      rows.push(option(id, [gameThumb(g, 'gthumb gthumb-sm'),
        h('span', { class: 'gp-opt-text' }, h('span', { class: 'gp-opt-name', text: e.title }), meta ? h('span', { class: 'gp-opt-meta', text: meta }) : null)],
      () => select(g)));
    }
    for (const e of olds) {
      const id = nextId('gpo');
      const pick = () => register(e.title);
      items.push({ id, pick });
      rows.push(option(id, [h('span', { class: 'gthumb gthumb-sm is-empty', 'aria-hidden': 'true' }, icon('book')),
        h('span', { class: 'gp-opt-text' }, h('span', { class: 'gp-opt-name', text: e.title }),
          h('span', { class: 'gp-opt-meta', text: `예전 기록 ${e.plays}개 · 눌러서 등록` }))], pick, 'is-legacy'));
    }
    if (games.length > shown.length) {
      rows.push(h('li', { class: 'gp-more', role: 'presentation', text: k ? `${games.length - shown.length}개 더 있어요 · 이름을 더 적어 보세요` : `등록한 ${noun()} ${games.length}개 · 이름으로 찾아요` }));
    }
    if (!games.length && !olds.length) {
      rows.push(h('li', { class: 'gp-empty', role: 'presentation', text: k ? `‘${query.trim()}’을(를) 찾지 못했어요` : `아직 등록한 ${noun()}이 없어요` }));
    }
    const addId = nextId('gpo');
    const addLabel = k && !exact ? `‘${query.trim()}’ 새 ${noun()} 등록` : `새 ${noun()} 등록`;
    const addPick = () => register(query.trim());
    items.push({ id: addId, pick: addPick });
    rows.push(option(addId, [h('span', { class: 'gp-add-ico', 'aria-hidden': 'true' }, icon('plus')), h('span', { class: 'gp-add-label', text: addLabel })], addPick, 'gp-add'));
    list.replaceChildren(...rows);
    active = Math.min(active, items.length - 1);
    paintActive();
  }

  function paintActive() {
    items.forEach((it, i) => {
      const o = list.querySelector(`#${it.id}`);
      if (o) o.setAttribute('aria-selected', i === active ? 'true' : 'false');
    });
    if (active >= 0 && items[active]) {
      input.setAttribute('aria-activedescendant', items[active].id);
      const o = list.querySelector(`#${items[active].id}`);
      if (o) o.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  let qt = null;
  input.addEventListener('input', () => {
    el.removeAttribute('aria-invalid');
    clearTimeout(qt);
    qt = setTimeout(() => { query = input.value; active = -1; paintList(); }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); paintActive(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(-1, active - 1); paintActive(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(qt);
      if (query !== input.value) { query = input.value; paintList(); }
      if (active >= 0 && items[active]) { items[active].pick(); return; }
      // 이름이 딱 맞는 게임이 하나면 그것, 아니면 새로 등록
      const k = nameKey(query);
      const same = gamesOfType(type).filter((g) => nameKey(g.title) === k);
      if (k && same.length === 1) select(same[0].game);
      else if (k && !same.length) register(query.trim());
    } else if (e.key === 'Escape' && (selected || legacy) && input.value === '') {
      e.preventDefault();
      searching = false;
      render();
    }
  });

  function summary() {
    const g = selected;
    const t = TYPES[type];
    const changeBtn = h('button', {
      type: 'button', class: 'btn btn-soft btn-sm gp-change', 'aria-label': `${t.noun} 변경`,
      onClick: () => { searching = true; render(); input.focus(); },
    }, '변경');
    if (!g) {
      // 게임 정보 전의 예전 기록: 이름만 있음 → 등록하거나 다른 게임으로 바꿀 수 있게
      const same = gamesOfType(type).filter((e) => nameKey(e.title) === nameKey(legacy));
      return h('div', { class: 'gp-picked is-legacy' },
        h('span', { class: 'gthumb is-empty', 'aria-hidden': 'true' }, icon(t.icon)),
        h('div', { class: 'gp-picked-text' },
          h('p', { class: 'gp-picked-name', text: legacy }),
          h('p', { class: 'gp-picked-meta', text: '게임 정보에 아직 연결되지 않은 이름이에요' }),
          h('div', { class: 'gp-picked-acts' },
            same.length === 1
              ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => select(same[0].game) }, `등록된 ‘${same[0].title}’에 연결`)
              : h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => register(legacy) }, icon('plus'), h('span', { text: '이 이름으로 등록' })))),
        changeBtn);
    }
    const meta = gameMeta(g);
    const editBtn = h('button', {
      type: 'button', class: 'icon-btn icon-btn-sm gp-edit', 'aria-label': `${g.title} 정보 수정`,
      onClick: async () => {
        const res = await openGameEditor(g);
        if (res && res.game) select(res.game);
      },
    }, icon('edit'));
    // 머미·방탈출은 같은 작품을 다시 하기 어려워서, 이미 해 본 멤버를 알려 줌
    const players = type !== 'boardgame' ? playedBy(g.id, excludeId).map((id) => memberInfo(id)).filter((x) => !x.missing) : [];
    return h('div', { class: 'gp-picked' },
      gameThumb(g),
      h('div', { class: 'gp-picked-text' },
        h('p', { class: 'gp-picked-name', text: g.title }),
        isOwnedGame(g) || meta
          ? h('p', { class: 'gp-picked-meta' }, isOwnedGame(g) ? h('span', { class: 'rbadge rbadge-own', text: '내 소장' }) : null, meta ? h('span', { text: meta }) : null)
          : null,
        players.length ? h('p', { class: 'gp-played' }, icon('users'), h('span', { text: `이미 해 본 멤버: ${players.map((x) => x.name).join(', ')}` })) : null),
      h('div', { class: 'gp-picked-side' }, editBtn, changeBtn));
  }

  function render() {
    input.placeholder = `${TYPES[type].noun} 이름으로 검색`;
    input.setAttribute('aria-label', `${TYPES[type].noun} 검색`);
    if (searching || (!selected && !legacy)) {
      const back = (selected || legacy)
        ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm gp-cancel', onClick: () => { searching = false; render(); } }, '취소')
        : null;
      el.replaceChildren(...[search, back].filter(Boolean));
      paintList();
    } else {
      el.replaceChildren(summary());
    }
  }

  render();

  return {
    el,
    /** 종류가 바뀜: 다른 종류의 게임은 비우고 다시 고르게 */
    setType(t) {
      if (t === type) return;
      type = t;
      if (selected && selected.type !== t) { selected = null; emit(); }
      legacy = '';
      searching = !selected;
      query = '';
      input.value = '';
      active = -1;
      render();
    },
    focus() {
      if (!searching && (selected || legacy)) { const b = el.querySelector('.gp-change'); if (b) b.focus(); return; }
      input.focus({ preventScroll: true });
    },
    select,
  };
}
