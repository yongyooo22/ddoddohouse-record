// 안전한 DOM 생성 유틸 — 사용자 값은 항상 textContent / 속성으로만 넣는다 (innerHTML 금지)

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly', 'required', 'multiple', 'indeterminate', 'open']);

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') {
      el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v));
    } else if (k === 'text') {
      el.textContent = String(v);
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv !== undefined && dv !== null) el.dataset[dk] = String(dv);
    } else if (k === 'style' || k === 'innerHTML' || k === 'outerHTML') {
      throw new Error(`h(): '${k}' 는 사용할 수 없어요`);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k.startsWith('on')) {
      throw new Error('h(): 문자열 이벤트 속성은 금지');
    } else if (PROP_KEYS.has(k)) {
      el[k] = v;
    } else if (k === 'htmlFor') {
      el.setAttribute('for', String(v));
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
}

export function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

/** h('div', {class:'x', onClick: fn}, '텍스트', child) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG 요소 생성 (차트용). 속성 값은 숫자/문자열, 텍스트는 text 로만 */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'style' || k.startsWith('on')) throw new Error('s(): 금지된 속성');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c instanceof Node) el.appendChild(c);
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

// ── 아이콘 (정적 SVG 템플릿만) ────────────────────────────────
const ICONS = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v11h4.5v-5.5h4V20h4.5V9"/>',
  book: '<path d="M5 5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2z"/><path d="M5 20a1.5 1.5 0 0 0 1.5 1.5H19V18"/><path d="M9 7.5h6M9 11h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chart: '<path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="6" rx="1"/><rect x="10.5" y="5.5" width="3" height="11.5" rx="1"/><rect x="15.5" y="13" width="3" height="4" rx="1"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c.6-3.3 2.8-5.2 5.5-5.2s4.9 1.9 5.5 5.2"/><circle cx="17" cy="9" r="2.5"/><path d="M16.2 14.3c2.3-.1 3.9 1.4 4.4 4.4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  filter: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="8.4" cy="8.4" r="1.25" fill="currentColor" stroke="none"/><circle cx="15.6" cy="8.4" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="8.4" cy="15.6" r="1.25" fill="currentColor" stroke="none"/><circle cx="15.6" cy="15.6" r="1.25" fill="currentColor" stroke="none"/>',
  magnifier: '<circle cx="10.5" cy="10.5" r="6.3"/><path d="M15.2 15.2 20.5 20.5"/><path d="M7.6 10.4a2.9 2.9 0 0 1 2.8-2.8"/>',
  door: '<path d="M6.5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 17.5 5v15.5"/><path d="M4 20.5h16"/><circle cx="12" cy="11" r="1.7"/><path d="M12 12.7v2.8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bulb: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.4 10.9c.6.5.9 1.1.9 1.9v.2h5v-.2c0-.8.3-1.4.9-1.9A6 6 0 0 0 12 3z"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5.5a2.5 2.5 0 0 0 3 4M16 6h2.5a2.5 2.5 0 0 1-3 4"/><path d="M12 13v4M8.5 20.5h7M10 17h4v3.5h-4z"/>',
  crown: '<path d="M4 17.5 3 8l5 4 4-6 4 6 5-4-1 9.5z"/><path d="M5 20.5h14"/>',
  pin: '<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.2 12 21 12 21z"/><circle cx="12" cy="10" r="2.3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M5 19.5h14"/>',
  upload: '<path d="M12 16V5M7 9.5l5-5 5 5"/><path d="M5 19.5h14"/>',
  refresh: '<path d="M19.5 11A7.5 7.5 0 0 0 6 7.1L4.5 8.5"/><path d="M4.5 4.5v4h4"/><path d="M4.5 13A7.5 7.5 0 0 0 18 16.9l1.5-1.4"/><path d="M19.5 19.5v-4h-4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  tag: '<path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.2 8.2-9 9z"/><circle cx="8" cy="8" r="1.4"/>',
  sort: '<path d="M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
  wifiOff: '<path d="M3 3l18 18"/><path d="M8.6 16.4a5 5 0 0 1 6.8 0"/><path d="M5 12.6a10 10 0 0 1 4.6-2.4M14.8 10.3A10 10 0 0 1 19 12.6"/><path d="M2 9a14.5 14.5 0 0 1 5-2.8M11 5.6A14.5 14.5 0 0 1 22 9"/><circle cx="12" cy="19.5" r=".9" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  note: '<path d="M5 4.5h14v15H5z"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>',
  mask: '<path d="M4 6.5c2.5-1 5.2-1.5 8-1.5s5.5.5 8 1.5c0 6.5-3.3 12-8 12.5-4.7-.5-8-6-8-12.5z"/><path d="M7.5 10.5c.8-.6 1.7-.6 2.5 0M14 10.5c.8-.6 1.7-.6 2.5 0M9.5 14.5c1.5 1 3.5 1 5 0"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  camera: '<path d="M4 8.7a2.2 2.2 0 0 1 2.2-2.2h1.9l1.6-2.2h4.6l1.6 2.2h1.9A2.2 2.2 0 0 1 20 8.7v9.1a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 17.8z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.7"/><path d="M4 17.5l4.6-4.6 3.4 3.4 2.6-2.6 5.4 5.3"/>',
  imageOff: '<path d="M3.5 3.5l17 17"/><path d="M20.5 16.2V7a2.5 2.5 0 0 0-2.5-2.5H8.8M4.4 5.3A2.5 2.5 0 0 0 3.5 7v10A2.5 2.5 0 0 0 6 19.5h12c.5 0 1-.1 1.3-.4"/><path d="M4 17.5l4.6-4.6 3.4 3.4"/>',
  swap: '<path d="M7 4.5 3.5 8 7 11.5"/><path d="M3.5 8h13"/><path d="M17 12.5l3.5 3.5-3.5 3.5"/><path d="M20.5 16h-13"/>',
  // 로고: 양옆에 반원 홈이 있는 티켓 + 가운데 작은 별
  // 소장: 뚜껑 덮인 보관 상자
  box: '<rect x="3.5" y="5" width="17" height="4.5" rx="1.2"/><path d="M5 9.5v8.75A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V9.5"/><path d="M10 13.25h4"/>',
  ticket: '<path d="M4.5 6h15a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8a2 2 0 0 1 2-2z"/><path class="ico-star" fill="currentColor" stroke-width="1" d="M12 8.6l.85 2.23 2.38.12-1.85 1.5.62 2.3L12 13.45l-2 1.3.62-2.3-1.85-1.5 2.38-.12z"/>',
};

const STAR_PATH = 'M12 2.6l2.83 5.95 6.5.8-4.78 4.5 1.22 6.45L12 17.14 6.23 20.3l1.22-6.45L2.67 9.35l6.5-.8z';

/** 아이콘 SVG. 템플릿은 위의 정적 문자열뿐이므로 innerHTML 사용이 안전함 */
export function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls ? `ico ${cls}` : 'ico');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : ICONS.info;
  return svg;
}

/** 채워진 별 모양 (별점용) */
export function starShape(cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls || '');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', STAR_PATH);
  svg.appendChild(p);
  return svg;
}

/** 원 모양 (난이도·공포도 게이지용) */
export function dotShape(cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls || '');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '8.5');
  svg.appendChild(c);
  return svg;
}
