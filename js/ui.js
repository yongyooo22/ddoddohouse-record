// 재사용 UI 컴포넌트 (모두 DOM API로 생성, 사용자 값은 textContent로만)
import { h, icon, starShape, dotShape } from './dom.js';
import { TYPES } from './constants.js';
import { memberInfo } from './store.js';
import { goBack } from './nav.js';

let uid = 0;
export const nextId = (p = 'u') => `${p}${++uid}`;

// ── 토스트 ──
const MAX_TOASTS = 3;

/**
 * 잠깐 뜨는 알림. action: {label, onClick} — 알림 안의 버튼 (예: 되돌리기). 눌리면 알림은 바로 닫힘
 * 같은 내용의 알림이 이미 떠 있으면 새로 쌓지 않고 그 알림을 조금 더 보여 줌 (여러 장이 한꺼번에 실패할 때 등)
 */
export function toast(message, kind = 'info', ms = 2800, { action = null } = {}) {
  const box = document.getElementById('toasts');
  if (!box) return;
  // 성공 알림이 뜨면 앞서 남은 오류 알림은 더 이상 맞지 않으므로 치움 (예: 입력 오류 → 고쳐서 저장 성공)
  if (kind === 'ok') box.querySelectorAll('.toast-error').forEach((t) => t.remove());
  const live = [...box.querySelectorAll('.toast:not(.is-out)')];
  const same = !action && live.find((t) => t.dataset.kind === kind && t.dataset.msg === message && !t.querySelector('.toast-btn'));
  const dismiss = (el) => {
    clearTimeout(el.timer);
    el.classList.remove('is-in');
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 300);
  };
  if (same) {
    clearTimeout(same.timer);
    same.timer = setTimeout(() => dismiss(same), ms);
    return;
  }
  // 한꺼번에 너무 많이 쌓여 화면을 가리지 않도록 오래된 것부터 치움
  live.slice(0, Math.max(0, live.length - (MAX_TOASTS - 1))).forEach((t) => t.remove());
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status', dataset: { kind, msg: message } },
    icon(kind === 'error' ? 'info' : kind === 'ok' ? 'check' : 'sparkle'),
    h('span', { class: 'toast-text', text: message }),
    action ? h('button', {
      type: 'button', class: 'toast-btn',
      onClick: () => { dismiss(el); action.onClick(); },
    }, action.label) : null);
  if (action) el.classList.add('has-action');
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  el.timer = setTimeout(() => dismiss(el), ms);
}

// ── 다이얼로그 (bottom sheet 스타일) ──
/**
 * actions: [{label, value, kind:'primary'|'danger'|'ghost', handler?: async () => boolean(false면 유지)}]
 * 반환: 누른 action 의 value (닫기/ESC 는 null)
 */
export function openDialog({ title, body, actions = [{ label: '확인', value: true, kind: 'primary' }], dismissible = true, cls = '', onOpen, bind } = {}) {
  return new Promise((resolve) => {
    const titleId = nextId('dlg');
    const dlg = h('dialog', { class: ['dlg', cls], 'aria-labelledby': titleId });
    let done = false;
    const buttons = actions.map((a) => {
      const b = h('button', { type: 'button', class: `btn btn-${a.kind || 'ghost'}` }, a.label);
      b.addEventListener('click', async () => {
        if (done) return;
        if (a.handler) {
          buttons.forEach((x) => { x.disabled = true; });
          let keep = false;
          try { keep = (await a.handler()) === false; } catch { keep = true; }
          buttons.forEach((x) => { x.disabled = false; });
          if (keep) return;
        }
        close(a.value);
      });
      return b;
    });
    const inner = h('div', { class: 'dlg-inner' },
      h('div', { class: 'dlg-grip', 'aria-hidden': 'true' }),
      h('h2', { class: 'dlg-title', id: titleId, text: title || '' }),
      body ? h('div', { class: 'dlg-body' }, body) : null,
      h('div', { class: 'dlg-actions' }, buttons));
    dlg.appendChild(inner);
    document.body.appendChild(dlg);

    function close(v) {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* 무시 */ }
      dlg.remove();
      resolve(v);
    }
    // 밖에서 닫혀도(잠금 등 closeAllDialogs) 기다리는 쪽이 '취소'로 받게
    dlg.addEventListener('close', () => close(null));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (dismissible) close(null);
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && dismissible) close(null);
    });
    dlg.showModal();
    if (bind) bind(close);
    if (onOpen) onOpen(dlg);
  });
}

/** 열려 있는 다이얼로그를 모두 닫고 없앰 (잠글 때 — 사진·기록이 잠금 화면 위에 남지 않게) */
export function closeAllDialogs() {
  for (const d of document.querySelectorAll('dialog')) {
    try { d.close(); } catch { /* 무시 */ }
    d.remove();
  }
}

export async function confirmDialog(title, message, { ok = '확인', cancel = '취소', danger = false } = {}) {
  const v = await openDialog({
    title,
    body: message ? h('p', { class: 'dlg-text', text: message }) : null,
    actions: [
      { label: cancel, value: false, kind: 'ghost' },
      { label: ok, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return v === true;
}

// ── 상단 바 ──
export function appBar({ title, back, actions = [], cls = '' }) {
  return h('header', { class: ['appbar', cls] },
    back
      ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': '뒤로', onClick: () => goBack(back) }, icon('back'))
      : h('span', { class: 'appbar-spacer' }),
    h('h1', { class: 'appbar-title', text: title }),
    h('div', { class: 'appbar-actions' }, actions));
}

// ── 더보기 메뉴 (⋯ 버튼 아래로 펼치는 작은 목록) ──
/**
 * items: [{ label, icon, onSelect, danger }] — 항목을 누르면 메뉴를 닫고 onSelect.
 * 밖을 누르거나 Esc·Tab 이면 닫힘, ↑↓ 로 항목 이동
 */
export function moreMenu({ label = '더보기', items = [], cls = '' } = {}) {
  const id = nextId('menu');
  const btn = h('button', {
    type: 'button', class: 'icon-btn menu-btn', 'aria-label': label, title: label,
    'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id,
  }, icon('more'));
  const list = h('div', { class: 'menu', role: 'menu', id, 'aria-label': label, hidden: true });
  const wrap = h('div', { class: ['menu-wrap', cls] }, btn, list);
  const els = items.filter(Boolean).map((it) => {
    const b = h('button', { type: 'button', role: 'menuitem', tabindex: '-1', class: ['menu-item', it.danger ? 'is-danger' : ''] },
      it.icon ? icon(it.icon) : null, h('span', { text: it.label }));
    b.addEventListener('click', () => { close(false); it.onSelect(); });
    return b;
  });
  list.append(...els);
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(false); };
  function move(d) {
    const i = els.indexOf(document.activeElement);
    const next = els[(i + d + els.length) % els.length];
    if (next) next.focus();
  }
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); els[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1].focus(); }
    else if (e.key === 'Tab') close(false);
  });
  function open() {
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDoc, true);
    if (els[0]) els[0].focus();
  }
  function close(focusBtn) {
    if (list.hidden) return;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true);
    if (focusBtn) btn.focus();
  }
  btn.addEventListener('click', () => (list.hidden ? open() : close(false)));
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && list.hidden) { e.preventDefault(); open(); } });
  return wrap;
}

// ── 종류 배지 ──
export function typeBadge(type) {
  const t = TYPES[type];
  if (!t) return h('span', { class: 'badge', text: '기록' });
  return h('span', { class: `badge ${t.cls}` }, icon(t.icon), h('span', { text: t.label }));
}

/**
 * 종류 이름 — 기본은 풀네임('머더미스터리'). 자리가 좁은 화면에서만 CSS가 줄임말('머미')로 바꿔 보여 줘요.
 * 글자는 풀네임 그대로 두고 보여 주는 것만 바꾸므로 읽어 주기·검색은 늘 풀네임이에요.
 * fit: 'tight' = 520px 미만 화면에서 줄임 (칸이 여럿인 필터·요약 띠), 'snug' = 350px 미만에서만 줄임
 */
export function typeName(type, fit = 'snug') {
  const t = TYPES[type];
  if (!t) return h('span', { text: '기록' });
  if (t.short === t.label) return h('span', { text: t.label });
  return h('span', { class: `tn tn-${fit}`, dataset: { short: t.short } }, h('span', { class: 'tn-full', text: t.label }));
}

export function typeIcon(type, cls = '') {
  const t = TYPES[type];
  return h('span', { class: `type-ico ${t ? t.cls : ''} ${cls}`, 'aria-hidden': 'true' }, icon(t ? t.icon : 'book'));
}

// ── 도장 ──
export function stamp(text, kind = 'ink', { tilt = true } = {}) {
  return h('span', { class: `stamp stamp-${kind}${tilt ? '' : ' stamp-flat'}` }, text);
}

// ── 별점 (읽기 전용) ──
function glyphFor(kind) {
  return kind === 'dot' ? dotShape : starShape;
}

function ratingUnits(value, kind) {
  const shape = glyphFor(kind);
  const units = [];
  for (let i = 0; i < 5; i++) {
    const f = Math.max(0, Math.min(1, value - i));
    const u = h('span', { class: `r-unit${f >= 1 ? ' is-full' : f >= 0.5 ? ' is-half' : ''}` },
      shape('r-bg'), h('span', { class: 'r-fg' }, shape('r-fill')));
    units.push(u);
  }
  return units;
}

export function starsView(value, { size = 'sm', num = true, kind = 'star', label = '별점' } = {}) {
  const v = Number(value) || 0;
  return h('span', { class: `stars stars-${size} glyph-${kind}`, role: 'img', 'aria-label': v > 0 ? `${label} ${v}점 (5점 만점)` : `${label} 없음` },
    h('span', { class: 'stars-units' }, ratingUnits(v, kind)),
    num ? h('span', { class: 'stars-num', text: v > 0 ? v.toFixed(1) : '–' }) : null);
}

// ── 별점 입력 (0.5 단위, 탭/드래그/키보드) ──
export function ratingInput({ value = 0, onChange, label = '별점', kind = 'star', size = 'lg', clearable = true, hint } = {}) {
  let v = Number(value) || 0;
  const units = [];
  const shape = glyphFor(kind);
  for (let i = 0; i < 5; i++) {
    units.push(h('span', { class: 'r-unit' }, shape('r-bg'), h('span', { class: 'r-fg' }, shape('r-fill'))));
  }
  const track = h('div', {
    class: 'rating-track', role: 'slider', tabindex: '0', 'aria-label': label,
    'aria-valuemin': '0', 'aria-valuemax': '5',
  }, units);
  const out = h('span', { class: 'rating-out', 'aria-hidden': 'true' });
  const clearBtn = clearable
    ? h('button', { type: 'button', class: 'rating-clear', 'aria-label': `${label} 지우기` }, icon('x'))
    : null;
  const wrap = h('div', { class: `rating-input rating-${size} glyph-${kind}` }, track, out, clearBtn);

  const vtext = (x) => (x > 0 ? `${x}점` : hint || '미평가');
  function paint() {
    units.forEach((u, i) => {
      const f = Math.max(0, Math.min(1, v - i));
      u.classList.toggle('is-full', f >= 1);
      u.classList.toggle('is-half', f === 0.5);
    });
    track.setAttribute('aria-valuenow', String(v));
    track.setAttribute('aria-valuetext', vtext(v));
    // 작은 게이지도 따로 준 안내(예: 공포도 '없음/미평가')가 있으면 보여 줌
    out.textContent = v > 0 ? v.toFixed(1) : (hint || (size === 'sm' ? '–' : '미평가'));
    out.classList.toggle('is-empty', v === 0);
    if (clearBtn) clearBtn.hidden = v === 0;
  }
  function set(nv) {
    const x = Math.max(0, Math.min(5, Math.round(Number(nv) * 2) / 2));
    if (x === v) return;
    v = x;
    paint();
    if (onChange) onChange(v);
  }
  function valueAt(clientX) {
    const first = units[0].getBoundingClientRect();
    if (clientX < first.left) return 0;
    for (let i = 0; i < units.length; i++) {
      const r = units[i].getBoundingClientRect();
      const next = units[i + 1] ? units[i + 1].getBoundingClientRect().left : Infinity;
      if (clientX < next) {
        const x = Math.min(clientX, r.right) - r.left;
        return i + (x <= r.width / 2 ? 0.5 : 1);
      }
    }
    return 5;
  }

  let startX = 0, startY = 0, dragging = false, pointerId = null;
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY; dragging = false;
    try { track.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
  });
  track.addEventListener('pointermove', (e) => {
    if (pointerId !== e.pointerId) return;
    if (!dragging && Math.abs(e.clientX - startX) > 6 && Math.abs(e.clientX - startX) > Math.abs(e.clientY - startY)) dragging = true;
    if (dragging) set(Math.max(0.5, valueAt(e.clientX)));
  });
  track.addEventListener('pointerup', (e) => {
    if (pointerId !== e.pointerId) return;
    pointerId = null;
    if (!dragging) {
      const nv = valueAt(e.clientX);
      set(nv === v ? 0 : Math.max(0.5, nv));
    }
    dragging = false;
  });
  track.addEventListener('pointercancel', () => { pointerId = null; dragging = false; });
  track.addEventListener('keydown', (e) => {
    const map = { ArrowRight: 0.5, ArrowUp: 0.5, ArrowLeft: -0.5, ArrowDown: -0.5, PageUp: 1, PageDown: -1 };
    if (e.key in map) { set(v + map[e.key]); e.preventDefault(); }
    else if (e.key === 'Home' || e.key === 'Backspace' || e.key === 'Delete') { set(0); e.preventDefault(); }
    else if (e.key === 'End') { set(5); e.preventDefault(); }
    else if (/^[0-5]$/.test(e.key)) { set(Number(e.key)); e.preventDefault(); }
  });
  if (clearBtn) clearBtn.addEventListener('click', () => { set(0); track.focus(); });
  paint();
  wrap.setValue = (nv) => { v = Math.max(0, Math.min(5, Math.round(Number(nv) * 2) / 2)) || 0; paint(); };
  return wrap;
}

// ── 세그먼트 (네이티브 라디오) ──
export function segmented({ options, value, onChange, label, cls = '', name }) {
  const n = name || nextId('seg');
  const wrap = h('div', { class: ['seg', cls], role: 'radiogroup', 'aria-label': label || '' });
  for (const o of options) {
    const id = `${n}-${o.key}`;
    const input = h('input', { type: 'radio', class: 'seg-input', name: n, id, value: o.key, checked: o.key === value });
    input.addEventListener('change', () => { if (input.checked && onChange) onChange(o.key); });
    const lab = h('label', { class: ['seg-item', o.cls], htmlFor: id },
      o.icon ? icon(o.icon) : null, o.label instanceof Node ? o.label : h('span', { text: o.label }));
    wrap.append(input, lab);
  }
  return wrap;
}

// ── 칩 토글 ──
export function chip({ label, pressed = false, onToggle, cls = '', lead, title }) {
  const b = h('button', { type: 'button', class: ['chip', cls], 'aria-pressed': pressed ? 'true' : 'false', title },
    lead || null, h('span', { class: 'chip-label', text: label }));
  b.addEventListener('click', () => {
    const now = b.getAttribute('aria-pressed') !== 'true';
    if (onToggle && onToggle(now) === false) return;
    b.setAttribute('aria-pressed', now ? 'true' : 'false');
  });
  return b;
}

// ── 스위치 ──
export function switchRow({ checked = false, onChange, label, desc, icon: ic }) {
  const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input', checked });
  input.addEventListener('change', () => onChange && onChange(input.checked));
  return h('label', { class: 'switch-row' },
    ic ? h('span', { class: 'switch-ico' }, icon(ic)) : null,
    h('span', { class: 'switch-text' },
      h('span', { class: 'switch-label', text: label }),
      desc ? h('span', { class: 'switch-desc', text: desc }) : null),
    input,
    h('span', { class: 'switch-ui', 'aria-hidden': 'true' }));
}

// ── 스테퍼 ──
/** 숫자 늘리기·줄이기. value 가 null 이면 아직 안 적음('–') — 0 으로 치지 않음 */
export function stepper({ value = null, min = 0, max = 99, onChange, label, unit = '' }) {
  const blank = (x) => x === null || x === undefined || x === '';
  let v = blank(value) ? null : Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
  const input = h('input', {
    type: 'number', inputmode: 'numeric', class: 'stepper-input', min: String(min), max: String(max),
    value: v === null ? '' : String(v), placeholder: '–', 'aria-label': label,
  });
  const paint = () => {
    input.value = v === null ? '' : String(v);
    minus.disabled = v === null || v <= min;
    plus.disabled = v !== null && v >= max;
  };
  const set = (nv) => {
    v = blank(nv) || !Number.isFinite(Number(nv)) ? null : Math.max(min, Math.min(max, Math.round(Number(nv))));
    paint();
    if (onChange) onChange(v);
  };
  const minus = h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `${label} 줄이기`, onClick: () => set(v === null ? min : v - 1) }, '−');
  const plus = h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `${label} 늘리기`, onClick: () => set(v === null ? min + 1 : v + 1) }, '+');
  input.addEventListener('change', () => set(input.value));
  paint();
  return h('div', { class: 'stepper' }, minus, input, unit ? h('span', { class: 'stepper-unit', text: unit }) : null, plus);
}

// ── 빈 화면 ──
export function emptyState({ icon: ic = 'book', title, text, action, cls = '' }) {
  return h('div', { class: ['empty', cls] },
    h('div', { class: 'empty-ico', 'aria-hidden': 'true' }, icon(ic)),
    h('p', { class: 'empty-title', text: title }),
    text ? h('p', { class: 'empty-text', text }) : null,
    action || null);
}

/** 첫 데이터를 받는 중 (빈 화면 대신) */
export function loadingState(text = '기록을 불러오는 중…') {
  return h('div', { class: 'loading-state', role: 'status' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('p', { text }));
}

/** 한 번도 못 받았는데 불러오기에 실패함 ("기록 없음"과 구분) */
export function loadErrorState(retry) {
  return emptyState({
    icon: 'wifiOff', title: '기록을 불러오지 못했어요',
    text: '인터넷 연결을 확인하고 다시 시도해 주세요. 서버에 저장된 기록은 그대로 있어요.',
    action: retry
      ? h('button', { type: 'button', class: 'btn btn-soft', onClick: () => { Promise.resolve(retry()).catch(() => {}); } }, icon('refresh'), h('span', { text: '다시 시도' }))
      : null,
  });
}

// ── 라벨 있는 필드 ──
export function field(label, control, { hint, id, cls = '', counter } = {}) {
  const fid = id || nextId('f');
  if (control && control.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].includes(control.tagName) && !control.id) control.id = fid;
  const labelEl = control && control.id
    ? h('label', { class: 'field-label', htmlFor: control.id, text: label })
    : h('span', { class: 'field-label', text: label });
  return h('div', { class: ['field', cls] },
    h('div', { class: 'field-head' }, labelEl, counter || null),
    control,
    hint ? h('p', { class: 'field-hint', text: hint }) : null);
}

/** 글자 수 카운터 연결 — 한도에 가까워졌을 때(80%)만 보여 줌 */
export function counterFor(input, max) {
  const c = h('span', { class: 'counter', 'aria-hidden': 'true' });
  const upd = () => {
    const n = Array.from(input.value).length;
    c.textContent = `${n}/${max}`;
    c.hidden = n < max * 0.8;
    c.classList.toggle('is-near', n > max * 0.9);
  };
  input.addEventListener('input', upd);
  upd();
  return c;
}

// ── 점수 막대 ──
export function scoreBars(items, { cls = '' } = {}) {
  return h('div', { class: ['scorebars', cls] }, items.map(({ label, value }) => {
    const v = Number(value) || 0;
    const fill = h('span', { class: 'sb-fill' });
    fill.style.width = `${(v / 5) * 100}%`;
    return h('div', { class: 'sb-row' },
      h('span', { class: 'sb-label', text: label }),
      h('span', { class: 'sb-track', role: 'img', 'aria-label': v > 0 ? `${label} ${v}점` : `${label} 미평가` }, fill),
      h('span', { class: `sb-val${v > 0 ? '' : ' is-empty'}`, text: v > 0 ? v.toFixed(1) : '–' }));
  }));
}

// 이번 실행 동안 펼친 스포일러 (백그라운드 새로고침으로 화면을 다시 그려도 다시 가려지지 않게)
const revealedSpoilers = new Set();

/** 스포일러 가림 블록: 탭하면 보임. key 를 주면 펼친 상태를 기억 */
export function spoilerBlock(content, { label = '스포일러 보기', inline = false, key = null } = {}) {
  const inner = h(inline ? 'span' : 'div', { class: 'spoiler-content' }, content);
  const box = h(inline ? 'span' : 'div', { class: `spoiler${inline ? ' spoiler-inline' : ''}` }, inner);
  if (key && revealedSpoilers.has(key)) {
    box.classList.add('is-revealed');
    return box;
  }
  inner.setAttribute('aria-hidden', 'true');
  inner.inert = true; // 가려진 안의 링크에 키보드 초점이 가지 않게
  const btn = h('button', { type: 'button', class: 'spoiler-btn' }, icon('eye'), h('span', { text: label }));
  box.appendChild(btn);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (key) revealedSpoilers.add(key);
    box.classList.add('is-revealed');
    inner.removeAttribute('aria-hidden');
    inner.inert = false;
    btn.remove();
  });
  return box;
}
