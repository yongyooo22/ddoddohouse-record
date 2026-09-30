// 시작 · 해시 라우터 · 테마 · 서비스 워커
import { h, icon } from './dom.js';
import * as repo from './repo.js';
import * as prefs from './prefs.js';
import { onVersionChange } from './db.js';
import { setRouter, markRendered, navigate } from './nav.js';
import { closeAllDialogs, toast } from './ui.js';
import { closeViewer } from './views/photos.js';
import * as homeView from './views/home.js';
import * as playView from './views/play.js';
import * as workView from './views/work.js';
import * as formView from './views/form.js';
import * as workFormView from './views/work-form.js';
import * as settingsView from './views/settings.js';

const viewEl = document.getElementById('view');

// ── 테마 (기본은 밝은 크림색. 설정에서 어둡게·기기 설정 따르기) ──
const THEME_COLORS = { light: '#F6F1E7', dark: '#1B1A17' };
export function applyTheme() {
  const t = prefs.getTheme();
  const root = document.documentElement;
  root.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? THEME_COLORS.dark : THEME_COLORS.light);
}
applyTheme();
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (prefs.getTheme() === 'system') applyTheme(); });
}

// ── 라우팅 ──
const ROUTES = [
  [/^\/?$/, 'home', homeView, ''],
  [/^\/new$/, 'new', formView, '새 기록'],
  [/^\/play\/([^/]+)$/, 'play', playView, '기록'],
  [/^\/play\/([^/]+)\/edit$/, 'edit', formView, '기록 수정'],
  [/^\/work\/([^/]+)$/, 'work', workView, '작품'],
  [/^\/work\/([^/]+)\/edit$/, 'work-edit', workFormView, '작품 정보 수정'],
  [/^\/settings$/, 'settings', settingsView, '설정'],
];

function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = {};
  if (qi >= 0) for (const [k, v] of new URLSearchParams(raw.slice(qi + 1))) query[k] = v;
  return { path: path.startsWith('/') ? path : `/${path}`, query };
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

let current = null;
let currentName = null;

// 뒤로가기 때 보던 위치로 (history 항목마다 스크롤 기억)
const scrollMem = new Map();
let entryId = null;
let seq = 0;

function route() {
  if (!repo.state.ready) return;
  if (entryId) scrollMem.set(entryId, window.scrollY);
  const st = history.state;
  let restore = null;
  if (st && st.eid) {
    entryId = st.eid;
    restore = scrollMem.has(entryId) ? scrollMem.get(entryId) : null;
  } else {
    entryId = `e${Date.now()}-${++seq}`;
    history.replaceState({ eid: entryId }, '');
  }

  const { path, query } = parseHash();
  let match = null;
  for (const [re, name, mod, title] of ROUTES) {
    const m = re.exec(path);
    if (m) { match = { name, mod, title, params: m.slice(1).map(safeDecode) }; break; }
  }
  if (!match) { navigate('#/', { replace: true }); return; }

  if (current && current.destroy) {
    try { current.destroy(); } catch (e) { console.error(e); }
  }
  closeViewer();
  closeAllDialogs();
  viewEl.replaceChildren();
  currentName = match.name;
  document.body.dataset.route = match.name;
  const book = repo.state.bookName;
  document.title = match.title ? `${match.title} · ${book}` : book;
  try {
    current = match.mod.mount(viewEl, { name: match.name, params: match.params, query, restored: !!(st && st.eid), applyTheme }) || {};
  } catch (e) {
    console.error(e);
    current = {};
    viewEl.replaceChildren(h('div', { class: 'container' }, h('p', { class: 'notice', text: '화면을 그리지 못했어요. 새로고침해 주세요.' })));
  }
  markRendered();
  window.scrollTo(0, restore ?? 0);
  if (!viewEl.contains(document.activeElement) || document.activeElement === document.body) {
    try { viewEl.focus({ preventScroll: true }); } catch { /* 무시 */ }
  }
}

setRouter(route);
window.addEventListener('hashchange', route);

repo.subscribe(() => {
  if (!repo.state.ready) return;
  if (currentName && current && current.update) {
    try { current.update(); } catch (e) { console.error(e); }
  }
});

// 다른 탭이 새 버전 앱으로 저장소 구조를 바꾸려 하면: 이 탭은 닫고 새로고침 안내
onVersionChange(() => {
  toast('다른 탭에서 새 버전이 열렸어요. 새로고침해 주세요', 'info', 8000);
});

// ── 저장소를 쓸 수 없을 때 (사생활 보호 모드·저장 차단 등) ──
function renderStorageError() {
  viewEl.replaceChildren(h('div', { class: 'container narrow fatal' },
    h('div', { class: 'fatal-ico', 'aria-hidden': 'true' }, icon('database')),
    h('h1', { class: 'fatal-title', text: '이 브라우저에서는 기록을 저장할 수 없어요' }),
    h('p', { text: '이 기록장은 기록과 사진을 브라우저 안(IndexedDB)에 저장해요. 사생활 보호(시크릿) 창이거나, 브라우저 설정에서 사이트 데이터 저장을 막아 두면 열리지 않아요.' }),
    h('p', { text: '일반 창에서 열거나, 이 사이트의 데이터 저장(쿠키 및 사이트 데이터)을 허용한 뒤 새로고침해 주세요.' }),
    h('button', { type: 'button', class: 'btn btn-primary', onClick: () => location.reload() }, icon('refresh'), h('span', { text: '새로고침' }))));
}

async function start() {
  const ok = await repo.init();
  if (!ok) { renderStorageError(); return; }
  route();
  // 쓰이지 않는 사진 정리 (작성 중인 초안의 사진은 남김, 올린 지 하루 지난 것만)
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
  idle(() => { repo.cleanupOrphanImages({ keep: prefs.draftPhotoIds() }).catch(() => {}); });
}

// ── 서비스 워커 (오프라인에서도 열리게) ──
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('새 버전이 준비됐어요. 앱을 다시 열면 적용돼요', 'info', 4000);
  });
}

start();
