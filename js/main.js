// 부트스트랩 · 라우터 · 키 처리
import { h, icon } from './dom.js';
import { APP_NAME } from './constants.js';
import * as store from './store.js';
import * as api from './api.js';
import { setRouter, markRendered, navigate } from './nav.js';
import { toast } from './ui.js';
import * as lockView from './views/lock.js';
import * as homeView from './views/home.js';
import * as listView from './views/list.js';
import * as detailView from './views/detail.js';
import * as formView from './views/form.js';
import * as statsView from './views/stats.js';
import * as membersView from './views/members.js';
import * as settingsView from './views/settings.js';

const viewEl = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const banner = document.getElementById('banner');

// ── 테마 ──
const THEME_COLORS = { light: '#F7F4EE', dark: '#17161A' };
function applyTheme() {
  const t = store.getTheme();
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const media = m.getAttribute('media') || '';
    const def = media.includes('dark') ? THEME_COLORS.dark : THEME_COLORS.light;
    m.setAttribute('content', t === 'system' ? def : THEME_COLORS[t]);
  });
}
applyTheme();

// ── URL 의 키 (#k=… 또는 ?key=…) → localStorage, 주소창에서 즉시 제거 ──
// 이미 쓰던 코드가 있는데 링크의 코드가 다르면, 서버에서 먼저 확인한 뒤에만 바꾼다.
// (잘린 링크·예전 링크·장난 링크 하나로 잘 되던 코드와 오프라인 사본이 지워지지 않도록)
let verifying = null;

function takeKeyFromUrl() {
  const hash = location.hash || '';
  const params = new URLSearchParams(location.search);
  const hm = /(?:^#|[#&?])k=([^&]*)/.exec(hash);
  let key = null;
  if (hm) {
    try { key = decodeURIComponent(hm[1]); } catch { key = hm[1]; }
  }
  if (!key && params.has('key')) key = params.get('key');
  if (!hm && !params.has('key')) return false;
  params.delete('key');
  const qs = params.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}#/`);
  key = (key || '').trim();
  if (!key || !api.isValidKeyFormat(key)) {
    if (store.getKey()) toast('링크의 코드 형식이 올바르지 않아 기존 코드로 열었어요', 'error', 4500);
    return false;
  }
  const stored = store.getKey();
  if (stored === key) return true;
  if (!stored) {
    store.forgetAccess();
    store.setKey(key);
    started = false;
    return true;
  }
  verifying = verifyNewKey(key);
  return true;
}

async function verifyNewKey(key) {
  try {
    const data = await api.fetchData({ key });
    verifying = null;
    adoptKey(key, data);
    if (currentName === 'lock') navigate('#/', { replace: true });
    toast('새 코드로 열었어요', 'ok');
  } catch (e) {
    verifying = null;
    if (e.code === 'unauthorized') toast('링크의 코드가 맞지 않아 기존 코드로 열었어요', 'error', 4500);
    else if (e.code === 'too_many_attempts') toast('시도가 너무 많아요. 15분쯤 뒤에 다시 해 주세요', 'error', 4500);
    else toast('링크의 코드를 확인하지 못해 기존 코드로 열었어요. 연결되면 링크를 다시 열어 주세요', 'error', 5000);
    if (store.getKey() && started) refresh().catch(() => {});
  }
}

/** 확인된 코드와 그 코드로 받은 데이터로 교체 */
function adoptKey(key, data) {
  store.forgetAccess();
  store.setKey(key);
  store.setData(data);
  store.setStatus('ok');
  started = true;
  lastRefresh = Date.now();
  document.body.classList.remove('is-locked');
}

// ── 데이터 동기화 ──
let started = false;
let inflight = null;
let lastRefresh = 0;

async function refresh() {
  if (inflight) return inflight;
  if (!store.getKey()) return null;
  store.setStatus('loading');
  document.body.classList.add('is-loading');
  inflight = (async () => {
    try {
      // 응답이 오기 전에 이 기기에서 저장·삭제한 내용은 덮어쓰지 않도록 표시를 찍어 둠
      const since = store.mutationMark();
      const data = await api.fetchData();
      store.setData(data, { since });
      store.setStatus('ok');
      lastRefresh = Date.now();
      return data;
    } catch (e) {
      if (e.code === 'offline') store.setStatus('offline', e.code);
      else if (e.code !== 'unauthorized') store.setStatus('error', e.code);
      throw e;
    } finally {
      inflight = null;
      document.body.classList.remove('is-loading');
    }
  })();
  return inflight;
}

function start() {
  if (started) return;
  started = true;
  store.loadCache();
  // 링크의 새 코드를 확인하는 중이면, 끝난 뒤에 (필요하면) 새로고침
  if (!verifying) refresh().catch(() => {});
}

// 401/429/503 전역 처리
api.onApiError((err) => {
  if (err.code === 'unauthorized') {
    store.forgetAccess();
    started = false;
    lock('코드가 바뀌었거나 맞지 않아요. 새로 공유받은 링크로 들어와 주세요.');
  } else if (err.code === 'too_many_attempts') {
    toast('시도가 너무 많아요. 15분쯤 뒤에 다시 해 주세요', 'error', 4500);
  }
});

// ── 잠금 ──
let current = null;
let currentName = null;

function lock(message) {
  if (current && current.destroy) { try { current.destroy(); } catch { /* 무시 */ } }
  currentName = 'lock';
  tabbar.hidden = true;
  banner.hidden = true;
  document.body.classList.add('is-locked');
  document.title = APP_NAME;
  if (location.hash && location.hash !== '#/') history.replaceState(null, '', `${location.pathname}#/`);
  viewEl.replaceChildren();
  current = lockView.mount(viewEl, { message, unlock }) || {};
}

async function unlock(key) {
  const data = await api.fetchData({ key });
  adoptKey(key, data);
  navigate('#/', { replace: true });
}

// ── 라우팅 ──
const ROUTES = [
  [/^\/?$/, 'home', homeView, 'home', '홈'],
  [/^\/records$/, 'records', listView, 'records', '기록'],
  [/^\/record\/([^/]+)$/, 'record', detailView, 'records', '기록'],
  [/^\/new$/, 'new', formView, 'new', '새 기록'],
  [/^\/new\/([a-z]+)$/, 'new', formView, 'new', '새 기록'],
  [/^\/edit\/([^/]+)$/, 'edit', formView, 'new', '기록 수정'],
  [/^\/stats$/, 'stats', statsView, 'stats', '통계'],
  [/^\/members$/, 'members', membersView, 'members', '멤버'],
  [/^\/member\/([^/]+)$/, 'member', membersView, 'members', '멤버'],
  [/^\/settings$/, 'settings', settingsView, 'home', '설정'],
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

// 뒤로가기 시 스크롤 복원
const scrollMem = new Map();
let entryId = null;
let seq = 0;

function route() {
  if (/(?:^#|[#&?])k=/.test(location.hash) || new URLSearchParams(location.search).has('key')) takeKeyFromUrl();
  if (!store.getKey()) { lock(); return; }
  start();
  document.body.classList.remove('is-locked');

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
  for (const [re, name, mod, tab, title] of ROUTES) {
    const m = re.exec(path);
    if (m) { match = { name, mod, tab, title, params: m.slice(1).map(safeDecode) }; break; }
  }
  if (!match) { navigate('#/', { replace: true }); return; }

  if (current && current.destroy) { try { current.destroy(); } catch (e) { console.error(e); } }
  viewEl.replaceChildren();
  currentName = match.name;
  const isForm = (match.name === 'new' && match.params[0]) || match.name === 'edit';
  tabbar.hidden = !!isForm;
  document.body.classList.toggle('has-tabbar', !isForm);
  for (const a of tabbar.querySelectorAll('[data-tab]')) {
    if (a.dataset.tab === match.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = match.name === 'home' ? APP_NAME : `${match.title} · ${APP_NAME}`;
  try {
    current = match.mod.mount(viewEl, {
      // restored: 뒤로/앞으로 가기로 이미 봤던 화면에 돌아옴 (쓰던 필터 등을 그대로 둠)
      name: match.name, params: match.params, query, refresh, applyTheme, lock, restored: !!(st && st.eid),
    }) || {};
  } catch (e) {
    console.error(e);
    current = {};
    viewEl.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'loading', text: '화면을 그리지 못했어요. 새로고침해 주세요.' })));
  }
  markRendered();
  renderBanner();
  window.scrollTo(0, restore ?? 0);
  // 화면이 바뀌면 초점을 새 화면으로 (스크린리더가 새 화면을 읽고, 키보드 탐색이 처음부터 시작되게)
  if (!viewEl.contains(document.activeElement) || document.activeElement === document.body) {
    try { viewEl.focus({ preventScroll: true }); } catch { /* 무시 */ }
  }
}

setRouter(route);
window.addEventListener('hashchange', route);

store.subscribe((kind) => {
  if (currentName === 'lock') return;
  if (kind === 'status') renderBanner();
  if (current && current.update && (kind === 'data' || currentName === 'settings' || (kind === 'status' && !store.state.lastSync))) {
    try { current.update(); } catch (e) { console.error(e); }
  }
});

// ── 상단 알림 띠 ──
function renderBanner() {
  if (currentName === 'lock') { banner.hidden = true; return; }
  const s = store.state;
  const offline = navigator.onLine === false || s.status === 'offline';
  let msg = null;
  let retry = false;
  let cls = 'banner-warn';
  if (offline) {
    msg = s.lastSync ? '오프라인이에요 — 이 기기에 저장된 기록을 보여 드려요 (읽기 전용)' : '오프라인이에요 — 인터넷에 연결되면 기록을 불러올게요';
    cls = 'banner-off';
    retry = navigator.onLine !== false;
  } else if (s.status === 'error') {
    if (s.errorCode === 'too_many_attempts') msg = '시도가 너무 많아요. 15분쯤 뒤에 다시 열어 주세요';
    else if (s.errorCode === 'not_configured') msg = '서버 설정이 아직 끝나지 않았어요 (APP_SECRET·Redis 연결 확인)';
    else {
      msg = s.lastSync ? '서버에 연결하지 못했어요. 이 기기에 저장된 기록을 보여 드려요' : '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요';
      retry = true;
    }
  }
  if (!msg) { banner.hidden = true; banner.replaceChildren(); return; }
  banner.className = `banner ${cls}`;
  const parts = [icon(offline ? 'wifiOff' : 'info'), h('span', { class: 'banner-text', text: msg })];
  if (retry) parts.push(h('button', { type: 'button', class: 'banner-btn', onClick: () => refresh().catch(() => {}) }, '다시 시도'));
  banner.replaceChildren(...parts);
  banner.hidden = false;
}

window.addEventListener('online', () => { renderBanner(); if (store.getKey()) refresh().catch(() => {}); });
window.addEventListener('offline', () => { store.setStatus('offline', 'offline'); renderBanner(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.getKey() && started && Date.now() - lastRefresh > 60000) {
    refresh().catch(() => {});
  }
});

// ── 서비스 워커 ──
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('새 버전이 준비됐어요. 앱을 다시 열면 적용돼요', 'info', 4000);
  });
}

route();
