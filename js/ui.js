// 재사용 UI 부품 (모두 DOM API로 생성, 사용자 값은 textContent로만)
import { h, icon, starShape } from './dom.js';
import { GENRES, FEAR_LABELS, DIFFICULTY_LABELS } from './constants.js';
import { goBack } from './nav.js';

let uid = 0;
export const nextId = (p = 'u') => `${p}${++uid}`;

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── 토스트 ──
const MAX_TOASTS = 3;

/**
 * 잠깐 뜨는 알림. action: {label, onClick} — 알림 안의 버튼 (예: 되돌리기). 눌리면 알림은 바로 닫힘
 * 같은 내용의 알림이 이미 떠 있으면 새로 쌓지 않고 그 알림을 조금 더 보여 줌
 */
export function toast(message, kind = 'info', ms = 2800, { action = null } = {}) {
  const box = document.getElementById('toasts');
  if (!box) return;
  if (kind === 'ok') box.querySelectorAll('.toast-error').forEach((t) => t.remove());
  const live = [...box.querySelectorAll('.toast:not(.is-out)')];
  const same = !action && live.find((t) => t.dataset.kind === kind && t.dataset.msg === message && !t.querySelector('.toast-btn'));
  const dismiss = (el) => {
    clearTimeout(el.timer);
    el.classList.remove('is-in');
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 250);
  };
  if (same) {
    clearTimeout(same.timer);
    same.timer = setTimeout(() => dismiss(same), ms);
    return;
  }
  live.slice(0, Math.max(0, live.length - (MAX_TOASTS - 1))).forEach((t) => t.remove());
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status', dataset: { kind, msg: message } },
    icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info'),
    h('span', { class: 'toast-text', text: message }),
    action ? h('button', {
      type: 'button', class: 'toast-btn',
      onClick: () => { dismiss(el); action.onClick(); },
    }, action.label) : null);
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  el.timer = setTimeout(() => dismiss(el), ms);
}

// ── 다이얼로그 (휴대폰에서는 아래에서 올라오는 시트) ──
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
      const b = h('button', { type: 'button', class: `btn btn-${a.kind || 'ghost'}` }, a.icon ? icon(a.icon) : null, h('span', { text: a.label }));
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
      h('h2', { class: 'dlg-title', id: titleId, text: title || '' }),
      body ? h('div', { class: 'dlg-body' }, body) : null,
      buttons.length ? h('div', { class: `dlg-actions${buttons.length > 2 ? ' is-stack' : ''}` }, buttons) : null);
    dlg.appendChild(inner);
    document.body.appendChild(dlg);

    function close(v) {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* 무시 */ }
      dlg.remove();
      resolve(v);
    }
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

export function closeAllDialogs() {
  for (const d of document.querySelectorAll('dialog')) {
    try { d.close(); } catch { /* 무시 */ }
    d.remove();
  }
}

export async function confirmDialog(title, message, { ok = '확인', cancel = '취소', danger = false } = {}) {
  const v = await openDialog({
    title,
    body: message ? (typeof message === 'string' ? h('p', { class: 'dlg-text', text: message }) : message) : null,
    actions: [
      { label: cancel, value: false, kind: 'ghost' },
      { label: ok, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return v === true;
}

/** 선택 목록 시트: items [{label, desc?, value, icon?, danger?}] → 고른 value (취소 null) */
export function choiceSheet(title, items, { text } = {}) {
  let closeFn = null;
  const list = h('div', { class: 'choice-list' },
    text ? h('p', { class: 'dlg-text', text }) : null,
    items.map((it) => h('button', {
      type: 'button', class: `choice${it.danger ? ' is-danger' : ''}`,
      onClick: () => { if (closeFn) closeFn(it.value); },
    }, it.icon ? icon(it.icon) : null,
    h('span', { class: 'choice-text' },
      h('span', { class: 'choice-label', text: it.label }),
      it.desc ? h('span', { class: 'choice-desc', text: it.desc }) : null))));
  return openDialog({
    title,
    cls: 'dlg-choice',
    body: list,
    actions: [{ label: '취소', value: null, kind: 'ghost' }],
    bind: (close) => { closeFn = close; },
  });
}

// ── 상단 바 ──
export function appBar({ title, back, actions = [], cls = '' }) {
  return h('header', { class: ['appbar', cls] },
    back
      ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': '뒤로', onClick: () => goBack(back) }, icon('back'))
      : null,
    h('h1', { class: 'appbar-title', text: title }),
    h('div', { class: 'appbar-actions' }, actions));
}

// ── 장르 태그 · 상태 표시 · 예시 표시 ──
export function genreTag(genre) {
  const g = GENRES[genre];
  if (!g) return h('span', { class: 'gtag', text: '기록' });
  return h('span', { class: `gtag ${g.cls}` }, icon(g.icon), h('span', { text: g.label }));
}

/** 장르 아이콘 타일 (표지가 없을 때) */
export function genreIcon(genre, cls = '') {
  const g = GENRES[genre];
  return h('span', { class: ['gicon', g ? g.cls : '', cls], 'aria-hidden': 'true' }, icon(g ? g.icon : 'ticket'));
}

/** 방탈출 성공·실패 작은 표시 */
export function resultTag(result) {
  if (result !== 'success' && result !== 'fail') return null;
  const ok = result === 'success';
  return h('span', { class: `rtag ${ok ? 'is-success' : 'is-fail'}` },
    h('span', { class: 'rtag-dot', 'aria-hidden': 'true' }),
    h('span', { text: ok ? '탈출 성공' : '탈출 실패' }));
}

export function sampleTag() {
  return h('span', { class: 'stag', title: '예시 기록 — 설정에서 한 번에 지울 수 있어요', text: '예시' });
}

// ── 별점 (읽기 전용) ──
function ratingUnits(value) {
  const units = [];
  for (let i = 0; i < 5; i++) {
    const f = Math.max(0, Math.min(1, value - i));
    units.push(h('span', { class: `r-unit${f >= 1 ? ' is-full' : f >= 0.5 ? ' is-half' : ''}` },
      starShape('r-bg'), h('span', { class: 'r-fg' }, starShape('r-fill'))));
  }
  return units;
}

/** 별 다섯 개 + 숫자. 미평가면 '미평가' 글자 */
export function starsView(value, { size = 'sm', num = true, label = '평점', compact = false } = {}) {
  const v = Number(value) || 0;
  if (v <= 0) return h('span', { class: `stars stars-${size} is-none`, text: '미평가' });
  if (compact) {
    return h('span', { class: `stars stars-${size} is-compact`, role: 'img', 'aria-label': `${label} ${v}점 (5점 만점)` },
      starShape('r-one'), h('span', { class: 'stars-num', text: v.toFixed(1) }));
  }
  return h('span', { class: `stars stars-${size}`, role: 'img', 'aria-label': `${label} ${v}점 (5점 만점)` },
    h('span', { class: 'stars-units' }, ratingUnits(v)),
    num ? h('span', { class: 'stars-num', text: v.toFixed(1) }) : null);
}

/** 평균 평점 (작품별 묶음) */
export function avgView(avg) {
  const v = Number(avg);
  if (!(v > 0)) return starsView(null);
  return h('span', { class: 'stars stars-sm is-compact is-avg', role: 'img', 'aria-label': `평균 평점 ${v.toFixed(1)}점 (5점 만점)` },
    h('span', { class: 'avg-label', text: '평균' }), starShape('r-one'), h('span', { class: 'stars-num', text: v.toFixed(1) }));
}

// ── 별점 입력 (0.5 단위, 탭/드래그/키보드, 미평가 허용) ──
export function ratingInput({ value = null, onChange, label = '평점', size = 'lg', id } = {}) {
  let v = Number(value) || 0;
  const units = [];
  for (let i = 0; i < 5; i++) {
    units.push(h('span', { class: 'r-unit' }, starShape('r-bg'), h('span', { class: 'r-fg' }, starShape('r-fill'))));
  }
  const track = h('div', {
    class: 'rating-track', role: 'slider', tabindex: '0', 'aria-label': label, id,
    'aria-valuemin': '0', 'aria-valuemax': '5',
  }, units);
  const out = h('span', { class: 'rating-out', 'aria-hidden': 'true' });
  const clearBtn = h('button', { type: 'button', class: 'rating-clear', 'aria-label': `${label} 지우기 (미평가)` }, icon('x'));
  const wrap = h('div', { class: `rating-input rating-${size}` }, track, out, clearBtn);

  function paint() {
    units.forEach((u, i) => {
      const f = Math.max(0, Math.min(1, v - i));
      u.classList.toggle('is-full', f >= 1);
      u.classList.toggle('is-half', f === 0.5);
    });
    track.setAttribute('aria-valuenow', String(v));
    track.setAttribute('aria-valuetext', v > 0 ? `${v}점` : '미평가');
    out.textContent = v > 0 ? v.toFixed(1) : '미평가';
    out.classList.toggle('is-empty', v === 0);
    clearBtn.hidden = v === 0;
  }
  function set(nv) {
    const x = Math.max(0, Math.min(5, Math.round(Number(nv) * 2) / 2));
    if (x === v) return;
    v = x;
    paint();
    if (onChange) onChange(v > 0 ? v : null);
  }
  function valueAt(clientX) {
    const first = units[0].getBoundingClientRect();
    if (clientX < first.left) return 0.5;
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

  // 가로로 끌면 점수 조절, 세로로 쓸면 화면 스크롤(touch-action: pan-y) — 쓸어 넘기다 점수가 바뀌지 않게
  let startX = 0, startY = 0, dragging = false, moved = false, pointerId = null;
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY; dragging = false; moved = false;
  });
  track.addEventListener('pointermove', (e) => {
    if (pointerId !== e.pointerId) return;
    const dx = Math.abs(e.clientX - startX);
    const dy = Math.abs(e.clientY - startY);
    if (dx > 10 || dy > 10) moved = true;
    if (!dragging && dx > 6 && dx > dy * 1.2) {
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    }
    if (dragging) set(valueAt(e.clientX));
  });
  track.addEventListener('pointerup', (e) => {
    if (pointerId !== e.pointerId) return;
    pointerId = null;
    // 제자리에서 누른 것만 '탭'으로: 같은 점수를 다시 누르면 미평가로
    if (!dragging && !moved) {
      const nv = valueAt(e.clientX);
      set(nv === v ? 0 : nv);
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
  clearBtn.addEventListener('click', () => { set(0); track.focus(); });
  paint();
  wrap.setValue = (nv) => { v = Math.max(0, Math.min(5, Math.round(Number(nv) * 2) / 2)) || 0; paint(); };
  return wrap;
}

// ── 단계 고르기 (체감 난이도 1~5, 공포도 0~5) — 같은 칸을 다시 누르면 비움 ──
export function levelPicker({ value = null, onChange, label, kind = 'difficulty' }) {
  const labels = kind === 'fear' ? FEAR_LABELS : DIFFICULTY_LABELS;
  const min = kind === 'fear' ? 0 : 1;
  let v = value === null || value === undefined ? null : Number(value);
  const out = h('span', { class: 'level-out', 'aria-hidden': 'true' });
  const btns = [];
  for (let i = min; i <= 5; i++) {
    const b = h('button', {
      type: 'button', class: `level-btn${i === 0 ? ' is-zero' : ''}`, 'aria-label': `${label} ${i === 0 ? '없음' : `${i}단계`} (${labels[i]})`,
      dataset: { level: String(i) },
    }, i === 0 ? h('span', { class: 'level-zero', text: '없음' }) : h('span', { class: 'level-dot' }));
    b.addEventListener('click', () => {
      v = v === i ? null : i;
      paint();
      if (onChange) onChange(v);
    });
    btns.push(b);
  }
  function paint() {
    for (const b of btns) {
      const i = Number(b.dataset.level);
      b.setAttribute('aria-pressed', v === i ? 'true' : 'false');
      b.classList.toggle('is-on', v !== null && i > 0 && i <= v);
    }
    out.textContent = v === null ? '기록 안 함' : labels[v];
    out.classList.toggle('is-empty', v === null);
  }
  paint();
  return h('div', { class: `level level-${kind}`, role: 'group', 'aria-label': label }, h('div', { class: 'level-btns' }, btns), out);
}

/** 단계 보기 (●●●○○ 보통) */
export function levelView(value, { kind = 'difficulty', label } = {}) {
  if (value === null || value === undefined) return null;
  const labels = kind === 'fear' ? FEAR_LABELS : DIFFICULTY_LABELS;
  const v = Number(value);
  const dots = [];
  for (let i = 1; i <= 5; i++) dots.push(h('span', { class: `lv-dot${i <= v ? ' is-on' : ''}` }));
  return h('span', { class: 'lv', role: 'img', 'aria-label': `${label} ${labels[v]}${v > 0 ? ` (5단계 중 ${v})` : ''}` },
    h('span', { class: 'lv-dots', 'aria-hidden': 'true' }, dots),
    h('span', { class: 'lv-label', 'aria-hidden': 'true', text: labels[v] }));
}

// ── 세그먼트 (네이티브 라디오). allowNone: 고른 것을 다시 누르면 선택 해제 ──
export function segmented({ options, value, onChange, label, cls = '', name, allowNone = false }) {
  const n = name || nextId('seg');
  const wrap = h('div', { class: ['seg', cls], role: 'radiogroup', 'aria-label': label || '' });
  let cur = value || null;
  const inputs = [];
  for (const o of options) {
    const id = `${n}-${o.key}`;
    const input = h('input', { type: 'radio', class: 'seg-input', name: n, id, value: o.key, checked: o.key === cur, disabled: !!o.disabled });
    input.addEventListener('change', () => {
      if (input.checked) { cur = o.key; if (onChange) onChange(o.key); }
    });
    const lab = h('label', { class: ['seg-item', o.cls], htmlFor: id },
      o.icon ? icon(o.icon) : null, h('span', { text: o.label }));
    if (allowNone) {
      // 이미 고른 칸을 다시 누르면 해제 (라디오는 원래 해제가 안 되므로)
      lab.addEventListener('click', (e) => {
        if (cur === o.key) {
          e.preventDefault();
          input.checked = false;
          cur = null;
          if (onChange) onChange(null);
        }
      });
    }
    inputs.push(input);
    wrap.append(input, lab);
  }
  wrap.setValue = (v) => { cur = v || null; for (const i of inputs) i.checked = i.value === cur; };
  wrap.setDisabled = (d) => { for (const i of inputs) i.disabled = d; wrap.classList.toggle('is-disabled', d); };
  return wrap;
}

// ── 숫자 스테퍼 (비워 둘 수 있음) ──
export function stepper({ value = null, min = 0, max = 99, onChange, label, unit = '', placeholder = '–' }) {
  let v = value === null || value === undefined || value === '' ? null : Number(value);
  const input = h('input', {
    type: 'text', inputmode: 'numeric', pattern: '[0-9]*', class: 'stepper-input', 'aria-label': label,
    value: v === null ? '' : String(v), placeholder, autocomplete: 'off',
  });
  const emit = () => { if (onChange) onChange(v); };
  const sync = () => {
    input.value = v === null ? '' : String(v);
    minus.disabled = v === null || v <= min;
    plus.disabled = v !== null && v >= max;
  };
  const set = (nv) => {
    v = nv === null ? null : Math.max(min, Math.min(max, Math.round(nv)));
    sync();
    emit();
  };
  const minus = h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `${label} 줄이기`, onClick: () => set(v === null ? min : v - 1) }, h('span', { 'aria-hidden': 'true', text: '−' }));
  const plus = h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `${label} 늘리기`, onClick: () => set(v === null ? Math.max(min, 1) : v + 1) }, h('span', { 'aria-hidden': 'true', text: '+' }));
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    if (!raw) set(null);
    else if (/^\d+$/.test(raw)) set(Number(raw));
    else sync();
  });
  sync();
  const box = h('div', { class: 'stepper' }, minus, input, unit ? h('span', { class: 'stepper-unit', text: unit }) : null, plus);
  box.setValue = (nv) => { v = nv === null || nv === undefined ? null : Number(nv); sync(); };
  return box;
}

// ── 빈 화면 ──
export function emptyState({ icon: ic = 'ticket', title, text, actions = [], ticket = false }) {
  const main = [
    h('div', { class: 'empty-ico', 'aria-hidden': 'true' }, icon(ic)),
    h('p', { class: 'empty-title', text: title }),
    text ? h('p', { class: 'empty-text', text }) : null,
  ];
  // 첫 화면: 아직 비어 있는 티켓 한 장 (절취선 아래에 첫 기록 버튼)
  if (ticket) {
    return h('div', { class: 'ticket empty-ticket' },
      h('div', { class: 'empty-main' }, main),
      h('div', { class: 'perf perf-lg', 'aria-hidden': 'true' }),
      h('div', { class: 'empty-actions' }, actions));
  }
  return h('div', { class: 'empty' }, main, actions.length ? h('div', { class: 'empty-actions' }, actions) : null);
}

// ── 라벨 있는 필드 ──
export function field(label, control, { hint, id, cls = '', counter, optional = false, error = null } = {}) {
  const fid = id || nextId('f');
  if (control && control.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].includes(control.tagName) && !control.id) control.id = fid;
  const labelEl = control && control.id
    ? h('label', { class: 'field-label', htmlFor: control.id }, label, optional ? h('span', { class: 'field-opt', text: ' 선택' }) : null)
    : h('span', { class: 'field-label' }, label, optional ? h('span', { class: 'field-opt', text: ' 선택' }) : null);
  const hintId = hint ? nextId('hint') : null;
  if (hintId && control && control.setAttribute) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: ['field', cls] },
    h('div', { class: 'field-head' }, labelEl, counter || null),
    control,
    hint ? h('p', { class: 'field-hint', id: hintId, text: hint }) : null,
    h('p', { class: 'field-error', role: 'alert', hidden: !error, text: error || '' }));
}

/** 필드 아래 오류 글자 보이기/숨기기 */
export function setFieldError(fieldEl, msg) {
  if (!fieldEl) return;
  const e = fieldEl.querySelector(':scope > .field-error');
  if (!e) return;
  e.textContent = msg || '';
  e.hidden = !msg;
  fieldEl.classList.toggle('has-error', !!msg);
}

/** 글자 수 카운터 연결 */
export function counterFor(input, max) {
  const c = h('span', { class: 'counter', 'aria-hidden': 'true' });
  const upd = () => {
    const n = Array.from(input.value).length;
    c.textContent = `${n}/${max}`;
    c.classList.toggle('is-near', n > max * 0.9);
    c.classList.toggle('is-over', n > max);
  };
  input.addEventListener('input', upd);
  upd();
  c.update = upd;
  return c;
}

/** textarea 높이를 내용에 맞춤 */
export function autoGrow(ta, { min = 3 } = {}) {
  ta.rows = min;
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 640)}px`;
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return ta;
}

// ── 접히는 영역 (추가 기록 · 스포일러) ──
/**
 * 버튼을 누르면 펼쳐짐. build() 는 처음 펼칠 때 한 번만 부름 → 접혀 있는 동안 내용이 DOM 에 없음
 * (스포일러가 화면 찾기·스크린리더·인쇄로 새지 않게)
 */
export function fold({ label, sub, open = false, build, cls = '', icon: ic = null, onToggle }) {
  const bodyId = nextId('fold');
  // sub: 글자 또는 (펼쳤는지) => 글자
  const subText = (o) => (typeof sub === 'function' ? sub(o) : sub);
  const subEl = sub ? h('span', { class: 'fold-sub', text: subText(false) }) : null;
  const btn = h('button', { type: 'button', class: 'fold-btn', 'aria-expanded': 'false', 'aria-controls': bodyId },
    ic ? icon(ic, 'fold-ico') : null,
    h('span', { class: 'fold-text' }, h('span', { class: 'fold-label', text: label }), subEl),
    icon('down', 'fold-caret'));
  const body = h('div', { class: 'fold-body', id: bodyId, hidden: true });
  const box = h('section', { class: ['fold', cls] }, btn, body);
  let built = false;
  function setOpen(o) {
    if (o && !built) {
      built = true;
      body.append(build());
    }
    body.hidden = !o;
    btn.setAttribute('aria-expanded', o ? 'true' : 'false');
    box.classList.toggle('is-open', o);
    if (subEl) subEl.textContent = subText(o);
    if (onToggle) onToggle(o);
  }
  btn.addEventListener('click', () => setOpen(body.hidden));
  if (open) setOpen(true);
  box.setOpen = setOpen;
  box.isOpen = () => !body.hidden;
  box.isBuilt = () => built;
  box.setSub = (fnOrText) => { sub = fnOrText; if (subEl) subEl.textContent = subText(!body.hidden); };
  return box;
}

// ── 한 번만 보이는 도장 (방탈출 저장 직후) ──
export function stampOnce(target, text, kind) {
  if (!target || reducedMotion()) return;
  const s = h('span', { class: `save-stamp is-${kind}`, 'aria-hidden': 'true' }, h('span', { text }));
  target.appendChild(s);
  s.addEventListener('animationend', () => s.remove(), { once: true });
  setTimeout(() => s.remove(), 2400);
}
