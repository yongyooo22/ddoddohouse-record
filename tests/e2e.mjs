// 또또하우스 기록장 E2E — 개발 서버(인메모리 Redis)를 띄우고 실제 Chromium(모바일 390×844)으로 전체 흐름 검증
// 실행: npm run e2e
//   CHROMIUM_PATH  Chromium 실행 파일 (기본: /opt/pw-browsers/chromium 이 있으면 그것, 없으면 Playwright 기본값)
//   E2E_SHOTS      스크린샷 폴더 (기본: test-results/shots)
//   E2E_HEADED=1   브라우저 창 띄우기
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startDevServer } from '../scripts/dev.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.E2E_SHOTS || path.join(ROOT, 'test-results', 'shots'));
const CHROMIUM = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium'].find((p) => existsSync(p));
const VIEWPORT = { width: 390, height: 844 };
const TZ = 'Asia/Seoul';
mkdirSync(SHOTS, { recursive: true });
for (const f of readdirSync(SHOTS)) if (/^FAIL-.*\.png$/.test(f)) rmSync(path.join(SHOTS, f));

// ── 결과 집계 ───────────────────────────────────────────────
let passN = 0;
let failN = 0;
const failures = [];
function check(name, ok, extra = '') {
  if (ok) {
    passN++;
    console.log(`  ✓ ${name}`);
  } else {
    failN++;
    failures.push(`${currentStep} › ${name}${extra ? ` — ${extra}` : ''}`);
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
  return !!ok;
}
let currentStep = '';
async function step(name, fn) {
  currentStep = name;
  console.log(`\n[${name}]`);
  try {
    await fn();
  } catch (err) {
    check('단계가 예외 없이 끝남', false, String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
    try {
      await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/[^\w가-힣-]+/g, '_')}.png`), fullPage: true });
    } catch { /* 무시 */ }
    try {
      await closeDialogs();
    } catch { /* 무시 */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch {
      last = undefined;
    }
    if (last) return last;
    await sleep(60);
  }
  return last;
}
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ── 서버 · 브라우저 ─────────────────────────────────────────
const serverErrors = [];
const srv = await startDevServer({
  port: 0,
  logger: { error: (...a) => serverErrors.push(a.map(String).join(' ')), log() {}, warn() {} },
});
const BASE = srv.url;
const SECRET = srv.secret;

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'x-app-key': SECRET, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* 무시 */ }
  return { status: res.status, data };
}

const browser = await chromium.launch({
  ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
  headless: process.env.E2E_HEADED !== '1',
});

// 콘솔 오류 · 페이지 오류 · CSP 위반 수집. 의도한 네트워크 오류(401/409 등)는 allowNet 으로 허용
const problems = [];
const cspViolations = [];
let allowNet = [];
async function newContext(opts = {}) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ko-KR',
    timezoneId: TZ,
    colorScheme: 'light',
    acceptDownloads: true,
    ...opts,
  });
  await ctx.exposeBinding('__e2eCsp', (_src, v) => cspViolations.push(v));
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__e2eCsp(`${e.violatedDirective} blocked=${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  return ctx;
}
function watch(p, tag = '') {
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (allowNet.some((re) => re.test(t))) return;
    problems.push(`${tag}console.error: ${t}`);
  });
  p.on('pageerror', (e) => problems.push(`${tag}pageerror: ${e.message}`));
  p.on('response', (r) => { if (r.status() >= 400) netLog.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
}
const netLog = [];
async function allowing(patterns, fn) {
  const prev = allowNet;
  allowNet = [...prev, ...patterns];
  try {
    return await fn();
  } finally {
    await sleep(150);
    allowNet = prev;
  }
}

const ctx = await newContext();
let page = await ctx.newPage();
watch(page);

// ── 페이지 도우미 ───────────────────────────────────────────
let theme = 'light';
async function shot(name, { keepScroll = false } = {}) {
  // 스크린샷용 정리: 남은 토스트를 치우고 맨 위로 (고정 헤더가 중간에 찍히지 않게)
  await page.evaluate((keep) => {
    document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
    if (!keep) window.scrollTo(0, 0);
  }, keepScroll);
  await sleep(250);
  await page.screenshot({ path: path.join(SHOTS, `${theme}-${name}.png`), fullPage: true });
}
async function noOverflow(label) {
  const r = await page.evaluate(() => {
    const iw = window.innerWidth;
    const cw = document.documentElement.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.right > cw + 1) {
        offenders.push(`${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ').join('.')}@${Math.round(b.left)}-${Math.round(b.right)}`);
      }
      if (offenders.length > 4) break;
    }
    return { sw: document.scrollingElement.scrollWidth, iw, cw, offenders };
  });
  return check(`${label}: 가로 스크롤 없음`, r.sw <= r.iw && r.sw <= r.cw, JSON.stringify(r));
}
async function go(hash, sel) {
  await page.evaluate((hh) => { location.hash = hh; }, hash);
  if (sel) await page.waitForSelector(sel, { timeout: 8000 });
  await sleep(80);
}
async function tab(name, sel) {
  await page.click(`#tabbar [data-tab="${name}"]`);
  await page.waitForSelector(sel, { timeout: 8000 });
  await sleep(80);
}
const dlg = 'dialog.dlg[open]';
async function dialogButton(label) {
  await page.click(`${dlg} .dlg-actions button:text-is("${label}")`);
}
async function closeDialogs() {
  for (let i = 0; i < 3; i++) {
    if (!(await page.$(dlg))) return;
    await page.keyboard.press('Escape');
    await sleep(120);
  }
}
async function toastSeen(re, timeout = 5000) {
  return until(async () => {
    const texts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent));
    return texts.find((t) => re.test(t));
  }, timeout);
}
async function text(sel) {
  const el = await page.$(sel);
  return el ? squash(await el.textContent()) : '';
}
async function texts(sel) {
  return (await page.$$eval(sel, (els) => els.map((e) => e.textContent))).map(squash);
}
async function cardTitles() {
  return texts('.page-list .rcard .card-link');
}
/** 가로 막대 행: [{ name, val, sub }] */
async function hbRows(scope) {
  return page.$$eval(`${scope} .hb-row`, (els) => els.map((e) => ({
    name: e.querySelector('.hb-name').textContent.trim(),
    val: e.querySelector('.hb-val > span:first-child').textContent.trim(),
    sub: (e.querySelector('.hb-sub') || { textContent: '' }).textContent.trim(),
  })));
}
async function localKey() {
  return page.evaluate(() => localStorage.getItem('ddh:key'));
}
async function setRating(trackSel, keys) {
  await page.focus(trackSel);
  for (const k of keys) await page.keyboard.press(k);
}
async function ratingOf(trackSel) {
  return page.getAttribute(trackSel, 'aria-valuenow');
}
// ── 기록 폼 도우미 (가운데 1열: 종류 · 게임 · 날짜 · 별점 · (머더미스터리) 내 역할 · 감상 + 사진 버튼) ──
const RATING = '.page-form .rec-rating .rating-track';
const REVIEW = '.page-form [data-field="review"]';
const panelSel = (key) => `.page-form .rec-panel[data-panel="${key}"]`;
/** 추가 입력 영역 펼치기 (이미 펼쳐져 있으면 그대로) */
async function openPanel(key) {
  const btn = `.page-form .addon[data-panel="${key}"]`;
  await page.waitForSelector(btn);
  if ((await page.getAttribute(btn, 'aria-expanded')) !== 'true') await page.click(btn);
  await page.waitForSelector(`${panelSel(key)}:not([hidden])`);
}
async function foldPanel(key) {
  if (await page.$(`${panelSel(key)}:not([hidden])`)) await page.click(`${panelSel(key)} .rp-fold`);
}
/** 저장 직후 주소(#/record/<id>)에서 기록 id */
const STAMP_ID = (url) => decodeURIComponent(url.split('#/record/')[1] || '');
/** 폼에 남아 있으면 안 되는 예전 입력 영역(버튼·패널)이 없는지 */
const noRemovedPanels = () => page.evaluate((keys) => keys.every((k) => !document.querySelector(`.page-form .addon[data-panel="${k}"]`) && !document.querySelector(`.page-form .rec-panel[data-panel="${k}"]`)), REMOVED_PANELS);
const pickedGame = () => text('.page-form .gp-picked-name');
/**
 * 게임 고르기: 같은 종류에 등록된 이름이면 검색해서 고르고, 없으면 검색 영역의 '＋ 새 게임 등록' 창에서 등록
 * (등록 창에서 extra(dlg) 로 대표 이미지·소장 등을 더 채울 수 있음)
 */
async function setGame(name, { extra = null } = {}) {
  await page.waitForSelector('.page-form .gp');
  if (await page.$('.page-form .gp-change')) await page.click('.page-form .gp-change');
  await page.fill('.page-form .gp-input', name);
  const opt = `.page-form .gp-opt:not(.gp-add):not(.is-legacy):has(.gp-opt-name:text-is("${name}"))`;
  await sleep(250);
  if (await page.$(opt)) {
    await page.click(opt);
  } else {
    await page.click('.page-form .gp-add');
    await page.waitForSelector(`${dlg}.dlg-game-form`);
    if (extra) await extra();
    await dialogButton('등록');
    await page.waitForSelector(`${dlg}.dlg-game-form`, { state: 'detached', timeout: 5000 });
  }
  await page.waitForSelector('.page-form .gp-picked');
}
/** 폼에 지금 보이는 입력 이름들 (숨긴 칸 제외) */
const visibleLabels = () => page.$$eval(
  '.page-form .rec-main > .rec-field > .field-label, .page-form .rec-main .rec-row .field-label, .page-form .rec-review-field .field-head > .field-label',
  (els) => els.filter((e) => e.getClientRects().length > 0).map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
);
/** 화면에서는 더 이상 입력받지 않는 예전 항목 — 폼에 버튼·영역이 없어야 함 */
const REMOVED_PANELS = ['result', 'details', 'tags'];
/** 폼의 추가 입력 버튼: 사진 · 함께한 사람(선택) */
const ADDONS = JSON.stringify(['사진', '함께한 사람']);
/** 키 순서와 상관없이 같은 내용인지 비교하기 위한 문자열 */
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const serverRecord = async (id) => (await api('GET', '/api/data')).data.records.find((r) => r.id === id) || null;
/** 서버의 기록 하나를 API 로 덮어씀 (예전 화면이 만들던 '자세한 정보'를 넣어 예전 기록을 흉내) */
async function seedLegacy(id, patch) {
  const cur = (await api('GET', '/api/data')).data.records.find((r) => r.id === id);
  const next = { ...cur, ...patch };
  for (const k of ['bg', 'mm', 'er']) if (patch[k]) next[k] = { ...(cur[k] || {}), ...patch[k] };
  const res = await api('POST', '/api/records', { record: next, baseUpdatedAt: cur.updatedAt });
  return res;
}
async function bodyBg() {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}
function isDarkColor(rgb) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
  if (!m) return false;
  return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) < 80;
}

// 브라우저(Asia/Seoul) 기준 날짜 — 테스트를 도는 기계의 시간대와 무관하게
const seoulDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = seoulDate(new Date());
const YESTERDAY = seoulDate(new Date(Date.now() - 86400e3));
const seoulHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
// 새 기록 기본 날짜: 새벽 0~5시에 쓰면 전날 모임으로 보고 어제
const DEFAULT_DATE = seoulHour < 5 ? YESTERDAY : TODAY;
const PAST = seoulDate(new Date(Date.now() - 40 * 86400e3)); // 항상 지난달 이전
const ids = {};

// ═════════════════════════════════════════════════════════════
await step('CSP 감지기 자체 점검', async () => {
  const res = await page.goto(`${BASE}/`);
  const hdr = res.headers();
  check('문서에 CSP 헤더', /default-src 'self'/.test(hdr['content-security-policy'] || ''), hdr['content-security-policy']);
  check('X-Robots-Tag noindex', /noindex/.test(hdr['x-robots-tag'] || ''));
  check('Referrer-Policy no-referrer', hdr['referrer-policy'] === 'no-referrer');
  check('X-Frame-Options DENY', hdr['x-frame-options'] === 'DENY');
  check('index 는 no-cache', /no-cache/.test(hdr['cache-control'] || ''), hdr['cache-control']);
  await page.waitForSelector('.lock');
  await allowing([/Content Security Policy|Refused to apply inline style/i], async () => {
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.setAttribute('style', 'color:red');
      document.body.appendChild(d);
      d.remove();
    });
    await until(() => cspViolations.length > 0, 2000);
  });
  check('인라인 style 속성이 CSP 로 차단되고 감지됨', cspViolations.length > 0);
  cspViolations.length = 0;
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  check('robots.txt 전체 차단', /User-agent: \*\s+Disallow: \//.test(robots));
  const meta = await page.getAttribute('meta[name="robots"]', 'content');
  check('robots meta noindex', /noindex/.test(meta || ''));
});

await step('잠금 화면 (키 없음)', async () => {
  await page.waitForSelector('.lock');
  check('잠금 화면 표시', !!(await page.$('.lock #lock-key')));
  check('탭바 숨김', await page.$eval('#tabbar', (e) => e.hidden));
  check('앱 이름 표시', (await text('.lock-title')) === '또또하우스 기록장');
  check('안내 문구', (await text('.lock-desc')).includes('공유받은 링크로 들어와 주세요'));
  await noOverflow('잠금 화면');
  await shot('01-lock');
});

await step('잘못된 코드', async () => {
  await page.fill('#lock-key', 'wrong-code-000000000');
  await allowing([/status of 401/], async () => {
    await page.click('.lock-form button[type="submit"]');
    const err = await until(async () => text('.lock-err'), 5000);
    check('오류 문구 표시', /코드가 맞지 않아요/.test(err || ''), err);
  });
  check('여전히 잠금 화면', !!(await page.$('.lock')));
  check('잘못된 코드는 저장 안 됨', (await localKey()) === null);
  await shot('02-lock-error');
});

await step('공유 링크 #k= 로 잠금 해제', async () => {
  await page.goto('about:blank');
  await page.goto(`${BASE}/#k=${encodeURIComponent(SECRET)}`);
  await page.waitForSelector('.page-home', { timeout: 8000 });
  check('홈 화면 표시', true);
  check('주소창에서 키 제거', !page.url().includes(SECRET) && !page.url().includes('k='), page.url());
  check('키가 localStorage 에 저장', (await localKey()) === SECRET);
  check('탭바 표시', !(await page.$eval('#tabbar', (e) => e.hidden)));
  const hist = await page.evaluate(() => history.length);
  check('history 항목에도 키 없음', await page.evaluate(() => !location.href.includes('k=')), String(hist));
  // 빈 홈: 제목 '플레이 기록' · 작은 '기록 없음' 상자(한 줄 + 기록 남기기) · 멤버 먼저 등록 안내 없음 · 소장 게임 등록 버튼만
  check('홈 제목은 ‘플레이 기록’ (인사말·오늘 날짜 없음)', (await text('.page-home .home-title')) === '플레이 기록' && !(await page.$('.page-home .home-date')), await text('.page-home .home-head'));
  check('기록 없음: 한 줄 안내 + ‘기록 남기기’', (await text('.page-home .empty-title')) === '첫 플레이를 기록해 보세요' && !(await page.$('.page-home .empty-text')) &&
    (await text('.page-home .empty .btn-primary')) === '기록 남기기' && (await page.getAttribute('.page-home .empty .btn-primary', 'href')) === '#/new', await text('.page-home .empty'));
  check('기록 없음 상자는 낮게 (240px 이하) · 작은 카드 아이콘', await page.$eval('.page-home .empty', (e) => {
    const ico = e.querySelector('.empty-ico').getBoundingClientRect();
    return e.getBoundingClientRect().height <= 240 && ico.width <= 44 && getComputedStyle(e.querySelector('.empty-ico')).borderRadius !== '50%';
  }));
  check('멤버 먼저 등록 안내 없음', !(await page.$('.page-home .tip')) && !(await page.$('.page-home a[href="#/members"]')));
  check('내 소장 게임: 없으면 작은 ‘소장 게임 등록’ 버튼만', (await text('.page-home .home-owned .sec-title')) === '내 소장 게임' &&
    (await text('.page-home .home-owned .btn')) === '소장 게임 등록' && !(await page.$('.page-home .otiles')));
  await noOverflow('빈 홈');
  await shot('03-home-empty');
});

await step('?key= 로도 잠금 해제', async () => {
  const c2 = await newContext();
  const p2 = await c2.newPage();
  watch(p2, '[?key] ');
  await p2.goto(`${BASE}/?key=${encodeURIComponent(SECRET)}`);
  await p2.waitForSelector('.page-home', { timeout: 8000 });
  check('?key= 로 홈 진입', true);
  check('?key= 가 주소창에서 제거', !p2.url().includes('key='), p2.url());
  await c2.close();
});

await step('멤버 추가 · 중복 · 수정', async () => {
  await tab('members', '.page-members');
  check('빈 멤버 안내', !!(await page.$('.page-members .empty')));
  const add = async (name, emoji, color) => {
    await page.click('.page-members .page-head button[aria-label="멤버 추가"]');
    await page.waitForSelector(`${dlg}.dlg-member`);
    await page.fill(`${dlg} input[placeholder="이름 또는 별명"]`, name);
    if (emoji) await page.click(`${dlg} .emoji-pick[aria-label="${emoji} 고르기"]`);
    if (color) await page.click(`${dlg} label.swatch.mc-${color}`);
    await dialogButton('저장');
    await page.waitForSelector(dlg, { state: 'detached', timeout: 5000 });
  };
  await add('연경', '🐰', 'c1');
  await shot('04-members-one');
  await add('영식', '🦊', 'c6');
  await add('민지', null, 'c4');
  await add('도윤', '🎩', 'c8');
  const names = await texts('.page-members .mlist-name');
  check('멤버 4명 표시', names.length === 4, names.join(','));

  // 중복 이름 (대소문자·공백 무시)
  await page.click('.page-members .page-head button[aria-label="멤버 추가"]');
  await page.waitForSelector(`${dlg}.dlg-member`);
  await page.fill(`${dlg} input[placeholder="이름 또는 별명"]`, '  연경 ');
  await dialogButton('저장');
  const err = await until(() => text(`${dlg} .form-err`), 3000);
  check('중복 이름 거부', /같은 이름의 멤버가 이미 있어요/.test(err || ''), err);
  await shot('05-member-dialog-dup');
  await dialogButton('취소');
  await page.waitForSelector(dlg, { state: 'detached' });

  // 서버도 중복을 막는지 (다른 기기에서 동시에 추가한 경우)
  const dup = await api('POST', '/api/members', { member: { name: '영식' } });
  check('서버도 중복 이름 400', dup.status === 400 && dup.data.reason === 'duplicate', JSON.stringify(dup));

  // 수정: 민지 → 민지짱 ⭐
  await page.click('.page-members .mlist-row:has(.mlist-name > span:text-is("민지"))');
  await page.waitForSelector('.page-profile');
  await page.click('.page-profile .appbar button[aria-label="수정"]');
  await page.waitForSelector(`${dlg}.dlg-member`);
  await page.fill(`${dlg} input[placeholder="이름 또는 별명"]`, '민지짱');
  await page.click(`${dlg} .emoji-pick[aria-label="⭐ 고르기"]`);
  await dialogButton('저장');
  await page.waitForSelector(dlg, { state: 'detached' });
  check('프로필 이름 갱신', (await until(async () => (await text('.phero-name')) === '민지짱' && '민지짱')) === '민지짱');
  check('프로필 아바타 이모지', (await text('.phero .av')) === '⭐', await text('.phero .av'));
  await tab('members', '.page-members');
  const names2 = await texts('.page-members .mlist-name');
  check('목록에 수정된 이름', names2.includes('민지짱') && !names2.includes('민지'), names2.join(','));
  await noOverflow('멤버 목록');
  await shot('06-members');

  const { data } = await api('GET', '/api/data');
  for (const m of data.members) ids[m.name] = m.id;
  check('서버에 멤버 4명 저장', data.members.length === 4);
});

await step('API 로 비교용 기록 준비', async () => {
  const er0 = await api('POST', '/api/records', {
    record: {
      type: 'escaperoom', date: PAST, title: '저주받은 인형의 집', members: [ids['연경'], ids['영식']], rating: 3,
      oneLiner: '무서웠다', tags: ['공포'],
      er: { brand: '키이스케이프', branch: '강남점', genre: '공포', playerCount: 2, timeLimitMin: 70, cleared: false, hints: 3, difficulty: 4, fear: 5 },
    },
  });
  check('실패한 방탈출 기록 생성', er0.status === 200, JSON.stringify(er0.data));
  ids.er0 = er0.data.record.id;
  await page.reload();
  await page.waitForSelector('.page-members');
});

await step('보드게임 기록 (새 간단 폼: 소장 게임 검색·선택 · 날짜 · 별점 · 감상)', async () => {
  // 소장 탭에 먼저 등록해 둔 게임 (인원·예상 시간·장르는 게임 정보로 한 번만)
  const reg = await api('POST', '/api/games', { game: { type: 'boardgame', title: '테라포밍 마스', owned: true, playersMin: 1, playersMax: 5, timeMin: 90, timeMax: 120, genres: ['전략'] } });
  check('소장 게임 등록 (API)', reg.status === 200 && reg.data.game.owned === true, JSON.stringify(reg.data));
  ids.gTera = reg.data.game.id;
  await page.reload();
  await page.waitForSelector('.page-members');
  await page.click('#tabbar .tab-add');
  await page.waitForSelector('.page-form.t-boardgame');
  check('＋ → 종류 고르기 없이 바로 폼 (기본 보드게임)', page.url().endsWith('#/new/boardgame') && (await page.$eval('.page-form .rec-type .seg-input:checked', (e) => e.value)) === 'boardgame', page.url());
  check('폼에서는 탭바 숨김', await page.$eval('#tabbar', (e) => e.hidden));
  // 처음엔 종류 · 게임 · 날짜 · 별점 · 감상만 (내 역할 칸은 머더미스터리에만), 추가 입력은 ‘사진’ 버튼 하나
  const mainLabels = await visibleLabels();
  check('처음 보이는 항목: 종류·게임·날짜·별점·감상 (내 역할 칸은 숨김)', JSON.stringify(mainLabels) === JSON.stringify(['종류', '게임', '날짜', '별점', '감상']) &&
    await page.isHidden('.page-form [data-field="mm.myRole"]'), JSON.stringify(mainLabels));
  check('추가 입력은 ‘사진’·‘함께한 사람’ 버튼 둘뿐 (영역은 접힘)', JSON.stringify(await texts('.page-form .addon .addon-label')) === ADDONS &&
    (await page.$$eval('.page-form .rec-panel', (els) => els.length === 2 && els.every((e) => e.hidden))), JSON.stringify(await texts('.page-form .addon')));
  check('결과·자세한 정보·태그 버튼·영역 없음 (함께한 사람 칩은 펼치기 전엔 없음)', await noRemovedPanels() && !(await page.$('.page-form .chip-member, .page-form .chip-tag, .page-form .result-row, .page-form .score-row, .page-form .stamp-choice-clear')));
  const formText = await text('.page-form');
  check('폼 글자에도 예전 항목 이름 없음', ['자세한 정보', '태그', '순위', '승자', '플레이 시간'].every((w) => !formText.includes(w)), formText);
  check('하나의 흰 기록 영역 (카드 여러 개 아님)', (await page.$$('.page-form .rec-sheet')).length === 1 && !(await page.$('.page-form .card')));
  check('날짜 기본값 (새벽 5시 전이면 어제, 아니면 오늘)', (await page.inputValue('[data-field="date"]')) === DEFAULT_DATE, `${await page.inputValue('[data-field="date"]')} vs ${DEFAULT_DATE} (${seoulHour}시)`);
  const pressedChip = await page.$$eval('.date-quick .chip[aria-pressed="true"]', (els) => els.map((e) => e.textContent));
  check('기본 날짜에 맞는 빠른 선택 칩 표시', JSON.stringify(pressedChip) === JSON.stringify([seoulHour < 5 ? '어제' : '오늘']), JSON.stringify(pressedChip));
  await page.click('.date-quick .chip:text-is("어제")');
  check('‘어제’ 한 번에 선택', (await page.inputValue('[data-field="date"]')) === YESTERDAY);
  await page.click('.date-quick .chip:text-is("오늘")');
  check('‘오늘’ 한 번에 선택', (await page.inputValue('[data-field="date"]')) === TODAY &&
    (await page.getAttribute('.date-quick .chip:text-is("오늘")', 'aria-pressed')) === 'true');

  // 게임 없이 저장 → 오류 (게임과 날짜만 있으면 저장 가능)
  await page.click('.save-btn');
  check('게임을 고르지 않으면 저장 안 됨', !!(await toastSeen(/게임을 골라 주세요/)));
  check('게임 칸 aria-invalid · 검색칸에 초점', (await page.getAttribute('.page-form .gp', 'aria-invalid')) === 'true' &&
    await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('gp-input')));
  // 등록된 게임 검색 → 작은 대표 이미지 · 이름 · 요약
  await page.fill('.page-form .gp-input', '테라');
  const opt = '.page-form .gp-opt:has(.gp-opt-name:text-is("테라포밍 마스"))';
  await page.waitForSelector(opt);
  check('검색 결과: 썸네일 · 이름 · 내 소장 · 인원·시간·장르', !!(await page.$(`${opt} .gthumb`)) && (await text(`${opt} .gp-opt-meta`)) === '내 소장 · 1~5명 · 90~120분 · 전략', await text(opt));
  check('검색 영역 안에 ‘＋ 새 게임 등록’', !!(await until(async () => (await text('.page-form .gp-add')) === '‘테라’ 새 게임 등록', 3000)), await text('.page-form .gp-add'));
  await noOverflow('게임 검색');
  await shot('08a-form-search');
  await page.click(opt);
  await page.waitForSelector('.page-form .gp-picked');
  check('고른 게임은 작은 요약 (이름 · 내 소장 · 2~4명 · 시간 · 장르)', (await pickedGame()) === '테라포밍 마스' &&
    (await text('.page-form .gp-picked-meta')) === '내 소장1~5명 · 90~120분 · 전략' && !!(await page.$('.page-form .gp-change')), await text('.page-form .gp-picked'));
  check('게임 칸 오류 표시 사라짐', (await page.getAttribute('.page-form .gp', 'aria-invalid')) === null);
  // 별점: 탭(반 별) → 4번째 별 왼쪽 절반 = 3.5
  const u4 = await page.$(`${RATING} .r-unit:nth-child(4)`);
  const b = await u4.boundingBox();
  await page.mouse.click(b.x + b.width * 0.25, b.y + b.height / 2);
  check('반 별 탭 → 3.5', (await ratingOf(RATING)) === '3.5', await ratingOf(RATING));
  const u1 = await (await page.$(`${RATING} .r-unit:nth-child(1)`)).boundingBox();
  const u5 = await (await page.$(`${RATING} .r-unit:nth-child(5)`)).boundingBox();
  await page.mouse.move(u1.x + 4, u1.y + u1.height / 2);
  await page.mouse.down();
  await page.mouse.move(u5.x + u5.width * 0.5, u5.y + u5.height / 2, { steps: 8 });
  await page.mouse.move(u5.x + u5.width - 2, u5.y + u5.height / 2, { steps: 2 });
  await page.mouse.up();
  check('드래그 → 5점', (await ratingOf(RATING)) === '5', await ratingOf(RATING));
  await setRating(RATING, ['4', 'ArrowRight']);
  check('키보드 → 4.5', (await ratingOf(RATING)) === '4.5', await ratingOf(RATING));
  // 감상: 처음엔 3줄, 쓰는 만큼 늘어남. 글자 수는 한도에 가까울 때만
  const h0 = await page.$eval(REVIEW, (e) => e.getBoundingClientRect().height);
  check('감상은 처음 2~3줄 높이 · 글자 수 숨김', h0 >= 60 && h0 <= 110 && await page.$eval('.page-form .rec-review-foot .counter', (e) => e.hidden), String(h0));
  await page.fill(REVIEW, '화성 개척은 역시 재밌다\n영식이 막판 도시 타일로 역전했다.\n다음엔 확장 더 넣어서!\n\n다음 판은 더 길게.\n끝.');
  const h1 = await page.$eval(REVIEW, (e) => e.getBoundingClientRect().height);
  check('쓰는 만큼 감상 칸이 늘어남', h1 > h0 + 30, `${h0} → ${h1}`);
  check('게임 정보(소장 여부·대표 이미지)는 기록에서 다시 묻지 않음', !(await page.$('.page-form .seg-own')) && !(await page.$('.page-form .cv-field')));
  check('사진 버튼의 요약은 비어 있음', (await text('.page-form .addon[data-panel="photos"] .addon-sum')) === '');
  await noOverflow('보드게임 폼');
  await shot('08-form-boardgame');

  // 저장 버튼 연타 → POST 1번
  let posts = 0;
  const onReq = (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/records')) posts++; };
  page.on('request', onReq);
  await page.evaluate(() => { const s = document.querySelector('.save-btn'); s.click(); s.click(); s.click(); });
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  await sleep(300);
  page.off('request', onReq);
  check('연타해도 저장 요청 1번', posts === 1, String(posts));
  check('저장 토스트', !!(await toastSeen(/기록을 저장했어요/)));
  check('저장 후 초안 삭제', (await page.evaluate(() => localStorage.getItem('ddh:draft'))) === null);
  ids.bg = STAMP_ID(page.url());
  check('상세: 별점 4.5', (await text('.dhero-rating .stars-num')) === '4.5');
  check('상세: 감상', (await text('.page-detail .review-text')).startsWith('화성 개척은 역시 재밌다'));
  const gameInfo = await text('.page-detail .dgame');
  check('상세: 게임 정보(이름 · 내 소장 · 인원·예상 시간·장르)', gameInfo.includes('테라포밍 마스') && gameInfo.includes('내 소장') && gameInfo.includes('1~5명 · 90~120분 · 전략'), gameInfo);
  check('상세: 적지 않은 순위·그날의 정보·태그·멤버는 아예 안 보임', !(await page.$('.page-detail .rank-row')) && !(await page.$('.page-detail .info-grid')) && !(await page.$('.page-detail .dtags')) &&
    !(await page.$('.page-detail .mrows')) && !(await page.$('.page-detail .dhero-stamp')), await text('.page-detail'));
  const saved = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.bg);
  check('서버 저장: 게임 연결(gameId) · 제목 · 날짜', saved && saved.gameId === ids.gTera && saved.title === '테라포밍 마스' && saved.date === TODAY, JSON.stringify(saved && { gameId: saved.gameId, title: saved.title, date: saved.date }));
  check('서버 저장: 감상은 하나(후기), 한줄평 비움 · 별점 4.5', saved && saved.review.startsWith('화성 개척은') && saved.oneLiner === '' && saved.rating === 4.5, JSON.stringify(saved));
  check('서버 저장: 적지 않은 것은 비어 있음 (멤버·결과·태그·소장 여부)', saved && saved.members.length === 0 && saved.tags.length === 0 && saved.bg.results.length === 0 &&
    saved.bg.ownership === null && saved.bg.place === '' && saved.bg.playTimeMin === null, JSON.stringify(saved && saved.bg));
  await noOverflow('보드게임 상세');
  await shot('09-detail-boardgame');
});

await step('예전 기록 준비 (API) — 보드게임: 멤버·점수·순위·승자·장소·태그', async () => {
  // 예전 화면(함께한 사람·결과·자세한 정보·태그)으로 남긴 기록을 흉내: 이후 단계의 통계·프로필·소장·백업 검사에 쓰임
  const res = await seedLegacy(ids.bg, {
    members: [ids['연경'], ids['영식'], ids['민지짱']], tags: ['전략'],
    bg: {
      place: '또또하우스 거실', playTimeMin: 150, mode: 'competitive', expansion: '서곡',
      results: [
        { memberId: ids['연경'], score: 85, rank: 2, winner: false },
        { memberId: ids['영식'], score: 92, rank: 1, winner: true },
        { memberId: ids['민지짱'], score: 85, rank: 2, winner: false },
      ],
    },
  });
  check('예전 형태 보드게임 기록 저장', res.status === 200 && res.data.record.bg.results.length === 3 && res.data.record.tags[0] === '전략', JSON.stringify(res.data));
  await page.reload();
  await page.waitForSelector('#tabbar:not([hidden])');
  await go(`#/record/${encodeURIComponent(ids.bg)}`, '.page-detail');
  const rows = await texts('.page-detail .rank-row');
  check('상세: 순위 3줄, 영식 1등', rows.length === 3 && rows[0].startsWith('1') && rows[0].includes('영식'), rows.join(' | '));
  check('상세: 우승자 표시', (await texts('.page-detail .rank-row.is-winner .mrow-name')).join() === '영식');
  check('상세: 우승 도장', (await text('.dhero-stamp')).includes('우승'));
  const info = await text('.page-detail .info-grid');
  check('상세: 장소·시간·확장판 (그날의 정보)', info.includes('또또하우스 거실') && info.includes('2시간 30분') && info.includes('서곡') && !info.includes('경쟁'), info);
  check('상세: 함께한 멤버 3명', (await text('.page-detail .dsec:has(.mrows) .dsec-title')) === '함께한 멤버 3명', await text('.page-detail .dsec:has(.mrows) .dsec-title'));
  check('상세: 태그는 더 이상 보이지 않음 (서버에는 그대로)', !(await page.$('.page-detail .dtags')) && !(await page.$('.page-detail a[href*="tag="]')));
  await noOverflow('보드게임 상세 (예전 기록)');
  await shot('09b-detail-boardgame-legacy');
});

await step('머더미스터리 기록 (팝업 등록 · 작품 태그 · 내 역할 · 스포일러)', async () => {
  await go('#/new/murdermystery', '.page-form.t-murdermystery');
  await page.click('.date-quick .chip:text-is("오늘")');
  // 종류 · 작품 · 날짜 · 별점 · 내 역할 · 감상 — 사진 버튼 하나, 예전 입력 영역은 없음
  const labels = await visibleLabels();
  check('머더미스터리 폼 항목: 종류·작품·날짜·별점·내 역할·감상', JSON.stringify(labels) === JSON.stringify(['종류', '작품', '날짜', '별점', '내 역할', '감상']), JSON.stringify(labels));
  check('사진·함께한 사람 버튼뿐 · 결과·자세한 정보·태그 없음', JSON.stringify(await texts('.page-form .addon .addon-label')) === ADDONS && await noRemovedPanels() &&
    !(await page.$('.page-form .role-card, .page-form .chip-culprit, .page-form .seg-item:has-text("범인 검거"), .page-form [aria-label="범인 검거 결과"]')));
  const roleIn = '.page-form [data-field="mm.myRole"]';
  check('내 역할: 글칸 하나 (예시 · 30자)', (await text('.page-form .rec-role .field-label')) === '내 역할' && (await page.getAttribute(roleIn, 'placeholder')) === '예) 세바스찬' &&
    (await page.getAttribute(roleIn, 'maxlength')) === '30' && (await page.getAttribute(roleIn, 'type')) === 'text');
  check('내 역할 칸이 날짜·별점 아래, 감상 위', await page.evaluate(() => {
    const y = (s) => document.querySelector(s).getBoundingClientRect().top;
    return y('.page-form .rec-date-rate') < y('.page-form .rec-role') && y('.page-form .rec-role') < y('.page-form .rec-review-field');
  }));
  // 날짜·내 역할·감상을 먼저 쓴 뒤 팝업으로 새 작품 등록 → 쓰던 값은 그대로
  await page.fill(roleIn, '마르타');
  await page.fill(REVIEW, '범인이 집사였다니\n\n집사가 범인이었고 끝까지 안 들켰다. 마지막 투표에서 영식이 엉뚱한 사람을 찍음.');
  await setRating(RATING, ['4']);
  await page.fill('.page-form .gp-input', '붉은 저택의 초대');
  await sleep(250);
  check('없는 작품 → 검색 영역 안에 등록 버튼', (await text('.page-form .gp-add')) === '‘붉은 저택의 초대’ 새 작품 등록', await text('.page-form .gp-add'));
  await page.click('.page-form .gp-add');
  await page.waitForSelector(`${dlg}.dlg-game-form`);
  check('등록 창: 지금 종류·검색어를 미리 채움', (await page.$eval(`${dlg} .seg-input:checked`, (e) => e.value)) === 'murdermystery' &&
    (await page.inputValue('[data-field="game-title"]')) === '붉은 저택의 초대' && (await text(`${dlg} .dlg-title`)) === '새 작품 등록');
  check('기록에서 연 등록 창: 내 소장은 기본 선택 안 함', (await page.isChecked(`${dlg} .gf-own-input`)) === false);
  check('이름만 필수 (대표 이미지·소장은 선택)', (await text(`${dlg} .gform`)).includes('대표 이미지 (선택)'));
  // 머더미스터리 작품에는 ‘태그’ (보드게임의 ‘장르’ 자리) — 인원·시간 칸은 없음
  check('작품 등록 창: ‘태그’ 칸 · 추천 칩 · 직접 추가 (장르·인원·시간 칸 없음)', (await text(`${dlg} .gf-genre-box .field-label`)) === '태그' && await page.isVisible(`${dlg} .gf-genre-box`) &&
    (await texts(`${dlg} .gf-genres .chip-label`)).slice(0, 4).join() === '추리중심,RP중심,감성,반전' && !!(await page.$(`${dlg} input[aria-label="태그 직접 추가"]`)) &&
    await page.isHidden(`${dlg} .gf-bg`) && !(await text(`${dlg} .gform`)).includes('장르'), await text(`${dlg} .gform`));
  // 취소해도 쓰던 날짜·내 역할·감상·별점은 그대로
  await dialogButton('취소');
  await page.waitForSelector(dlg, { state: 'detached' });
  check('팝업을 취소해도 내 역할·감상·날짜·별점 유지', (await page.inputValue(REVIEW)).startsWith('범인이 집사였다니') && (await page.inputValue('[data-field="date"]')) === TODAY && (await ratingOf(RATING)) === '4' &&
    (await page.inputValue(roleIn)) === '마르타');
  await page.click('.page-form .gp-add');
  await page.waitForSelector(`${dlg}.dlg-game-form`);
  await page.click(`${dlg} .gf-genres .chip:has-text("반전")`);
  await page.click(`${dlg} .gf-genres .chip:has-text("추리중심")`);
  await page.fill(`${dlg} input[aria-label="태그 직접 추가"]`, '인생작');
  await page.press(`${dlg} input[aria-label="태그 직접 추가"]`, 'Enter');
  check('직접 넣은 태그도 칩으로 · 선택됨', (await page.getAttribute(`${dlg} .gf-genres .chip:has-text("인생작")`, 'aria-pressed')) === 'true');
  await shot('10a-game-dialog-murdermystery');
  await dialogButton('등록');
  await page.waitForSelector(dlg, { state: 'detached', timeout: 5000 });
  check('등록하면 팝업이 닫히고 방금 등록한 작품이 선택됨', (await pickedGame()) === '붉은 저택의 초대');
  check('작품 요약에 태그 (두 개까지 + 외 1)', (await text('.page-form .gp-picked-meta')) === '반전, 추리중심 외 1', await text('.page-form .gp-picked-meta'));
  check('등록 뒤에도 쓰던 내용 유지', (await page.inputValue(REVIEW)).startsWith('범인이 집사였다니') && (await page.inputValue(roleIn)) === '마르타');
  // 스포일러는 감상 바로 옆에 작게 (내 역할도 함께 가림)
  check('스포일러 체크는 감상 옆 · 안내에 감상·역할', !!(await page.$('.page-form .rec-review-field .rec-spoiler .mini-check')) &&
    (await page.getAttribute('.page-form .rec-spoiler .mini-check', 'title')) === '목록과 상세에서 감상·역할을 열기 전까지 가려요');
  await page.click('.page-form .rec-spoiler .mini-check');
  await noOverflow('머더미스터리 폼');
  await shot('10-form-murdermystery');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  ids.mm = STAMP_ID(page.url());

  // 상세: 스포일러라 감상과 내 역할은 가려져 있다가 열면 보임
  const reviewSec = '.page-detail .dsec:has(.dsec-title:text-is("감상"))';
  const myRoleSec = '.page-detail .dsec:has(.dsec-title:text-is("내 역할"))';
  const blurred = await page.$$eval('.page-detail .spoiler .spoiler-content', (els) => els.map((e) => getComputedStyle(e).filter));
  check('상세: 감상·내 역할 모두 가림', blurred.length === 2 && blurred.every((f) => f.includes('blur')), JSON.stringify(blurred));
  check('상세: 내 역할 칸이 감상보다 위', (await (await page.$(myRoleSec)).boundingBox()).y < (await (await page.$(reviewSec)).boundingBox()).y);
  check('상세: 가린 내용은 스크린리더에도 숨김 · 키보드로도 못 감', await page.$eval(`${myRoleSec} .spoiler-content`, (e) => e.getAttribute('aria-hidden') === 'true' && e.inert === true) &&
    await page.$eval(`${reviewSec} .spoiler-content`, (e) => e.getAttribute('aria-hidden') === 'true'));
  check('상세: 내 역할 가림 버튼', (await text(`${myRoleSec} .spoiler-btn`)) === '내 역할 보기', await text(`${myRoleSec} .spoiler-btn`));
  check('상세: 적지 않은 역할과 결과·그날의 정보·세부 평가·태그는 안 보임', !(await page.$('.page-detail .role-row')) && !(await page.$('.page-detail .info-grid')) && !(await page.$('.page-detail .scorebars')) &&
    !(await page.$('.page-detail .dtags')) && !(await page.$('.page-detail .dsec:has(.dsec-title:text-is("역할과 결과"))')) && !(await page.$('.page-detail .dsec:has(.dsec-title:text-is("세부 평가"))')) &&
    !(await page.$('.page-detail .dsec:has(.dsec-title:text-is("그날의 정보"))')), await text('.page-detail'));
  const dgame = await text('.page-detail .dgame');
  check('상세: 작품 정보에 태그', dgame.includes('붉은 저택의 초대') && (await text('.page-detail .dgame-meta')) === '반전, 추리중심, 인생작', dgame);
  await shot('11-detail-murdermystery-hidden');
  await page.click(`${myRoleSec} .spoiler-btn`);
  check('내 역할 열면 보임', !!(await until(async () => (await text(`${myRoleSec} .my-role`)) === '마르타' && (await page.$eval(`${myRoleSec} .spoiler-content`, (e) => getComputedStyle(e).filter === 'none')), 2000)) &&
    (await page.$eval(`${myRoleSec} .spoiler-content`, (e) => e.inert === false)), await text(myRoleSec));
  check('내 역할을 열어도 감상은 계속 가림', !!(await page.$(`${reviewSec} .spoiler:not(.is-revealed) .spoiler-btn`)));
  await page.click(`${reviewSec} .spoiler .spoiler-btn`);
  const after = await until(() => page.$eval(`${reviewSec} .spoiler-content`, (e) => (getComputedStyle(e).filter === 'none' ? 'none' : '')), 2000);
  check('열면 감상 보임', after === 'none', await page.$eval(`${reviewSec} .spoiler-content`, (e) => getComputedStyle(e).filter));
  check('감상 내용', (await text('.page-detail .review-text')).includes('집사가 범인이었고'));
  const saved = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.mm);
  check('서버 저장: 내 역할(mm.myRole) · 스포일러 · 별점 4', saved && saved.mm.myRole === '마르타' && saved.spoiler === true && saved.rating === 4 && saved.type === 'murdermystery', JSON.stringify(saved && saved.mm));
  check('서버 저장: 적지 않은 것은 비어 있음 (멤버·역할·검거 결과·점수·태그)', saved && saved.members.length === 0 && saved.mm.roles.length === 0 && saved.mm.culpritResult === null &&
    Object.values(saved.mm.scores).every((v) => v === 0) && saved.tags.length === 0 && saved.mm.publisher === '' && saved.mm.roleSpoiler === false, JSON.stringify(saved && saved.mm));
  const mmGame = (await api('GET', '/api/data')).data.games.find((g) => g.title === '붉은 저택의 초대');
  check('서버: 팝업으로 등록한 작품 (소장 아님) · 태그(genres) 3개 · 기록과 연결', mmGame && mmGame.type === 'murdermystery' && mmGame.owned === false && saved.gameId === mmGame.id &&
    JSON.stringify(mmGame.genres) === JSON.stringify(['반전', '추리중심', '인생작']), JSON.stringify(mmGame));
  ids.gMm = mmGame && mmGame.id;
  await noOverflow('머더미스터리 상세');
  await shot('12-detail-murdermystery');
});

await step('예전 기록 준비 (API) — 머더미스터리: 멤버·역할·범인·점수·태그', async () => {
  const res = await seedLegacy(ids.mm, {
    members: [ids['연경'], ids['영식'], ids['도윤']], tags: ['반전', '추리중심', '인생시나리오'],
    mm: {
      publisher: '머더랩', format: 'store', store: '강남점', gm: '하람', playerCount: 6, playTimeMin: 240,
      roles: [
        { memberId: ids['연경'], character: '집사 세바스찬', culprit: true, outcome: 'win', mvp: true },
        { memberId: ids['영식'], character: '탐정 조수', culprit: false, outcome: 'lose', mvp: false },
        { memberId: ids['도윤'], character: '정원사', culprit: false, outcome: null, mvp: false },
      ],
      culpritResult: 'escaped', scores: { story: 4.5, deduction: 4, roleplay: 5, balance: 3.5, production: 4 }, difficulty: 3, replay: true,
    },
  });
  check('예전 형태 머더미스터리 기록 저장 (내 역할은 그대로)', res.status === 200 && res.data.record.mm.roles.length === 3 && res.data.record.mm.myRole === '마르타', JSON.stringify(res.data));
  await page.reload();
  await page.waitForSelector('#tabbar:not([hidden])');
  await go(`#/record/${encodeURIComponent(ids.mm)}`, '.page-detail');
  const reviewSec = '.page-detail .dsec:has(.dsec-title:text-is("감상"))';
  const rolesSec = '.page-detail .dsec:has(.dsec-title:text-is("역할과 결과"))';
  const blurred = await page.$$eval('.page-detail .spoiler .spoiler-content', (els) => els.map((e) => getComputedStyle(e).filter));
  check('상세: 감상·내 역할·범인/역할 모두 가림', blurred.length === 3 && blurred.every((f) => f.includes('blur')), JSON.stringify(blurred));
  check('상세: 가린 역할의 멤버 링크는 키보드로도 못 감(inert)', await page.$eval(`${rolesSec} .spoiler-content`, (e) => e.inert === true && e.getAttribute('aria-hidden') === 'true'));
  check('상세: 범인 도주 결과 도장은 그대로 보임', (await text(`${rolesSec} .result-big`)).includes('범인 도주'));
  check('상세: 역할 가림 버튼', (await text(`${rolesSec} .spoiler-btn`)) === '범인·역할 보기', await text(`${rolesSec} .spoiler-btn`));
  await page.click(`${reviewSec} .spoiler .spoiler-btn`);
  check('감상을 열어도 범인/역할은 계속 가림', !!(await page.$(`${rolesSec} .spoiler:not(.is-revealed) .spoiler-btn`)));
  // 백그라운드 새로고침(다시 온라인 등)으로 화면을 다시 그려도 연 스포일러는 그대로
  const reqs = [];
  const onReq = (r) => { if (r.url().endsWith('/api/data')) reqs.push(r); };
  page.on('request', onReq);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => reqs.length > 0, 3000);
  await sleep(400);
  page.off('request', onReq);
  check('새로고침 후에도 연 감상 유지', reqs.length > 0 && !!(await page.$(`${reviewSec} .spoiler.is-revealed`)) && !(await page.$(`${reviewSec} .spoiler-btn`)));
  await page.click(`${rolesSec} .spoiler-btn`);
  check('범인·역할 펼침', !!(await until(() => page.$(`${rolesSec} .spoiler.is-revealed`), 2000)) &&
    (await page.$eval(`${rolesSec} .spoiler-content`, (e) => e.inert === false)));
  const roles = await texts('.page-detail .role-row');
  check('역할 3개', roles.length === 3, roles.join(' | '));
  const yk = roles.find((r) => r.includes('연경')) || '';
  check('연경: 캐릭터·범인·승·MVP', yk.includes('집사 세바스찬') && yk.includes('범인') && yk.includes('승') && yk.includes('MVP'), yk);
  check('범인 도주 도장', (await text('.dhero-stamp')).includes('범인 도주'));
  const info = await text('.page-detail .info-grid');
  check('제작사·형태·매장·GM·인원·시간', ['머더랩', '매장형', '강남점', '하람', '6인', '4시간'].every((s) => info.includes(s)), info);
  const bars = await texts('.page-detail .scorebars .sb-row');
  check('세부 점수 5개', bars.length === 5 && bars[0].includes('4.5') && bars[3].includes('3.5'), bars.join(' | '));
  check('추천 표시', (await text('.page-detail .replay')).includes('다시 하고 싶어요'));
  check('태그는 보이지 않음', !(await page.$('.page-detail .dtags')));
  await noOverflow('머더미스터리 상세 (예전 기록)');
  await shot('12b-detail-murdermystery-legacy');
});

await step('방탈출 기록 (새 간단 폼: 테마 등록 · 별점 · 감상)', async () => {
  await go('#/new/escaperoom', '.page-form.t-escaperoom');
  await page.click('.date-quick .chip:text-is("오늘")');
  // 새 테마를 매장·지점과 함께 등록 (방탈출에는 소장 여부·장르·태그 없음)
  await setGame('잊혀진 연구소', {
    extra: async () => {
      check('방탈출 등록 창: 소장 여부 없음 · 매장·지점', await page.isHidden(`${dlg} .gf-own`) && await page.isVisible(`${dlg} input[aria-label="매장(브랜드)"]`));
      check('방탈출 등록 창: 장르·태그 칸 없음', await page.isHidden(`${dlg} .gf-genre-box`) && await page.isHidden(`${dlg} .gf-bg`) &&
        !(await page.$$eval(`${dlg} .field-label`, (els) => els.some((e) => e.getClientRects().length > 0 && /장르|태그/.test(e.textContent)))));
      await page.fill(`${dlg} input[aria-label="매장(브랜드)"]`, '키이스케이프');
      await page.fill(`${dlg} input[aria-label="지점"]`, '홍대점');
      await shot('13a-game-dialog-escaperoom');
    },
  });
  check('테마 요약에 매장·지점', (await text('.page-form .gp-picked-meta')) === '키이스케이프 홍대점', await text('.page-form .gp-picked-meta'));
  const labels = await visibleLabels();
  check('방탈출 폼 항목: 종류·테마·날짜·별점·감상 (내 역할 칸 없음)', JSON.stringify(labels) === JSON.stringify(['종류', '테마', '날짜', '별점', '감상']) && await page.isHidden('.page-form [data-field="mm.myRole"]'), JSON.stringify(labels));
  check('사진·함께한 사람 버튼뿐 · 성공 여부·남은 시간·힌트·세부 평가·누적 번호 입력 없음', JSON.stringify(await texts('.page-form .addon .addon-label')) === ADDONS && await noRemovedPanels() &&
    !(await page.$('.page-form .stamp-choice-clear, .page-form .stepper-input, .page-form .ordinal-note, .page-form .score-row')));
  await setRating(RATING, ['5']);
  await page.fill(REVIEW, '장치가 끝내준다');
  await noOverflow('방탈출 폼');
  await shot('13-form-escaperoom');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  ids.er = STAMP_ID(page.url());
  check('상세: 별점 5.0 · 감상', (await text('.dhero-rating .stars-num')) === '5.0' && (await text('.page-detail .review-text')) === '장치가 끝내준다');
  check('상세: 적지 않은 탈출 결과·세부 평가는 안 보임 · 그날의 정보엔 테마의 매장·지점만', !(await page.$('.page-detail .result-er')) && !(await page.$('.page-detail .er-nums')) && !(await page.$('.page-detail .gauge-item')) &&
    !(await page.$('.page-detail .scorebars')) && !(await page.$('.page-detail .dtags')) &&
    (await text('.page-detail .info-grid')).includes('키이스케이프') && (await text('.page-detail .info-grid')).includes('홍대점') && (await page.$$('.page-detail .info-item')).length === 2, await text('.page-detail'));
  check('2번째 방탈출', (await text('.dhero-top .ordinal')) === '2번째 방탈출', await text('.dhero-top .ordinal'));
  const saved = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.er);
  check('서버 저장: 결과·힌트·시간은 비어 있음(null) · 별점 5', saved && saved.er.cleared === null && saved.er.hints === null && saved.er.remainingSec === null && saved.er.timeLimitMin === null &&
    saved.er.brand === '키이스케이프' && saved.er.branch === '홍대점' && // 고른 테마의 매장·지점은 기록에도 남음 (통계 '브랜드별')
    saved.rating === 5 && saved.members.length === 0 && saved.tags.length === 0, JSON.stringify(saved && saved.er));
  const g = (await api('GET', '/api/data')).data.games.find((x) => x.title === '잊혀진 연구소');
  check('서버: 테마 정보(소장 없음 · 매장·지점 · 장르 없음)', g && g.type === 'escaperoom' && g.owned === false && g.brand === '키이스케이프' && g.branch === '홍대점' && !('genres' in g) && saved.gameId === g.id, JSON.stringify(g));
  ids.gEr = g && g.id;
  await noOverflow('방탈출 상세');
  await shot('14-detail-escaperoom');

  // 같은 테마를 다시 기록 (게임과 날짜만으로 저장) → 테마의 기록 2개
  await go('#/new/escaperoom', '.page-form.t-escaperoom');
  await setGame('잊혀진 연구소');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const bare = STAMP_ID(page.url());
  check('상세: 게임과 날짜만 있어도 저장 · 결과·힌트 칸 없음', !(await page.$('.page-detail .result-er')) && !(await page.$('.page-detail .er-nums')));
  check('같은 테마를 다시 기록 → 기록 2개', (await text('.page-detail .dgame')).includes('기록 2개'), await text('.page-detail .dgame'));
  const bareRec = (await api('GET', '/api/data')).data.records.find((r) => r.id === bare);
  await go('#/records', '.page-list');
  check('게임·날짜만으로 저장 · 결과·힌트·시간·별점·감상은 비어 있음', bareRec && bareRec.er.cleared === null && bareRec.er.hints === null && bareRec.er.remainingSec === null &&
    bareRec.rating === 0 && bareRec.review === '' && bareRec.gameId === ids.gEr, JSON.stringify(bareRec && bareRec.er));

  await api('DELETE', `/api/records?id=${encodeURIComponent(bare)}`);
  await syncFromServer();
});

await step('예전 기록 준비 (API) — 방탈출: 멤버·성공·남은 시간·힌트·세부 평가', async () => {
  const res = await seedLegacy(ids.er, {
    members: [ids['연경'], ids['영식'], ids['민지짱']],
    er: {
      brand: '키이스케이프', branch: '홍대점', genre: 'SF', playerCount: 3, timeLimitMin: 75, cleared: true, remainingSec: 754, hints: 2,
      scores: { story: 4, interior: 5, puzzle: 4.5, device: 3 }, difficulty: 3.5, fear: 1, activity: 2, replay: true,
    },
  });
  check('예전 형태 방탈출 기록 저장', res.status === 200 && res.data.record.er.remainingSec === 754 && res.data.record.er.hints === 2, JSON.stringify(res.data));
  await page.reload();
  await page.waitForSelector('#tabbar:not([hidden])');
  await go(`#/record/${encodeURIComponent(ids.er)}`, '.page-detail');
  const nums = await texts('.page-detail .er-num');
  check('남은 시간 12:34 · 힌트 2', nums.some((n) => n.includes('12:34')) && nums.some((n) => n.startsWith('2')), nums.join(' | '));
  check('탈출 성공 도장', (await text('.dhero-stamp')).includes('탈출 성공'));
  check('2번째 방탈출', (await text('.dhero-top .ordinal')) === '2번째 방탈출', await text('.dhero-top .ordinal'));
  const gauges = await texts('.page-detail .gauge-item');
  check('난이도·공포도·활동성 게이지', gauges.length === 3 && gauges[0].includes('3.5'), gauges.join(' | '));
  check('세부 점수 4개 · 추천', (await texts('.page-detail .scorebars .sb-row')).length === 4 && (await text('.page-detail .replay')).includes('추천해요'));
  const info = await text('.page-detail .info-grid');
  check('브랜드·지점·장르·인원·제한 시간', ['키이스케이프', '홍대점', 'SF', '3인', '75분'].every((s) => info.includes(s)), info);
  await noOverflow('방탈출 상세 (예전 기록)');
  await shot('14b-detail-escaperoom-legacy');
});

await step('초안 이어 쓰기 (같은 id 로 저장)', async () => {
  await page.click('#tabbar .tab-add');
  await page.waitForSelector('.page-form');
  check('＋ → 마지막으로 기록한 종류(방탈출)', page.url().endsWith('#/new/escaperoom') &&
    (await page.$eval('.page-form .rec-type .seg-input:checked', (e) => e.value)) === 'escaperoom', page.url());
  await page.fill(REVIEW, '종류를 바꿔도 남는 감상');
  await page.click('.page-form .rec-type .seg-item:has-text("보드게임")');
  check('폼 안에서 종류 바꾸기 → 주소·라벨도 보드게임, 감상은 그대로', page.url().endsWith('#/new/boardgame') && !!(await page.$('.page-form.t-boardgame')) &&
    (await text('.page-form .rec-game > .field-label')) === '게임' && (await page.inputValue(REVIEW)) === '종류를 바꿔도 남는 감상', page.url());
  await setGame('삭제할 게임');
  const draft = await until(() => page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('ddh:draft') || 'null');
    return d && d.model && d.model.title === '삭제할 게임' && d.model.gameId ? d : null;
  }), 3000);
  check('입력 중 초안 저장 (고른 게임 포함)', !!draft);
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await page.waitForSelector('.page-home, .page-detail, .page-list', { timeout: 5000 });
  await page.click('#tabbar .tab-add');
  await page.waitForSelector('.page-form .draft-banner:not([hidden])');
  check('새 기록 폼에 초안 안내 (종류 · 게임)', (await text('.page-form .draft-banner')).includes('보드게임 · 삭제할 게임') && page.url().endsWith('#/new/boardgame'), await text('.page-form .draft-banner'));
  await page.click('.page-form .draft-banner button:has-text("불러오기")');
  check('게임·감상 복원', (await pickedGame()) === '삭제할 게임' && (await page.inputValue(REVIEW)) === '종류를 바꿔도 남는 감상');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  ids.junk = decodeURIComponent(page.url().split('#/record/')[1] || '');
  check('초안에서 만든 id 그대로 저장', draft && ids.junk === draft.recordId, `${ids.junk} vs ${draft && draft.recordId}`);
});

await step('목록 · 배지 · 필터 · 검색', async () => {
  // 상세에서 펼친 스포일러 기억(이번 실행 동안만)을 비우고 시작
  await page.reload();
  await page.waitForSelector('#tabbar:not([hidden])');
  await tab('records', '.page-list');
  // 이전 필터 상태 초기화
  await page.click('.page-list .seg-type .seg-item:has-text("전체")');
  const titles = await until(async () => { const t = await cardTitles(); return t.length === 5 && t; });
  check('기록 5개', titles && titles.length === 5, String(titles));
  const cardOf = (t) => `.page-list .rcard:has(.card-link:text-is("${t}"))`;
  check('보드게임 배지', (await text(`${cardOf('테라포밍 마스')} .badge`)) === '보드게임');
  check('머더미스터리 배지', (await text(`${cardOf('붉은 저택의 초대')} .badge`)) === '머더미스터리');
  check('방탈출 배지', (await text(`${cardOf('잊혀진 연구소')} .badge`)) === '방탈출');
  // 티켓 카드: 장르 태그 → 제목(최대 두 줄) → 날짜 · 점선 아래 ★ 평점 · 한줄평
  // 우승자·참여자·배역·범인·스포일러·남은 시간·누적 번호는 상세 화면에서
  const bgCard = cardOf('테라포밍 마스');
  check('카드 날짜: 2026.10.01 꼴 회색 글씨', /^\d{4}\.\d{2}\.\d{2}$/.test(await text(`${bgCard} .rcard-date`)), await text(`${bgCard} .rcard-date`));
  check('카드 평점: ★ 4.5 (별 다섯 개 대신)', (await text(`${bgCard} .rcard-rating`)) === '4.5' &&
    (await page.getAttribute(`${bgCard} .rcard-rating`, 'aria-label')) === '별점 4.5점' && !(await page.$('.page-list .rcard .stars')));
  check('카드 감상: 첫 부분을 두 줄까지', (await text(`${bgCard} .rcard-one`)).startsWith('화성 개척은 역시 재밌다') &&
    await page.$eval(`${bgCard} .rcard-one`, (e) => getComputedStyle(e).webkitLineClamp === '2'), await text(`${bgCard} .rcard-one`));
  const bgText = await text(bgCard);
  check('보드게임 카드: 우승 도장·승자·참여자는 상세로', !bgText.includes('우승') && !(await page.$(`${bgCard} .av`)) && !(await page.$(`${bgCard} .stamp`)), bgText);
  check('카드 대표 사진 칸 72px 정사각형', await page.$eval(`${bgCard} .rcard-thumb`, (e) => { const b = e.getBoundingClientRect(); return Math.round(b.width) === 72 && Math.round(b.height) === 72; }));
  check('카드 제목은 최대 두 줄', await page.$eval(`${bgCard} .rcard-title`, (e) => getComputedStyle(e).webkitLineClamp === '2'));
  // 스포일러 머더미스터리 기록: 감상은 열기 전까지 가림, 범인·역할은 카드에 없음
  const mmCard = cardOf('붉은 저택의 초대');
  const mmText = await text(mmCard);
  check('스포일러 머더미스터리 카드: 내 역할·범인·역할 없음 · 감상은 가림', !mmText.includes('마르타') && !mmText.includes('세바스찬') && !(await page.$(`${mmCard} .rcard-role`)) &&
    !!(await page.$(`${mmCard} .spoiler:not(.is-revealed) .spoiler-btn`)) && await page.$eval(`${mmCard} .spoiler-content`, (e) => e.getAttribute('aria-hidden') === 'true' && getComputedStyle(e).filter.includes('blur')), mmText);
  await page.click(`${mmCard} .spoiler-btn`);
  check('카드에서 열면 감상만 보이고 상세로 넘어가지 않음', !!(await until(() => page.$(`${mmCard} .spoiler.is-revealed`), 2000)) && !!(await page.$('.page-list')) &&
    (await text(`${mmCard} .rcard-one`)).startsWith('범인이 집사였다니'));
  check('스포일러 머더미스터리 카드: 평점은 보임', (await text(`${mmCard} .rcard-rating`)) === '4.0', await text(`${mmCard} .rcard-rating`));
  check('방탈출 카드: 작은 성공 배지', (await text(`${cardOf('잊혀진 연구소')} .rbadge`)) === '탈출 성공');
  check('실패 방탈출: 작은 실패 배지', (await text(`${cardOf('저주받은 인형의 집')} .rbadge`)) === '탈출 실패');
  check('보드게임·머더미스터리 카드엔 결과 배지 없음', !(await page.$(`${bgCard} .rbadge-clear, ${bgCard} .rbadge-fail`)) && !(await page.$(`${mmCard} .rbadge`)));
  check('보드게임 카드: 작은 내 소장 배지 (매장형 머더미스터리는 없음)', (await text(`${bgCard} .rbadge`)) === '내 소장');
  check('카드에 기울인 도장 없음', !(await page.$('.page-list .rcard .stamp')));
  const erText = await text(cardOf('잊혀진 연구소'));
  check('방탈출 카드: 남은 시간·힌트·브랜드·누적 번호는 상세로', !erText.includes('남김') && !erText.includes('힌트') && !erText.includes('키이스케이프') && !erText.includes('번째'), erText);
  // 카드 아무 곳(사진·점선 아래)을 눌러도 기록이 열림 — 카드 링크가 받음
  const hitStub = await page.$eval(`${bgCard} .rcard-stub`, (el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit ? `${hit.tagName}.${hit.className}` : 'none';
  });
  check('점선 아래를 눌러도 카드 링크로', /^A\.card-link/.test(hitStub), hitStub);
  await page.evaluate(() => scrollTo(0, 0));
  const groups = await texts('.page-list .mgroup-head .mg-month');
  check('월별 그룹 2개', groups.length === 2, groups.join(','));
  await noOverflow('기록 목록');
  await shot('15-list');

  // 종류 세그먼트
  await page.click('.page-list .seg-type .seg-item:has-text("머더미스터리")');
  let t = await until(async () => { const x = await cardTitles(); return x.length === 1 && x; });
  check('머더미스터리 필터 → 1개', t && t[0] === '붉은 저택의 초대', String(t));
  await page.click('.page-list .seg-type .seg-item:has-text("방탈출")');
  t = await until(async () => { const x = await cardTitles(); return x.length === 2 && x; });
  check('방탈출 필터 → 2개', !!t, String(t));
  await page.click('.page-list .seg-type .seg-item:has-text("전체")');
  // 검색 (제목 · 매장 · 내 역할 · 후기) — 태그는 더 이상 검색·필터 대상이 아님
  const search = async (q, expect) => {
    await page.fill('.page-list .search-input', q);
    const got = await until(async () => { const x = await cardTitles(); return JSON.stringify(x.sort()) === JSON.stringify([...expect].sort()) && x; }, 3000);
    check(`검색 "${q}" → ${expect.length}개`, !!got, String(await cardTitles()));
  };
  await search('연구소', ['잊혀진 연구소']);
  await search('강남점', ['붉은 저택의 초대', '저주받은 인형의 집']);
  check('검색창 안내: 제목, 매장, 역할, 감상', (await page.getAttribute('.page-list .search-input', 'placeholder')) === '제목, 매장, 역할, 감상 검색');
  await search('#반전', []); // 예전 기록에 태그가 남아 있어도 검색에는 안 잡힘
  await search('마르타', ['붉은 저택의 초대']); // 내 역할(mm.myRole)
  await search('집사 세바스찬', ['붉은 저택의 초대']); // 예전 기록의 배역 이름
  await search('역전했다', ['테라포밍 마스']);
  await search('없는검색어', []);
  check('결과 없음 안내', !!(await page.$('.page-list .empty')));
  await search('', ['테라포밍 마스', '붉은 저택의 초대', '잊혀진 연구소', '저주받은 인형의 집', '삭제할 게임']);
  // 멤버 필터 (태그 묶음은 없음)
  await page.click('.page-list .list-tools button:has-text("필터")');
  const groups2 = await texts('.page-list .filter-panel .fp-label');
  check('필터 영역: 멤버·소장 묶음만 (태그 묶음·태그 칩 없음)', groups2.length >= 2 && groups2.every((g) => !g.includes('태그')) && !(await page.$('.page-list .filter-panel .chip-tag')), groups2.join(' | '));
  await page.click('.page-list .filter-panel .chip-member:has(.chip-label:text-is("민지짱"))');
  t = await until(async () => { const x = await cardTitles(); return x.length === 2 && x; });
  check('멤버 필터(민지짱) → 2개', !!t, String(await cardTitles()));
  await page.click('.page-list .filter-panel .chip-own:has-text("내 소장")');
  t = await until(async () => { const x = await cardTitles(); return x.length === 1 && x; });
  check('멤버+소장 필터 → 1개', t && t[0] === '테라포밍 마스', String(await cardTitles()));
  await noOverflow('필터 열린 목록');
  await shot('16-list-filtered');
  check('적용 중인 필터는 칩 · 필터 버튼에 개수', (await texts('.page-list .achips .achip')).length === 2 && (await text('.page-list .filter-btn .fbadge')) === '2');
  await page.click('.page-list .list-tools button:has-text("필터")');
  check('필터 영역을 접어도 칩은 남음', await page.isHidden('.page-list .filter-panel') && (await texts('.page-list .achips .achip')).length === 2);
  await page.click('.page-list .achips button:has-text("모두 해제")');
  t = await until(async () => { const x = await cardTitles(); return x.length === 5 && x; });
  check('모두 해제 → 5개', !!t);
  // 정렬: 별점순
  await page.selectOption('.page-list select[aria-label="정렬"]', 'rating');
  t = await until(async () => { const x = await cardTitles(); return x[0] === '잊혀진 연구소' && x; });
  check('별점순 정렬', !!t, String(await cardTitles()));
  await page.selectOption('.page-list select[aria-label="정렬"]', 'new');
  // 홈 바로가기 → 종류 필터
  await go('#/records?type=boardgame', '.page-list');
  t = await until(async () => { const x = await cardTitles(); return x.length === 2 && x; });
  check('?type=boardgame 링크 → 보드게임 2개', !!t, String(await cardTitles()));
  await page.click('.page-list .seg-type .seg-item:has-text("전체")');
});

await step('내 역할 (머더미스터리): 종류에 따라 칸 보임/숨김 · 목록 카드 · 상세 · 검색 · 스포일러 가리기', async () => {
  const role = '.page-form [data-field="mm.myRole"]';
  const typeBtn = (label) => `.page-form .rec-type .seg-item:has-text("${label}")`;
  // 새 기록: 종류를 바꾸면 내 역할 칸이 나타나고 사라짐 (쓴 값은 남음)
  await go('#/new/boardgame', '.page-form.t-boardgame');
  check('보드게임 새 기록: 내 역할 칸 없음', await page.isHidden(role));
  await page.click(typeBtn('머더미스터리'));
  await page.waitForSelector('.page-form.t-murdermystery');
  check('머더미스터리로 바꾸면 내 역할 칸이 나타남', await page.isVisible(role) && JSON.stringify(await visibleLabels()) === JSON.stringify(['종류', '작품', '날짜', '별점', '내 역할', '감상']), JSON.stringify(await visibleLabels()));
  await page.fill(role, '해리엇 부인');
  await page.click(typeBtn('방탈출'));
  check('방탈출로 바꾸면 숨김', await page.isHidden(role) && JSON.stringify(await visibleLabels()) === JSON.stringify(['종류', '테마', '날짜', '별점', '감상']), JSON.stringify(await visibleLabels()));
  await page.click(typeBtn('보드게임'));
  check('보드게임으로 바꿔도 숨김', await page.isHidden(role));
  await page.click(typeBtn('머더미스터리'));
  check('다시 머더미스터리로 오면 쓰던 내 역할 그대로', (await page.isVisible(role)) && (await page.inputValue(role)) === '해리엇 부인');
  await setGame('붉은 저택의 초대');
  await setRating(RATING, ['3']);
  await page.fill(REVIEW, '내 역할 시험용 감상');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const roleId = STAMP_ID(page.url());
  const mySec = '.page-detail .dsec:has(.dsec-title:text-is("내 역할"))';
  check('상세: 스포일러가 아니면 내 역할을 가리지 않고 보여 줌', (await text(`${mySec} .my-role`)) === '해리엇 부인' && !(await page.$(`${mySec} .spoiler`)) && !(await page.$('.page-detail .spoiler')), await text(mySec));
  const saved = await serverRecord(roleId);
  check('서버 저장: mm.myRole · 스포일러 아님', saved && saved.mm.myRole === '해리엇 부인' && saved.spoiler === false && saved.mm.roleSpoiler === false && saved.gameId === ids.gMm, JSON.stringify(saved && { spoiler: saved.spoiler, gameId: saved.gameId, gMm: ids.gMm, myRole: saved.mm.myRole }));
  await noOverflow('내 역할 상세');
  await shot('12c-detail-myrole');

  // 목록: 스포일러가 아닌 카드에는 ‘내 역할 · …’ 한 줄, 스포일러 카드·다른 종류에는 없음
  await go('#/records', '.page-list');
  const cardOf = (id) => `.page-list .rcard:has(.card-link[href="#/record/${encodeURIComponent(id)}"])`;
  await page.waitForSelector(cardOf(roleId));
  check('목록 카드: ‘내 역할 · 해리엇 부인’ 한 줄', (await text(`${cardOf(roleId)} .rcard-role`)) === '내 역할 · 해리엇 부인' && (await page.$$(`${cardOf(roleId)} .rcard-role`)).length === 1, await text(cardOf(roleId)));
  check('스포일러 기록 카드에는 내 역할 없음 · 다른 종류 카드에도 없음', !(await page.$(`${cardOf(ids.mm)} .rcard-role`)) && (await page.$$('.page-list .rcard-role')).length === 1);
  await noOverflow('내 역할 목록');
  await shot('15b-list-myrole');
  // 검색: 내 역할(mm.myRole)도 찾고, 예전 기록의 배역 이름·스포일러 기록도 찾음
  const hrefs = () => page.$$eval('.page-list .rcard .card-link', (els) => els.map((e) => e.getAttribute('href')).sort());
  const href = (id) => `#/record/${encodeURIComponent(id)}`;
  const searchHrefs = async (q, expect) => {
    await page.fill('.page-list .search-input', q);
    const got = await until(async () => { const x = await hrefs(); return JSON.stringify(x) === JSON.stringify(expect.map(href).sort()) && x; }, 3000);
    check(`검색 "${q}" → ${expect.length}개`, !!got, JSON.stringify(await hrefs()));
  };
  await searchHrefs('해리엇', [roleId]);
  await searchHrefs('마르타', [ids.mm]);
  await searchHrefs('집사 세바스찬', [ids.mm]);
  await page.fill('.page-list .search-input', '');

  // 수정 폼에 저장된 내 역할이 채워져 있고, 스포일러를 켜면 상세·카드에서 가림
  await go(`#/edit/${encodeURIComponent(roleId)}`, '.page-form');
  check('수정 폼: 내 역할 채워짐 · 보이는 항목', (await page.inputValue(role)) === '해리엇 부인' && JSON.stringify(await visibleLabels()) === JSON.stringify(['종류', '작품', '날짜', '별점', '내 역할', '감상']));
  await page.click('.page-form .rec-spoiler .mini-check');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  check('스포일러로 바꾸면 상세의 내 역할이 가려짐', (await text(`${mySec} .spoiler-btn`)) === '내 역할 보기' && await page.$eval(`${mySec} .spoiler-content`, (e) => e.getAttribute('aria-hidden') === 'true'));
  await go('#/records', '.page-list');
  check('스포일러 카드에는 내 역할 없음', !!(await page.waitForSelector(cardOf(roleId))) && !(await page.$(`${cardOf(roleId)} .rcard-role`)) && (await page.$$('.page-list .rcard-role')).length === 0);
  // ‘역할 가리기’(mm.roleSpoiler)만 켠 예전 기록: 감상은 보이고 내 역할만 가림
  check('(준비) 스포일러 끄고 역할만 가리기', (await seedLegacy(roleId, { spoiler: false, mm: { roleSpoiler: true } })).status === 200);
  await syncFromServer();
  check('역할 가리기만 켠 카드에도 내 역할 없음', !(await page.$(`${cardOf(roleId)} .rcard-role`)));
  await go(`#/record/${encodeURIComponent(roleId)}`, '.page-detail');
  check('상세: 감상은 보이고 내 역할만 가림', !!(await page.$(`${mySec} .spoiler:not(.is-revealed)`)) && (await page.$$('.page-detail .spoiler')).length === 1 && (await text('.page-detail .review-text')) === '내 역할 시험용 감상');
  await page.click(`${mySec} .spoiler-btn`);
  check('눌러서 열면 내 역할이 보임', !!(await until(async () => (await text(`${mySec} .my-role`)) === '해리엇 부인' && (await page.$eval(`${mySec} .spoiler-content`, (e) => getComputedStyle(e).filter === 'none')), 2000)));
  await api('DELETE', `/api/records?id=${encodeURIComponent(roleId)}`);
  await syncFromServer();
  check('(정리) 시험 기록 삭제', (await serverRecord(roleId)) === null);
});

// ═════════════════════════════════════════════════════════════
// 나 (이 기기의 멤버): 기기마다 localStorage['ddh:me'] 에 멤버 id 를 저장. 아래 단계들은 시험용 멤버·기록을 만들었다가 마지막에 모두 지움
const ME_KEY = 'ddh:me';
const getMeLS = () => page.evaluate((k) => localStorage.getItem(k), ME_KEY);
const setMeLS = (id) => page.evaluate(([k, v]) => { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); }, [ME_KEY, id]);
const meT = { recs: [], members: [], base: null };
const mkRole = (memberId, character) => ({ memberId, character, culprit: false, outcome: null, mvp: false });
/** 추가 입력 버튼의 요약 (펼쳐 놓은 동안에는 영역 머리의 요약) */
const addonSum = async (key) => text((await page.$(`${panelSel(key)}:not([hidden])`)) ? `${panelSel(key)} .rp-sum` : `.page-form .addon[data-panel="${key}"] .addon-sum`);
const pressedMembers = () => page.$$eval(`${panelSel('members')} .chip-member[aria-pressed="true"]`, (els) => els.map((e) => e.dataset.memberId).sort());
const chipPressed = (id) => page.getAttribute(`${panelSel('members')} .chip-member[data-member-id="${id}"]`, 'aria-pressed');
/** 폼의 ‘나 줄’ 버튼으로 나 고르기 창을 열고 멤버를 고름 */
async function pickMeIn(id) {
  await page.click('.page-form .me-row-btn');
  await page.waitForSelector(`${dlg}.dlg-me`);
  await page.click(`${dlg}.dlg-me .me-pick-row[data-member-id="${id}"]`);
  await page.waitForSelector(`${dlg}.dlg-me`, { state: 'detached', timeout: 5000 });
}
/** 새 기록·수정 폼에서 나가기 (쓴 게 있으면 ‘그만 쓰기’) */
async function leaveForm() {
  await page.click('.page-form .savebar button:has-text("취소")');
  if (await until(() => page.$(dlg), 800)) await dialogButton('그만 쓰기');
  await page.waitForSelector('.page-form', { state: 'detached', timeout: 5000 });
}
async function saveForm() {
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const id = STAMP_ID(page.url());
  meT.recs.push(id);
  return id;
}
async function seedMm(title, { date = PAST, members, myRole = '', roles = [], spoiler = false, roleSpoiler = false, rating = 3.5 }) {
  const res = await api('POST', '/api/records', { record: { type: 'murdermystery', date, title, members, rating, oneLiner: '', spoiler, mm: { myRole, roles, roleSpoiler } } });
  if (res.status !== 200) throw new Error(`시험 기록 만들기 실패 ${title}: ${JSON.stringify(res.data)}`);
  meT.recs.push(res.data.record.id);
  return res.data.record.id;
}
async function addMember(name) {
  const res = await api('POST', '/api/members', { member: { name } });
  if (res.status !== 200) throw new Error(`시험 멤버 만들기 실패 ${name}: ${JSON.stringify(res.data)}`);
  meT.members.push(res.data.member.id);
  return res.data.member.id;
}
async function reloadApp() {
  await page.reload();
  await page.waitForSelector('#tabbar:not([hidden])');
}

await step('나: 멤버 프로필에서 정하고 풀기 · 목록 배지 · 지운 멤버는 나가 아님', async () => {
  const d = (await api('GET', '/api/data')).data;
  meT.base = { records: d.records.length, members: d.members.length, games: d.games.length };
  await setMeLS(null);
  const yk = ids['연경'];
  await go(`#/member/${encodeURIComponent(yk)}`, '.page-profile');
  check('프로필: ‘이 기기에서 나로 설정’ · 아직 누르지 않음 · 나 배지 없음', (await text('.phero-me')) === '이 기기에서 나로 설정' && (await page.getAttribute('.phero-me', 'aria-pressed')) === 'false' &&
    !(await page.$('.page-profile .me-badge')), await text('.phero'));
  await page.click('.phero-me');
  const on = await until(async () => (await page.getAttribute('.phero-me', 'aria-pressed')) === 'true' && (await text('.phero-me')) === '이 기기의 나예요 (해제)', 2500);
  check('누르면 aria-pressed=true · ‘이 기기의 나예요 (해제)’', !!on, `${await text('.phero-me')} / ${await page.getAttribute('.phero-me', 'aria-pressed')}`);
  check('히어로 이름 옆에 ‘나’ 배지', (await text('.phero .phero-name .me-badge')) === '나' && (await text('.phero .phero-name > span:first-child')) === '연경', await text('.phero-name'));
  check('localStorage 에 멤버 id 저장', (await getMeLS()) === yk, String(await getMeLS()));
  await tab('members', '.page-members');
  const badgeRows = await page.$$eval('.page-members .mlist-row', (els) => els.filter((e) => e.querySelector('.me-badge')).map((e) => e.querySelector('.mlist-name > span').textContent.trim()));
  check('멤버 목록: 연경 한 줄에만 ‘나’ 배지', JSON.stringify(badgeRows) === JSON.stringify(['연경']), JSON.stringify(badgeRows));
  check('배지 글자는 ‘나’', (await text('.page-members .mlist-row .me-badge')) === '나');
  await noOverflow('멤버 목록 (나 배지)');
  // 다시 눌러 풀기
  await page.click(`.page-members .mlist-row:has(.mlist-name > span:text-is("연경"))`);
  await page.waitForSelector('.page-profile .phero-me');
  check('프로필을 다시 열어도 ‘나’ 상태', (await page.getAttribute('.phero-me', 'aria-pressed')) === 'true' && !!(await page.$('.phero .me-badge')));
  await page.click('.phero-me');
  const off = await until(async () => (await page.getAttribute('.phero-me', 'aria-pressed')) === 'false' && (await text('.phero-me')) === '이 기기에서 나로 설정' && !(await page.$('.phero .me-badge')), 2500);
  check('다시 누르면 해제 (aria-pressed=false · 배지 사라짐)', !!off, `${await text('.phero-me')} / ${await page.getAttribute('.phero-me', 'aria-pressed')}`);
  check('해제하면 localStorage 에서 지워짐', (await getMeLS()) === null, String(await getMeLS()));
  await tab('members', '.page-members');
  check('멤버 목록에 ‘나’ 배지 없음', !(await page.$('.page-members .me-badge')));

  // 나로 정한 멤버를 지우면 나가 아닌 것으로 (시험용 멤버)
  const gone = await addMember('임시삭제');
  await reloadApp();
  await go(`#/member/${encodeURIComponent(gone)}`, '.page-profile');
  await page.click('.phero-me');
  check('(준비) 시험용 멤버를 나로 정함', !!(await until(async () => (await getMeLS()) === gone && (await page.$('.phero .me-badge')), 2500)));
  await page.click('.page-profile .appbar button[aria-label="삭제"]');
  await page.waitForSelector(dlg);
  await dialogButton('삭제');
  await page.waitForSelector('.page-members', { timeout: 8000 });
  meT.members = meT.members.filter((x) => x !== gone);
  check('지운 멤버는 목록에 없고 ‘나’ 배지도 없음', !(await page.$('.page-members .me-badge')) && !(await texts('.page-members .mlist-name')).some((t) => t.includes('임시삭제')));
  await go('#/new/murdermystery', '.page-form.t-murdermystery');
  check('새 기록 폼: 지운 멤버는 나로 보지 않음 (아직 안 골랐어요) · 참여자도 비어 있음', (await text('.page-form .me-row')).includes('내가 누구인지 아직 안 골랐어요') && (await addonSum('members')) === '', await text('.page-form .me-row'));
  await page.click('.page-form .savebar button:has-text("취소")');
  await page.waitForSelector('.page-form', { state: 'detached', timeout: 5000 });
  await setMeLS(null);
});

await step('나 고르기 (기록 폼): 고르기 · 바꾸기 · 나 해제 · 새 멤버로 등록', async () => {
  await setMeLS(null);
  const yk = ids['연경'];
  const ys = ids['영식'];
  await go('#/new/murdermystery', '.page-form.t-murdermystery');
  check('나가 없으면 안내 문구 + ‘나 고르기’', (await text('.page-form .me-row')).includes('내가 누구인지 아직 안 골랐어요') && (await text('.page-form .me-row-btn')) === '나 고르기' && (await addonSum('members')) === '', await text('.page-form .me-row'));
  check('내 역할 칸 아래에 나 줄', await page.evaluate(() => {
    const y = (s) => document.querySelector(s).getBoundingClientRect().top;
    return y('.page-form [data-field="mm.myRole"]') < y('.page-form .me-row') && y('.page-form .me-row') < y('.page-form .rec-review-field');
  }));
  check('추가 입력 버튼 둘: 사진 · 함께한 사람', JSON.stringify(await texts('.page-form .addon .addon-label')) === ADDONS);
  const memberN = (await api('GET', '/api/data')).data.members.length;
  await page.click('.page-form .me-row-btn');
  await page.waitForSelector(`${dlg}.dlg-me`);
  const rows = await page.$$eval(`${dlg}.dlg-me .me-pick-row`, (els) => els.map((e) => e.getAttribute('data-member-id')));
  const acts = await texts(`${dlg} .dlg-actions button`);
  check('나 고르기 창: 제목 · 멤버 전부 나열', (await text(`${dlg}.dlg-me .dlg-title`)) === '나는 누구인가요?' && rows.length === memberN && rows.includes(yk) && rows.includes(ys), `${rows.length}/${memberN}`);
  check('나 고르기 창: 아직 나가 없으면 ‘나 해제’ 없음 · 취소 · 새 멤버로 등록', JSON.stringify(acts) === JSON.stringify(['취소', '새 멤버로 등록']), JSON.stringify(acts));
  await page.keyboard.press('Escape');
  await page.waitForSelector(`${dlg}.dlg-me`, { state: 'detached', timeout: 5000 });
  check('창을 닫으면 그대로 (나 없음)', (await getMeLS()) === null && (await text('.page-form .me-row-btn')) === '나 고르기');

  await pickMeIn(yk);
  check('고르면 ‘나: 연경’ · 버튼은 ‘바꾸기’', (await text('.page-form .me-row')).includes('나: 연경') && (await text('.page-form .me-row-btn')) === '바꾸기', await text('.page-form .me-row'));
  check('함께한 사람 버튼 요약에 연경 · localStorage 저장', (await addonSum('members')) === '연경' && (await getMeLS()) === yk, `${await addonSum('members')} / ${await getMeLS()}`);
  await openPanel('members');
  check('함께한 사람 칩: 연경만 눌려 있음 · ‘새 멤버’ 버튼', (await chipPressed(yk)) === 'true' && (await chipPressed(ys)) === 'false' && !!(await page.$(`${panelSel('members')} .chip-add`)));

  // 바꾸기 → 영식: 새 기록이라 새 나도 참여자에 들어가고 예전 나도 그대로
  await page.click('.page-form .me-row-btn');
  await page.waitForSelector(`${dlg}.dlg-me`);
  check('바꾸기 창: 지금 나(연경)가 표시됨 · ‘나 해제’ 버튼', (await page.getAttribute(`${dlg}.dlg-me .me-pick-row.is-current`, 'data-member-id')) === yk &&
    (await page.getAttribute(`${dlg}.dlg-me .me-pick-row[data-member-id="${yk}"]`, 'aria-pressed')) === 'true' && (await texts(`${dlg} .dlg-actions button`)).includes('나 해제'));
  await page.click(`${dlg}.dlg-me .me-pick-row[data-member-id="${ys}"]`);
  await page.waitForSelector(`${dlg}.dlg-me`, { state: 'detached', timeout: 5000 });
  check('영식으로 바뀜: ‘나: 영식’ · localStorage', (await text('.page-form .me-row')).includes('나: 영식') && (await getMeLS()) === ys, await text('.page-form .me-row'));
  check('새 기록: 영식도 참여자에 추가, 연경은 그대로 (요약 · 칩)', (await addonSum('members')) === '연경, 영식' && (await chipPressed(yk)) === 'true' && (await chipPressed(ys)) === 'true', await addonSum('members'));

  // 나 해제
  await page.click('.page-form .me-row-btn');
  await page.waitForSelector(`${dlg}.dlg-me`);
  await dialogButton('나 해제');
  await page.waitForSelector(`${dlg}.dlg-me`, { state: 'detached', timeout: 5000 });
  check('나 해제: 안내 문구로 돌아옴 · localStorage 지움 · 참여자는 그대로', (await text('.page-form .me-row')).includes('내가 누구인지 아직 안 골랐어요') && (await text('.page-form .me-row-btn')) === '나 고르기' &&
    (await getMeLS()) === null && (await addonSum('members')) === '연경, 영식' && (await chipPressed(yk)) === 'true', await text('.page-form .me-row'));

  // 새 멤버로 등록 → 나로 정해지고 참여자에도 들어감
  await page.click('.page-form .me-row-btn');
  await page.waitForSelector(`${dlg}.dlg-me`);
  await dialogButton('새 멤버로 등록');
  await page.waitForSelector(`${dlg}.dlg-member`);
  await page.fill(`${dlg} input[placeholder="이름 또는 별명"]`, '임시새나');
  await dialogButton('저장');
  await page.waitForSelector(dlg, { state: 'detached', timeout: 5000 });
  const created = (await api('GET', '/api/data')).data.members.find((m) => m.name === '임시새나');
  if (created) meT.members.push(created.id);
  check('새 멤버가 서버에 저장됨', !!created);
  check('새 멤버가 나로: ‘나: 임시새나’ · localStorage', !!created && (await text('.page-form .me-row')).includes('나: 임시새나') && (await getMeLS()) === created.id, `${await text('.page-form .me-row')} / ${await getMeLS()}`);
  check('참여자에도 들어감 (연경, 영식 외 1명)', (await addonSum('members')) === '연경, 영식 외 1명' && !!created && (await chipPressed(created.id)) === 'true', await addonSum('members'));
  await leaveForm();
  if (created) {
    await api('DELETE', `/api/members?id=${encodeURIComponent(created.id)}`);
    meT.members = meT.members.filter((x) => x !== created.id);
  }
  await setMeLS(null);
  await syncFromServer();
});

await step('나가 있을 때 저장: 참여자 · 내 배역(mm.roles) · 함께한 사람은 선택', async () => {
  const yk = ids['연경'];
  const ys = ids['영식'];
  await setMeLS(yk);
  // ① 머더미스터리: 나는 자동 참여자 · 영식 칩을 더 눌러 함께한 사람 추가 · 내 역할 → mm.roles
  await go('#/new/murdermystery', '.page-form.t-murdermystery');
  check('새 폼: ‘나: 연경’ · 요약 연경 (나가 참여자로 시작)', (await text('.page-form .me-row')).includes('나: 연경') && (await text('.page-form .me-row-btn')) === '바꾸기' && (await addonSum('members')) === '연경');
  await openPanel('members');
  await page.click(`${panelSel('members')} .chip-member[data-member-id="${ys}"]`);
  check('칩으로 영식을 더하면 요약 ‘연경, 영식’', (await addonSum('members')) === '연경, 영식' && (await chipPressed(ys)) === 'true', await addonSum('members'));
  await setGame('붉은 저택의 초대');
  await page.fill('.page-form [data-field="mm.myRole"]', '해리엇 부인');
  await setRating(RATING, ['3']);
  const id1 = await saveForm();
  const r1 = await serverRecord(id1);
  check('서버: members 에 나(연경)와 영식', !!r1 && r1.members.length === 2 && r1.members.includes(yk) && r1.members.includes(ys), JSON.stringify(r1 && r1.members));
  check('서버: mm.myRole = 해리엇 부인', !!r1 && r1.mm.myRole === '해리엇 부인');
  check('서버: mm.roles 에 나의 배역만 {character, culprit:false, outcome:null, mvp:false}', !!r1 && canon(r1.mm.roles) === canon([mkRole(yk, '해리엇 부인')]), JSON.stringify(r1 && r1.mm.roles));

  // ② 수정: 내 역할만 바꾸면 myRole 과 배역 이름이 함께 바뀜
  await go(`#/edit/${encodeURIComponent(id1)}`, '.page-form');
  check('수정 폼: 내 역할이 채워져 있음 · 나 줄', (await page.inputValue('[data-field="mm.myRole"]')) === '해리엇 부인' && (await text('.page-form .me-row')).includes('나: 연경'));
  await page.fill('[data-field="mm.myRole"]', '선대 공작');
  await saveForm();
  const r1b = await serverRecord(id1);
  check('수정 저장: myRole · roles[나].character 모두 ‘선대 공작’ (배역은 하나뿐)', !!r1b && r1b.mm.myRole === '선대 공작' && canon(r1b.mm.roles) === canon([mkRole(yk, '선대 공작')]) && canon(r1b.members) === canon(r1.members), JSON.stringify(r1b && r1b.mm.roles));
  // 내 역할을 지우고 저장하면 myRole 은 비고, 배역 이름은 건드리지 않음
  await go(`#/edit/${encodeURIComponent(id1)}`, '.page-form');
  await page.fill('[data-field="mm.myRole"]', '');
  await saveForm();
  const r1c = await serverRecord(id1);
  check('내 역할을 비우면 myRole 만 비고 배역은 그대로', !!r1c && r1c.mm.myRole === '' && canon(r1c.mm.roles) === canon([mkRole(yk, '선대 공작')]), JSON.stringify(r1c && r1c.mm));

  // ③ 수정으로는 나를 참여자에 넣지 않음 (참여자 없는 예전 기록)
  const old = await seedMm('나 없는 예전 기록', { members: [], myRole: '예전역할' });
  await syncFromServer();
  await go(`#/edit/${encodeURIComponent(old)}`, '.page-form');
  check('수정 폼: 참여자 요약 비어 있음', (await addonSum('members')) === '');
  await page.fill('[data-field="mm.myRole"]', '바뀐역할');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const o2 = await serverRecord(old);
  check('수정해도 나는 참여자에 안 들어가고 배역도 안 생김 (members [] · roles [])', !!o2 && o2.members.length === 0 && o2.mm.roles.length === 0 && o2.mm.myRole === '바뀐역할', JSON.stringify(o2 && { m: o2.members, r: o2.mm.roles }));

  // ④ 함께한 사람에서 나를 빼면 내 배역은 만들지 않음 (참여자만 roles 에 있을 수 있어요)
  await go('#/new/murdermystery', '.page-form.t-murdermystery');
  await openPanel('members');
  await page.click(`${panelSel('members')} .chip-member[data-member-id="${yk}"]`);
  check('칩을 끄면 요약이 비어 있음 (나 줄은 그대로)', (await addonSum('members')) === '' && (await text('.page-form .me-row')).includes('나: 연경'));
  await setGame('붉은 저택의 초대');
  await page.fill('[data-field="mm.myRole"]', '집사 대리');
  const id4 = await saveForm();
  const r4 = await serverRecord(id4);
  check('나가 참여자가 아니면: members [] · roles [] · myRole 은 저장', !!r4 && r4.members.length === 0 && r4.mm.roles.length === 0 && r4.mm.myRole === '집사 대리', JSON.stringify(r4 && { m: r4.members, r: r4.mm.roles }));

  // ⑤ 보드게임·방탈출 새 기록도 나를 참여자로 (내 역할 줄은 없음)
  await go('#/new/boardgame', '.page-form.t-boardgame');
  check('보드게임 폼: 나 줄 없음 (내 역할 칸이 숨겨져 있음) · 요약 연경', (await page.isHidden('.page-form .me-row')) && (await addonSum('members')) === '연경');
  await setGame('테라포밍 마스');
  const id5 = await saveForm();
  const r5 = await serverRecord(id5);
  check('보드게임 새 기록: members [나]', !!r5 && canon(r5.members) === canon([yk]), JSON.stringify(r5 && r5.members));
  await go('#/new/escaperoom', '.page-form.t-escaperoom');
  check('방탈출 폼: 요약 연경', (await addonSum('members')) === '연경');
  await setGame('잊혀진 연구소');
  const id6 = await saveForm();
  const r6 = await serverRecord(id6);
  check('방탈출 새 기록: members [나]', !!r6 && canon(r6.members) === canon([yk]), JSON.stringify(r6 && r6.members));

  // ⑥ 나가 없으면 예전처럼 참여자 없이 저장 · 내 역할만 있고 배역은 없음
  await setMeLS(null);
  await go('#/new/murdermystery', '.page-form.t-murdermystery');
  check('나가 없는 새 폼: 요약 비어 있음', (await addonSum('members')) === '');
  await setGame('붉은 저택의 초대');
  await page.fill('[data-field="mm.myRole"]', '해리엇 부인');
  const id7 = await saveForm();
  const r7 = await serverRecord(id7);
  check('나가 없으면: members [] · roles [] · myRole 은 저장', !!r7 && r7.members.length === 0 && r7.mm.roles.length === 0 && r7.mm.myRole === '해리엇 부인', JSON.stringify(r7 && { m: r7.members, r: r7.mm.roles }));
  await go('#/new/boardgame', '.page-form.t-boardgame');
  await setGame('테라포밍 마스');
  const id8 = await saveForm();
  check('나가 없으면 보드게임도 members []', ((await serverRecord(id8)) || { members: ['x'] }).members.length === 0);

  // 정리
  for (const id of meT.recs.splice(0)) await api('DELETE', `/api/records?id=${encodeURIComponent(id)}`);
  await syncFromServer();
  check('(정리) 시험 기록 삭제', (await api('GET', '/api/data')).data.records.length === meT.base.records);
});

await step('프로필: 맡았던 역할 (내가 맡았던 역할 · 가려진 역할 · 예전 내 역할 · 10개 제한)', async () => {
  const na = await addMember('임시나');
  const nam = await addMember('임시남');
  const bin = await addMember('임시빈');
  meT.na = na; meT.nam = nam; meT.bin = bin;
  const d1 = seoulDate(new Date(Date.now() - 41 * 86400e3));
  const d2 = seoulDate(new Date(Date.now() - 42 * 86400e3));
  const d3 = seoulDate(new Date(Date.now() - 43 * 86400e3));
  const d4 = seoulDate(new Date(Date.now() - 44 * 86400e3));
  meT.r1 = await seedMm('RP-일반', { date: d1, members: [na, nam], roles: [mkRole(na, '공작부인'), mkRole(nam, '하인 톰')], rating: 4 });
  meT.r2 = await seedMm('RP-스포일러', { date: d2, members: [na], roles: [mkRole(na, '비밀 범인')], spoiler: true });
  meT.r3 = await seedMm('RP-예전기록', { date: d3, members: [na], myRole: '레거시역할' });
  meT.r4 = await seedMm('RP-역할가림', { date: d4, members: [na], roles: [mkRole(na, '가린 역할2')], roleSpoiler: true });
  meT.r5 = await seedMm('RP-빈배역', { date: d4, members: [na], myRole: '무시됨', roles: [mkRole(na, '')] });
  await reloadApp();
  await setMeLS(na);
  await go(`#/member/${encodeURIComponent(na)}`, '.page-profile');
  const prole = '.page-profile .prole';
  // 앞 단계의 ‘붉은 저택의 초대’ 스포일러 기록(ids.mm)은 내 역할(mm.myRole)만 있고 배역이 없어서, 나로 정한 사람이면 누구에게나 ‘가려진 역할’ 한 줄로 이어짐
  check('내 프로필: ‘내가 맡았던 역할’ 구역 · 5개 (시험 기록 4개 + 앞서 만든 내 역할 기록 1개)', (await text(`${prole} .sec-title`)) === '내가 맡았던 역할' && (await text(`${prole} .sec-sub`)) === '5개', await text(prole));
  const roleTexts = (await texts(`${prole} .prole-role`)).sort();
  check('역할: 공작부인 · 예전 기록의 내 역할 · 스포일러/가림 기록은 ‘가려진 역할’ 셋', JSON.stringify(roleTexts) === JSON.stringify(['가려진 역할', '가려진 역할', '가려진 역할', '공작부인', '레거시역할'].sort()), JSON.stringify(roleTexts));
  const row1 = `${prole} .prole-row:has(.prole-link[href="#/record/${encodeURIComponent(meT.r1)}"])`;
  check('일반 기록 행: 역할 · 제목 · 날짜 · 별점 4.0', (await text(`${row1} .prole-role`)) === '공작부인' && (await text(`${row1} .prole-title`)) === 'RP-일반' &&
    (await text(`${row1} .prole-meta`)).includes(d1.replace(/-/g, '.')) && (await text(`${row1} .prole-meta .stars-num`)) === '4.0', await text(`${row1} .prole-meta`));
  const whole = await text('.page-profile');
  const proleText = await text(prole);
  check('가린 역할의 이름은 프로필 어디에도 없음 (비밀 범인 · 가린 역할2)', !whole.includes('비밀 범인') && !whole.includes('가린 역할2'), whole);
  check('역할 이름이 빈 배역은 구역에 없음 (내 역할 ‘무시됨’ 도 안 나옴)', !proleText.includes('무시됨') && !proleText.includes('RP-빈배역'), proleText);
  const hidden = await page.$$eval(`${prole} .prole-row`, (els) => els.filter((e) => e.querySelector('.prole-role').textContent === '가려진 역할').map((e) => e.querySelector('.prole-title').textContent).sort());
  check('가려진 역할 행은 제목으로만 기록에 이어 줌 (스포일러 · 역할가림 · 앞서 만든 스포일러 기록)', JSON.stringify(hidden) === JSON.stringify(['RP-스포일러', 'RP-역할가림', '붉은 저택의 초대'].sort()), JSON.stringify(hidden));
  await noOverflow('프로필 (맡았던 역할)');
  // 제목 링크 → 그 기록 상세
  await page.click(`${row1} .prole-link`);
  await page.waitForSelector('.page-detail');
  check('역할 행을 누르면 그 기록 상세 (#/record/<id>)', STAMP_ID(page.url()) === meT.r1 && (await text('.page-detail .dhero-title')) === 'RP-일반', page.url());

  // 나가 아닌 사람: 배역에 이름이 있는 기록만 (예전 ‘내 역할’은 나에게만)
  await go(`#/member/${encodeURIComponent(nam)}`, '.page-profile');
  check('다른 멤버: ‘맡았던 역할’ (내가 아님) · 하인 톰 하나', (await text(`${prole} .sec-title`)) === '맡았던 역할' && JSON.stringify(await texts(`${prole} .prole-role`)) === JSON.stringify(['하인 톰']) &&
    (await text(`${prole} .sec-sub`)) === '1개', await text(prole));
  check('다른 멤버 프로필: 나 설정 버튼은 ‘나로 설정’ · 배지 없음', (await text('.phero-me')) === '이 기기에서 나로 설정' && !(await page.$('.page-profile .me-badge')));
  await go(`#/member/${encodeURIComponent(meT.bin)}`, '.page-profile');
  check('역할이 없는 멤버: 구역이 없음', !(await page.$('.page-profile .prole')));

  // 나를 풀면 임시나도 일반 멤버: 예전 ‘내 역할’ 기록은 빠짐
  await setMeLS(null);
  await go(`#/member/${encodeURIComponent(na)}`, '.page-profile');
  const t3 = (await texts(`${prole} .prole-role`)).sort();
  check('나가 아니면 ‘맡았던 역할’ · 예전 기록(레거시역할) 빠지고 3개', (await text(`${prole} .sec-title`)) === '맡았던 역할' && JSON.stringify(t3) === JSON.stringify(['가려진 역할', '가려진 역할', '공작부인'].sort()) && !(await text(prole)).includes('레거시역할'), JSON.stringify(t3));
  await setMeLS(na);

  // 10개 넘으면 최근 10개만 + 안내
  const many = [];
  for (let i = 0; i < 12; i++) {
    many.push(seedMm(`RP-다수${i}`, { date: seoulDate(new Date(Date.now() - (i + 1) * 86400e3)), members: [na], roles: [mkRole(na, `다수역${i}`)] }));
  }
  const manyIds = await Promise.all(many);
  await reloadApp();
  await go(`#/member/${encodeURIComponent(na)}`, '.page-profile');
  check('17개 중 10개만 보임 + ‘최근 10개만 보여요 (전체 17개)’', (await page.$$(`${prole} .prole-row`)).length === 10 && (await text(`${prole} > p`)) === '최근 10개만 보여요 (전체 17개)' && (await text(`${prole} .sec-sub`)) === '17개', await text(prole));
  check('최근 것부터: 오늘 기록(가려진 역할) 다음이 다수역0(어제), 1 …', JSON.stringify((await texts(`${prole} .prole-role`)).slice(0, 3)) === JSON.stringify(['가려진 역할', '다수역0', '다수역1']), JSON.stringify((await texts(`${prole} .prole-role`)).slice(0, 3)));
  await noOverflow('프로필 (역할 10개)');
  for (const id of manyIds) await api('DELETE', `/api/records?id=${encodeURIComponent(id)}`);
  meT.recs = meT.recs.filter((x) => !manyIds.includes(x));
  await reloadApp();
  await go(`#/member/${encodeURIComponent(na)}`, '.page-profile');
  check('(정리) 다시 5개 · 안내 없음', (await text(`${prole} .sec-sub`)) === '5개' && !(await page.$(`${prole} > p`)));
});

await step('나: 수정 폼에서 배역 이름을 내 역할로 채워 줌 (저장해도 배역은 그대로)', async () => {
  const yk = ids['연경'];
  await setMeLS(yk);
  const pre = await seedMm('프리필 시험', { members: [yk, ids['영식']], myRole: '', roles: [mkRole(yk, '프리필 역할'), { ...mkRole(ids['영식'], '탐정 조수'), outcome: 'win' }] });
  await syncFromServer();
  const before = await serverRecord(pre);
  await go(`#/edit/${encodeURIComponent(pre)}`, '.page-form');
  check('내 역할 입력이 내 배역 이름으로 채워짐', (await page.inputValue('[data-field="mm.myRole"]')) === '프리필 역할', await page.inputValue('[data-field="mm.myRole"]'));
  check('수정 폼: 나 줄 · 함께한 사람 요약에 두 사람', (await text('.page-form .me-row')).includes('나: 연경') && (await addonSum('members')) === '연경, 영식', await addonSum('members'));
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const after = await serverRecord(pre);
  check('아무것도 안 고치고 저장: 배역 그대로 (영식의 승리 · 탐정 조수 포함)', canon(after.mm.roles) === canon(before.mm.roles) && canon(after.members) === canon(before.members), `${canon(before.mm.roles)}\n${canon(after.mm.roles)}`);
  check('저장하면 mm.myRole 에 이름이 남음', after.mm.myRole === '프리필 역할');
  // 나가 없으면 채우지 않음
  await setMeLS(null);
  const pre2 = await seedMm('프리필 시험 2', { members: [yk], myRole: '', roles: [mkRole(yk, '다른 역할')] });
  await syncFromServer();
  await go(`#/edit/${encodeURIComponent(pre2)}`, '.page-form');
  check('나가 없으면 내 역할 칸은 비어 있음', (await page.inputValue('[data-field="mm.myRole"]')) === '');
  await leaveForm();
  // 직접 적은 내 역할이 있으면 그것을 우선
  await setMeLS(yk);
  const pre3 = await seedMm('프리필 시험 3', { members: [yk], myRole: '내가 적은 역할', roles: [mkRole(yk, '배역 이름')] });
  await syncFromServer();
  await go(`#/edit/${encodeURIComponent(pre3)}`, '.page-form');
  check('내 역할(myRole)이 있으면 배역 이름으로 덮지 않음', (await page.inputValue('[data-field="mm.myRole"]')) === '내가 적은 역할');
  await leaveForm();
  for (const id of [pre, pre2, pre3]) await api('DELETE', `/api/records?id=${encodeURIComponent(id)}`);
  meT.recs = meT.recs.filter((x) => ![pre, pre2, pre3].includes(x));
  await setMeLS(null);
  await syncFromServer();
});

await step('나: 레이아웃 (폼 · 나 고르기 창 · 프로필) 390 · 320 · 1440 가로 넘침 없음 + 스크린샷', async () => {
  const na = meT.na;
  await setMeLS(na);
  await reloadApp();
  // 새 머더미스터리 폼: 나 줄 + 두 추가 버튼 (함께한 사람 펼침)
  await go('#/new/murdermystery', '.page-form.t-murdermystery');
  await page.fill('[data-field="mm.myRole"]', '해리엇 부인');
  await openPanel('members');
  check('폼: 나 줄 · 버튼 둘', (await text('.page-form .me-row')).includes('나: 임시나') && JSON.stringify(await texts('.page-form .addon .addon-label')) === ADDONS);
  check('나 줄 ‘바꾸기’ 버튼은 터치 크기(높이 36px 이상)', await page.$eval('.page-form .me-row-btn', (e) => e.getBoundingClientRect().height >= 36), String(await page.$eval('.page-form .me-row-btn', (e) => e.getBoundingClientRect().height)));
  await noOverflow('390 나가 있는 머더미스터리 폼');
  await shot('me-form-mm-390');
  await page.click('.page-form .me-row-btn');
  await page.waitForSelector(`${dlg}.dlg-me`);
  await noOverflow('390 나 고르기 창');
  check('나 고르기 창이 화면 안 (아래에서 올라오는 시트)', await page.$eval(`${dlg}.dlg-me`, (e) => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1; }));
  await shot('me-pick-dialog-390');
  await page.keyboard.press('Escape');
  await page.waitForSelector(`${dlg}.dlg-me`, { state: 'detached', timeout: 5000 });
  await page.setViewportSize({ width: 320, height: 640 });
  await sleep(150);
  await noOverflow('320 나가 있는 머더미스터리 폼');
  await page.click('.page-form .me-row-btn');
  await page.waitForSelector(`${dlg}.dlg-me`);
  await noOverflow('320 나 고르기 창');
  await page.keyboard.press('Escape');
  await page.waitForSelector(`${dlg}.dlg-me`, { state: 'detached', timeout: 5000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(200);
  await noOverflow('1440 나가 있는 머더미스터리 폼');
  await shot('me-form-mm-1440');
  await page.click('.page-form .me-row-btn');
  await page.waitForSelector(`${dlg}.dlg-me`);
  await noOverflow('1440 나 고르기 창');
  await shot('me-pick-dialog-1440');
  await page.keyboard.press('Escape');
  await page.waitForSelector(`${dlg}.dlg-me`, { state: 'detached', timeout: 5000 });
  await page.setViewportSize(VIEWPORT);
  await sleep(150);
  await leaveForm();

  // 프로필: 맡았던 역할 구역
  for (const [w, h2, label] of [[390, 844, '390'], [320, 640, '320'], [1440, 900, '1440']]) {
    await page.setViewportSize({ width: w, height: h2 });
    await go(`#/member/${encodeURIComponent(na)}`, '.page-profile .prole');
    await sleep(150);
    await noOverflow(`${label} 프로필 (맡았던 역할)`);
    if (w !== 320) await shot(`me-profile-roles-${label}`);
  }
  await page.setViewportSize(VIEWPORT);
  await sleep(150);
  await go('#/members', '.page-members');
  await noOverflow('390 멤버 목록 (나 배지)');
});

await step('나: 시험 데이터 정리', async () => {
  for (const id of meT.recs.splice(0)) await api('DELETE', `/api/records?id=${encodeURIComponent(id)}`);
  for (const id of meT.members.splice(0)) await api('DELETE', `/api/members?id=${encodeURIComponent(id)}`);
  await setMeLS(null);
  await reloadApp();
  const d = (await api('GET', '/api/data')).data;
  check('시험 멤버·기록이 모두 지워져 처음 개수로 돌아옴', meT.base && d.records.length === meT.base.records && d.members.length === meT.base.members && d.games.length === meT.base.games, JSON.stringify({ base: meT.base, now: [d.records.length, d.members.length, d.games.length] }));
  check('localStorage 에 나가 남아 있지 않음', (await getMeLS()) === null);
  await go('#/', '.page-home');
});

/** 감상·별점·수정 시각만 빼고 비교 (화면에서 고친 두 값 말고는 서버 값이 그대로여야 함) */
const withoutEdited = ({ review, rating, updatedAt, ...rest }) => canon(rest);

await step('기록 수정 (예전 멤버·순위·태그는 화면에 없어도 그대로 보존)', async () => {
  const before = await serverRecord(ids.bg);
  await go(`#/record/${encodeURIComponent(ids.bg)}`, '.page-detail');
  await page.click('.page-detail .dactions a:has-text("수정하기")');
  await page.waitForSelector('.page-form');
  check('수정 폼에 고른 게임', (await pickedGame()) === '테라포밍 마스');
  check('수정 폼에 기존 별점', (await ratingOf(RATING)) === '4.5');
  check('수정 폼: 종류는 고정 표시', !!(await page.$('.page-form .rec-type .badge')) && !(await page.$('.page-form .rec-type .seg')));
  const open = await page.$$eval('.page-form .rec-panel:not([hidden])', (els) => els.map((e) => e.dataset.panel));
  check('수정 폼: 사진은 없고 함께한 사람이 있으면 그 영역만 펼쳐짐', JSON.stringify(open) === JSON.stringify(before.members.length ? ['members'] : []), JSON.stringify(open));
  check('수정 폼: 함께한 사람 칩은 기록의 멤버만 눌려 있음 (순위·자세한 정보·태그 입력은 없음 · 보이는 항목: 종류·게임·날짜·별점·감상)', await noRemovedPanels() && !(await page.$('.page-form .result-row, .page-form .chip-tag')) &&
    canon(await pressedMembers()) === canon([...before.members].sort()) &&
    JSON.stringify(await visibleLabels()) === JSON.stringify(['종류', '게임', '날짜', '별점', '감상']), JSON.stringify(await visibleLabels()));
  await page.fill(REVIEW, '화성 개척은 언제나 옳다\n영식이 막판 도시 타일로 역전했다.');
  await setRating(RATING, ['ArrowRight']);
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  check('수정 토스트', !!(await toastSeen(/수정했어요/)));
  check('수정된 감상', (await text('.page-detail .review-text')).includes('언제나 옳다'));
  check('수정된 별점 5.0', (await text('.dhero-rating .stars-num')) === '5.0');
  check('수정 시각 표시', (await text('.page-detail .dmeta')).includes('수정'));
  const rows = await texts('.page-detail .rank-row');
  check('수정 후에도 순위 유지', rows[0] && rows[0].includes('영식'), rows.join(' | '));
  check('수정 후에도 게임 연결 유지', (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.bg).gameId === ids.gTera);
  const after = await serverRecord(ids.bg);
  check('서버: 감상·별점만 바뀜', after.review.startsWith('화성 개척은 언제나 옳다') && after.rating === 5 && before.rating === 4.5 && after.updatedAt !== before.updatedAt);
  check('서버: 멤버·순위·점수·승자·장소·시간·확장판·태그·날짜·게임 연결이 그대로', withoutEdited(after) === withoutEdited(before) && after.members.length === 3 && after.bg.results.length === 3 &&
    after.tags.join() === '전략' && after.bg.place === '또또하우스 거실', `${withoutEdited(before)}\n${withoutEdited(after)}`);
});

await step('동시 수정 충돌 (409) — 취소 후 초안으로 덮어쓰기', async () => {
  await go(`#/edit/${encodeURIComponent(ids.er)}`, '.page-form');
  // 다른 사람이 먼저 수정
  const cur = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.er);
  const other = await api('POST', '/api/records', { record: { ...cur, rating: 2, review: '다른 사람의 감상' }, baseUpdatedAt: cur.updatedAt });
  check('다른 기기 수정 성공', other.status === 200);
  await page.fill(REVIEW, '장치가 정말 끝내준다 (내 수정)');
  await allowing([/status of 409/], async () => {
    await page.click('.save-btn');
    await page.waitForSelector(dlg, { timeout: 8000 });
  });
  check('충돌 다이얼로그 제목', (await text(`${dlg} .dlg-title`)) === '다른 사람이 먼저 수정했어요');
  check('최신본 표시', (await text(`${dlg} .conflict-title`)) === '잊혀진 연구소' && (await text(`${dlg} .conflict-review`)) === '다른 사람의 감상', await text(`${dlg} .conflict-card`));
  const diff = await text(`${dlg} .conflict-diff`);
  check('다른 부분 안내', diff.includes('별점') && diff.includes('감상') && !diff.includes('게임'), diff);
  await noOverflow('충돌 다이얼로그');
  await shot('17-conflict-dialog');
  await dialogButton('취소');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  check('취소 → 최신본 상세', (await text('.page-detail .review-text')) === '다른 사람의 감상' && (await text('.dhero-rating .stars-num')) === '2.0');
  check('내 내용은 초안으로 보관', await page.evaluate(() => (JSON.parse(localStorage.getItem('ddh:draft') || 'null') || {}).key || null) === `edit:${ids.er}`);

  // 다시 수정 → 초안 불러오기 → 저장 → 또 충돌 → 덮어쓰기
  await page.click('.page-detail .dactions a:has-text("수정하기")');
  await page.waitForSelector('.page-form .draft-banner:not([hidden])');
  check('초안 배너', true);
  await page.click('.page-form .draft-banner button:has-text("불러오기")');
  check('초안의 내 감상 복원', (await page.inputValue(REVIEW)) === '장치가 정말 끝내준다 (내 수정)');
  await allowing([/status of 409/], async () => {
    await page.click('.save-btn');
    await page.waitForSelector(dlg, { timeout: 8000 });
  });
  check('초안의 오래된 기준 → 다시 충돌', (await text(`${dlg} .dlg-title`)) === '다른 사람이 먼저 수정했어요');
  await dialogButton('내 내용으로 덮어쓰기');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  check('덮어쓰기 → 내 별점', (await text('.dhero-rating .stars-num')) === '5.0', await text('.dhero-rating .stars-num'));
  check('덮어쓰기 → 내 감상', (await text('.page-detail .review-text')).includes('(내 수정)'));
  check('덮어쓴 뒤 초안 삭제', (await page.evaluate(() => localStorage.getItem('ddh:draft'))) === null);
  const saved = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.er);
  check('서버에도 내 내용', saved.title === '잊혀진 연구소' && saved.review.includes('(내 수정)') && saved.rating === 5 && saved.er.remainingSec === 754, JSON.stringify(saved));
  check('예전 방탈출 기록: 멤버·성공·남은 시간·힌트·세부 평가·장르가 수정 뒤에도 그대로', withoutEdited(saved) === withoutEdited(cur) && saved.members.length === 3 && saved.er.cleared === true &&
    saved.er.hints === 2 && saved.er.scores.puzzle === 4.5 && saved.er.fear === 1 && saved.er.replay === true && saved.er.genre === 'SF', JSON.stringify(saved.er));
});

await step('기록 삭제 (확인 다이얼로그)', async () => {
  await go(`#/record/${encodeURIComponent(ids.junk)}`, '.page-detail');
  await page.click('.page-detail .appbar button[aria-label="삭제"]');
  await page.waitForSelector(dlg);
  check('삭제 확인 문구', (await text(`${dlg} .dlg-title`)) === '이 기록을 삭제할까요?');
  await shot('18-delete-confirm');
  await dialogButton('취소');
  await page.waitForSelector(dlg, { state: 'detached' });
  check('취소하면 그대로', !!(await page.$('.page-detail')));
  await page.click('.page-detail .appbar button[aria-label="삭제"]');
  await page.waitForSelector(dlg);
  await dialogButton('삭제');
  await page.waitForSelector('.page-list', { timeout: 8000 });
  check('삭제 토스트', !!(await toastSeen(/기록을 삭제했어요/)));
  const t = await until(async () => { const x = await cardTitles(); return x.length === 4 && x; });
  check('목록에서 사라짐', t && !t.includes('삭제할 게임'), String(await cardTitles()));
  const { data } = await api('GET', '/api/data');
  check('서버에서도 삭제', !data.records.some((r) => r.id === ids.junk));
});

await step('멤버 삭제 → (떠난 멤버)', async () => {
  await go(`#/member/${encodeURIComponent(ids['도윤'])}`, '.page-profile');
  await page.click('.page-profile .appbar button[aria-label="삭제"]');
  await page.waitForSelector(dlg);
  await dialogButton('삭제');
  await page.waitForSelector('.page-members', { timeout: 8000 });
  const names = await texts('.page-members .mlist-name');
  check('멤버 3명', names.length === 3 && !names.includes('도윤'), names.join(','));
  await go(`#/record/${encodeURIComponent(ids.mm)}`, '.page-detail');
  const mem = await texts('.page-detail .mrows .mrow-name');
  check('상세: (떠난 멤버) 표시', mem.includes('(떠난 멤버)') && mem.includes('연경'), mem.join(','));
  const roles = await texts('.page-detail .role-row');
  check('역할에도 (떠난 멤버)', roles.some((r) => r.includes('(떠난 멤버)') && r.includes('정원사')), roles.join(' | '));
  check('떠난 멤버는 링크 아님', !!(await page.$('.page-detail .mrow.is-gone')) && !(await page.$('.page-detail a.mrow.is-gone')));
  // 수정 폼에는 멤버·역할 칸이 없지만, 떠난 멤버가 들어 있는 예전 기록을 고쳐 저장해도 멤버·역할·범인·점수는 그대로
  const beforeMm = await serverRecord(ids.mm);
  await go(`#/edit/${encodeURIComponent(ids.mm)}`, '.page-form');
  check('수정 폼: 저장된 내 역할이 채워져 있음 · 함께한 사람에 떠난 멤버 칩(눌림)이 하나 · 역할 카드는 없음', (await page.inputValue('[data-field="mm.myRole"]')) === '마르타' && await noRemovedPanels() &&
    (await page.$$('.page-form .chip-member.is-gone[aria-pressed="true"]')).length === 1 && canon(await pressedMembers()) === canon([...beforeMm.members].sort()) &&
    !(await page.$('.page-form .role-card')));
  check('수정 폼: 보이는 항목은 종류·작품·날짜·별점·내 역할·감상', JSON.stringify(await visibleLabels()) === JSON.stringify(['종류', '작품', '날짜', '별점', '내 역할', '감상']), JSON.stringify(await visibleLabels()));
  await page.fill(REVIEW, `${beforeMm.review} (다시 읽고 고침)`);
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const afterMm = await serverRecord(ids.mm);
  check('서버: 감상만 바뀜', afterMm.review.endsWith('(다시 읽고 고침)') && afterMm.rating === beforeMm.rating);
  check('서버: 떠난 멤버 포함 멤버·역할·범인·검거 결과·점수·태그·내 역할이 그대로', withoutEdited(afterMm) === withoutEdited(beforeMm) && afterMm.members.includes(ids['도윤']) && afterMm.mm.roles.length === 3 &&
    afterMm.mm.roles.find((x) => x.memberId === ids['연경']).culprit === true && afterMm.mm.culpritResult === 'escaped' && afterMm.mm.scores.story === 4.5 && afterMm.mm.myRole === '마르타' &&
    afterMm.tags.length === 3, `${withoutEdited(beforeMm)}\n${withoutEdited(afterMm)}`);
  const rolesAfter = await texts('.page-detail .role-row');
  check('상세: 역할에 (떠난 멤버) 그대로', rolesAfter.some((r) => r.includes('(떠난 멤버)') && r.includes('정원사')), rolesAfter.join(' | '));
});

await step('통계 (생성한 데이터와 일치)', async () => {
  await tab('stats', '.page-stats');
  const tiles = async () => Object.fromEntries((await page.$$eval('.page-stats .tile', (els) => els.map((e) => [
    e.querySelector('.tile-label').textContent.trim(),
    e.querySelector('.tile-value').textContent.replace(/\s+/g, ''),
    (e.querySelector('.tile-sub') || { textContent: '' }).textContent.trim(),
  ]))).map(([k, v, s]) => [k, s ? `${v}|${s}` : v]));
  await page.click('.page-stats .seg-type .seg-item:has-text("전체")');
  let tl = await tiles();
  check('전체 4개 · 이번 달 3개', tl['전체 기록'] === '4개' && tl['이번 달'] === '3개', JSON.stringify(tl));
  check('종류별 1·1·2', tl['보드게임'] === '1회' && tl['머더미스터리'] === '1회' && tl['방탈출'] === '2회', JSON.stringify(tl));
  const mem = await hbRows('.page-stats .chart-card:has(.chart-title:text-is("멤버별 참여"))');
  const cnt = (n) => (mem.find((r) => r.name === n) || {}).val;
  check('멤버별 참여 (연경 4 · 영식 4 · 민지짱 2 · 떠난 멤버 1)', cnt('연경') === '4회' && cnt('영식') === '4회' && cnt('민지짱') === '2회' && cnt('(떠난 멤버)') === '1회', JSON.stringify(mem));
  const cols = await page.$$eval('.page-stats .cols', (els) => els.map((e) => e.querySelectorAll('.col').length));
  check('월별 12칸 · 요일 7칸', JSON.stringify(cols) === '[12,7]', JSON.stringify(cols));
  const lastCol = await page.$$eval('.page-stats .cols', (els) => els[0].lastElementChild.getAttribute('aria-label'));
  check('이번 달 막대 3개', /총 3개/.test(lastCol || ''), lastCol);
  await noOverflow('통계 전체');
  await shot('19-stats-all');

  await page.click('.page-stats .seg-type .seg-item:has-text("보드게임")');
  await page.waitForSelector('.page-stats .champ');
  tl = await tiles();
  check('보드게임 1판 · 1종', tl['플레이'] === '1판' && tl['플레이한 게임'] === '1종', JSON.stringify(tl));
  check('최다 우승자 영식 1번', (await text('.page-stats .champ-name')) === '영식' && (await text('.page-stats .champ-sub')) === '1번 우승');
  const rates = await hbRows('.page-stats .chart-card:has(.chart-title:text-is("멤버별 승률"))');
  check('승률: 영식 100% · 연경 0%(0승/1판) · 민지짱 0%', rates[0].name === '영식' && rates[0].val === '100%' &&
    rates.some((r) => r.name === '연경' && r.val === '0%' && r.sub === '0승/1판') && rates.some((r) => r.name === '민지짱' && r.val === '0%'), JSON.stringify(rates));
  await noOverflow('통계 보드게임');
  await shot('20-stats-boardgame');

  await page.click('.page-stats .seg-type .seg-item:has-text("머더미스터리")');
  await page.waitForSelector('.page-stats .stable');
  tl = await tiles();
  check('머더미스터리 1회 · 1편 · 평균 4.0 · 검거율 0%', tl['플레이'] === '1회' && tl['시나리오'] === '1편' && tl['평균 별점'].startsWith('4.0') && tl['범인 검거율'] === '0%|1번 중 0번', JSON.stringify(tl));
  const rowsT = await page.$$eval('.page-stats .stable tbody tr', (els) => els.map((tr) =>
    [tr.querySelector('th .cell-m > span:last-child').textContent.trim(), ...[...tr.querySelectorAll('td')].map((td) => td.textContent.trim())].join(' ')));
  const yk = rowsT.find((r) => r.startsWith('연경 ')) || '';
  check('연경: 1 · 범인 1번 · 생존 100% · 승률 100% · MVP 1번', yk === '연경 1 1번 100% 100% 1번', yk);
  const ys = rowsT.find((r) => r.startsWith('영식 ')) || '';
  check('영식: 1 · – · – · 0% · –', ys === '영식 1 – – 0% –', ys);
  const pub = await hbRows('.page-stats .chart-card:has(.chart-title:text-is("제작사별"))');
  check('제작사 머더랩 1회', pub.length === 1 && pub[0].name === '머더랩' && pub[0].val === '1회', JSON.stringify(pub));
  const avg = await texts('.page-stats .scorebars .sb-row');
  check('세부 점수 평균', avg.length === 5 && avg[0].includes('4.5') && avg[2].includes('5.0'), avg.join(' | '));
  await noOverflow('통계 머더미스터리');
  await shot('21-stats-murdermystery');

  await page.click('.page-stats .seg-type .seg-item:has-text("방탈출")');
  await page.waitForSelector('.page-stats .tile-hero.t-escaperoom');
  tl = await tiles();
  check('방탈출 2개 · 성공률 50% · 힌트 2.5 · 남은 12:34', tl['방탈출'] === '2개' && tl['성공률'] === '50%|1개 탈출' && tl['평균 힌트'] === '2.5개' && tl['평균 남은 시간'].startsWith('12:34'), JSON.stringify(tl));
  const brands = await hbRows('.page-stats .chart-card:has(.chart-title:text-is("브랜드별"))');
  check('브랜드 키이스케이프 2개', brands.length === 1 && brands[0].name === '키이스케이프' && brands[0].val === '2개', JSON.stringify(brands));
  const ms = await hbRows('.page-stats .chart-card:has(.chart-title:text-is("멤버별 성공률"))');
  check('멤버별 성공률 (민지짱 100% · 연경 50%)', ms[0].name === '민지짱' && ms[0].val === '100%' && ms.some((r) => r.name === '연경' && r.val === '50%' && r.sub === '1/2'), JSON.stringify(ms));
  await noOverflow('통계 방탈출');
  await shot('22-stats-escaperoom');
  await page.click('.page-stats .seg-type .seg-item:has-text("전체")');
});

await step('홈 요약 · 멤버 프로필', async () => {
  await tab('home', '.page-home');
  // 낮은 요약 띠: 전체 · 이번 달 · 종류별 (큰 표지·비율 막대·종류별 최근 날짜 없음)
  const sumOf = () => page.$$eval('.page-home .summary .sum-item', (els) => els.map((e) => `${e.querySelector('.sum-label').textContent} ${e.querySelector('.sum-value').textContent}`));
  const sums = await sumOf();
  check('요약 띠: 전체 4회 · 이번 달 3회 · 보드게임 1회 · 머더미스터리 1회 · 방탈출 2회',
    JSON.stringify(sums) === JSON.stringify(['전체 4회', '이번 달 3회', '보드게임 1회', '머더미스터리 1회', '방탈출 2회']), JSON.stringify(sums));
  check('큰 표지·이번 달 멤버 카드는 홈에 없음', !(await page.$('.page-home .cover')) && !(await page.$('.page-home .mate')));
  const mobRows = await page.$eval('.page-home .summary', (e) => new Set([...e.querySelectorAll('.sum-item')].map((x) => Math.round(x.getBoundingClientRect().top))).size);
  check('휴대폰: 요약 띠는 한 줄 다섯 칸', mobRows === 1, String(mobRows));
  const headH = await page.$eval('.page-home .home-head', (e) => e.getBoundingClientRect().height);
  check('휴대폰: 제목은 한 줄로 낮게', headH < 48, String(headH));
  check('홈 제목 ‘플레이 기록’', (await text('.page-home .home-title')) === '플레이 기록');
  check('휴대폰: 최근 기록 첫 카드가 첫 화면 위쪽에', await page.$eval('.page-home .rcard', (e) => e.getBoundingClientRect().top < 260));
  check('휴대폰: 최근 기록 한 칸', await page.evaluate(() => {
    const c = [...document.querySelectorAll('.page-home .rlist > .rcard')];
    return c.length > 1 && c[1].getBoundingClientRect().top >= c[0].getBoundingClientRect().bottom;
  }));
  check('최근 기록이 요약 띠 바로 아래', await page.$eval('.page-home .summary', (e) => !!(e.nextElementSibling && e.nextElementSibling.matches('.home-recent'))));
  check('최근 기록 4개', (await page.$$('.page-home .rcard')).length === 4);
  check('‘전체 보기’ → 기록 목록', (await page.getAttribute('.page-home .home-recent .link-more', 'href')) === '#/records');
  // 최근 기록 아래 내 소장 게임 (작은 표지 · 최대 6개) → 게임 상세 → 플레이 기록하기
  check('최근 기록 다음에 내 소장 게임', await page.$eval('.page-home .home-recent', (e) => !!(e.nextElementSibling && e.nextElementSibling.matches('.home-owned'))));
  check('멤버 먼저 등록 안내 없음', !(await page.$('.page-home .tip')));
  const ownTiles = await texts('.page-home .otile-name');
  check('내 소장 게임 표지: 테라포밍 마스 · 6개 이하', ownTiles.includes('테라포밍 마스') && ownTiles.length <= 6, JSON.stringify(ownTiles));
  check('표지 → 게임 상세 주소', (await page.getAttribute('.page-home .otile-link:has(.otile-name:text-is("테라포밍 마스"))', 'href')) === `#/game/${encodeURIComponent(ids.gTera)}`);
  check('‘전체 보기’ → 소장', (await page.getAttribute('.page-home .home-owned .link-more', 'href')) === '#/collection');
  await noOverflow('홈');
  await shot('23-home');
  await page.click('.page-home .otile-link:has(.otile-name:text-is("테라포밍 마스"))');
  await page.waitForSelector('.page-game');
  check('게임 상세: 이름 · 내 소장 · 인원·시간·장르', (await text('.page-game .ghero-title')) === '테라포밍 마스' && !!(await page.$('.page-game .ghero .rbadge-own')) &&
    (await text('.page-game .ghero-info')) === '1~5명 · 90~120분 · 전략', await text('.page-game .ghero'));
  const teraRecs = (await api('GET', '/api/data')).data.records.filter((r) => r.gameId === ids.gTera).length;
  check('게임 상세: 그 게임 기록만', (await page.$$('.page-game .rcard')).length === teraRecs && teraRecs > 0, String(teraRecs));
  check('게임 상세: 기록 수·평균 별점', (await text('.page-game .ghero-stat')).startsWith(`${teraRecs}번 했어요`), await text('.page-game .ghero-stat'));
  await noOverflow('게임 상세');
  await shot('23b-game');
  await page.click('.page-game .ghero-write');
  await page.waitForSelector('.page-form.t-boardgame');
  check('플레이 기록하기 → 게임이 골라진 새 기록', (await pickedGame()) === '테라포밍 마스' && page.url().includes(`?game=${encodeURIComponent(ids.gTera)}`), await pickedGame());
  await page.click('.page-form .savebar button:has-text("취소")');
  await page.waitForSelector('.page-game');
  check('취소 → 게임 상세로 돌아옴', !!(await page.$('.page-game')));
  await tab('home', '.page-home');
  // 요약 띠의 종류 칸 → 그 종류 목록, 전체 칸 → 전체 목록
  await page.click('.page-home .sum-item.t-escaperoom .sum-link');
  const erOnly = await until(async () => { const x = await cardTitles(); return x.length === 2 && x; });
  check('요약 띠 방탈출 → 방탈출 2개', !!erOnly && (await text('.page-list .seg-type .seg-input:checked + .seg-item')) === '방탈출', String(await cardTitles()));
  await tab('home', '.page-home');
  await page.click('.page-home .sum-item:has(.sum-label:text-is("전체")) .sum-link');
  check('요약 띠 전체 → 4개', !!(await until(async () => { const x = await cardTitles(); return x.length === 4 && x; })), String(await cardTitles()));
  // 이번 달 가장 많이 함께한 멤버는 멤버 화면에서 (집계는 그대로)
  await tab('members', '.page-members');
  check('멤버 화면: 이번 달 가장 많이 함께한 멤버 3번', (await text('.page-members .mate-count')) === '3번 함께했어요', await text('.page-members .mate-count'));
  check('멤버 화면에 이번 달 멤버 카드는 하나만', (await page.$$('.page-members .mate')).length === 1);
  await go(`#/member/${encodeURIComponent(ids['연경'])}`, '.page-profile');
  const tiles = await texts('.page-profile .ptile');
  check('프로필: 보드게임 0승 · 머더미스터리 범인 1번 · 방탈출 50%', tiles[0].includes('1회') && tiles[0].includes('0승') && tiles[1].includes('범인 1번') && tiles[2].includes('2회') && tiles[2].includes('성공률 50%'), tiles.join(' | '));
  check('프로필: 최근 기록 4개', (await page.$$('.page-profile .rcard')).length === 4);
  await noOverflow('멤버 프로필');
  await shot('24-member-profile');
});

await step('소장 탭 · 소장 필터 · 예전 기록 이름을 게임으로 등록', async () => {
  // 게임 정보 전의 예전 기록: 대여한 같은 게임 두 판 + 집에서 한 보드게임형 머더미스터리(내 소장) 한 판 — 이 단계 끝에 지움
  const mk = async (record) => (await api('POST', '/api/records', { record })).data.record.id;
  const gamesBefore = new Set((await api('GET', '/api/data')).data.games.map((g) => g.id));
  const extra = [
    await mk({ type: 'boardgame', date: PAST, title: '스플렌더', members: [ids['연경']], rating: 3, bg: { ownership: 'borrowed', lender: '영식' } }),
    await mk({ type: 'boardgame', date: TODAY, title: '스플렌더 ', members: [ids['연경']], bg: { ownership: 'borrowed', lender: '도윤' } }),
    await mk({ type: 'murdermystery', date: PAST, title: '마지막 야간열차', members: [ids['연경']], rating: 4, mm: { format: 'box', ownership: 'mine' } }),
  ];
  await syncFromServer();
  try {
    // 휴대폰 탭 막대: 홈 · 기록 · 소장 | ＋ | 통계 · 멤버 · 설정 (새 기록 버튼이 가운데)
    await tab('home', '.page-home');
    const bar = await page.$$eval('#tabbar > a', (els) => els.filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => { const b = e.getBoundingClientRect(); return { tab: e.dataset.tab, cls: e.className, mid: b.left + b.width / 2 }; }));
    check('탭 막대 일곱 칸 (소장·설정 포함)', JSON.stringify(bar.map((x) => x.tab)) === JSON.stringify(['home', 'records', 'collection', 'new', 'stats', 'members', 'settings']), JSON.stringify(bar.map((x) => x.tab)));
    const plus = bar.find((x) => x.cls.includes('tab-add'));
    check('새 기록 버튼이 가운데', !!plus && Math.abs(plus.mid - VIEWPORT.width / 2) < 2, JSON.stringify(plus));
    check('홈 머리에 톱니 버튼 없음 (설정은 탭 막대에)', !(await page.$('.page-home .home-head .icon-btn')));

    // 소장 탭: '내 소장'인 게임만 (소장 아닌 게임 정보·방탈출 테마·대여 기록은 없음)
    await tab('collection', '.page-collection');
    check('소장 탭 선택 표시', (await page.getAttribute('#tabbar [data-tab="collection"]', 'aria-current')) === 'page');
    const owned = await texts('.page-collection .gcard-title');
    check('소장 게임 2개 (최근 순) — 등록한 내 소장 + 예전 기록의 내 소장', JSON.stringify(owned) === JSON.stringify(['테라포밍 마스', '마지막 야간열차']), JSON.stringify(owned));
    check('소장 아닌 게임(붉은 저택의 초대·삭제할 게임)·테마·대여는 없음', !owned.includes('붉은 저택의 초대') && !owned.includes('잊혀진 연구소') && !owned.includes('스플렌더') && !(await page.$('.page-collection .borrowed')));
    check('소장 개수', (await text('.page-collection .list-count')) === '내 소장 2개', await text('.page-collection .list-count'));
    const tera = '.page-collection .gcard:has(.card-link:text-is("테라포밍 마스"))';
    const teraRec = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.bg);
    check('게임 카드: 인원·시간·장르 · 횟수·최근 날짜·평균 별점', (await text(`${tera} .gcard-info`)) === '1~5명 · 90~120분 · 전략' && (await text(`${tera} .gcard-plays`)) === '1번 했어요' &&
      (await text(`${tera} .gcard-last`)) === `최근 ${teraRec.date.replace(/-/g, '.')}` && (await text(`${tera} .gcard-rating`)) === teraRec.rating.toFixed(1), await text(tera));
    await page.click('.page-collection .seg-type .seg-item:has-text("머더미스터리")');
    check('종류 고르기: 머더미스터리만', JSON.stringify(await texts('.page-collection .gcard-title')) === JSON.stringify(['마지막 야간열차']));
    await page.click('.page-collection .seg-type .seg-item:has-text("전체")');
    await page.selectOption('.page-collection select[aria-label="정렬"]', 'name');
    check('이름순 정렬', JSON.stringify(await texts('.page-collection .gcard-title')) === JSON.stringify(['마지막 야간열차', '테라포밍 마스']));
    await page.selectOption('.page-collection select[aria-label="정렬"]', 'recent');
    await noOverflow('소장 탭');
    await shot('25-collection');

    // 게임 카드 → 게임 상세 (그 게임 기록만 · 플레이 기록하기)
    await page.click(`${tera} .card-link`);
    await page.waitForSelector('.page-game');
    check('게임 카드 → 게임 상세 (그 게임 기록 1개)', (await text('.page-game .ghero-title')) === '테라포밍 마스' && (await page.$$('.page-game .rcard')).length === 1 &&
      (await page.getAttribute('.page-game .ghero-write', 'href')) === `#/new/boardgame?game=${encodeURIComponent(ids.gTera)}`);
    // 게임 정보 전의 예전 기록(내 소장)도 게임 상세로 — 기록은 그대로 두고 '게임 정보로 등록'을 권함
    await tab('collection', '.page-collection');
    await page.click('.page-collection .gcard:has(.card-link:text-is("마지막 야간열차")) .card-link');
    await page.waitForSelector('.page-game');
    check('예전 기록 이름의 게임 상세: 기록 1개 · 게임 정보로 등록 · 이름으로 기록 쓰기', (await page.$$('.page-game .rcard')).length === 1 &&
      !!(await page.$('.page-game .ghero-acts button:has-text("게임 정보로 등록")')) &&
      (await page.getAttribute('.page-game .ghero-write', 'href')) === `#/new/murdermystery?title=${encodeURIComponent('마지막 야간열차')}`, await text('.page-game .ghero'));
    await shot('25a-game-legacy');
    // 그 게임 기록 목록 (게임 필터 칩)
    await go(`#/records?game=${encodeURIComponent(ids.gTera)}`, '.page-list');
    const only = await until(async () => { const x = await cardTitles(); return x.length === 1 && x; });
    check('게임 카드 → 그 게임 기록만', !!only && only[0] === '테라포밍 마스' && (await text('.page-list .achips')).includes('테라포밍 마스'), String(await cardTitles()));
    check('카드에 내 소장 배지 (게임 정보)', (await text('.page-list .rcard .rbadge')) === '내 소장');
    await page.click('.page-list .achips .achip');
    check('게임 필터 해제 → 전체 7개', !!(await until(async () => (await cardTitles()).length === 7)), String(await cardTitles()));
    await page.click('.page-list .seg-type .seg-item:has-text("보드게임")');
    check('보드게임 3개', !!(await until(async () => (await cardTitles()).length === 3)), String(await cardTitles()));
    check('예전 대여 판 카드에 대여 배지', (await texts('.page-list .rcard .rbadge')).filter((x) => x === '대여').length === 2, JSON.stringify(await texts('.page-list .rcard .rbadge')));

    // 소장 필터 (하나만 고름). '대여'는 예전 기록에 대여가 있을 때만
    await page.click('.page-list .list-tools button:has-text("필터")');
    await page.click('.page-list .filter-panel .chip-own:has-text("대여")');
    check('대여 필터 → 2개', !!(await until(async () => { const x = await cardTitles(); return x.length === 2 && x.every((tt) => tt.startsWith('스플렌더')) && x; })), String(await cardTitles()));
    await page.click('.page-list .filter-panel .chip-own:has-text("내 소장")');
    check('내 소장 필터 → 1개 (대여는 풀림)', !!(await until(async () => { const x = await cardTitles(); return x.length === 1 && x[0] === '테라포밍 마스' && x; })) &&
      (await page.getAttribute('.page-list .filter-panel .chip-own:has-text("대여")', 'aria-pressed')) === 'false', String(await cardTitles()));
    await page.click('.page-list .filter-panel .chip-own:has-text("내 소장")');
    check('다시 누르면 해제 → 3개', !!(await until(async () => { const x = await cardTitles(); return x.length === 3 && x; })), String(await cardTitles()));
    // 빌려준 사람 이름으로도 검색
    await page.fill('.page-list .search-input', '도윤');
    check('빌려준 사람으로 검색', !!(await until(async () => { const x = await cardTitles(); return x.length === 1 && x[0].startsWith('스플렌더') && x; }, 3000)), String(await cardTitles()));
    await page.fill('.page-list .search-input', '');
    await page.click('.page-list .seg-type .seg-item:has-text("전체")');
    await page.click('.page-list .list-tools button:has-text("필터")');
    await go('#/records?own=borrowed', '.page-list');
    check('?own=borrowed → 대여한 판 2개 · 종류 전체', !!(await until(async () => { const x = await cardTitles(); return x.length === 2 && x; })) &&
      (await page.$eval('.page-list .seg-type input:checked', (e) => e.value)) === 'all', String(await cardTitles()));
    await page.click('.page-list .achip:has-text("대여")');

    // 기록 폼: 예전 기록에만 있는 이름은 검색 결과에서 눌러 바로 게임으로 등록 (기록은 그대로, 이름으로 합치지 않음)
    await go('#/new/boardgame', '.page-form');
    await page.fill('.page-form .gp-input', '스플');
    const legacyOpt = '.page-form .gp-opt.is-legacy:has(.gp-opt-name:text-is("스플렌더"))';
    await page.waitForSelector(legacyOpt);
    check('예전 기록 이름: 기록 수 · 눌러서 등록', (await text(`${legacyOpt} .gp-opt-meta`)) === '예전 기록 2개 · 눌러서 등록', await text(legacyOpt));
    await page.click(legacyOpt);
    await page.waitForSelector(`${dlg}.dlg-game-form`);
    check('등록 창에 그 이름', (await page.inputValue('[data-field="game-title"]')) === '스플렌더');
    await dialogButton('등록');
    await page.waitForSelector(dlg, { state: 'detached', timeout: 5000 });
    check('등록한 게임이 선택됨', (await pickedGame()) === '스플렌더');
    const spl = (await api('GET', '/api/data')).data.games.find((g) => g.title === '스플렌더');
    const legacyRecs = (await api('GET', '/api/data')).data.records.filter((r) => extra.includes(r.id) && r.type === 'boardgame');
    check('예전 기록은 바꾸지 않음 (gameId 없음)', !!spl && legacyRecs.length === 2 && legacyRecs.every((r) => !r.gameId), JSON.stringify(legacyRecs.map((r) => r.gameId)));
    await page.click('.page-form .savebar button:has-text("취소")');
    await page.waitForSelector(dlg);
    await dialogButton('그만 쓰기');
    await page.waitForSelector('.page-form', { state: 'detached', timeout: 5000 });
    // 같은 이름 게임이 하나뿐이면 예전 기록도 그 게임 기록으로 모아 보여 줌 (보여 줄 때만)
    await go(`#/records?game=${encodeURIComponent(spl.id)}`, '.page-list');
    check('등록한 게임으로 예전 기록 2개를 모아 봄', !!(await until(async () => (await cardTitles()).length === 2)), String(await cardTitles()));
    await page.click('.page-list .achips .achip');
  } finally {
    // 다음 단계의 개수 검사에 섞이지 않게 (중간에 실패해도) 지움
    for (const id of extra) await api('DELETE', `/api/records?id=${encodeURIComponent(id)}`);
    for (const g of (await api('GET', '/api/data')).data.games) if (!gamesBefore.has(g.id)) await api('DELETE', `/api/games?id=${encodeURIComponent(g.id)}`);
    await syncFromServer();
  }
});

await step('소장 게임 등록 · 인원·시간·장르 · 같은 이름 · 메뉴 · 고치기 · 기록 쓰기 · 소장 해제 · 백업', async () => {
  const serverGames = async () => (await api('GET', '/api/data')).data.games;
  const gcard = (title) => `.page-collection .gcard:has(.card-link:text-is("${title}"))`;
  const madeRecords = [];
  const gamesBefore = new Set((await serverGames()).map((g) => g.id));
  const todayDot = TODAY.replace(/-/g, '.');
  try {
    await tab('collection', '.page-collection');
    const before = await texts('.page-collection .gcard-title');
    const playedToday = (await texts('.page-collection .gcard-last')).filter((x) => x === `최근 ${todayDot}`).length;
    check('머리에 ‘게임 등록’ 버튼 (휴대폰에서도 글자)', (await text('.page-collection .head-add')) === '게임 등록' && await page.isVisible('.page-collection .head-add .head-label'));
    await page.click('.page-collection .head-add');
    await page.waitForSelector(dlg);
    check('등록 창', (await text(`${dlg} .dlg-title`)) === '소장 게임 등록' &&
      JSON.stringify(await texts(`${dlg} .dlg-actions button`)) === JSON.stringify(['닫기', '계속 등록', '등록']), JSON.stringify(await texts(`${dlg} .dlg-actions button`)));
    check('이름 칸에 바로 초점', await page.evaluate(() => document.activeElement && document.activeElement.dataset.field === 'game-title'));
    const nameLabel = `${dlg} .field:has([data-field="game-title"]) .field-label`;
    check('기본 종류 보드게임 · 게임 이름 · 종류는 보드게임·머더미스터리만', (await page.$eval(`${dlg} .seg-input:checked`, (e) => e.value)) === 'boardgame' && (await text(nameLabel)) === '게임 이름' &&
      JSON.stringify(await texts(`${dlg} .seg-type .seg-item`)) === JSON.stringify(['보드게임', '머더미스터리']));
    check('소장 탭에서 연 창: 내 소장 기본 선택', await page.isChecked(`${dlg} .gf-own-input`));
    // 보드게임 정보: 인원 · 예상 시간은 나란히, 장르는 그 아래
    const pos = await page.evaluate(() => {
      const r = (sel) => document.querySelector(`dialog[open] ${sel}`).getBoundingClientRect();
      return { p: r('input[aria-label="최소 인원"]').top, t: r('input[aria-label="최소 예상 시간(분)"]').top, g: r('.gf-genres').top };
    });
    check('인원·예상 시간 나란히 · 장르는 아래', Math.abs(pos.p - pos.t) < 2 && pos.g > pos.p + 20, JSON.stringify(pos));
    check('장르 추천 칩 (전략·파티·추리·협력 …)', (await texts(`${dlg} .gf-genres .chip-label`)).slice(0, 4).join() === '전략,파티,추리,협력', JSON.stringify(await texts(`${dlg} .gf-genres .chip-label`)));
    check('보드게임 등록 창: 이름표는 ‘장르’ (인원·예상 시간 칸도 있음)', (await text(`${dlg} .gf-genre-box .field-label`)) === '장르' && await page.isVisible(`${dlg} input[aria-label="장르 직접 추가"]`) &&
      await page.isVisible(`${dlg} .gf-bg`));
    await noOverflow('소장 게임 등록 창');
    await shot('25b-collection-register');

    // 빈 이름은 막음
    await dialogButton('등록');
    check('빈 이름 → 안내 · 창 유지', (await text(`${dlg} .form-err`)) === '게임 이름을 적어 주세요' && !!(await page.$(dlg)));
    // 계속 등록: 인원 1~4 · 시간 30~150 · 장르 2개(하나는 직접) 와 함께 저장하고 칸을 비운 채 창 유지
    await page.fill('[data-field="game-title"]', '아그리콜라');
    await page.fill('[data-field="game-memo"]', '확장 포함');
    await page.fill(`${dlg} input[aria-label="최소 인원"]`, '1');
    await page.fill(`${dlg} input[aria-label="최대 인원"]`, '4');
    await page.fill(`${dlg} input[aria-label="최소 예상 시간(분)"]`, '150');
    await page.fill(`${dlg} input[aria-label="최대 예상 시간(분)"]`, '30');
    await page.click(`${dlg} .gf-genres .chip:has-text("전략")`);
    await page.fill(`${dlg} input[aria-label="장르 직접 추가"]`, '농장');
    await page.press(`${dlg} input[aria-label="장르 직접 추가"]`, 'Enter');
    check('직접 넣은 장르도 칩으로 · 선택됨', (await page.getAttribute(`${dlg} .gf-genres .chip:has-text("농장")`, 'aria-pressed')) === 'true');
    await dialogButton('계속 등록');
    check('최대 시간 < 최소 시간 → 안내', !!(await until(async () => (await text(`${dlg} .form-err`)) === '최대 시간이 최소 시간보다 짧아요')));
    await page.fill(`${dlg} input[aria-label="최소 예상 시간(분)"]`, '30');
    await page.fill(`${dlg} input[aria-label="최대 예상 시간(분)"]`, '150');
    await dialogButton('계속 등록');
    const addedLine = await until(async () => { const t = await text(`${dlg} .gform-added`); return t.includes('아그리콜라') && t; });
    check('계속 등록 → 창 유지 · 방금 넣은 이름 안내 · 칸 비움', !!addedLine && (await page.inputValue('[data-field="game-title"]')) === '' &&
      (await page.inputValue('[data-field="game-memo"]')) === '' && (await page.inputValue(`${dlg} input[aria-label="최소 인원"]`)) === '' &&
      await page.evaluate(() => document.activeElement.dataset.field === 'game-title'), String(addedLine));
    // 같은 종류·같은 이름(공백·대소문자 무시)은 먼저 보여 줌 (합치지 않음)
    await page.fill('[data-field="game-title"]', '  아그리콜라 ');
    const dup = await until(async () => { const t = await text(`${dlg} .gf-dup`); return t.includes('같은 이름이 이미 있어요') && t; });
    check('같은 이름 → 기존 게임을 먼저 보여 줌 (이미 내 소장)', !!dup && dup.includes('아그리콜라') && dup.includes('1~4명 · 30~150분') && dup.includes('이미 내 소장'), String(dup));
    await shot('25b2-collection-register-dup');
    // 머더미스터리로 바꾸면 인원·시간 칸은 숨고 장르 자리가 ‘태그’(추천 칩도 작품용)로 바뀜
    await page.click(`${dlg} .seg-item:has-text("머더미스터리")`);
    check('머더미스터리 → 작품 이름 · 보드게임 칸 숨김 · 같은 이름 안내 사라짐', (await text(nameLabel)) === '작품 이름' && await page.isHidden(`${dlg} .gf-bg`) && await page.isHidden(`${dlg} .gf-dup`));
    check('머더미스터리 → 장르 대신 ‘태그’ 칸 · 작품 태그 추천 칩', (await text(`${dlg} .gf-genre-box .field-label`)) === '태그' && await page.isVisible(`${dlg} .gf-genre-box`) &&
      (await texts(`${dlg} .gf-genres .chip-label`)).slice(0, 4).join() === '추리중심,RP중심,감성,반전' && !!(await page.$(`${dlg} input[aria-label="태그 직접 추가"]`)), JSON.stringify(await texts(`${dlg} .gf-genres .chip-label`)));
    await page.click(`${dlg} .seg-item:has-text("보드게임")`);
    check('다시 보드게임 → ‘장르’ 이름표 · 장르 추천 칩', (await text(`${dlg} .gf-genre-box .field-label`)) === '장르' && (await texts(`${dlg} .gf-genres .chip-label`)).slice(0, 4).join() === '전략,파티,추리,협력' && await page.isVisible(`${dlg} .gf-bg`));
    await page.click(`${dlg} .seg-item:has-text("머더미스터리")`);
    await page.fill('[data-field="game-title"]', '열차 밖의 밤');
    await page.click(`${dlg} .gf-genres .chip:has-text("호러")`);
    await page.fill(`${dlg} input[aria-label="태그 직접 추가"]`, '열차물');
    await page.press(`${dlg} input[aria-label="태그 직접 추가"]`, 'Enter');
    check('태그 두 개 선택 (추천 칩 + 직접 추가)', JSON.stringify(await texts(`${dlg} .gf-genres .chip[aria-pressed="true"] .chip-label`)) === JSON.stringify(['호러', '열차물']), JSON.stringify(await texts(`${dlg} .gf-genres .chip[aria-pressed="true"] .chip-label`)));
    await page.press('[data-field="game-title"]', 'Enter');
    await page.waitForSelector(dlg, { state: 'detached', timeout: 5000 });
    check('닫으면 몇 개 등록했는지 알림', !!(await toastSeen(/소장 게임 2개를 등록했어요/)), String(await texts('.toast')));
    let games = await serverGames();
    const agri = games.find((g) => g.title === '아그리콜라');
    check('서버: 내 소장 · 인원 1~4 · 시간 30~150 · 장르 2개', agri && agri.type === 'boardgame' && agri.owned === true && agri.memo === '확장 포함' &&
      agri.playersMin === 1 && agri.playersMax === 4 && agri.timeMin === 30 && agri.timeMax === 150 && JSON.stringify(agri.genres) === '["전략","농장"]', JSON.stringify(agri));
    check('서버: 머더미스터리도 내 소장 · 태그는 genres 에', games.some((g) => g.type === 'murdermystery' && g.title === '열차 밖의 밤' && g.owned === true && JSON.stringify(g.genres) === JSON.stringify(['호러', '열차물'])), JSON.stringify(games));
    check('서버: 머더미스터리 작품에는 인원·시간 값 없음', games.filter((g) => g.title === '열차 밖의 밤').every((g) => !('playersMin' in g) && !('timeMin' in g)), JSON.stringify(games.filter((g) => g.title === '열차 밖의 밤')));

    // 목록: 기록이 없어도 소장에 보임
    const after = await texts('.page-collection .gcard-title');
    check('소장 목록에 함께 보임 · 개수', after.length === before.length + 2 && after.includes('아그리콜라') && after.includes('열차 밖의 밤') &&
      (await text('.page-collection .list-count')) === `내 소장 ${before.length + 2}개`, JSON.stringify(after));
    check('최근 순: 방금 등록한 게임이 위로', after.indexOf('열차 밖의 밤') < after.indexOf('아그리콜라') && after.indexOf('아그리콜라') < playedToday + 2, `${JSON.stringify(after)} · 오늘 한 게임 ${playedToday}`);
    check('안 해 본 게임 카드: 인원·시간·장르 · 안내 · 등록일 · 메모 · 메뉴', (await text(`${gcard('아그리콜라')} .gcard-info`)) === '1~4명 · 30~150분 · 전략, 농장' &&
      (await text(`${gcard('아그리콜라')} .gcard-plays`)) === '아직 안 해 봤어요' && (await text(`${gcard('아그리콜라')} .gcard-last`)) === `${todayDot} 등록` &&
      (await text(`${gcard('아그리콜라')} .gcard-memo`)) === '확장 포함' && !!(await page.$(`${gcard('아그리콜라')} .gcard-more`)), await text(gcard('아그리콜라')));
    check('머더미스터리 카드: 정보 줄에 태그', (await text(`${gcard('열차 밖의 밤')} .gcard-info`)) === '호러, 열차물', await text(gcard('열차 밖의 밤')));
    await page.selectOption('.page-collection select[aria-label="정렬"]', 'plays');
    check('많이 한 순: 안 해 본 게임은 뒤로', (await texts('.page-collection .gcard-title')).slice(-2).every((x) => ['아그리콜라', '열차 밖의 밤'].includes(x)));
    await page.selectOption('.page-collection select[aria-label="정렬"]', 'recent');
    await noOverflow('소장 (등록한 게임)');
    await shot('25c-collection-games');

    // 메뉴(⋯): 안 해 본 게임이라 '기록 보기'는 없고, 기록이 없으니 지우기도 가능
    await page.click(`${gcard('아그리콜라')} .gcard-more`);
    await page.waitForSelector(dlg);
    check('메뉴: 제목 · 정보 · 메모 · 항목', (await text(`${dlg} .dlg-title`)) === '아그리콜라' && (await text(`${dlg} .gmenu-memo`)) === '확장 포함' &&
      (await text(`${dlg} .gmenu-meta`)) === '1~4명 · 30~150분 · 전략, 농장' &&
      JSON.stringify(await texts(`${dlg} .gmenu-item`)) === JSON.stringify(['이 게임으로 새 기록 쓰기', '게임 정보 수정', '소장에서 빼기', '게임 정보 삭제']), JSON.stringify(await texts(`${dlg} .gmenu-item`)));
    await shot('25d-collection-game-menu');
    await page.click(`${dlg} .gmenu-item:has-text("게임 정보 수정")`);
    await page.waitForSelector(`${dlg} .dlg-title:text-is("게임 정보 수정")`);
    check('고치기: 지금 값 · 취소/저장', (await page.inputValue('[data-field="game-title"]')) === '아그리콜라' && (await page.inputValue('[data-field="game-memo"]')) === '확장 포함' &&
      (await page.inputValue(`${dlg} input[aria-label="최대 인원"]`)) === '4' && (await page.getAttribute(`${dlg} .gf-genres .chip:has-text("농장")`, 'aria-pressed')) === 'true' &&
      JSON.stringify(await texts(`${dlg} .dlg-actions button`)) === JSON.stringify(['취소', '저장']));
    await page.fill('[data-field="game-memo"]', '확장 2개 포함');
    await page.fill(`${dlg} input[aria-label="최소 인원"]`, '');
    await page.fill(`${dlg} input[aria-label="최대 인원"]`, '2');
    await dialogButton('저장');
    await page.waitForSelector(dlg, { state: 'detached', timeout: 5000 });
    const agri2 = (await serverGames()).find((g) => g.id === agri.id);
    check('고친 정보 반영 (같은 id) · 한 칸만 적으면 고정 인원', !!(await toastSeen(/게임 정보를 고쳤어요/)) && (await text(`${gcard('아그리콜라')} .gcard-memo`)) === '확장 2개 포함' &&
      agri2.memo === '확장 2개 포함' && agri2.playersMin === 2 && agri2.playersMax === 2 && (await text(`${gcard('아그리콜라')} .gcard-info`)).startsWith('2명 · '), JSON.stringify(agri2));

    // 안 해 본 게임 카드도 게임 상세로 → 플레이 기록하기 (게임이 골라진 채)
    await page.click(`${gcard('열차 밖의 밤')} .card-link`);
    await page.waitForSelector('.page-game');
    check('작품 상세에도 태그', (await text('.page-game .ghero-info')) === '호러, 열차물', await text('.page-game .ghero'));
    check('안 해 본 게임 상세: 아직 안 해 봤어요 · 기록 없음 안내', (await text('.page-game .ghero-stat')).startsWith('아직 안 해 봤어요') && !(await page.$('.page-game .rcard')) &&
      !!(await page.$('.page-game .ghero-none')) && !!(await page.$('.page-game .ghero-more button:has-text("게임 정보 삭제")')), await text('.page-game'));
    await page.click('.page-game .ghero-write');
    await page.waitForSelector('.page-form.t-murdermystery');
    check('새 기록: 그 게임이 골라진 채', (await pickedGame()) === '열차 밖의 밤');
    await page.click('.save-btn');
    await page.waitForSelector('.page-detail', { timeout: 8000 });
    madeRecords.push(decodeURIComponent(page.url().split('#/record/')[1] || ''));
    const train = (await serverGames()).find((g) => g.title === '열차 밖의 밤');
    const rec = (await api('GET', '/api/data')).data.records.find((r) => r.id === madeRecords[0]);
    check('저장된 기록: 그 게임과 연결 · 소장 여부는 기록에 안 씀', rec && rec.title === '열차 밖의 밤' && rec.gameId === train.id && rec.mm.ownership === null, JSON.stringify(rec));
    await tab('collection', '.page-collection');
    check('기록을 쓰면 횟수가 붙고 그 게임 기록으로 이어짐', (await text(`${gcard('열차 밖의 밤')} .gcard-plays`)) === '1번 했어요' &&
      !!(await page.$(`${gcard('열차 밖의 밤')} a.card-link`)) && !!(await page.$(`${gcard('열차 밖의 밤')} .gcard-more`)));
    await page.click(`${gcard('열차 밖의 밤')} .gcard-more`);
    await page.waitForSelector(dlg);
    check('해 본 게임 메뉴엔 기록 보기 · 지우기는 없음', (await texts(`${dlg} .gmenu-item`))[0] === '기록 1개 보기' && !(await page.$(`${dlg} .gmenu-item:has-text("게임 정보 삭제")`)));

    // 소장 해제: 소장 여부만 바꿈 — 게임 정보와 지난 기록은 그대로, 기록할 때 계속 고를 수 있음
    await page.click(`${dlg} .gmenu-item:has-text("소장에서 빼기")`);
    await page.waitForSelector(`${dlg} .dlg-title:text-is("소장에서 뺄까요?")`);
    check('확인 문구: 게임 정보·기록은 그대로', (await text(`${dlg} .dlg-text`)).includes('게임 정보와 지난 기록은 그대로'));
    await dialogButton('빼기');
    check('소장 해제 → 목록에서 사라짐', !!(await toastSeen(/소장에서 뺐어요/)) && !!(await until(async () => !(await page.$(gcard('열차 밖의 밤'))))));
    const train2 = (await serverGames()).find((g) => g.id === train.id);
    const rec2 = (await api('GET', '/api/data')).data.records.find((r) => r.id === madeRecords[0]);
    check('서버: 게임 정보는 남고 소장만 해제 · 기록 연결 그대로', train2 && train2.owned === false && train2.title === '열차 밖의 밤' && rec2 && rec2.gameId === train.id, JSON.stringify(train2));
    await go('#/new/murdermystery', '.page-form');
    await page.fill('.page-form .gp-input', '열차');
    const trainOpt = '.page-form .gp-opt:has(.gp-opt-name:text-is("열차 밖의 밤"))';
    await page.waitForSelector(trainOpt);
    check('소장을 해제해도 기록에서 검색·선택 가능 (내 소장 표시만 없음)', !(await text(`${trainOpt} .gp-opt-meta`)).includes('내 소장'), await text(trainOpt));
    await page.click('.page-form .appbar button[aria-label="뒤로"]');
    await page.waitForSelector('.page-collection, .page-detail, .page-home, .page-list', { timeout: 5000 });

    // 설정: 숫자 · 내보내기에 게임 정보 포함 · 가져오기
    await tab('settings', '.page-settings');
    const nGames = (await serverGames()).length;
    check('설정: 게임 개수', (await text('.conn-meta')).includes(`게임 ${nGames}개`), await text('.conn-meta'));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.page-settings button:has-text("내보내기")')]);
    const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    const exAgri = (exported.games || []).find((g) => g.id === agri.id);
    check('내보내기: 게임 정보(인원·장르·소장) 포함', exported.games.length === nGames && exAgri && exAgri.memo === '확장 2개 포함' && exAgri.owned === true && exAgri.genres.length === 2, JSON.stringify(exAgri));
    check('내보내기 토스트에 게임', !!(await toastSeen(new RegExp(`게임 ${nGames}개`))));
    const backup = path.join(SHOTS, '..', 'games-backup.json');
    writeFileSync(backup, JSON.stringify({
      app: 'ddoddohouse-record', version: 1, records: [], members: [],
      games: [
        { id: 'bk-game-1', type: 'boardgame', title: '카르카손', memo: '', createdAt: '2025-01-02T03:04:05.000Z' }, // 예전 백업: 소장 여부가 없으면 내 소장
        { id: 'bk-game-2', type: 'boardgame', title: '아그리콜라 ', memo: '다른 기기' }, // 기록에 안 쓰인 같은 이름 → 이미 있음
        { id: 'bk-game-3', type: 'escaperoom', title: '연구소', brand: '비트포비아' }, // 방탈출 테마도 게임 정보로
      ],
    }));
    await page.setInputFiles('#import-file', backup);
    await page.waitForSelector(dlg);
    const counts = await text(`${dlg} .import-counts`);
    check('가져오기 미리보기: 게임 새로 2 · 이미 있음 1', counts.includes('게임 3개 — 새로 2 · 이미 있음 1'), counts);
    await dialogButton('가져오기');
    check('가져오기 완료 (실패 없음)', !!(await toastSeen(/가져오기 완료: 성공 2(?!\d)(?!.*실패)/, 8000)), String(await texts('.toast')));
    games = await serverGames();
    const carc = games.find((g) => g.id === 'bk-game-1');
    const lab = games.find((g) => g.id === 'bk-game-3');
    check('서버: 같은 id·등록 시각 · 예전 백업은 내 소장 · 테마는 소장 없음', carc && carc.createdAt === '2025-01-02T03:04:05.000Z' && carc.owned === true &&
      lab && lab.owned === false && lab.brand === '비트포비아' && games.find((g) => g.id === agri.id).memo === '확장 2개 포함' && !games.some((g) => g.id === 'bk-game-2'), JSON.stringify(games));

    // 기록이 없는 게임은 지울 수 있음
    await tab('collection', '.page-collection');
    check('가져온 게임도 소장에 (테마는 없음)', (await texts('.page-collection .gcard-title')).includes('카르카손') && !(await texts('.page-collection .gcard-title')).includes('연구소'));
    await page.click(`${gcard('아그리콜라')} .gcard-more`);
    await page.waitForSelector(dlg);
    await page.click(`${dlg} .gmenu-item:has-text("게임 정보 삭제")`);
    await page.waitForSelector(`${dlg} .dlg-title:text-is("게임 정보를 지울까요?")`);
    await dialogButton('지우기');
    check('기록 없는 게임 정보 삭제', !!(await toastSeen(/게임 정보를 지웠어요/)) && !!(await until(async () => !(await page.$(gcard('아그리콜라'))))) &&
      !(await serverGames()).some((g) => g.id === agri.id));
  } finally {
    for (const id of madeRecords) if (id) await api('DELETE', `/api/records?id=${encodeURIComponent(id)}`);
    for (const g of await serverGames()) if (!gamesBefore.has(g.id)) await api('DELETE', `/api/games?id=${encodeURIComponent(g.id)}`);
    await syncFromServer();
  }
});

await step('푸터: 모든 화면 맨 아래 제작자 표시 (탭 막대에 가리지 않음)', async () => {
  for (const [hash, sel] of [['#/', '.page-home'], ['#/collection', '.page-collection'], ['#/settings', '.page-settings']]) {
    await go(hash, sel);
    check(`${hash}: 푸터 문구 (이메일은 ‘문의’ 링크)`, (await text('.app-foot')) === '© 2026 김연경 · 문의' &&
      (await page.getAttribute('.app-foot a', 'href')) === 'mailto:earthssaem@gmail.com', await text('.app-foot'));
    check(`${hash}: 푸터는 작게`, await page.$eval('.app-foot', (e) => parseFloat(getComputedStyle(e).fontSize) <= 11.5));
    const pos = await page.evaluate(() => {
      scrollTo(0, document.scrollingElement.scrollHeight);
      const f = document.querySelector('.app-foot').getBoundingClientRect();
      const bar = document.getElementById('tabbar').getBoundingClientRect();
      return { bottom: Math.round(f.bottom - parseFloat(getComputedStyle(document.querySelector('.app-foot')).paddingBottom)), barTop: Math.round(bar.top) };
    });
    check(`${hash}: 맨 아래로 내리면 탭 막대 위에 보임`, pos.bottom <= pos.barTop, JSON.stringify(pos));
  }
  await go('#/', '.page-home');
});

let exportFile = null;
await step('설정: 내보내기 · 가져오기', async () => {
  await tab('home', '.page-home');
  await page.click('#tabbar .tab-settings');
  await page.waitForSelector('.page-settings');
  check('연결됨 표시', (await text('.conn-label')) === '연결됨');
  await noOverflow('설정');
  await shot('25-settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.page-settings button:has-text("내보내기")')]);
  exportFile = path.join(SHOTS, '..', 'export.json');
  await dl.saveAs(exportFile);
  const json = JSON.parse(readFileSync(exportFile, 'utf8'));
  check('파일 이름', /^ddoddohouse-backup-\d{8}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  check('JSON: 기록 4 · 멤버 3', json.records.length === 4 && json.members.length === 3, `${json.records.length}/${json.members.length}`);
  check('JSON: 앱 표시·세부 블록 포함 (내 역할도)', json.app === 'ddoddohouse-record' && json.records.find((r) => r.id === ids.mm).mm.roles.length === 3 && json.records.find((r) => r.id === ids.mm).mm.myRole === '마르타');

  // 서버에서 기록 하나를 지운 뒤 백업에서 되살리기
  const before = json.records.find((r) => r.id === ids.er0);
  check('삭제 API', (await api('DELETE', `/api/records?id=${encodeURIComponent(ids.er0)}`)).status === 200);
  await page.click('.page-settings button:has-text("새로고침")');
  check('새로고침 반영 (기록 3개)', !!(await until(async () => (await text('.conn-meta')).includes('기록 3개'))), await text('.conn-meta'));
  await page.setInputFiles('#import-file', exportFile);
  await page.waitForSelector(dlg);
  const counts = await text(`${dlg} .import-counts`);
  check('가져오기 미리보기', counts.includes('기록 4개') && counts.includes('새로 1') && counts.includes('멤버 3명'), counts);
  await shot('26-import-preview');
  await dialogButton('가져오기');
  check('가져오기 완료 토스트', !!(await toastSeen(/가져오기 완료: 성공 1(?!\d)/, 8000)), String(await texts('.toast')));
  const { data } = await api('GET', '/api/data');
  const back = data.records.find((r) => r.id === ids.er0);
  check('같은 id·createdAt 으로 복원', back && back.createdAt === before.createdAt && back.title === before.title && back.er.hints === 3, JSON.stringify(back));
  check('기록 4개로 복구', data.records.length === 4);
  check('설정 화면 숫자 갱신', !!(await until(async () => (await text('.conn-meta')).includes('기록 4개'))));

  // 덮어쓰기 모드: 서버 쪽 변경을 백업 내용으로 되돌림
  const cur = data.records.find((r) => r.id === ids.bg);
  await api('POST', '/api/records', { record: { ...cur, review: '다른 기기에서 바꿈' }, baseUpdatedAt: cur.updatedAt });
  await page.setInputFiles('#import-file', exportFile);
  await page.waitForSelector(dlg);
  await page.click(`${dlg} .seg-item:has-text("덮어쓰기")`);
  // 화면이 모르는 서버 쪽 변경 → 409 한 번 받은 뒤 최신 기준으로 다시 저장 (의도된 409)
  await allowing([/status of 409/], async () => {
    await dialogButton('가져오기');
    // 멤버 3 + 게임 정보 + 기록 4 (모두 같은 id 로 덮어씀)
    const n = json.members.length + json.games.length + json.records.length;
    check('덮어쓰기 가져오기 완료', !!(await toastSeen(new RegExp(`가져오기 완료: 성공 ${n}(?!\\d)`), 10000)), String(await texts('.toast')));
  });
  const after = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.bg);
  check('덮어쓰기로 백업 내용 복원', after.review.startsWith('화성 개척은 언제나 옳다') && after.gameId === ids.gTera, after.review);
});

await step('오프라인 (캐시 열람 · 저장 차단)', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await until(() => page.evaluate(() => !!navigator.serviceWorker.controller), 5000);
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys.find((k) => k.startsWith('ddoddohouse-record-')));
    return (await c.keys()).map((r) => new URL(r.url).pathname);
  });
  check('서비스 워커 사전 캐시', cached.includes('/js/main.js') && cached.includes('/css/app.css') && cached.includes('/js/stats.js'), `${cached.length}개`);
  check('API 응답은 캐시 안 됨', !cached.some((p) => p.startsWith('/api/')));
  // 주소창으로 다른 파일을 열어도 앱 셸 캐시가 덮어써지지 않아야 함
  // (브라우저의 텍스트 파일 보기 화면이 스스로 넣는 인라인 style 은 CSP 에 막히는 게 정상 → 이 구간만 제외)
  // 텍스트 파일을 열면 브라우저가 /favicon.ico 도 찾아보므로 이 구간의 404 도 제외
  await allowing([/Refused to apply inline style/, /status of 404/], async () => {
    await page.goto(`${BASE}/robots.txt`);
    await sleep(500);
  });
  for (let i = cspViolations.length - 1; i >= 0; i--) if (cspViolations[i].includes('/robots.txt')) cspViolations.splice(i, 1);
  await page.goto(`${BASE}/#/records`);
  await page.waitForSelector('.page-list');
  const shell = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys.find((k) => k.startsWith('ddoddohouse-record-')));
    const r = await c.match('/index.html');
    return r ? (await r.text()).slice(0, 200) : '';
  });
  check('캐시된 앱 셸은 HTML 그대로', shell.includes('<!doctype html>'), shell.slice(0, 60));
  await ctx.setOffline(true);
  await allowing([/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR/], async () => {
    await page.reload();
    await page.waitForSelector('.page-list', { timeout: 8000 });
    const titles = await until(async () => { const t = await cardTitles(); return t.length === 4 && t; });
    check('오프라인 새로고침에도 기록 4개', !!titles, String(await cardTitles()));
    const banner = await until(async () => (await page.$eval('#banner', (e) => !e.hidden)) && text('#banner'));
    check('오프라인 안내 띠', /오프라인/.test(banner || ''), banner);
    await shot('27-offline');
    await go(`#/edit/${encodeURIComponent(ids.bg)}`, '.page-form');
    await page.fill(REVIEW, '오프라인 수정 시도');
    await page.click('.save-btn');
    check('오프라인 저장 안내', !!(await toastSeen(/오프라인이라 저장할 수 없어요/)));
    check('초안 보관', await page.evaluate(() => (JSON.parse(localStorage.getItem('ddh:draft') || 'null') || {}).model?.review) === '오프라인 수정 시도');
  });
  await ctx.setOffline(false);
  await page.click('.page-form .savebar button:has-text("취소")');
  await page.waitForSelector(dlg);
  await dialogButton('그만 쓰기');
  await page.waitForSelector('.page-detail, .page-list', { timeout: 5000 });
  check('취소하면 초안 삭제', (await page.evaluate(() => localStorage.getItem('ddh:draft'))) === null);
  const hidden = await until(() => page.$eval('#banner', (e) => e.hidden), 6000);
  check('다시 온라인 → 안내 띠 사라짐', !!hidden);
});

await step('다크 테마', async () => {
  await go('#/settings', '.page-settings');
  await page.click('.page-settings .seg-item:has-text("다크")');
  check('data-theme=dark', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  const bg = await bodyBg();
  check('배경이 어두움', isDarkColor(bg), bg);
  check('테마 기억', (await page.evaluate(() => localStorage.getItem('ddh:theme'))) === 'dark');
  theme = 'dark';
  const screens = [
    ['#/', '.page-home', 'home'],
    ['#/records', '.page-list', 'list'],
    [`#/record/${encodeURIComponent(ids.bg)}`, '.page-detail', 'detail-boardgame'],
    [`#/record/${encodeURIComponent(ids.mm)}`, '.page-detail', 'detail-murdermystery'],
    [`#/record/${encodeURIComponent(ids.er)}`, '.page-detail', 'detail-escaperoom'],
    ['#/new/boardgame', '.page-form', 'form-boardgame'],
    ['#/new/murdermystery', '.page-form', 'form-murdermystery'],
    ['#/new/escaperoom', '.page-form', 'form-escaperoom'],
    ['#/stats', '.page-stats', 'stats'],
    ['#/members', '.page-members', 'members'],
    [`#/member/${encodeURIComponent(ids['연경'])}`, '.page-profile', 'member-profile'],
    ['#/settings', '.page-settings', 'settings'],
  ];
  for (const [hash, sel, name] of screens) {
    await go(hash, sel);
    if (name === 'form-murdermystery') await page.fill('.page-form [data-field="mm.myRole"]', '마르타'); // 내 역할 칸이 채워진 모습도 확인
    await noOverflow(`다크 ${name}`);
    await shot(name);
  }
  for (const seg of ['보드게임', '머더미스터리', '방탈출']) {
    await go('#/stats', '.page-stats');
    await page.click(`.page-stats .seg-type .seg-item:has-text("${seg}")`);
    await sleep(100);
    await noOverflow(`다크 통계 ${seg}`);
    await shot(`stats-${seg}`);
  }
  await page.click('#tabbar [data-tab="members"]');
  await page.waitForSelector('.page-members');
  await page.click('.page-members .page-head button[aria-label="멤버 추가"]');
  await page.waitForSelector(dlg);
  await shot('member-dialog');
  await dialogButton('취소');
  // 새 폼 초안은 지워 둠
  await page.evaluate(() => localStorage.removeItem('ddh:draft'));

  // 시스템 테마 + OS 다크
  await go('#/settings', '.page-settings');
  await page.click('.page-settings .seg-item:has-text("시스템")');
  await page.emulateMedia({ colorScheme: 'dark' });
  check('시스템 + OS 다크 → 어두움', isDarkColor(await bodyBg()), await bodyBg());
  await page.emulateMedia({ colorScheme: 'light' });
  check('시스템 + OS 라이트 → 밝음', !isDarkColor(await bodyBg()), await bodyBg());
  await page.click('.page-settings .seg-item:has-text("다크")');
  await page.emulateMedia({ colorScheme: 'light' });
  check('수동 다크는 OS 라이트보다 우선', isDarkColor(await bodyBg()));
  await page.click('.page-settings .seg-item:has-text("라이트")');
  await page.emulateMedia({ colorScheme: 'dark' });
  check('수동 라이트는 OS 다크보다 우선', !isDarkColor(await bodyBg()));
  await page.emulateMedia({ colorScheme: 'light' });
  theme = 'light';
});

await step('좁은 화면 (320px) 가로 넘침', async () => {
  await page.setViewportSize({ width: 320, height: 640 });
  const screens = [
    ['#/', '.page-home'], ['#/records', '.page-list'], [`#/record/${encodeURIComponent(ids.mm)}`, '.page-detail'],
    [`#/record/${encodeURIComponent(ids.er)}`, '.page-detail'], [`#/edit/${encodeURIComponent(ids.bg)}`, '.page-form'],
    [`#/edit/${encodeURIComponent(ids.mm)}`, '.page-form'], [`#/edit/${encodeURIComponent(ids.er)}`, '.page-form'],
    ['#/stats', '.page-stats'], ['#/members', '.page-members'], ['#/settings', '.page-settings'], ['#/collection', '.page-collection'],
  ];
  for (const [hash, sel] of screens) {
    await go(hash, sel);
    await noOverflow(`320px ${hash}`);
    if (hash === `#/edit/${encodeURIComponent(ids.er)}`) await shot('320-form-escaperoom');
    if (hash === `#/record/${encodeURIComponent(ids.mm)}`) await shot('320-detail-murdermystery');
    if (sel === '.page-form') {
      await page.click('.page-form .savebar button:has-text("취소")');
      await sleep(150);
    }
  }
  // 320px 에서도 탭 막대 일곱 칸이 넘치지 않고 새 기록 버튼은 가운데
  await go('#/', '.page-home');
  const bar320 = await page.$$eval('#tabbar > a', (els) => els.filter((e) => e.getBoundingClientRect().width > 0)
    .map((e) => { const b = e.getBoundingClientRect(); return { cls: e.className, l: b.left, r: b.right, mid: b.left + b.width / 2 }; }));
  const plus320 = bar320.find((x) => x.cls.includes('tab-add'));
  check('320px 탭 막대: 일곱 칸이 화면 안 · 새 기록 버튼 가운데', bar320.length === 7 && bar320.every((x) => x.l >= 0 && x.r <= 320) && !!plus320 && Math.abs(plus320.mid - 160) < 2, JSON.stringify(bar320));
  for (const seg of ['보드게임', '머더미스터리', '방탈출']) {
    await go('#/stats', '.page-stats');
    await page.click(`.page-stats .seg-type .seg-item:has-text("${seg}")`);
    await noOverflow(`320px 통계 ${seg}`);
  }
  await go('#/stats', '.page-stats');
  await page.click('.page-stats .seg-type .seg-item:has-text("머더미스터리")');
  await shot('320-stats-murdermystery');
  await page.click('.page-stats .seg-type .seg-item:has-text("전체")');
  await page.setViewportSize(VIEWPORT);
});

await step('401 → 키 삭제 후 잠금, 링크 붙여넣기로 다시 열기', async () => {
  await go('#/', '.page-home');
  await page.evaluate(() => localStorage.setItem('ddh:key', 'someone-elses-old-code-123'));
  await allowing([/status of 401/], async () => {
    await page.reload();
    await page.waitForSelector('.lock .lock-notice', { timeout: 8000 });
  });
  check('401 안내 문구', (await text('.lock-notice')).includes('코드가 바뀌었거나'));
  check('키 삭제', (await localKey()) === null);
  check('캐시 삭제', (await page.evaluate(() => localStorage.getItem('ddh:cache'))) === null);
  check('기록 내용이 화면에 남지 않음', !(await page.$('.rcard')));
  await page.fill('#lock-key', `${BASE}/#k=${encodeURIComponent(SECRET)}`);
  await page.click('.lock-form button[type="submit"]');
  await page.waitForSelector('.page-home', { timeout: 8000 });
  check('링크 붙여넣기로 열림', (await localKey()) === SECRET);
  check('데이터 다시 표시', (await text('.page-home .sum-total .sum-num')) === '4');
});

await step('잠금 해제 정보 지우기', async () => {
  await setMeLS(ids['연경']); // 이 기기의 ‘나’ 도 함께 지워져야 함
  await page.click('#tabbar .tab-settings');
  await page.waitForSelector('.page-settings');
  await page.click('.page-settings button:has-text("이 기기에서 잠금 해제 정보 지우기")');
  await page.waitForSelector(dlg);
  check('확인 문구에 받아 둔 사진도 지운다는 안내', (await text(`${dlg} .dlg-text`)).includes('받아 둔 사진'));
  const cleared = page.waitForResponse((r) => new URL(r.url()).pathname === '/clear-cache.txt', { timeout: 5000 }).catch(() => null);
  await dialogButton('지우기');
  await page.waitForSelector('.lock', { timeout: 5000 });
  check('잠금 화면으로', true);
  // 헤더는 브라우저가 처리하고 감춤 — 실제로 캐시가 비는지는 사진 단계에서 확인
  const cr = await cleared;
  check('브라우저 캐시(받아 둔 사진)도 비우라고 요청 (/clear-cache.txt)', !!cr && cr.status() === 200, cr ? String(cr.status()) : '요청 없음');
  check('키·캐시·초안·나 삭제', await page.evaluate(() => ['ddh:key', 'ddh:cache', 'ddh:draft', 'ddh:me'].every((k) => localStorage.getItem(k) === null)));
  check('주소창 초기화', page.url().endsWith('#/') || !page.url().includes('#/settings'), page.url());
  await page.reload();
  await page.waitForSelector('.lock');
  check('새로고침해도 잠금', !(await page.$('#tabbar:not([hidden])')));
  await shot('28-lock-after-wipe');
});

// ═════════════════════════════════════════════════════════════
// 리뷰 반영 점검 — 보안 · 데이터 유실 · 첫 로딩 · 접근성 (새 브라우저 컨텍스트에서)
const c3 = await newContext();
page = await c3.newPage();
watch(page, '[review] ');
const failCount = async () => Number((await srv.redis.get('ddh:fail:127.0.0.1')) || 0);
/** 서버 최신본을 받아 올 때까지 (다른 기기 변경 흉내 뒤) */
async function syncFromServer() {
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/data') && r.request().method() === 'GET', { timeout: 8000 }),
    page.evaluate(() => window.dispatchEvent(new Event('online'))),
  ]);
  await sleep(150);
}
const draftNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('ddh:draft') || 'null'));

await step('보안: 다른 사이트의 키 없는 요청(<img>·preflight)으로 잠기지 않음', async () => {
  await page.goto(`${BASE}/#k=${encodeURIComponent(SECRET)}`);
  await page.waitForSelector('.page-home .summary', { timeout: 8000 });
  const before = await failCount();
  // 다른 출처(포트가 다른 서버)의 악성 페이지: 방문자 브라우저로 키 없는 요청 25번 + 키를 붙인 교차 출처 fetch(→ preflight)
  const http = await import('node:http');
  const evil = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><body><script>
      for (let i = 0; i < 25; i++) new Image().src = ${JSON.stringify(BASE)} + '/api/data?i=' + i;
      fetch(${JSON.stringify(BASE)} + '/api/data', { headers: { 'x-app-key': 'guess-guess-guess' } }).catch(() => {});
      fetch(${JSON.stringify(BASE)} + '/api/records', { method: 'POST', body: 'x' }).catch(() => {});
      setTimeout(() => { document.title = 'done'; }, 800);
    </script></body>`);
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const ep = await c3.newPage();
  await ep.goto(`http://127.0.0.1:${evil.address().port}/`);
  await until(async () => (await ep.title()) === 'done', 5000);
  await sleep(300);
  await ep.close();
  await new Promise((r) => evil.close(r));
  const after = await failCount();
  check('키 없는 교차 사이트 요청은 실패 횟수로 안 셈', after === before, `${before} → ${after}`);
  const res = await page.evaluate(async (key) => (await fetch('/api/data', { headers: { 'x-app-key': key } })).status, SECRET);
  check('그 뒤에도 맞는 코드로 200 (잠기지 않음)', res === 200, String(res));
});

await step('보안: 틀린 링크를 열어도 쓰던 코드·기기 사본 유지, 새 코드는 확인 뒤에만 교체', async () => {
  await page.waitForSelector('.page-home .summary');
  const cacheBefore = await page.evaluate(() => !!localStorage.getItem('ddh:cache'));
  await allowing([/status of 401/], async () => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#k=wrong-link-code-000000`);
    check('틀린 링크 안내', !!(await toastSeen(/링크의 코드가 맞지 않아 기존 코드로 열었어요/, 6000)), String(await texts('.toast')));
  });
  check('쓰던 코드 그대로', (await localKey()) === SECRET);
  check('기기 사본 그대로', cacheBefore && (await page.evaluate(() => !!localStorage.getItem('ddh:cache'))));
  check('잠금 화면으로 가지 않음', !(await page.$('.lock')) && !!(await page.$('.page-home')));
  check('주소창에서 링크 코드 제거', !page.url().includes('k='), page.url());
  // 반대로: 기기에 예전 코드가 남아 있고 새 링크를 열면 → 서버 확인 뒤 교체
  await page.evaluate(() => localStorage.setItem('ddh:key', 'stale-old-code-1234567'));
  await page.goto('about:blank');
  await page.goto(`${BASE}/#k=${encodeURIComponent(SECRET)}`);
  check('새 코드 확인 뒤 교체 안내', !!(await toastSeen(/새 코드로 열었어요/, 6000)), String(await texts('.toast')));
  check('새 코드 저장', (await localKey()) === SECRET);
  await page.waitForSelector('.page-home .summary', { timeout: 8000 });
  check('데이터 표시', Number(await text('.page-home .sum-total .sum-num')) > 0);
});

await step('데이터: 응답만 못 받은 새 기록을 고쳐서 다시 저장해도 고친 내용이 남음', async () => {
  await go('#/new/boardgame', '.page-form');
  await setGame('응답 유실 테스트');
  await page.fill(REVIEW, '첫 버전 후기');
  let first = true;
  let posts = 0;
  let firstId = null;
  await page.route('**/api/records', async (route) => {
    posts++;
    if (first) {
      first = false;
      const resp = await route.fetch(); // 서버에는 저장됨
      firstId = (await resp.json()).record.id;
      await route.abort('connectionreset'); // …하지만 응답이 끊김
    } else {
      await route.continue();
    }
  });
  await allowing([/status of 409/, /net::ERR/, /Failed to load resource/], async () => {
    await page.click('.save-btn');
    check('온라인인데 응답이 끊기면 ‘오프라인’이 아니라 연결 끊김 안내', !!(await toastSeen(/서버와 연결이 끊겨 저장 결과를 확인하지 못했어요/)), String(await texts('.toast')));
    check('서버엔 첫 버전이 저장됨', (await serverRecord(firstId))?.review === '첫 버전 후기');
    await page.fill(REVIEW, '첫 버전 후기 + 나중에 고친 내용');
    await page.click('.save-btn');
    await page.waitForSelector('.page-detail', { timeout: 8000 });
  });
  await page.unroute('**/api/records');
  check('저장 토스트', !!(await toastSeen(/기록을 저장했어요/)));
  const saved = await serverRecord(firstId);
  check('고친 내용이 서버에 남음 (버려지지 않음)', saved && saved.review === '첫 버전 후기 + 나중에 고친 내용', JSON.stringify(saved && saved.review));
  check('같은 기록 하나만 (중복 없음)', (await api('GET', '/api/data')).data.records.filter((r) => r.title === '응답 유실 테스트').length === 1);
  check('초안 정리', (await draftNow()) === null);
  check('요청 3번 (첫 저장 · 409 · 이어서 저장)', posts === 3, String(posts));

  // 고친 게 없으면 다시 저장하지 않고 그대로 완료
  await go('#/new/boardgame', '.page-form');
  await setGame('응답 유실 그대로');
  first = true; posts = 0;
  await page.route('**/api/records', async (route) => {
    posts++;
    if (first) { first = false; const r = await route.fetch(); firstId = (await r.json()).record.id; await route.abort('connectionreset'); } else await route.continue();
  });
  await allowing([/status of 409/, /net::ERR/, /Failed to load resource/], async () => {
    await page.click('.save-btn');
    await toastSeen(/서버와 연결이 끊겨/);
    await page.click('.save-btn');
    await page.waitForSelector('.page-detail', { timeout: 8000 });
  });
  await page.unroute('**/api/records');
  const same = await serverRecord(firstId);
  check('내용이 같으면 409 뒤 추가 저장 없이 완료', posts === 2 && same && same.createdAt === same.updatedAt, `${posts} ${same && same.updatedAt}`);
});

await step('데이터: 늦게 도착한 새로고침이 방금 저장·삭제한 기록을 되돌리지 않음', async () => {
  let release;
  let fetched = false;
  const hold = new Promise((r) => { release = r; });
  await page.route('**/api/data', async (route) => {
    const resp = await route.fetch(); // 이 시점의 서버 사본 (저장 전)
    fetched = true;
    await hold;
    await route.fulfill({ response: resp });
  });
  await go('#/new/boardgame', '.page-form');
  await setGame('레이스 테스트 게임');
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); // 새로고침 시작 (앱 복귀·재연결과 같음)
  await until(() => fetched, 5000);
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const raceId = decodeURIComponent(page.url().split('#/record/')[1] || '');
  release();
  await sleep(600);
  await page.unroute('**/api/data');
  check('늦은 응답 뒤에도 상세에 그대로', (await text('.dhero-title')) === '레이스 테스트 게임', await text('.page-detail'));
  check('기기 사본에도 남음', await page.evaluate((id) => (JSON.parse(localStorage.getItem('ddh:cache') || '{}').records || []).some((r) => r.id === id), raceId));

  // 삭제도 마찬가지: 늦은 응답에 옛 사본이 있어도 다시 나타나지 않음
  let release2;
  let fetched2 = false;
  const hold2 = new Promise((r) => { release2 = r; });
  await page.route('**/api/data', async (route) => {
    const resp = await route.fetch();
    fetched2 = true;
    await hold2;
    await route.fulfill({ response: resp });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => fetched2, 5000);
  await page.click('.page-detail .appbar button[aria-label="삭제"]');
  await page.waitForSelector(dlg);
  await dialogButton('삭제');
  await page.waitForSelector('.page-list', { timeout: 8000 });
  release2();
  await sleep(600);
  await page.unroute('**/api/data');
  check('삭제한 기록이 다시 나타나지 않음', !(await cardTitles()).includes('레이스 테스트 게임'), String(await cardTitles()));
  check('기기 사본에서도 빠짐', await page.evaluate((id) => !(JSON.parse(localStorage.getItem('ddh:cache') || '{}').records || []).some((r) => r.id === id), raceId));
});

await step('데이터: 수정하는 동안 다른 사람이 삭제 → 몰래 되살리지 않고 물어봄', async () => {
  const made = await api('POST', '/api/records', {
    record: { type: 'escaperoom', date: PAST, title: '곧 삭제될 테마', members: [], er: { cleared: false, hints: 1 } },
  });
  const rec = made.data.record;
  await syncFromServer();
  await go(`#/edit/${encodeURIComponent(rec.id)}`, '.page-form');
  check('다른 기기에서 삭제', (await api('DELETE', `/api/records?id=${encodeURIComponent(rec.id)}`)).status === 200);
  await page.fill(REVIEW, '삭제된 줄 모르고 고침');
  await allowing([/status of 404/], async () => {
    await page.click('.save-btn');
    await page.waitForSelector(dlg, { timeout: 8000 });
  });
  check('삭제 안내 다이얼로그', (await text(`${dlg} .dlg-title`)) === '다른 사람이 삭제한 기록이에요', await text(`${dlg} .dlg-title`));
  check('저장 전에는 서버에 없음 (되살아나지 않음)', (await serverRecord(rec.id)) === null);
  await dialogButton('새 기록으로 다시 저장');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const back = await serverRecord(rec.id);
  check('고른 경우에만 다시 저장 (원래 작성 시각 유지)', back && back.review === '삭제된 줄 모르고 고침' && back.createdAt === rec.createdAt, JSON.stringify(back));
  await api('DELETE', `/api/records?id=${encodeURIComponent(rec.id)}`);
  await syncFromServer();
});

await step('데이터: 지워진 기록의 수정 초안도 이어 쓸 수 있음', async () => {
  const rec = (await api('POST', '/api/records', { record: { type: 'boardgame', date: PAST, title: '초안 남은 게임', members: [] } })).data.record;
  await syncFromServer();
  await go(`#/edit/${encodeURIComponent(rec.id)}`, '.page-form');
  await page.fill(REVIEW, '길게 쓴 후기를 잃으면 안 돼요');
  check('수정 초안 저장', !!(await until(async () => (await draftNow())?.key === `edit:${rec.id}`, 3000)));
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await sleep(300);
  await api('DELETE', `/api/records?id=${encodeURIComponent(rec.id)}`);
  await syncFromServer();
  await go('#/new', '.page-form .draft-banner:not([hidden])');
  check('새 기록 폼에 수정 초안 안내', (await text('.page-form .draft-banner')).includes('수정하던 기록이 있어요'), await text('.page-form .draft-banner'));
  await page.click('.page-form .draft-banner a:has-text("이어 쓰기")');
  await page.waitForSelector('.page-form .draft-banner:has-text("삭제됐어요")', { timeout: 8000 });
  await page.waitForSelector('.page-form', { timeout: 8000 });
  check('‘삭제됐어요’ 안내와 함께 폼이 열림', (await text('.page-form .draft-banner')).includes('삭제됐어요'), await text('.page-form .draft-banner'));
  check('초안 내용 복원', (await page.inputValue(REVIEW)) === '길게 쓴 후기를 잃으면 안 돼요');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const saved = await serverRecord(rec.id);
  check('같은 id 로 새로 저장', saved && saved.review === '길게 쓴 후기를 잃으면 안 돼요', JSON.stringify(saved));
  check('초안 정리', (await draftNow()) === null);
  await api('DELETE', `/api/records?id=${encodeURIComponent(rec.id)}`);
  await syncFromServer();
});

await step('데이터: 다른 기록을 저장해도 보관된 초안은 그대로', async () => {
  await page.evaluate(() => localStorage.setItem('ddh:draft', JSON.stringify({
    key: 'new', recordId: 'kept-draft-1', savedAt: new Date().toISOString(),
    model: { type: 'murdermystery', title: '보관된 초안', review: '오프라인에서 쓴 긴 후기' },
  })));
  await go(`#/edit/${encodeURIComponent(ids.bg)}`, '.page-form');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const d = await draftNow();
  check('수정 저장 뒤에도 다른 초안 유지', d && d.model && d.model.title === '보관된 초안', JSON.stringify(d));
  await go('#/new', '.page-form.t-murdermystery .draft-banner:not([hidden])');
  check('새 기록 폼에 그 초안 안내 (초안의 종류로)', (await text('.page-form .draft-banner')).includes('머더미스터리 · 보관된 초안'), await text('.page-form .draft-banner'));
  // 취소(작성 안 함)도 남의 초안을 지우지 않음
  await go('#/new/escaperoom', '.page-form');
  await setGame('잠깐');
  await sleep(500);
  await page.evaluate(() => localStorage.setItem('ddh:draft', JSON.stringify({ key: 'new', recordId: 'kept-draft-2', savedAt: new Date().toISOString(), model: { type: 'boardgame', title: '또 다른 초안' } })));
  await page.click('.page-form .savebar button:has-text("취소")');
  await page.waitForSelector(dlg);
  await dialogButton('그만 쓰기');
  await sleep(300);
  check('취소도 다른 초안은 안 지움', (await draftNow())?.recordId === 'kept-draft-2');
  await page.evaluate(() => localStorage.removeItem('ddh:draft'));
});

await step('가져오기: 이름이 같은 멤버는 기존 멤버로 합쳐서 기록을 이어 붙임', async () => {
  const backup = path.join(SHOTS, '..', 'import-merge.json');
  writeFileSync(backup, JSON.stringify({
    app: 'ddoddohouse-record', version: 1,
    members: [{ id: 'oldYeonkyung', name: ' 연경 ', color: 'c3' }],
    records: [{ id: 'imp-merge-1', type: 'escaperoom', date: PAST, title: '가져온 방탈출', members: ['oldYeonkyung'], er: { cleared: true, hints: 0 } }],
  }));
  await go('#/settings', '.page-settings');
  check('가져오기는 키보드로 닿는 진짜 버튼', !!(await page.$('.page-settings button:has-text("가져오기")')));
  await page.setInputFiles('#import-file', backup);
  await page.waitForSelector(dlg);
  check('미리보기: 같은 이름 합침 안내', (await text(`${dlg} .import-counts`)).includes('이름이 같은 멤버 1명'), await text(`${dlg} .import-counts`));
  await dialogButton('가져오기');
  check('실패 없이 완료', !!(await toastSeen(/가져오기 완료: 성공 1(?!\d)(?!.*실패)/, 8000)), String(await texts('.toast')));
  const { data } = await api('GET', '/api/data');
  const r = data.records.find((x) => x.id === 'imp-merge-1');
  check('기록의 멤버가 기존 연경으로 연결', r && JSON.stringify(r.members) === JSON.stringify([ids['연경']]), JSON.stringify(r && r.members));
  check('멤버가 새로 생기지 않음', !data.members.some((m) => m.id === 'oldYeonkyung'));
  await go(`#/record/${encodeURIComponent('imp-merge-1')}`, '.page-detail');
  check('상세에 (떠난 멤버) 대신 연경', (await texts('.page-detail .mrows .mrow-name')).join() === '연경');
  await api('DELETE', '/api/records?id=imp-merge-1');
  await syncFromServer();
});

await step('목록: 멤버 ‘모두 보기’는 예전 검색·종류 필터를 비움 (태그 링크는 없음)', async () => {
  await tab('records', '.page-list');
  await page.click('.page-list .seg-type .seg-item:has-text("보드게임")');
  await page.fill('.page-list .search-input', '테라');
  await sleep(300);
  await go(`#/member/${encodeURIComponent(ids['민지짱'])}`, '.page-profile');
  await page.click('.page-profile a.link-more');
  await page.waitForSelector('.page-list');
  const expected = (await api('GET', '/api/data')).data.records.filter((r) => r.members.includes(ids['민지짱'])).length;
  const got = await until(async () => { const t = await cardTitles(); return t.length === expected && t; }, 3000);
  check(`민지짱 기록 ${expected}개 모두 보임`, !!got, String(await cardTitles()));
  check('검색어 비움', (await page.inputValue('.page-list .search-input')) === '');
  check('종류는 전체', (await page.$eval('.page-list .seg-type input:checked', (e) => e.value)) === 'all');
  // 태그는 더 이상 링크가 아님: 태그가 남아 있는 예전 기록 상세에도 태그 줄이 없고, 옛 ?tag= 주소는 필터 없이 전체 목록
  await go(`#/record/${encodeURIComponent(ids.er0)}`, '.page-detail');
  check('상세에 태그 줄·태그 링크 없음 (예전 기록에 태그가 있어도)', !(await page.$('.page-detail .dtags')) && !(await page.$('.page-detail a[href*="tag="]')) &&
    (await serverRecord(ids.er0)).tags.join() === '공포');
  await go('#/records?tag=%EA%B3%B5%ED%8F%AC', '.page-list');
  await sleep(200);
  check('옛 ?tag= 주소는 무시 (태그 칩·태그 필터 없음)', !(await page.$('.page-list .achips .achip:has-text("#공포")')) && !(await page.$('.page-list .filter-panel .chip-tag')), String(await texts('.page-list .achips .achip')));
});

await step('머더미스터리: 같은 작품을 이미 해 본 멤버 안내', async () => {
  await go('#/new/murdermystery', '.page-form');
  await setGame('붉은 저택의 초대');
  const played = await until(async () => text('.page-form .gp-played'), 3000);
  check('이미 해 본 멤버: 연경, 영식', /이미 해 본 멤버: .*연경/.test(played || '') && (played || '').includes('영식') && !(played || '').includes('(떠난 멤버)'), played);
  await page.click('.page-form .savebar button:has-text("취소")');
  await page.waitForSelector(dlg);
  await dialogButton('그만 쓰기');
  await sleep(200);
});

await step('통계: 결과 미기록 판은 승률·범인 생존률 분모에서 빠짐', async () => {
  const made = [];
  made.push((await api('POST', '/api/records', { record: { type: 'boardgame', date: PAST, title: '결과 없는 판', members: [ids['영식']], bg: { mode: 'coop', coopWin: null } } })).data.record.id);
  made.push((await api('POST', '/api/records', { record: { type: 'murdermystery', date: PAST, title: '검거 미기록', members: [ids['연경']], mm: { roles: [{ memberId: ids['연경'], culprit: true }], culpritResult: null } } })).data.record.id);
  await syncFromServer();
  await go('#/stats', '.page-stats');
  await page.click('.page-stats .seg-type .seg-item:has-text("보드게임")');
  const rates = await hbRows('.page-stats .chart-card:has(.chart-title:text-is("멤버별 승률"))');
  const ys = rates.find((r) => r.name === '영식') || {};
  check('협력 미기록 판은 패배로 안 셈 (영식 100%)', ys.val === '100%', JSON.stringify(rates));
  await page.click('.page-stats .seg-type .seg-item:has-text("머더미스터리")');
  await page.waitForSelector('.page-stats .stable');
  const rowsT = await page.$$eval('.page-stats .stable tbody tr', (els) => els.map((tr) =>
    [tr.querySelector('th .cell-m > span:last-child').textContent.trim(), ...[...tr.querySelectorAll('td')].map((td) => td.textContent.trim())].join(' ')));
  const yk = rowsT.find((r) => r.startsWith('연경 ')) || '';
  check('범인 2번 중 검거 미기록 1번 → 생존 100% (50% 아님)', yk.startsWith('연경 2 2번 100%'), yk);
  for (const id of made) await api('DELETE', `/api/records?id=${encodeURIComponent(id)}`);
  await syncFromServer();
  await page.click('.page-stats .seg-type .seg-item:has-text("전체")');
});

await step('접근성: 다이얼로그 버튼 줄 · 화면 이동 초점 · 카드 날짜', async () => {
  await page.setViewportSize({ width: 390, height: 664 }); // 아이폰 Safari 실제 보이는 높이
  await tab('members', '.page-members');
  await page.click('.page-members .page-head button[aria-label="멤버 추가"]');
  await page.waitForSelector(`${dlg}.dlg-member`);
  const barBg = await page.$eval(`${dlg} .dlg-actions`, (e) => getComputedStyle(e).backgroundColor);
  check('버튼 줄 배경이 불투명', barBg !== 'rgba(0, 0, 0, 0)' && barBg !== 'transparent', barBg);
  const covered = await page.$$eval(`${dlg} label.swatch`, (els) => els.filter((el) => {
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !(hit && hit.closest('label.swatch') === el);
  }).length);
  check('색 고르기 칸이 버튼에 가려지지 않음', covered === 0, String(covered));
  await dialogButton('취소');
  await page.setViewportSize(VIEWPORT);
  await go('#/stats', '.page-stats');
  check('화면을 옮기면 초점이 새 화면으로', await page.evaluate(() => document.activeElement && document.activeElement.id === 'view'));
  await go('#/records', '.page-list');
  const label = await page.getAttribute('.page-list .rcard .card-link', 'aria-label');
  check('카드 링크 이름에 날짜 포함 (스크린리더)', /\d{4}\. \d{1,2}\. \d{1,2}\./.test(label || ''), label);
  await go('#/settings', '.page-settings');
  await page.click('.page-settings button:has-text("이 기기에서 잠금 해제 정보 지우기")');
  await page.waitForSelector(dlg);
  check('공용 기기: 방문 기록도 지우라는 안내', (await text(`${dlg} .dlg-text`)).includes('방문 기록'));
  await dialogButton('취소');
});

await step('저장 공간 부족: 캐시 쓰기 실패 시 오래된 사본을 남기지 않음', async () => {
  await go('#/', '.page-home');
  check('캐시 있음', await page.evaluate(() => !!localStorage.getItem('ddh:cache')));
  await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    window.__origSetItem = orig;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'ddh:cache') throw new DOMException('quota', 'QuotaExceededError');
      return orig.call(this, k, v);
    };
  });
  await syncFromServer();
  check('쓰기 실패하면 예전 사본은 지움', await page.evaluate(() => localStorage.getItem('ddh:cache') === null));
  await page.evaluate(() => { Storage.prototype.setItem = window.__origSetItem; });
  await syncFromServer();
  check('공간이 생기면 다시 저장', await page.evaluate(() => !!localStorage.getItem('ddh:cache')));
});

await step('첫 로딩: 빈 화면 대신 ‘불러오는 중’, 새 기록 폼은 데이터가 온 뒤에', async () => {
  const cs = await newContext();
  const ps = await cs.newPage();
  watch(ps, '[slow] ');
  let open;
  const gate = new Promise((r) => { open = r; });
  await ps.route('**/api/data', async (route) => { await gate; await route.continue(); });
  await ps.goto(`${BASE}/#k=${encodeURIComponent(SECRET)}`);
  await ps.waitForSelector('.page-home .loading-state', { timeout: 8000 });
  check('홈: 불러오는 중 표시', true);
  check('홈: 0회 요약 띠·멤버 등록 안내·빈 안내 없음', !(await ps.$('.page-home .summary')) && !(await ps.$('.page-home .tip')) && !(await ps.$('.page-home .empty')));
  await ps.screenshot({ path: path.join(SHOTS, 'light-29-first-load.png') });
  await ps.click('#tabbar [data-tab="members"]');
  check('멤버: 불러오는 중 (멤버 없음 안내 아님)', !!(await ps.waitForSelector('.page-members .loading-state', { timeout: 5000 })) && !(await ps.$('.page-members .empty')));
  await ps.click('#tabbar .tab-add');
  await ps.waitForSelector('.loading');
  check('새 기록 폼은 데이터 전에는 안 그림', !(await ps.$('.page-form')));
  open();
  await ps.waitForSelector('.page-form', { timeout: 8000 });
  await ps.fill('.page-form .gp-input', '테라');
  await ps.waitForSelector('.page-form .gp-opt:not(.gp-add)', { timeout: 5000 });
  check('데이터가 오면 게임 검색 목록이 채워짐 (테라포밍 마스)', (await ps.$$eval('.page-form .gp-opt:not(.gp-add) .gp-opt-name', (els) => els.map((e) => e.textContent.trim()))).includes('테라포밍 마스'));
  await ps.fill('.page-form .gp-input', '');
  check('게임 검색 목록도 채워짐', (await ps.$$eval('.page-form .gp-opt:not(.gp-add)', (els) => els.length)) > 0);
  await cs.close();

  // 첫 로딩 실패 (기기 사본 없음): '기록 없음'이 아니라 실패 안내 + 다시 시도
  const ce = await newContext();
  const pe = await ce.newPage();
  watch(pe, '[fail] ');
  let failing = true;
  await pe.route('**/api/data', async (route) => {
    if (failing) await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server_error"}' });
    else await route.continue();
  });
  await allowing([/status of 500/], async () => {
    await pe.goto(`${BASE}/#k=${encodeURIComponent(SECRET)}`);
    await pe.waitForSelector('.page-home .empty', { timeout: 8000 });
  });
  const title = squash(await pe.textContent('.page-home .empty-title'));
  check('홈: 불러오기 실패 안내', title === '기록을 불러오지 못했어요', title);
  const bannerText = squash(await pe.textContent('#banner'));
  check('안내 띠가 ‘저장된 기록을 보여 드려요’라고 하지 않음', bannerText.includes('서버에 연결하지 못했어요') && !bannerText.includes('저장된 기록'), bannerText);
  await pe.screenshot({ path: path.join(SHOTS, 'light-30-first-load-error.png') });
  await pe.click('#tabbar [data-tab="members"]');
  await pe.waitForSelector('.page-members .empty');
  check('멤버: ‘아직 멤버가 없어요’ 대신 실패 안내', squash(await pe.textContent('.page-members .empty-title')) === '기록을 불러오지 못했어요');
  failing = false;
  await pe.click('.page-members .empty button:has-text("다시 시도")');
  check('다시 시도 → 멤버 목록', !!(await pe.waitForSelector('.page-members .mlist', { timeout: 8000 })));
  await ce.close();
});

await c3.close();

// ═════════════════════════════════════════════════════════════
// 사진 — 올리기(압축·EXIF 제거) · 대표/순서 · 갤러리/뷰어 · 이전 대표 사진 · 정리(gc) · 백업 (새 브라우저 컨텍스트에서)
const PHOTO_DIR = path.join(SHOTS, '..', 'photos');
mkdirSync(PHOTO_DIR, { recursive: true });
const cp = await newContext();
await cp.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
page = await cp.newPage();
watch(page, '[photo] ');
await page.goto(`${BASE}/#k=${encodeURIComponent(SECRET)}`);
await page.waitForSelector('.page-home');

const imgStats = async () => (await api('GET', '/api/images?stats=1')).data;
const imgList = async () => (await api('GET', '/api/images?list=1')).data.images;
/** 저장된 사진 바이트 (x-app-key 로) */
async function imgBytes(id, size = 'f') {
  const res = await fetch(`${BASE}/api/images?id=${encodeURIComponent(id)}&size=${size}`, { headers: { 'x-app-key': SECRET } });
  return { status: res.status, type: res.headers.get('content-type'), headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}
/** 저장된 사진의 가로·세로 (브라우저에서 디코드) */
const imgDims = (id, size = 'f') => page.evaluate(async ([i, s]) => {
  const res = await fetch(`/api/images?id=${encodeURIComponent(i)}&size=${s}`, { headers: { 'x-app-key': localStorage.getItem('ddh:key') } });
  const bmp = await createImageBitmap(await res.blob());
  return { w: bmp.width, h: bmp.height };
}, [id, size]);
/** 폼 사진 칸의 사진 id 순서 (올리기 끝난 것만) */
const formPhotoIds = () => page.$$eval('.rec-panel[data-panel="photos"] .ph-cell:not(.ph-cell-add)', (els) => els.map((e) => (e.querySelector('.pimg[data-photo]') || { dataset: {} }).dataset.photo || null));
const photoInput = '.rec-panel[data-panel="photos"] input[type="file"]';
async function photosSettled(n, timeout = 20000) {
  return until(async () => {
    const st = await page.$$eval('.rec-panel[data-panel="photos"] .ph-tile', (els) => els.map((e) => (e.classList.contains('is-busy') ? 'busy' : e.classList.contains('is-error') ? 'error' : 'ok')));
    return st.length === n && st.every((x) => x !== 'busy') && st;
  }, timeout);
}

// 테스트용 사진을 브라우저 canvas 로 만듦: EXIF(회전 6 + 가짜 GPS 문구)를 끼운 JPEG, 투명 PNG, 잡음 가득한 큰 JPEG, 작은 JPEG 들
const made = await page.evaluate(async () => {
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  async function draw(w, h, type, hue, { noise = false, alpha = false, q = 0.92 } = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    if (noise) {
      const im = x.createImageData(w, h);
      for (let i = 0; i < im.data.length; i += 4) {
        im.data[i] = Math.random() * 255; im.data[i + 1] = Math.random() * 255; im.data[i + 2] = Math.random() * 255; im.data[i + 3] = 255;
      }
      x.putImageData(im, 0, 0);
    } else {
      if (!alpha) {
        const g = x.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, `hsl(${hue},70%,62%)`); g.addColorStop(1, `hsl(${hue + 50},65%,38%)`);
        x.fillStyle = g; x.fillRect(0, 0, w, h);
      }
      x.fillStyle = alpha ? `hsla(${hue},80%,50%,.85)` : 'rgba(255,255,255,.85)';
      x.beginPath(); x.arc(w * 0.38, h * 0.45, Math.min(w, h) * 0.22, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#26221E'; x.font = `bold ${Math.round(Math.min(w, h) / 7)}px sans-serif`; x.fillText('또또', w * 0.56, h * 0.62);
    }
    const b = await new Promise((r) => c.toBlob(r, type, q));
    return new Uint8Array(await b.arrayBuffer());
  }
  // JPEG 의 SOI 바로 뒤에 EXIF(APP1) 끼우기: Orientation=6(시계 방향 90°) + 위치 정보처럼 보이는 문구
  function withExif(jpg) {
    const secret = new TextEncoder().encode('GPS-SECRET-37.5665N-126.9780E');
    const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0x00, 0x06, 0, 0, 0, 0, 0, 0];
    const payload = [...new TextEncoder().encode('Exif'), 0, 0, ...tiff, ...secret];
    const len = payload.length + 2;
    const app1 = [0xff, 0xe1, len >> 8, len & 0xff, ...payload];
    const out = new Uint8Array(jpg.length + app1.length);
    out.set(jpg.subarray(0, 2), 0);
    out.set(app1, 2);
    out.set(jpg.subarray(2), 2 + app1.length);
    return out;
  }
  return {
    exif: toB64(withExif(await draw(1800, 1200, 'image/jpeg', 20))),
    png: toB64(await draw(900, 1200, 'image/png', 200, { alpha: true })),
    noisy: toB64(await draw(3000, 2000, 'image/jpeg', 0, { noise: true, q: 0.95 })),
    s3: toB64(await draw(640, 480, 'image/jpeg', 120)),
    s4: toB64(await draw(480, 640, 'image/jpeg', 280)),
    s5: toB64(await draw(800, 600, 'image/jpeg', 330)),
  };
});
const P = {};
for (const [k, ext] of [['exif', 'jpg'], ['png', 'png'], ['noisy', 'jpg'], ['s3', 'jpg'], ['s4', 'jpg'], ['s5', 'jpg']]) {
  P[k] = path.join(PHOTO_DIR, `${k}.${ext}`);
  writeFileSync(P[k], Buffer.from(made[k], 'base64'));
}
P.heic = path.join(PHOTO_DIR, 'IMG_0001.heic');
writeFileSync(P.heic, Buffer.from('000000186674797068656963000000006d696631686569630000', 'hex'));
P.heic2 = path.join(PHOTO_DIR, 'IMG_0002.heic');
writeFileSync(P.heic2, Buffer.from('000000186674797068656963000000006d696631686569630000', 'hex'));
const photoIds = {};

await step('사진: 올리기 — JPEG·PNG 모두 다시 인코딩, EXIF(위치 정보) 제거, 회전 반영', async () => {
  check('테스트 사진: EXIF 넣은 JPEG', readFileSync(P.exif).includes(Buffer.from('GPS-SECRET')) && readFileSync(P.noisy).length > 1_500_000, String(readFileSync(P.noisy).length));
  const before = await imgStats();
  await go('#/new/boardgame', '.page-form');
  await setGame('카탄');
  await openPanel('photos');
  check('사진 칸: 빈 상태는 작은 추가 칸 · 안내 한 줄', !!(await page.$('.rec-panel[data-panel="photos"] .ph-grid.is-empty .ph-add')) && (await text('.rec-panel[data-panel="photos"] .ph-hint')).includes('최대 4장'));
  // 동시에 몇 장을 올리는지 (느린 연결에서 한꺼번에 올리면 모두 시간 초과가 나므로 한 장씩)
  const upl = { now: 0, max: 0, n: 0 };
  const isUpload = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/images';
  const onReq = (r) => { if (isUpload(r)) { upl.n++; upl.now++; upl.max = Math.max(upl.max, upl.now); } };
  const onDone = (r) => { if (isUpload(r)) upl.now--; };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  await page.setInputFiles(photoInput, [P.exif, P.png]);
  check('고르자마자 칸 2개 (줄이는 중/대기 표시)', (await page.$$('.rec-panel[data-panel="photos"] .ph-tile')).length === 2);
  const st = await photosSettled(2);
  page.off('request', onReq);
  page.off('requestfinished', onDone);
  page.off('requestfailed', onDone);
  check('두 장 모두 올라감', st && st.every((x) => x === 'ok'), JSON.stringify(st));
  check('여러 장을 골라도 한 장씩 차례로 올림 (동시에 1장)', upl.n === 2 && upl.max === 1, JSON.stringify(upl));
  check('첫 장에 ‘첫 장’ 표시 (게임 대표 이미지와 다른 말)', (await text('.rec-panel[data-panel="photos"] .ph-cell:nth-child(1) .ph-badge')) === '첫 장' &&
    !(await page.$('.rec-panel[data-panel="photos"] .ph-cell:nth-child(2) .ph-badge')));
  check('접은 사진 버튼에 사진 수', await (async () => { await foldPanel('photos'); const t = await text('.page-form .addon[data-panel="photos"] .addon-sum'); await openPanel('photos'); return t === '2장'; })());
  check('썸네일이 blob: 주소로 보임', await page.$$eval('.rec-panel[data-panel="photos"] .ph-cell:not(.ph-cell-add) img', (els) => els.length === 2 && els.every((e) => e.src.startsWith('blob:') && e.complete && e.naturalWidth > 0)));
  const ids = await formPhotoIds();
  photoIds.exif = ids[0];
  photoIds.png = ids[1];
  check('서버에 2장 추가', (await imgStats()).count === before.count + 2);
  const full = await imgBytes(photoIds.exif, 'f');
  const thumb = await imgBytes(photoIds.exif, 't');
  check('원본: WebP/JPEG 로 다시 인코딩 (350KB 이하)', /image\/(webp|jpeg)/.test(full.type) && full.buf.length <= 350 * 1024, `${full.type} ${full.buf.length}`);
  check('썸네일: 40KB 이하', thumb.buf.length <= 40 * 1024 && /image\/(webp|jpeg)/.test(thumb.type), String(thumb.buf.length));
  check('EXIF·위치 정보 문구가 남지 않음', !full.buf.includes(Buffer.from('GPS-SECRET')) && !full.buf.includes(Buffer.from('Exif')) && !thumb.buf.includes(Buffer.from('GPS-SECRET')));
  const d = await imgDims(photoIds.exif, 'f');
  check('EXIF 회전(6) 반영 → 세로 사진, 긴 변 1280px 이하', d.h > d.w && Math.max(d.w, d.h) <= 1280, JSON.stringify(d));
  const dt = await imgDims(photoIds.exif, 't');
  check('썸네일 긴 변 360px 이하', Math.max(dt.w, dt.h) <= 360, JSON.stringify(dt));
  const png = await imgBytes(photoIds.png, 'f');
  check('PNG 도 WebP/JPEG 로 바꿔 올림', /image\/(webp|jpeg)/.test(png.type) && png.buf[0] !== 0x89, png.type);
  check('사진 응답 헤더 (nosniff·private 캐시·CSP)', full.headers.get('x-content-type-options') === 'nosniff' && /private/.test(full.headers.get('cache-control') || '') &&
    /img-src 'self' data: blob:/.test(full.headers.get('content-security-policy') || ''), `${full.headers.get('cache-control')} | ${full.headers.get('content-security-policy')}`);
});

await step('사진: 큰 사진 줄이기 · 4장 제한 · 열 수 없는 형식(HEIC)', async () => {
  await page.setInputFiles(photoInput, [P.heic]);
  check('열 수 없는 형식(HEIC) 안내 + 해결 방법', !!(await toastSeen(/이 사진 형식\(HEIC 등\)은 열 수 없어요\. 카메라 설정의 ‘고효율’ 사진을 끄거나 JPG로 저장해서 올려 주세요/, 10000)), String(await texts('.toast')));
  check('열지 못한 사진은 칸에서 빠짐', !!(await until(async () => (await page.$$('.rec-panel[data-panel="photos"] .ph-tile')).length === 2, 3000)));
  await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
  await page.setInputFiles(photoInput, [P.heic, P.heic2]);
  check('여러 장이 같은 이유로 실패하면 알림은 하나 (몇 장인지)', !!(await toastSeen(/사진 2장은 열 수 없는 형식\(HEIC 등\)이라 뺐어요/, 10000)) &&
    (await texts('.toast')).filter((t) => t.includes('HEIC')).length === 1, String(await texts('.toast')));
  check('두 장 모두 칸에서 빠짐', !!(await until(async () => (await page.$$('.rec-panel[data-panel="photos"] .ph-tile')).length === 2, 3000)));
  await page.setInputFiles(photoInput, [P.noisy, P.s3]);
  const st = await photosSettled(4, 30000);
  check('큰 사진 포함 4장', st && st.length === 4 && st.every((x) => x === 'ok'), JSON.stringify(st));
  check('4장이면 추가 칸 사라짐 · 4/4', !(await page.$('.rec-panel[data-panel="photos"] .ph-cell-add')) && (await text('.rec-panel[data-panel="photos"] .ph-hint')).startsWith('4/4장'));
  const ids = await formPhotoIds();
  photoIds.noisy = ids[2];
  photoIds.s3 = ids[3];
  const big = await imgBytes(photoIds.noisy, 'f');
  const dims = await imgDims(photoIds.noisy, 'f');
  check('잡음 가득한 큰 사진도 350KB·1280px 안으로', big.buf.length <= 350 * 1024 && Math.max(dims.w, dims.h) <= 1280, `${big.buf.length} ${JSON.stringify(dims)}`);
  check('썸네일도 40KB 이하', (await imgBytes(photoIds.noisy, 't')).buf.length <= 40 * 1024);
  await page.setInputFiles(photoInput, [P.s4]);
  check('5장째는 안내만', !!(await toastSeen(/사진은 4장까지/)) && (await page.$$('.rec-panel[data-panel="photos"] .ph-tile')).length === 4);
  check('사진 칸 아래에 ‘첫 장’ 배지 말고 다른 글자(예: null)가 없음', JSON.stringify(await texts('.rec-panel[data-panel="photos"] .ph-cell:not(.ph-cell-add) .ph-foot')) === JSON.stringify(['첫 장', '', '', '']),
    JSON.stringify(await texts('.rec-panel[data-panel="photos"] .ph-cell:not(.ph-cell-add) .ph-foot')));
  await noOverflow('사진 4장 폼');
});

await step('사진: 첫 장 바꾸기 · 순서 · 빼기 · 붙여넣기', async () => {
  const [a, b, c, d] = await formPhotoIds();
  await page.click('.rec-panel[data-panel="photos"] .ph-cell:nth-child(2) .ph-open');
  await page.waitForSelector(`${dlg}.dlg-photo`);
  check('첫 장으로 버튼 이름: ‘2번 사진을 첫 장으로’', (await page.getAttribute(`${dlg} .ph-sheet-actions .btn:has-text("첫 장으로")`, 'aria-label')) === '2번 사진을 첫 장으로');
  await page.click(`${dlg} .ph-sheet-actions .btn:has-text("첫 장으로")`);
  await page.waitForSelector(dlg, { state: 'detached' });
  check('‘첫 장으로’ → 둘째 장이 맨 앞', JSON.stringify(await formPhotoIds()) === JSON.stringify([b, a, c, d]), JSON.stringify(await formPhotoIds()));
  check('새 첫 장에 배지', !!(await page.$(`.rec-panel[data-panel="photos"] .ph-cell:nth-child(1).is-cover .pimg[data-photo="${b}"]`)));
  // 사진을 누르면 순서 바꾸기 시트
  await page.click('.rec-panel[data-panel="photos"] .ph-cell:nth-child(3) .ph-open');
  await page.waitForSelector(`${dlg}.dlg-photo`);
  check('시트: 크게 보기·첫 장으로·앞 순서로·뒤 순서로·빼기', JSON.stringify(await texts(`${dlg} .ph-sheet-actions .btn`)) === JSON.stringify(['크게 보기', '첫 장으로', '앞 순서로', '뒤 순서로', '사진 빼기']), JSON.stringify(await texts(`${dlg} .ph-sheet-actions .btn`)));
  check('순서 버튼 이름에 몇 번 사진인지 (앱의 ‘뒤로’와 다름)', (await page.getAttribute(`${dlg} .ph-sheet-actions .btn:has-text("뒤 순서로")`, 'aria-label')) === '3번 사진을 뒤 순서로');
  await shot('31-photo-sheet');
  await page.click(`${dlg} .ph-sheet-actions .btn:has-text("앞 순서로")`);
  await page.waitForSelector(dlg, { state: 'detached' });
  check('‘앞 순서로’ → 3번째가 2번째로', JSON.stringify(await formPhotoIds()) === JSON.stringify([b, c, a, d]), JSON.stringify(await formPhotoIds()));
  // ✕ 로 빼기: 잠깐 되돌릴 수 있고, 그 뒤 이 폼에서 올린 사진이라 서버에서도 지움
  const before = (await imgStats()).count;
  // ✕ 누르는 영역이 사진을 크게 덮지 않음 (사진 모서리만)
  const xCover = await page.$eval('.rec-panel[data-panel="photos"] .ph-cell:nth-child(2) .ph-tile', (tile) => {
    tile.scrollIntoView({ block: 'center' });
    const b = tile.getBoundingClientRect();
    let hit = 0, all = 0;
    for (let x = b.left + 1; x < b.right; x += 2) for (let y = b.top + 1; y < b.bottom; y += 2) {
      all++;
      const el = document.elementFromPoint(x, y);
      if (el && el.closest('.ph-x')) hit++;
    }
    return hit / all;
  });
  check('✕ 누르는 영역은 사진의 13% 이하', xCover > 0 && xCover <= 0.13, String(xCover));
  await page.click('.rec-panel[data-panel="photos"] .ph-cell:nth-child(4) .ph-x');
  check('✕ → 3장', JSON.stringify(await formPhotoIds()) === JSON.stringify([b, c, a]));
  check('빼고 나면 초점이 남은 칸으로', await page.evaluate(() => !!document.activeElement.closest('.rec-panel[data-panel="photos"]')));
  check('‘되돌리기’ 알림', !!(await toastSeen(/4번 사진을 뺐어요/)) && !!(await page.$('.toast .toast-btn:text-is("되돌리기")')));
  await page.click('.toast .toast-btn:text-is("되돌리기")');
  check('되돌리기 → 같은 자리로', JSON.stringify(await formPhotoIds()) === JSON.stringify([b, c, a, d]), JSON.stringify(await formPhotoIds()));
  check('되돌리는 동안 서버 사진 그대로', (await imgStats()).count === before);
  await page.click('.rec-panel[data-panel="photos"] .ph-cell:nth-child(4) .ph-x');
  check('다시 ✕ → 3장', JSON.stringify(await formPhotoIds()) === JSON.stringify([b, c, a]));
  check('되돌릴 시간이 지나면 서버에서도 지움', !!(await until(async () => (await imgStats()).count === before - 1, 10000)), JSON.stringify(await imgStats()));
  // 클립보드 붙여넣기: 실제 클립보드에 그림을 넣고 Ctrl+V (클립보드를 못 쓰는 환경이면 paste 이벤트로 대신)
  const clip = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bin], { type: 'image/png' }) })]);
      if (document.activeElement) document.activeElement.blur();
      return 'clipboard';
    } catch {
      const dt = new DataTransfer();
      dt.items.add(new File([bin], 'clip.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return 'event';
    }
  }, readFileSync(P.png).toString('base64'));
  if (clip === 'clipboard') await page.keyboard.press('Control+V');
  const st = await photosSettled(4);
  check(`붙여넣은 사진이 4번째로 (${clip === 'clipboard' ? '실제 클립보드 + Ctrl+V' : 'paste 이벤트'})`, st && st.length === 4 && st.every((x) => x === 'ok'), JSON.stringify(st));
  const pasted = (await formPhotoIds())[3];
  check('붙여넣은 PNG 도 WebP/JPEG 로 올라감', !!pasted && /image\/(webp|jpeg)/.test((await imgBytes(pasted, 'f')).type));
  // 글 칸에 글자를 붙여넣을 때는 가로채지 않음
  const hijacked = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '글자');
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }));
    const input = document.querySelector('.page-form [data-field="review"]');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('글 칸에 글자+그림 붙여넣기는 방해 안 함', hijacked === false && (await page.$$('.rec-panel[data-panel="photos"] .ph-tile')).length === 4);
  photoIds.order = await formPhotoIds();
  await noOverflow('사진 폼');
  await shot('32-form-photos');
});

await step('사진: 저장 → 상세 갤러리 · 전체화면 뷰어 · 목록 카드 썸네일', async () => {
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 10000 });
  ids.catan = decodeURIComponent(page.url().split('#/record/')[1] || '');
  const saved = await serverRecord(ids.catan);
  check('서버 기록에 사진 순서 그대로 (첫 장 = 대표)', saved && JSON.stringify(saved.photos) === JSON.stringify(photoIds.order), JSON.stringify(saved && saved.photos));
  check('갤러리 4장', (await page.$$('.page-detail .dg-slide')).length === 4 && (await page.$$('.page-detail .dg-thumb')).length === 4);
  check('대표 사진이 맨 앞', (await page.getAttribute('.page-detail .dg-slide:first-child .pimg', 'data-photo')) === photoIds.order[0]);
  check('카운터 1 / 4', (await text('.page-detail .dg-count')) === '1 / 4');
  const loaded = await until(() => page.$eval('.page-detail .dg-slide:first-child img', (e) => e.complete && e.naturalWidth > 0 && e.src.startsWith('blob:')), 5000);
  check('대표 사진 표시', !!loaded);
  await page.click('.page-detail .dg-thumb:nth-child(3)');
  check('썸네일 누르면 넘어감 (3 / 4)', !!(await until(async () => (await text('.page-detail .dg-count')) === '3 / 4', 3000)), await text('.page-detail .dg-count'));
  check('고른 썸네일 표시', (await page.getAttribute('.page-detail .dg-thumb:nth-child(3)', 'aria-current')) === 'true');
  check('Tab 으로는 보이는 사진 하나만 (나머지는 썸네일로)', JSON.stringify(await page.$$eval('.page-detail .dg-slide', (els) => els.map((e) => e.tabIndex))) === JSON.stringify([-1, -1, 0, -1]));
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/data'), { timeout: 8000 }),
    page.evaluate(() => window.dispatchEvent(new Event('online'))),
  ]);
  await sleep(300);
  check('새로고침돼도 보던 사진 그대로 (3 / 4)', (await text('.page-detail .dg-count')) === '3 / 4' &&
    (await page.$eval('.page-detail .dg-track', (t) => Math.round(t.scrollLeft / t.clientWidth))) === 2, await text('.page-detail .dg-count'));
  await page.click('.page-detail .dg-thumb:nth-child(1)');
  await until(async () => (await text('.page-detail .dg-count')) === '1 / 4', 3000);
  // 넘어가는 움직임이 끝난 뒤에 찍음 (전체 페이지 스크린샷은 움직이는 도중을 멈춰 찍음)
  await until(() => page.$eval('.page-detail .dg-track', (t) => t.scrollLeft < 1), 3000);
  await sleep(200);
  await noOverflow('사진 상세');
  await shot('33-detail-gallery');

  // 전체화면 뷰어
  await page.click('.page-detail .dg-slide:first-child');
  await page.waitForSelector('dialog.viewer[open]');
  check('뷰어: 접근성 이름·닫기·이전/다음 라벨', (await page.getAttribute('dialog.viewer', 'aria-label')) === '사진 크게 보기' &&
    !!(await page.$('dialog.viewer button[aria-label="닫기"]')) && !!(await page.$('dialog.viewer button[aria-label="다음 사진"]')) && !!(await page.$('dialog.viewer button[aria-label="이전 사진"]')));
  check('뷰어: 초점이 닫기 버튼', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label') === '닫기'));
  check('뷰어: 1 / 4 · 사진 대체 텍스트', (await text('dialog.viewer .vw-count')) === '1 / 4' && (await page.getAttribute('dialog.viewer .vw-slide:first-child img', 'alt')) === '사진 1 / 4');
  await until(() => page.$eval('dialog.viewer .vw-slide:first-child img', (e) => e.complete && e.naturalWidth > 0), 5000);
  await page.keyboard.press('ArrowRight');
  check('→ 키로 다음 사진', !!(await until(async () => (await text('dialog.viewer .vw-count')) === '2 / 4', 3000)));
  await page.click('dialog.viewer button[aria-label="다음 사진"]');
  check('다음 버튼', !!(await until(async () => (await text('dialog.viewer .vw-count')) === '3 / 4', 3000)));
  await page.keyboard.press('ArrowLeft');
  check('← 키로 이전 사진', !!(await until(async () => (await text('dialog.viewer .vw-count')) === '2 / 4', 3000)));
  check('뷰어가 열린 동안 상태 표시줄 색도 어둡게', (await page.$$eval('meta[name="theme-color"]', (els) => els.map((e) => e.content))).every((c) => c === '#0B0A0D'));
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, `${theme}-34-viewer.png`) });
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog.viewer', { state: 'detached' });
  check('Esc 로 닫힘 · 갤러리도 뷰어에서 본 사진(2 / 4)으로, 초점도 그 사진', (await text('.page-detail .dg-count')) === '2 / 4' &&
    await page.evaluate(() => document.activeElement.classList.contains('dg-slide') && document.activeElement.getAttribute('aria-label') === '사진 2/4 크게 보기'), await text('.page-detail .dg-count'));
  check('상태 표시줄 색 되돌림', !(await page.$$eval('meta[name="theme-color"]', (els) => els.map((e) => e.content))).includes('#0B0A0D'));
  check('닫아도 상세 화면 그대로', !!(await page.$('.page-detail')) && page.url().includes('#/record/'));
  // 안드로이드 뒤로가기 → 뷰어만 닫힘
  await page.click('.page-detail .dg-slide:first-child');
  await page.waitForSelector('dialog.viewer[open]');
  await page.goBack();
  await page.waitForSelector('dialog.viewer', { state: 'detached', timeout: 3000 });
  check('뒤로가기는 뷰어만 닫음', !!(await page.$('.page-detail')) && page.url().includes(`#/record/${encodeURIComponent(ids.catan)}`), page.url());
  // 아래로 쓸어내려 닫기
  await page.click('.page-detail .dg-slide:first-child');
  await page.waitForSelector('dialog.viewer[open]');
  const box = await (await page.$('dialog.viewer .vw-track')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 220, { steps: 6 });
  await page.mouse.up();
  check('아래로 쓸면 닫힘', !!(await until(async () => !(await page.$('dialog.viewer')), 3000)));
  check('쓸어 닫아도 상세 화면', page.url().includes('#/record/'), page.url());

  // 목록 카드 · 홈 최근 기록
  await tab('records', '.page-list');
  const card = `.page-list .rcard:has(.card-link:text-is("카탄"))`;
  await page.waitForSelector(`${card} .rcard-photo`);
  const thumbOk = await until(() => page.$eval(`${card} .rcard-photo img`, (e) => e.complete && e.naturalWidth > 0 && e.src.startsWith('blob:')), 5000);
  check('목록 카드: 대표 사진 썸네일', !!thumbOk && (await page.getAttribute(`${card} .rcard-photo .pimg`, 'data-photo')) === photoIds.order[0]);
  check('목록 카드: 사진 수 표시 · 링크 이름에 사진 수', (await text(`${card} .rcard-pn`)) === '4' && /사진 4장/.test(await page.getAttribute(`${card} .card-link`, 'aria-label')));
  const plain = '.page-list .rcard:has(.card-link:text-is("잊혀진 연구소"))';
  check('사진 없는 카드는 예전 모습', !!(await page.$(plain)) && !(await page.$(`${plain} .rcard-photo`)) && !(await page.$eval(plain, (e) => e.classList.contains('has-photo'))));
  check('사진 썸네일을 눌러도 기록이 열림', await page.$eval(`${card} .rcard-photo`, (el) => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && hit.classList.contains('card-link');
  }));
  await noOverflow('사진 있는 목록');
  await shot('35-list-photo');
  await tab('home', '.page-home');
  check('홈 최근 기록에도 썸네일', !!(await page.waitForSelector('.page-home .rcard .rcard-photo img', { timeout: 5000 })));
  await shot('36-home-photo');
});

await step('사진: 저장 공간 80% 넘으면 알림 · 가득 차면 더 넣지 않음', async () => {
  const real = await imgStats();
  // 서버 한도(150MB)를 실제로 채우는 대신 사용량 응답만 바꿔서 확인 (사진은 진짜 서버로 올림)
  let fake = { count: 600, bytes: Math.floor(real.limitBytes * 0.8) - 1000, limitCount: real.limitCount, limitBytes: real.limitBytes };
  const statsUrl = '**/api/images?stats=1';
  await page.route(statsUrl, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }));
  try {
    await go('#/new/boardgame', '.page-form');
    await sleep(300);
    check('80% 전에는 사진 칸 안내 없음', await page.$eval('.rec-panel[data-panel="photos"] .ph-store', (e) => e.hidden));
    await page.setInputFiles(photoInput, [P.s5]);
    const st = await photosSettled(1);
    check('사진 올라감', st && st[0] === 'ok', JSON.stringify(st));
    check('80%를 막 넘으면 알림', !!(await toastSeen(/사진 저장 공간이 80%를 넘었어요/)), String(await texts('.toast')));
    const note = await text('.rec-panel[data-panel="photos"] .ph-store');
    check('사진 칸에 찬 정도 · 대략 남은 장수', /^사진 저장 공간이 80% 찼어요 · 약 [\d,]+장 더 넣을 수 있어요/.test(note) &&
      !(await page.$eval('.rec-panel[data-panel="photos"] .ph-add', (e) => e.disabled)), note);
    await page.click('.page-form .savebar button:has-text("취소")');
    await page.waitForSelector(dlg);
    await dialogButton('그만 쓰기');
    await page.waitForSelector('.page-form', { state: 'detached', timeout: 5000 });

    // 가득 참: 사진 추가가 막히고 정리 방법 안내, 골라도 올리지 않음
    fake = { ...fake, bytes: real.limitBytes };
    await go('#/new/boardgame', '.page-form');
    const fullNote = await until(async () => { const tt = await text('.rec-panel[data-panel="photos"] .ph-store'); return tt.includes('가득 찼어요') && tt; }, 3000);
    check('가득 차면 사진 추가 막힘 · 정리 방법 안내', !!fullNote && fullNote.includes('정리') && (await page.$eval('.rec-panel[data-panel="photos"] .ph-add', (e) => e.disabled)), String(fullNote));
    const posts = [];
    const onReq = (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/images') posts.push(r.url()); };
    page.on('request', onReq);
    await page.setInputFiles(photoInput, [P.s4]); // 붙여넣기·끌어 놓기와 같은 길
    const warned = await toastSeen(/사진 저장 공간이 가득 찼어요/);
    await sleep(200);
    page.off('request', onReq);
    check('가득 차면 골라도 올리지 않고 안내만', !!warned && posts.length === 0 && (await page.$$('.rec-panel[data-panel="photos"] .ph-tile')).length === 0, `${posts.length} ${String(await texts('.toast'))}`);
    await noOverflow('사진 저장 공간 가득 참 폼');
    await shot('37-photo-storage-full');
    await page.click('.page-form .savebar button:has-text("취소")');
    await page.waitForSelector('.page-form', { state: 'detached', timeout: 5000 });
    await go('#/settings', '.page-settings');
    const sw = await until(async () => { const tt = await text('.page-settings .store-warn'); return tt && tt; }, 3000);
    check('설정에도 가득 참 안내 (기록은 계속 저장됨)', !!sw && sw.includes('가득 찼어요') && sw.includes('기록은 계속 저장돼요'), String(sw));
  } finally {
    await page.unroute(statsUrl);
  }
});

await step('사진: 게임 대표 이미지는 플레이 사진과 따로 (사진 없는 기록 카드에 대표 이미지)', async () => {
  // 같은 사진을 다른 기록이 함께 가리키는 경우 (예전 앱의 '이전 대표 사진 쓰기') — 뒤 단계의 정리 규칙 확인용
  const shared = await api('POST', '/api/records', { record: { type: 'boardgame', date: TODAY, title: '카탄', members: [ids['민지짱']], photos: [photoIds.order[0]] } });
  check('같은 사진을 가리키는 두 번째 기록', shared.status === 200, JSON.stringify(shared.data));
  ids.catan2 = shared.data.record.id;
  await syncFromServer();
  const before = (await imgStats()).count;
  await go('#/new/boardgame', '.page-form');
  await setGame('카탄');
  // 고른 게임의 '정보 수정'에서 대표 이미지 넣기
  await page.click('.page-form .gp-edit');
  await page.waitForSelector(`${dlg}.dlg-game-form`);
  check('게임 정보 창: 대표 이미지 칸', (await text(`${dlg} .dlg-title`)) === '게임 정보 수정' && !!(await page.$(`${dlg} .cv-tile.is-empty`)));
  await page.setInputFiles(`${dlg} .cv-field input[type="file"]`, [P.s5]);
  await until(() => page.$(`${dlg} .cv-tile:not(.is-busy) .pimg[data-photo]`), 15000);
  check('대표 이미지 미리보기 · 빼기 버튼', !!(await page.$(`${dlg} .cv-tile .pimg[data-photo]`)) && await page.isVisible(`${dlg} .cv-remove`));
  await shot('36b-game-cover');
  await dialogButton('저장');
  await page.waitForSelector(dlg, { state: 'detached', timeout: 8000 });
  const game = (await api('GET', '/api/data')).data.games.find((g) => g.title === '카탄' && g.type === 'boardgame');
  check('서버: 게임에 대표 이미지', game && typeof game.cover === 'string' && (await imgBytes(game.cover, 't')).status === 200, JSON.stringify(game));
  ids.catanCover = game && game.cover;
  check('기록 폼의 게임 요약에 대표 이미지', (await page.getAttribute('.page-form .gp-picked .gthumb .pimg', 'data-photo')) === ids.catanCover);
  await openPanel('photos');
  check('플레이 사진 칸은 비어 있음 (대표 이미지는 기록 사진이 아님)', JSON.stringify(await formPhotoIds()) === '[]');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const bareId = decodeURIComponent(page.url().split('#/record/')[1] || '');
  check('사진 없는 기록: 갤러리 없음 · 게임 정보에 대표 이미지', !(await page.$('.page-detail .dgallery')) &&
    (await page.getAttribute('.page-detail .dgame .gthumb .pimg', 'data-photo')) === ids.catanCover);
  check('서버 기록 사진 비어 있음', JSON.stringify((await serverRecord(bareId)).photos) === '[]');
  await tab('records', '.page-list');
  const covered = `.page-list .rcard:has(.card-link[href="#/record/${encodeURIComponent(bareId)}"])`;
  await page.waitForSelector(`${covered} .rcard-photo`);
  check('목록: 사진 없는 기록은 게임 대표 이미지로', (await page.getAttribute(`${covered} .rcard-photo .pimg`, 'data-photo')) === ids.catanCover && !(await page.$(`${covered} .rcard-pn`)));
  const withPhotos = `.page-list .rcard:has(.card-link[href="#/record/${encodeURIComponent(ids.catan)}"])`;
  check('목록: 플레이 사진이 있으면 그날 사진', (await page.getAttribute(`${withPhotos} .rcard-photo .pimg`, 'data-photo')) === photoIds.order[0]);
  await shot('37-list-cover');
  check('대표 이미지는 사진 정리에서도 남음', (await api('POST', '/api/images?action=gc', {})).status === 200 && (await imgBytes(ids.catanCover, 't')).status === 200);
  check('사진 수: 대표 이미지 1장만 늘어남', (await imgStats()).count === before + 1);
  await api('DELETE', `/api/records?id=${encodeURIComponent(bareId)}`);
  await syncFromServer();
});

await step('사진: 올리기 실패 → 다시 시도 · 올리는 중에 저장하면 기다렸다 저장', async () => {
  await go('#/new/escaperoom', '.page-form');
  await setGame('사진 테스트 방');
  let fails = 1;
  await page.route('**/api/images', async (route) => {
    if (route.request().method() === 'POST' && fails > 0) {
      fails--;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server_error"}' });
    } else await route.continue();
  });
  await allowing([/status of 500/], async () => {
    await page.setInputFiles(photoInput, [P.s4]);
    const st = await photosSettled(1);
    check('실패하면 그 칸에 다시 시도', st && st[0] === 'error' && (await text('.rec-panel[data-panel="photos"] .ph-state')).includes('다시'), JSON.stringify(st));
    check('실패 안내', !!(await toastSeen(/업로드하지 못했어요/)), String(await texts('.toast')));
  });
  await page.click('.save-btn');
  check('실패한 사진이 있으면 저장 안 하고 안내', !!(await toastSeen(/올리지 못한 사진이 있어요/)) && !!(await page.$('.page-form')));
  await page.click('.rec-panel[data-panel="photos"] .ph-cell:nth-child(1) .ph-open');
  const st2 = await photosSettled(1);
  check('다시 시도 → 올라감', st2 && st2[0] === 'ok', JSON.stringify(st2));
  // 느린 업로드: 올리는 중에 저장 → 다 올라간 뒤 자동 저장
  await page.unroute('**/api/images');
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/api/images', async (route) => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  await page.setInputFiles(photoInput, [P.s5]);
  await page.waitForSelector('.rec-panel[data-panel="photos"] .ph-tile.is-busy');
  check('올리는 중: 저장 버튼에 표시', /사진 올리는 중/.test(await text('.save-btn')), await text('.save-btn'));
  await page.click('.save-btn');
  check('눌러도 바로 저장하지 않고 안내', !!(await toastSeen(/사진을 다 올리면 바로 저장할게요/)) && !!(await page.$('.page-form')));
  release();
  await page.waitForSelector('.page-detail', { timeout: 10000 });
  await page.unroute('**/api/images');
  ids.erPhoto = decodeURIComponent(page.url().split('#/record/')[1] || '');
  const rec = await serverRecord(ids.erPhoto);
  check('다 올린 뒤 두 장과 함께 저장', rec && rec.photos.length === 2, JSON.stringify(rec && rec.photos));
  photoIds.er = rec.photos;
});

await step('사진: 저장 전에 서버에서 사라진 사진 → 그 사진만 빼고 다시 저장하게', async () => {
  await go('#/new/escaperoom', '.page-form');
  await setGame('사라진 사진 방');
  await page.setInputFiles(photoInput, [P.s3, P.s5]);
  await photosSettled(2);
  const [gone, kept] = await formPhotoIds();
  // 다른 기기에서 정리된 경우처럼 서버에서만 지움 (이 기기 메모리에는 받아 둔 사진이 그대로 있음)
  check('서버에서 사진 하나 지움', (await api('DELETE', `/api/images?id=${encodeURIComponent(gone)}`)).status === 200);
  await allowing([/status of 400/], async () => {
    await page.click('.save-btn');
    check('없는 사진만 빼고 다시 저장하라는 안내', !!(await toastSeen(/사라진 사진 1장을 뺐어요/, 5000)) && !!(await page.$('.page-form')), String(await texts('.toast')));
  });
  check('폼에 남은 사진은 그대로', JSON.stringify(await formPhotoIds()) === JSON.stringify([kept]), JSON.stringify(await formPhotoIds()));
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const id = decodeURIComponent(page.url().split('#/record/')[1] || '');
  check('다시 저장하면 남은 사진과 함께 저장', JSON.stringify((await serverRecord(id)).photos) === JSON.stringify([kept]));
});

await step('사진: 초안에 올린 사진이 남음', async () => {
  await go('#/new/murdermystery', '.page-form');
  await setGame('사진 초안');
  await page.setInputFiles(photoInput, [P.s3]);
  await photosSettled(1);
  const [pid] = await formPhotoIds();
  const draft = await until(() => page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('ddh:draft') || 'null');
    return d && d.model && Array.isArray(d.model.photos) && d.model.photos.length ? d : null;
  }), 3000);
  check('초안에 사진 id', draft && draft.model && JSON.stringify(draft.model.photos) === JSON.stringify([pid]), JSON.stringify(draft && draft.model && draft.model.photos));
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await page.waitForSelector('.page-home, .page-detail, .page-list', { timeout: 5000 });
  await page.click('#tabbar .tab-add');
  await page.waitForSelector('.page-form .draft-banner:not([hidden])');
  await page.click('.page-form .draft-banner button:has-text("불러오기")');
  await page.waitForSelector('.page-form .gp-picked');
  check('이어 쓰면 사진도 그대로', JSON.stringify(await formPhotoIds()) === JSON.stringify([pid]) &&
    !!(await until(() => page.$eval('.rec-panel[data-panel="photos"] .ph-cell:nth-child(1) img', (e) => e.complete && e.naturalWidth > 0), 5000)));
  await page.click('.page-form .savebar button:has-text("취소")');
  await page.waitForSelector(dlg);
  await dialogButton('그만 쓰기');
  await sleep(200);
  check('그만 쓰면 초안 삭제', (await draftNow()) === null);
  check('초안에만 있던 사진도 서버에서 지움', !!(await until(async () => (await imgBytes(pid, 't')).status === 404, 4000)));

  // 초안 배너의 ‘버리기’도 초안에만 있던 사진을 지움
  await go('#/new/murdermystery', '.page-form');
  await setGame('버릴 초안');
  await page.setInputFiles(photoInput, [P.s4]);
  await photosSettled(1);
  const [pid2] = await formPhotoIds();
  await until(async () => JSON.stringify(((await draftNow()) || { model: {} }).model.photos) === JSON.stringify([pid2]), 3000);
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await page.waitForSelector('.page-home, .page-detail, .page-list', { timeout: 5000 });
  await go('#/new/murdermystery', '.page-form');
  await page.click('.draft-banner button:has-text("버리기")');
  check('초안 버리기 → 그 사진도 지움', !!(await until(async () => (await imgBytes(pid2, 't')).status === 404, 4000)) && (await draftNow()) === null);
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await page.waitForSelector('.page-home, .page-detail, .page-list', { timeout: 5000 });
});

/** 기록에서 빠진 사진의 하루 유예가 지난 것처럼: 빠진 시각(imgtouch)과 올린 시각을 이틀 전으로 */
async function ageReleased(ids) {
  const old = new Date(Date.now() - 2 * 86400e3).toISOString();
  for (const id of ids) {
    const raw = await srv.redis.hget('ddh:imgmeta', id);
    if (raw) await srv.redis.hset('ddh:imgmeta', { [id]: JSON.stringify({ ...JSON.parse(raw), createdAt: old }) });
    if (await srv.redis.hget('ddh:imgtouch', id)) await srv.redis.hset('ddh:imgtouch', { [id]: old });
  }
}

await step('사진: 기록 수정으로 뺀 사진 → 저장하면 빠진 것으로 표시, 하루 뒤 정리 (다른 기록이 쓰는 사진은 남김)', async () => {
  await go(`#/edit/${encodeURIComponent(ids.catan)}`, '.page-form');
  check('수정 폼에 저장된 사진 순서 그대로', JSON.stringify(await formPhotoIds()) === JSON.stringify(photoIds.order), JSON.stringify(await formPhotoIds()));
  const dropped = photoIds.order[3];
  await page.click('.rec-panel[data-panel="photos"] .ph-cell:nth-child(4) .ph-x');
  // 대표(0번)는 ‘카탄’ 두 번째 기록도 쓰므로 빼도 남아야 함 → 대표를 빼고 원래 둘째 장이 대표가 되게
  await page.click('.rec-panel[data-panel="photos"] .ph-cell:nth-child(1) .ph-x');
  check('폼에서 2장 뺌', JSON.stringify(await formPhotoIds()) === JSON.stringify(photoIds.order.slice(1, 3)), JSON.stringify(await formPhotoIds()));
  await sleep(300);
  check('저장 전에는 서버 사진 그대로 (저장된 기록이 아직 씀)', (await imgBytes(dropped, 't')).status === 200 && (await imgBytes(photoIds.order[0], 't')).status === 200);
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  check('서버 기록: 남은 2장, 둘째 장이 대표', JSON.stringify((await serverRecord(ids.catan)).photos) === JSON.stringify(photoIds.order.slice(1, 3)));
  // 바로 지우지 않음: 다른 기기의 저장 안 한 폼(되살리기·가져다 쓴 대표 사진)이 아직 가리킬 수 있어서
  check('뺀 사진은 하루 동안 남고 빠진 시각이 적힘', (await imgBytes(dropped, 't')).status === 200 && !!(await srv.redis.hget('ddh:imgtouch', dropped)));
  check('상세 갤러리 2장', (await page.$$('.page-detail .dg-slide')).length === 2 && (await text('.page-detail .dg-count')) === '1 / 2');
  await ageReleased([dropped, photoIds.order[0]]);
  check('하루 뒤 정리: 안 쓰는 사진만', (await api('POST', '/api/images?action=gc', {})).data.deleted === 1);
  check('뺀 사진은 서버에서 정리됨', (await imgBytes(dropped, 't')).status === 404 && !(await imgList()).some((m) => m.id === dropped));
  check('다른 기록이 쓰는 사진은 남음', (await imgBytes(photoIds.order[0], 't')).status === 200);
});

await step('사진: 기록 삭제 → 그 기록에만 있던 사진은 하루 뒤 정리 (그동안은 되살리기 가능, 함께 쓰는 대표 사진은 남김)', async () => {
  const snapshot = await serverRecord(ids.catan);
  await go(`#/record/${encodeURIComponent(ids.catan)}`, '.page-detail');
  await page.click('.page-detail .appbar button[aria-label="삭제"]');
  await page.waitForSelector(dlg);
  await dialogButton('삭제');
  await page.waitForSelector('.page-list', { timeout: 8000 });
  const mine = photoIds.order.slice(1, 3);
  check('지운 직후엔 사진이 남음 (다른 기기에서 수정 중이던 폼이 되살릴 수 있게)', mine.every((id) => !!id) && (await imgBytes(mine[0], 't')).status === 200);
  // 수정 중이던 다른 기기가 '새 기록으로 다시 저장' → 사진까지 그대로
  const again = await api('POST', '/api/records', { record: { ...snapshot, title: '카탄 (되살림)' }, baseUpdatedAt: null });
  check('유예 동안 되살리면 사진도 그대로', again.status === 200 && JSON.stringify(again.data.record.photos) === JSON.stringify(mine), JSON.stringify(again.data));
  check('되살린 기록 삭제', (await api('DELETE', `/api/records?id=${encodeURIComponent(ids.catan)}`)).status === 200);
  await ageReleased([...mine, photoIds.order[0]]);
  // 하루 뒤 아무 기록이나 저장·삭제하면 서버가 함께 정리 (gc 를 누르지 않아도)
  const tmp = await api('POST', '/api/records', { record: { type: 'boardgame', date: TODAY, title: '정리 트리거', members: [] } });
  check('임시 기록 저장·삭제', tmp.status === 200 && (await api('DELETE', `/api/records?id=${encodeURIComponent(tmp.data.record.id)}`)).status === 200);
  const left = new Set((await imgList()).map((m) => m.id));
  check('함께 쓰는 대표 사진은 남음', left.has(photoIds.order[0]));
  check('이 기록에만 있던 사진은 지워짐', mine.every((id) => !left.has(id)), JSON.stringify(mine.map((id) => left.has(id))));
  check('지워진 사진은 404', (await imgBytes(mine[0], 't')).status === 404);
  await syncFromServer();
});

let photoExport = null;
let photoExportNoImg = null;
await step('사진: 설정 — 저장 공간 · 사용하지 않는 사진 정리', async () => {
  // 어떤 기록에도 안 쓰이고 하루가 지난 사진 하나 만들기 (서버 메타의 시각을 이틀 전으로)
  const up = await api('POST', '/api/images', { full: made.s3, thumb: made.s3 });
  check('고아 사진 올림', up.status === 200 && up.data.image && up.data.image.id, JSON.stringify(up.data));
  const orphan = up.data.image.id;
  const meta = JSON.parse(await srv.redis.hget('ddh:imgmeta', orphan));
  await srv.redis.hset('ddh:imgmeta', { [orphan]: JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 2 * 86400e3).toISOString() }) });
  const stats = await imgStats();
  await go('#/settings', '.page-settings');
  const main = await until(async () => { const t = await text('.set-store .store-main'); return t.includes('장') && t; }, 5000);
  check('사진 수·용량 / 한도', main && main.includes(`사진 ${stats.count}장`) && /\d+(\.\d)?(KB|MB) \/ 150MB/.test(main), main);
  check('사용량 막대 (meter)', (await page.getAttribute('.set-store .store-meter', 'role')) === 'meter' && (await page.getAttribute('.set-store .store-meter', 'aria-valuenow')) !== null);
  await noOverflow('설정 (사진 저장 공간)');
  await shot('38-settings-storage');
  await page.click('.set-store button:has-text("사용하지 않는 사진 정리")');
  await page.waitForSelector(dlg);
  check('정리 전 확인', (await text(`${dlg} .dlg-title`)).includes('정리할까요'));
  await dialogButton('정리하기');
  check('정리 결과 토스트 (1장)', !!(await toastSeen(/사용하지 않는 사진 1장을 정리했어요/)), String(await texts('.toast')));
  check('고아 사진 삭제', (await imgBytes(orphan, 't')).status === 404);
  check('화면의 사진 수도 줄어듦', !!(await until(async () => (await text('.set-store .store-main')).includes(`사진 ${stats.count - 1}장`), 5000)), await text('.set-store .store-main'));
  check('기록에 붙은 사진은 그대로', (await imgBytes(photoIds.order[0], 't')).status === 200 && (await imgBytes(photoIds.er[0], 't')).status === 200);
});

await step('사진: 내보내기에 사진 포함 · 가져오기로 사진까지 되살림', async () => {
  check('‘사진 포함’ 기본 켬', await page.$eval('.page-settings .switch-row:has-text("사진 포함") input', (e) => e.checked));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('.page-settings button:has-text("내보내기")')]);
  photoExport = path.join(SHOTS, '..', 'export-photos.json');
  await dl.saveAs(photoExport);
  const json = JSON.parse(readFileSync(photoExport, 'utf8'));
  const want = [...new Set([...json.records.flatMap((r) => r.photos || []), ...json.games.map((g) => g.cover).filter(Boolean)])];
  check('images: 기록 사진 + 게임 대표 이미지 모두', json.games.some((g) => g.cover === ids.catanCover) && Array.isArray(json.images) && json.images.length === want.length && want.every((id) => json.images.some((im) => im.id === id)), `${json.images && json.images.length} vs ${want.length}`);
  const im = json.images.find((x) => x.id === photoIds.er[0]) || {};
  check('사진 항목: id·mime·full·thumb(base64)·createdAt', /image\/(webp|jpeg)/.test(im.mime) && /^[A-Za-z0-9+/]+=*$/.test(im.full || '') && /^[A-Za-z0-9+/]+=*$/.test(im.thumb || '') &&
    !String(im.full).startsWith('data:') && typeof im.createdAt === 'string', JSON.stringify({ ...im, full: String(im.full).slice(0, 20), thumb: String(im.thumb).slice(0, 20) }));
  check('백업의 사진 = 서버 사진 그대로', Buffer.from(im.full, 'base64').equals((await imgBytes(photoIds.er[0], 'f')).buf));
  check('내보내기 토스트에 사진 수', !!(await toastSeen(new RegExp(`사진 ${want.length}장을 내보냈어요`))));
  // 사진 빼고 내보내기
  await page.click('.page-settings .switch-row:has-text("사진 포함")');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.page-settings button:has-text("내보내기")')]);
  photoExportNoImg = path.join(SHOTS, '..', 'export-nophotos.json');
  await dl2.saveAs(photoExportNoImg);
  const j2 = JSON.parse(readFileSync(photoExportNoImg, 'utf8'));
  check('‘사진 포함’ 끄면 images 없음', !('images' in j2) && j2.records.length === json.records.length);
  await page.click('.page-settings .switch-row:has-text("사진 포함")');

  // 서버에서 사진 기록을 지우고 하루가 지나 사진도 정리된 뒤, 백업으로 기록과 사진을 함께 되살림
  const countBefore = (await imgStats()).count;
  check('사진 기록 삭제 API', (await api('DELETE', `/api/records?id=${encodeURIComponent(ids.erPhoto)}`)).status === 200);
  await ageReleased(photoIds.er);
  check('하루 뒤 정리로 그 기록의 사진도 사라짐', (await api('POST', '/api/images?action=gc', {})).data.deleted === photoIds.er.length && (await imgBytes(photoIds.er[0], 'f')).status === 404);
  await page.click('.page-settings button:has-text("새로고침")');
  await until(async () => (await text('.conn-meta')).includes(`기록 ${json.records.length - 1}개`), 5000);
  await page.setInputFiles('#import-file', photoExport);
  await page.waitForSelector(dlg);
  const counts = await text(`${dlg} .import-counts`);
  check('미리보기에 사진 수', counts.includes(`사진 ${want.length}장`), counts);
  await shot('39-import-photos');
  await dialogButton('가져오기');
  check('가져오기 완료', !!(await toastSeen(/가져오기 완료: 성공 3(?!\d)/, 15000)), String(await texts('.toast')));
  const back = await serverRecord(ids.erPhoto);
  check('기록이 사진과 함께 돌아옴', back && JSON.stringify(back.photos) === JSON.stringify(photoIds.er), JSON.stringify(back && back.photos));
  const restored = await imgBytes(photoIds.er[0], 'f');
  check('사진이 같은 id 로 같은 내용', restored.status === 200 && restored.buf.equals(Buffer.from(im.full, 'base64')));
  check('사진 수도 삭제 전과 같음 (이미 있던 사진은 다시 올리지 않음)', (await imgStats()).count === countBefore, `${(await imgStats()).count} vs ${countBefore}`);
});

await step('사진: 코드 없이는 사진을 볼 수 없음 (401)', async () => {
  const id = photoIds.order[0];
  const noKey = await fetch(`${BASE}/api/images?id=${encodeURIComponent(id)}&size=t`);
  const body = Buffer.from(await noKey.arrayBuffer());
  check('키 없는 사진 요청 → 401 JSON (사진 바이트 없음)', noKey.status === 401 && /application\/json/.test(noKey.headers.get('content-type') || '') &&
    body[0] !== 0xff && !body.toString('latin1').includes('WEBP') && noKey.headers.get('cache-control') === 'no-store', `${noKey.status} ${noKey.headers.get('content-type')} ${noKey.headers.get('cache-control')}`);
  const failsBefore = await failCount();
  const wrong = await fetch(`${BASE}/api/images?id=${encodeURIComponent(id)}&size=f`, { headers: { 'x-app-key': 'wrong-key-000000000000' } });
  check('틀린 코드 → 401', wrong.status === 401 && !(await wrong.text()).includes('WEBP'));
  check('틀린 코드는 실패 횟수로 셈 (무차별 대입 차단 대상)', (await failCount()) === failsBefore + 1);
  await srv.redis.del('ddh:fail:127.0.0.1'); // 이 확인으로 쌓인 실패 횟수는 지움 (뒤 단계에 영향 없게)
  // 브라우저에서 주소만으로(<img src>) 부르면 키가 안 붙으므로 못 봄 → 앱은 항상 x-app-key 로 받아 blob: 으로 보여 줌
  await allowing([/status of 401/], async () => {
    const r = await page.evaluate((u) => new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ ok: true, w: im.naturalWidth });
      im.onerror = () => resolve({ ok: false });
      im.src = u;
    }), `/api/images?id=${encodeURIComponent(id)}&size=t`);
    check('<img src="/api/images?..."> 로는 안 보임', r.ok === false, JSON.stringify(r));
  });
  check('그래도 앱은 잠기지 않음', !(await page.$('section.lock')) && !!(await page.$('#tabbar:not([hidden])')));
});

await step('사진: 코드가 바뀌어 잠기면 뷰어·사진 시트도 닫히고 받아 둔 사진 캐시도 비움', async () => {
  const lockBy401 = async () => {
    const cleared = page.waitForResponse((r) => new URL(r.url()).pathname === '/clear-cache.txt', { timeout: 5000 }).catch(() => null);
    await page.route('**/api/data', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }));
    await allowing([/status of 401/], async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForSelector('section.lock', { timeout: 5000 });
    });
    await page.unroute('**/api/data');
    return cleared;
  };
  const photoVisible = () => page.$$eval('img', (els) => els.some((e) => e.src.startsWith('blob:') && !e.hidden && e.getBoundingClientRect().width > 0));
  /** 이 사진이 브라우저 HTTP 캐시에 있는지 (네트워크 없이 캐시만 봄) */
  const httpCached = (id) => allowing([/ERR_CACHE_MISS/], () => page.evaluate(async ([i, k]) => {
    try {
      const r = await fetch(`/api/images?id=${encodeURIComponent(i)}&size=t`, { headers: { 'x-app-key': k }, cache: 'only-if-cached', mode: 'same-origin' });
      return r.status === 200;
    } catch { return false; }
  }, [id, SECRET]));
  const unlockAgain = async () => {
    await page.goto(`${BASE}/#k=${encodeURIComponent(SECRET)}`);
    await page.waitForSelector('.page-home');
  };
  // 1) 상세의 전체화면 뷰어가 열린 채로
  await go(`#/record/${encodeURIComponent(ids.erPhoto)}`, '.page-detail');
  const probeId = photoIds.er[0];
  await page.evaluate(async ([i, k]) => { await (await fetch(`/api/images?id=${encodeURIComponent(i)}&size=t`, { headers: { 'x-app-key': k } })).arrayBuffer(); }, [probeId, SECRET]);
  check('(준비) 본 사진은 브라우저 캐시에 있음', await httpCached(probeId));
  await page.click('.page-detail .dg-slide:first-child');
  await page.waitForSelector('dialog.viewer[open]');
  const cr = await lockBy401();
  check('잠금 화면 위에 뷰어가 남지 않음 (사진 안 보임)', !(await page.$('dialog')) && !(await photoVisible()));
  check('뷰어 상태도 되돌림 (스크롤 잠금·상태 표시줄 색)', !(await page.evaluate(() => document.documentElement.classList.contains('vw-open'))) &&
    !(await page.$$eval('meta[name="theme-color"]', (els) => els.map((e) => e.content))).includes('#0B0A0D'));
  check('브라우저 캐시의 사진도 비움 (Clear-Site-Data: "cache")', !!cr && cr.status() === 200 && !(await httpCached(probeId)), cr ? String(cr.status()) : '요청 없음');
  await unlockAgain();
  // 2) 폼의 사진 시트가 열린 채로
  await go(`#/edit/${encodeURIComponent(ids.erPhoto)}`, '.page-form');
  await page.click('.rec-panel[data-panel="photos"] .ph-cell:nth-child(1) .ph-open');
  await page.waitForSelector(`${dlg}.dlg-photo`);
  await page.click(`${dlg} .ph-sheet-actions .btn:has-text("크게 보기")`);
  await page.waitForSelector('dialog.viewer[open]');
  await lockBy401();
  check('잠금 화면 위에 폼의 뷰어·사진 시트가 남지 않음', !(await page.$('dialog')) && !(await photoVisible()));
  await unlockAgain();
  // 사진 시트만 열린 채로
  await go(`#/edit/${encodeURIComponent(ids.erPhoto)}`, '.page-form');
  await page.click('.rec-panel[data-panel="photos"] .ph-cell:nth-child(1) .ph-open');
  await page.waitForSelector(`${dlg}.dlg-photo`);
  await lockBy401();
  check('사진 시트만 열려 있어도 닫힘', !(await page.$('dialog')) && !(await photoVisible()));
  await unlockAgain();
});

await step('사진: 빈 새 서버에 백업 가져오기 → 기록·사진 모두 되살림', async () => {
  const json = JSON.parse(readFileSync(photoExport, 'utf8'));
  const withPhotos = json.records.filter((r) => (r.photos || []).length);
  const srv2 = await startDevServer({
    port: 0,
    logger: { error: (...a) => serverErrors.push(`[srv2] ${a.map(String).join(' ')}`), log() {}, warn() {} },
  });
  const api2 = async (p) => (await fetch(srv2.url + p, { headers: { 'x-app-key': srv2.secret } })).json();
  const bytes2 = async (id, size) => {
    const res = await fetch(`${srv2.url}/api/images?id=${encodeURIComponent(id)}&size=${size}`, { headers: { 'x-app-key': srv2.secret } });
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  };
  const c2 = await newContext();
  const prevPage = page;
  page = await c2.newPage();
  watch(page, '[fresh] ');
  try {
    await page.goto(`${srv2.url}/#k=${encodeURIComponent(srv2.secret)}`);
    await page.waitForSelector('.page-home');
    check('새 서버는 비어 있음', (await api2('/api/data')).records.length === 0 && (await api2('/api/images?stats=1')).count === 0);
    await go('#/settings', '.page-settings');

    // 1) 사진 없이 내보낸 백업: 서버에 없는 사진 참조만 빼고 기록은 저장 (서버가 알려 준 missing 목록으로)
    await allowing([/status of 400/], async () => {
      await page.setInputFiles('#import-file', photoExportNoImg);
      await page.waitForSelector(dlg);
      check('사진 없는 백업 미리보기엔 사진 줄 없음', !(await text(`${dlg} .import-counts`)).includes('사진'));
      await dialogButton('가져오기');
      check('사진 없는 백업도 실패 없이 가져옴', !!(await toastSeen(new RegExp(`가져오기 완료: 성공 ${json.records.length + json.members.length + (json.games || []).length}(?!\\d)(?!.*실패)`), 15000)), String(await texts('.toast')));
    });
    const d1 = await api2('/api/data');
    check('기록은 모두 들어오고 없는 사진 참조는 빠짐', d1.records.length === json.records.length && d1.records.every((r) => Array.isArray(r.photos) && r.photos.length === 0));

    // 사진 포함 백업을 '건너뛰기'로: 가져오지 않는(이미 있는) 기록의 사진은 올리지 않음 (어디에도 안 쓰이는 사진이 쌓이지 않게)
    await page.setInputFiles('#import-file', photoExport);
    await page.waitForSelector(dlg);
    await dialogButton('가져오기');
    check('건너뛰기: 가져올 것이 없음', !!(await toastSeen(/가져오기 완료: 성공 0(?!\d)/, 15000)), String(await texts('.toast')));
    check('건너뛴 기록의 사진은 올리지 않음', (await api2('/api/images?stats=1')).count === 0);

    // 2) 사진 포함 백업을 덮어쓰기로: 사진을 같은 id 로 먼저 올리고 기록이 다시 사진을 가리킴
    await page.setInputFiles('#import-file', photoExport);
    await page.waitForSelector(dlg);
    const counts = await text(`${dlg} .import-counts`);
    check('미리보기: 기록·멤버·사진 수', counts.includes(`기록 ${json.records.length}개`) && counts.includes(`사진 ${json.images.length}장`), counts);
    await page.click(`${dlg} .seg-item:has-text("덮어쓰기")`);
    // 첫 사진 올리기는 서버 오류 한 번 (잠깐의 문제는 다시 올려서 기록에서 빠지지 않아야 함)
    let failOnce = true;
    await page.route('**/api/images', async (route) => {
      if (route.request().method() === 'POST' && failOnce) {
        failOnce = false;
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server_error"}' });
      } else await route.continue();
    });
    await allowing([/status of 500/], async () => {
      await dialogButton('가져오기');
      check('사진까지 가져오기 완료 (실패 없음 — 한 번 실패한 사진은 다시 올림)', !!(await toastSeen(new RegExp(`가져오기 완료: 성공 ${json.members.length + json.images.length + json.records.length + (json.games || []).length}(?!\\d)(?!.*실패)`), 20000)) && !failOnce, String(await texts('.toast')));
    });
    await page.unroute('**/api/images');
    const list2 = (await api2('/api/images?list=1')).images;
    check('새 서버에 사진이 같은 id 로 모두', list2.length === json.images.length && json.images.every((im) => list2.some((m) => m.id === im.id && m.mime === im.mime)),
      `${list2.length} vs ${json.images.length}`);
    let same = true;
    for (const im of json.images) {
      const [f, t] = [await bytes2(im.id, 'f'), await bytes2(im.id, 't')];
      if (f.status !== 200 || !f.buf.equals(Buffer.from(im.full, 'base64')) || t.status !== 200 || !t.buf.equals(Buffer.from(im.thumb, 'base64'))) same = false;
    }
    check('원본·썸네일 바이트가 백업과 똑같음', same);
    const d2 = await api2('/api/data');
    check('기록이 사진을 원래 순서대로 가리킴', withPhotos.length > 0 && withPhotos.every((r) => JSON.stringify((d2.records.find((x) => x.id === r.id) || {}).photos) === JSON.stringify(r.photos)));
    // 화면에서도 보임
    await tab('records', '.page-list');
    const t0 = withPhotos[0];
    const card = `.page-list .rcard:has(.pimg[data-photo="${t0.photos[0]}"])`;
    check('새 서버 목록 카드에 대표 사진', !!(await until(() => page.$eval(`${card} .rcard-photo img`, (e) => !e.hidden && e.complete && e.naturalWidth > 0), 6000)));
    await go(`#/record/${encodeURIComponent(t0.id)}`, '.page-detail');
    check('새 서버 상세 갤러리', (await page.$$('.page-detail .dg-slide')).length === t0.photos.length &&
      !!(await until(() => page.$eval('.page-detail .dg-slide:first-child img', (e) => !e.hidden && e.complete && e.naturalWidth > 0), 6000)));
    await go('#/settings', '.page-settings');
    check('새 서버 설정: 사진 수', !!(await until(async () => (await text('.set-store .store-main')).includes(`사진 ${json.images.length}장`), 5000)), await text('.set-store .store-main'));
  } finally {
    await c2.close();
    page = prevPage;
    await srv2.close();
  }
});

await step('사진: 불러오기 실패·오프라인 → 자리표시, 다시 연결되면 보임', async () => {
  const imageGets = (url) => url.pathname === '/api/images' && url.searchParams.has('id');
  await page.route(imageGets, (route) => route.abort());
  await allowing([/ERR_FAILED|Failed to load resource|net::/], async () => {
    await page.reload();
    await page.waitForSelector('#tabbar:not([hidden])');
    await tab('records', '.page-list');
    const card = `.page-list .rcard:has(.card-link:text-is("카탄"))`;
    const err = await until(() => page.$(`${card} .rcard-photo .pimg.is-error .pimg-fallback`), 5000);
    check('실패하면 아이콘 자리표시 (깨진 이미지 아님)', !!err && !(await page.$eval(`${card} .rcard-photo img`, (e) => !e.hidden)));
    await shot('40-photo-fallback');
    await page.unroute(imageGets);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const ok = await until(() => page.$eval(`${card} .rcard-photo img`, (e) => !e.hidden && e.complete && e.naturalWidth > 0), 5000);
    check('다시 연결되면 사진이 보임', !!ok);
  });
});

await step('사진: 원본이 작은 사진보다 먼저 와도 원본이 남음 (늦게 온 작은 사진으로 덮지 않음)', async () => {
  const rec = (await api('GET', '/api/data')).data.records.find((r) => r.title === '카탄' && (r.photos || []).length);
  const cover = rec.photos[0];
  const gets = (size) => (url) => url.pathname === '/api/images' && url.searchParams.get('size') === size;
  let fullDone;
  const fullSent = new Promise((r) => { fullDone = r; });
  // 작은 사진은 원본 바로 뒤에 도착 (원본을 그리는 사이) — 둘 다 브라우저 캐시에 있을 때 생길 수 있는 순서.
  // 그 사이를 매번 재현하려고 이 단계에서만 그리기(decode)를 늦춤
  await page.addInitScript(() => {
    const orig = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function decode() {
      const p = orig.call(this);
      if (!sessionStorage.getItem('e2e-slow-decode')) return p;
      return new Promise((resolve, reject) => setTimeout(() => p.then(resolve, reject), 500));
    };
  });
  await page.evaluate(() => sessionStorage.setItem('e2e-slow-decode', '1'));
  await page.route(gets('f'), async (route) => { const res = await route.fetch(); await route.fulfill({ response: res }); fullDone(); });
  await page.route(gets('t'), async (route) => { const res = await route.fetch(); await fullSent; await sleep(50); await route.fulfill({ response: res }); });
  await page.goto(`${BASE}/#/record/${encodeURIComponent(rec.id)}`);
  await page.reload(); // 메모리의 사진 캐시를 비우고 처음부터
  const slideImg = '.page-detail .dg-slide:first-child img';
  await until(() => page.$eval(slideImg, (e) => !e.hidden && e.complete && e.naturalWidth > 0), 8000);
  await sleep(1500);
  const shownW = await page.$eval(slideImg, (e) => e.naturalWidth);
  await page.evaluate(() => sessionStorage.removeItem('e2e-slow-decode'));
  await page.unroute(gets('f'));
  await page.unroute(gets('t'));
  const full = await imgDims(cover, 'f');
  check('대표 사진은 원본 크기로 보임', shownW === full.w, `보이는 ${shownW}px, 원본 ${full.w}px`);
});

await step('사진: 다크 모드 · 320px · 가로 스크롤 없음', async () => {
  await page.evaluate(() => localStorage.setItem('ddh:theme', 'dark'));
  await page.reload();
  await page.waitForSelector('#tabbar:not([hidden])');
  theme = 'dark';
  check('다크 적용', isDarkColor(await bodyBg()));
  const screens = [
    [`#/record/${encodeURIComponent(ids.erPhoto)}`, '.page-detail', 'photo-detail'],
    ['#/records', '.page-list', 'photo-list'],
    [`#/edit/${encodeURIComponent(ids.erPhoto)}`, '.page-form', 'photo-form'],
    ['#/settings', '.page-settings', 'photo-settings'],
  ];
  for (const [hash, sel, name] of screens) {
    await go(hash, sel);
    await until(() => page.$$eval('.pimg', (els) => els.every((e) => !e.classList.contains('is-loading'))), 2500);
    await noOverflow(`다크 ${name}`);
    await shot(name);
  }
  await go(`#/record/${encodeURIComponent(ids.erPhoto)}`, '.page-detail');
  await page.click('.page-detail .dg-slide:first-child');
  await page.waitForSelector('dialog.viewer[open]');
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'dark-photo-viewer.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.removeItem('ddh:theme'));
  await page.reload();
  await page.waitForSelector('#tabbar:not([hidden])');
  theme = 'light';

  await page.setViewportSize({ width: 320, height: 640 });
  for (const [hash, sel] of [[`#/record/${encodeURIComponent(ids.erPhoto)}`, '.page-detail'], ['#/records', '.page-list'], ['#/', '.page-home'],
    [`#/edit/${encodeURIComponent(ids.erPhoto)}`, '.page-form'], ['#/settings', '.page-settings']]) {
    await go(hash, sel);
    await sleep(150);
    await noOverflow(`320px 사진 ${hash}`);
    if (sel === '.page-form') await shot('320-photo-form');
    if (sel === '.page-list') await shot('320-photo-list');
  }
  // 320px 에서도 사진 칸 버튼들이 44px 이상 누를 수 있음
  await go(`#/edit/${encodeURIComponent(ids.erPhoto)}`, '.page-form');
  const targets = await page.$$eval('.rec-panel[data-panel="photos"] .ph-x, .rec-panel[data-panel="photos"] .ph-cover-btn, .rec-panel[data-panel="photos"] .ph-open, .rec-panel[data-panel="photos"] .ph-add', (els) => els.map((el) => {
    const b = el.getBoundingClientRect();
    const after = getComputedStyle(el, '::after');
    const extra = after.content !== 'none' ? { t: -parseFloat(after.top) || 0, l: -parseFloat(after.left) || 0 } : { t: 0, l: 0 };
    return { cls: el.className, w: Math.round(b.width + 2 * Math.max(0, extra.l)), h: Math.round(b.height + 2 * Math.max(0, extra.t)) };
  }));
  check('320px: 사진 칸 버튼 누르는 영역 44px 이상', targets.length > 0 && targets.every((t) => t.w >= 44 && t.h >= 44), JSON.stringify(targets));
  await page.click('.page-form .savebar button:has-text("취소")');
  await page.setViewportSize(VIEWPORT);
});

await cp.close();

// ── 노트북(가로) · 태블릿: 사이드바와 여러 단 배치 ───────────────
const dc = await newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
page = await dc.newPage();
watch(page, '[desktop] ');
theme = 'light';
/** 두 요소가 나란히(같은 줄, a 가 왼쪽) 놓였는지 */
const sideBySide = (a, b) => page.evaluate(([sa, sb]) => {
  const x = document.querySelector(sa);
  const y = document.querySelector(sb);
  if (!x || !y) return false;
  const p = x.getBoundingClientRect();
  const q = y.getBoundingClientRect();
  return Math.abs(p.top - q.top) < 2 && p.right <= q.left && p.width > 0 && q.width > 0;
}, [a, b]);

await step('노트북 1440px: 왼쪽 사이드바 · 여러 단 · 가로 스크롤 없음', async () => {
  await page.goto(`${BASE}/#k=${encodeURIComponent(SECRET)}`);
  await page.waitForSelector('.page-home .summary', { timeout: 8000 });
  const side = await page.$eval('#tabbar', (e) => { const b = e.getBoundingClientRect(); return { l: b.left, w: b.width, h: b.height, dir: getComputedStyle(e).flexDirection }; });
  check('메뉴가 왼쪽 사이드바 (화면 높이 전체 · 폭 230~250px)', side.l === 0 && side.w >= 230 && side.w <= 250 && side.h === 900 && side.dir === 'column', JSON.stringify(side));
  check('사이드바 로고: 집 모양 기록장 (기록 줄 포함)', !!(await page.$('#tabbar .side-logo svg .ico-accent')));
  check('사이드바: 이름 · 새 기록 버튼 · 설정', await page.isVisible('#tabbar .side-brand') && await page.isVisible('#tabbar .side-cta') && await page.isVisible('#tabbar .tab-settings') && !(await page.isVisible('#tabbar .tab-add')));
  check('본문이 사이드바 오른쪽에서 시작', await page.$eval('#view', (e) => e.getBoundingClientRect().left >= 232));
  // 왼쪽 위 로고·이름을 누르면 홈으로 (다른 화면에서도, 스크린리더엔 '홈으로')
  check('사이드바 로고·이름은 홈 링크', (await page.$eval('#tabbar .side-brand', (e) => e.tagName + e.getAttribute('href') + e.getAttribute('aria-label'))) === 'A#/또또하우스 기록장 홈으로');
  await go('#/stats', '.page-stats');
  await page.click('#tabbar .side-brand');
  await page.waitForSelector('.page-home', { timeout: 8000 });
  check('로고를 누르면 홈 화면 · 메뉴의 홈이 선택됨', (await page.evaluate(() => location.hash)) === '#/' && (await text('#tabbar .tab[aria-current="page"]')) === '홈');
  const sideTabs = await page.$$eval('#tabbar a.tab', (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent.trim()));
  check('사이드바 메뉴: 홈 · 기록 · 소장 · 통계 · 멤버 · 설정', JSON.stringify(sideTabs) === JSON.stringify(['홈', '기록', '소장', '통계', '멤버', '설정']), JSON.stringify(sideTabs));
  // 홈: 낮은 요약 띠 바로 아래 최근 기록 — 첫 줄 카드가 스크롤 없이 다 보임
  const strip = await page.$eval('.page-home .summary', (e) => {
    const b = e.getBoundingClientRect();
    return { h: Math.round(b.height), rows: new Set([...e.querySelectorAll('.sum-item')].map((x) => Math.round(x.getBoundingClientRect().top))).size };
  });
  check('홈: 요약 띠는 한 줄 · 낮게 (64px 이하)', strip.h >= 36 && strip.h <= 64 && strip.rows === 1, JSON.stringify(strip));
  check('홈: 이번 달 멤버 카드는 멤버 화면으로 (홈엔 없음)', !(await page.$('.page-home .mate')));
  const sumGap = await page.$$eval('.page-home .summary .sum-link', (els) => Math.max(...els.map((e) => e.querySelector('.sum-value').getBoundingClientRect().left - e.querySelector('.sum-label').getBoundingClientRect().right)));
  check('홈: 요약 띠 항목명과 숫자가 붙어 있음 (‘보드게임 12회’)', sumGap >= 0 && sumGap <= 16, String(sumGap));
  check('홈: 카드 모서리 16~20px', await page.$eval('.page-home .rcard', (e) => { const r = parseFloat(getComputedStyle(e).borderTopLeftRadius); return r >= 16 && r <= 20; }) &&
    await page.$eval('.page-home .summary', (e) => parseFloat(getComputedStyle(e).borderTopLeftRadius) <= 20));
  check('홈: 최근 기록 세 칸', await sideBySide('.page-home .rlist > .rcard:nth-child(1)', '.page-home .rlist > .rcard:nth-child(2)') &&
    await sideBySide('.page-home .rlist > .rcard:nth-child(2)', '.page-home .rlist > .rcard:nth-child(3)'));
  const firstRow = await page.evaluate(() => {
    scrollTo(0, 0);
    return Math.max(...[...document.querySelectorAll('.page-home .rlist > .rcard')].slice(0, 3).map((e) => e.getBoundingClientRect().bottom));
  });
  check('홈: 최근 기록 첫 줄이 스크롤 없이 다 보임 (1440×900)', firstRow > 0 && firstRow <= 900, String(firstRow));
  check('홈 머리에 톱니 버튼 없음 (설정은 사이드바에)', !(await page.$('.page-home .home-head .icon-btn')));
  // 긴 제목·긴 한줄평: 제목은 두 줄까지 말줄임, 한줄평은 점선 아래 두 줄까지 — 서로 겹치지 않고 같은 줄 카드는 점선 높이가 같음
  const longRec = (await api('POST', '/api/records', {
    record: {
      type: 'escaperoom', date: TODAY, rating: 3.5, members: [ids['연경']], er: { cleared: false },
      title: '아주아주 긴 제목을 가진 방탈출 테마 — 이름이 두 줄을 훌쩍 넘어가면 카드에서 어떻게 보이는지 확인하려는 기록',
      oneLiner: '한줄평도 길게 써 보면 카드 아래쪽 칸에서 두 줄까지만 보이고 나머지는 말줄임표로 줄어드는지 확인하려고 일부러 길게 적은 문장',
    },
  })).data.record;
  await page.reload();
  await page.waitForSelector(`.page-home .rcard:has(a[href="#/record/${encodeURIComponent(longRec.id)}"])`, { timeout: 8000 });
  const lay = await page.$$eval('.page-home .rlist > .rcard', (cards) => cards.slice(0, 3).map((c) => {
    const r = (s) => { const e = c.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const title = c.querySelector('.rcard-title');
    const lh = parseFloat(getComputedStyle(title).lineHeight);
    return {
      card: c.getBoundingClientRect(), title: r('.rcard-title'), date: r('.rcard-date'), thumb: r('.rcard-thumb'), main: r('.rcard-main'), stub: r('.rcard-stub'), one: r('.rcard-one'),
      titleLines: Math.round(title.getBoundingClientRect().height / lh), clipped: title.scrollHeight > title.clientHeight + 1,
    };
  }));
  const L = lay[0];
  check('긴 제목: 두 줄에서 말줄임', L.titleLines === 2 && L.clipped, JSON.stringify({ lines: L.titleLines, clipped: L.clipped }));
  check('긴 제목·날짜·한줄평이 겹치지 않음', lay.every((x) => x.title.bottom <= x.date.top + 1 && x.main.bottom <= x.stub.top + 1 && x.thumb.bottom <= x.stub.top + 1 &&
    (!x.one || (x.one.top >= x.stub.top && x.one.bottom <= x.card.bottom + 1))), JSON.stringify(lay.map((x) => [x.title.bottom, x.date.top, x.main.bottom, x.stub.top, x.one && x.one.bottom, x.card.bottom])));
  check('같은 줄 카드는 점선 높이가 같음', lay.every((x) => Math.abs(x.stub.top - lay[0].stub.top) < 1.5), JSON.stringify(lay.map((x) => x.stub.top)));
  check('긴 기록이 있어도 첫 줄이 화면 안', Math.max(...lay.map((x) => x.card.bottom)) <= 900, String(Math.max(...lay.map((x) => x.card.bottom))));
  await noOverflow('1440 홈');
  await shot('desktop-home');
  await api('DELETE', `/api/records?id=${encodeURIComponent(longRec.id)}`);
  await page.reload();
  await page.waitForSelector('.page-home .summary', { timeout: 8000 });

  await page.click('#tabbar [data-tab="records"]');
  await page.waitForSelector('.page-list .rcard');
  check('목록: 큰 필터 칸 대신 ‘필터’ 버튼 (처음엔 접힘)', await page.isHidden('.page-list .filter-panel') && await page.isVisible('.page-list .list-tools button[aria-controls="list-filter"]'));
  check('목록: 검색 · 필터 · 정렬이 한 줄', await sideBySide('.page-list .list-tools .search-wrap', '.page-list .list-tools .filter-btn') &&
    await sideBySide('.page-list .list-tools .filter-btn', '.page-list .list-tools select[aria-label="정렬"]'));
  check('목록: 머리의 ‘새 기록’은 숨김 (사이드바가 주 버튼)', await page.isHidden('.page-list .head-add') && await page.isVisible('#tabbar .side-cta'));
  await page.click('.page-list .list-tools button:has-text("필터")');
  const chipSel = '.page-list .filter-panel .chip-member:has(.chip-label:text-is("영식"))';
  await page.click(chipSel);
  const found = await until(async () => { const t = await text('.page-list .list-count'); return t.includes('찾았어요') && t; }, 3000);
  const shown = (await cardTitles()).length;
  const expected = (await api('GET', '/api/data')).data.records.filter((r) => (r.members || []).includes(ids['영식'])).length;
  check('필터 칩을 누르면 바로 걸러짐', !!found && (await page.getAttribute(chipSel, 'aria-pressed')) === 'true' && shown === expected, `${found} · 카드 ${shown} / 기대 ${expected}`);
  await page.click('.page-list .filter-panel button:has-text("필터 모두 해제")');
  await page.click('.page-list .list-tools button:has-text("필터")');
  await noOverflow('1440 목록');
  await shot('desktop-list');

  // 기록 없이 등록한 게임도 함께 (메모 · 메뉴 버튼) — 찍고 나서 지움
  const deskGame = (await api('POST', '/api/games', { game: { type: 'boardgame', title: '아그리콜라', memo: '확장 포함 · 1~4인' } })).data.game;
  await page.click('#tabbar [data-tab="collection"]');
  await page.waitForSelector('.page-collection');
  check('소장: 사이드바에서 열림 · 표시', (await page.getAttribute('#tabbar [data-tab="collection"]', 'aria-current')) === 'page');
  await syncFromServer();
  check('소장: 등록한 게임 카드 (메뉴 버튼)', !!(await until(() => page.$('.page-collection .gcard:has(.card-link:text-is("아그리콜라")) .gcard-more'))));
  await noOverflow('1440 소장');
  await shot('desktop-collection');
  await page.click('.page-collection .head-add');
  await page.waitForSelector(dlg);
  await noOverflow('1440 소장 게임 등록 창');
  await shot('desktop-collection-register');
  await dialogButton('닫기');
  await api('DELETE', `/api/games?id=${encodeURIComponent(deskGame.id)}`);
  await syncFromServer();

  await go(`#/record/${encodeURIComponent(ids.erPhoto)}`, '.page-detail');
  check('상세: (사진·요약) | (기록) 두 단', await sideBySide('.page-detail .detail-col-a', '.page-detail .detail-col-b'));
  check('상세: 사진이 왼쪽 단 맨 위', !!(await page.$('.page-detail .detail-col-a > .dgallery:first-child')));
  await noOverflow('1440 상세');
  await shot('desktop-detail');

  await go(`#/edit/${encodeURIComponent(ids.erPhoto)}`, '.page-form');
  const sheet = await page.$eval('.page-form .rec-sheet', (e) => { const b = e.getBoundingClientRect(); const v = document.querySelector('#view').getBoundingClientRect(); return { w: b.width, mid: b.left + b.width / 2, vmid: v.left + v.width / 2 }; });
  check('폼: 가운데 1열 · 최대 약 800px', sheet.w <= 802 && sheet.w >= 700 && Math.abs(sheet.mid - sheet.vmid) < 3, JSON.stringify(sheet));
  check('폼: 날짜와 별점은 한 줄', await sideBySide('.page-form .rec-date-rate > .rec-field:first-child', '.page-form .rec-rating'));
  check('폼: 입력칸 높이 44~48px', await page.$eval('.page-form [data-field="date"]', (e) => { const h = e.getBoundingClientRect().height; return h >= 44 && h <= 48; }));
  check('폼에서도 사이드바는 그대로 (휴대폰만 숨김)', await page.$eval('#tabbar', (e) => e.hidden && e.getBoundingClientRect().width > 0));
  check('저장 버튼이 폼 오른쪽 아래에 보임', await page.$eval('.page-form .save-btn', (e) => { const b = e.getBoundingClientRect(); const f = document.querySelector('.page-form .rec-sheet').getBoundingClientRect(); return b.bottom <= innerHeight && b.top > innerHeight - 120 && Math.abs(b.right - f.right) < 24; }));
  await noOverflow('1440 폼');
  await shot('desktop-form');
  await page.click('.page-form .savebar button:has-text("취소")');
  await sleep(150);

  await go('#/stats', '.page-stats');
  check('통계: 숫자 타일이 한 줄 (전체·이번 달 | 종류별)', await sideBySide('.page-stats .stats-body > .tiles-2', '.page-stats .stats-body > .tiles-3'));
  check('통계: 월별 · 요일별 차트가 나란히', await sideBySide('.page-stats .stats-body > .chart-card:nth-child(3)', '.page-stats .stats-body > .chart-card:nth-child(4)'));
  await noOverflow('1440 통계');
  await shot('desktop-stats');
  for (const seg of ['보드게임', '머더미스터리', '방탈출']) {
    await page.click(`.page-stats .seg-type .seg-item:has-text("${seg}")`);
    await noOverflow(`1440 통계 ${seg}`);
  }
  await page.click('.page-stats .seg-type .seg-item:has-text("전체")');

  await page.click('#tabbar [data-tab="members"]');
  await page.waitForSelector('.page-members .mlist');
  check('멤버: 카드 격자', await sideBySide('.page-members .mlist li:nth-child(1)', '.page-members .mlist li:nth-child(2)'));
  check('멤버 추가 버튼에 글자', (await text('.page-members .page-head button[aria-label="멤버 추가"]')) === '멤버 추가');
  await noOverflow('1440 멤버');
  await go(`#/member/${encodeURIComponent(ids['영식'])}`, '.page-profile');
  check('프로필: 소개 | 종류별 타일 나란히', await sideBySide('.page-profile > .phero', '.page-profile > .ptiles'));
  await noOverflow('1440 프로필');

  await page.click('#tabbar .tab-settings');
  await page.waitForSelector('.page-settings');
  check('설정: 사이드바에서 열림 · 표시', (await page.getAttribute('#tabbar .tab-settings', 'aria-current')) === 'page');
  check('설정: 두 단', await sideBySide('.page-settings .set-col:nth-child(1)', '.page-settings .set-col:nth-child(2)'));
  await noOverflow('1440 설정');
  await shot('desktop-settings');

  await page.click('#tabbar .side-cta');
  await page.waitForSelector('.page-form');
  check('새 기록: 바로 폼 · 종류 세 칸이 한 줄', await sideBySide('.page-form .rec-type .seg-item.t-boardgame', '.page-form .rec-type .seg-item.t-murdermystery'));
  await noOverflow('1440 새 기록');
  await shot('desktop-form-new');
  await page.click('.page-form .rec-type .seg-item:has-text("머더미스터리")');
  await page.fill('.page-form [data-field="mm.myRole"]', '세바스찬');
  check('새 기록(머더미스터리): 내 역할 칸이 가운데 1열 안에 · 가로 넘침 없음', await page.$eval('.page-form .rec-role', (e) => { const b = e.getBoundingClientRect(); const f = document.querySelector('.page-form .rec-sheet').getBoundingClientRect(); return b.left >= f.left && b.right <= f.right && b.width > 0; }));
  await noOverflow('1440 새 기록 (머더미스터리)');
  await shot('desktop-form-murdermystery');
  await page.evaluate(() => localStorage.removeItem('ddh:draft'));
});

await step('태블릿 1024px: 왼쪽 레일 · 가로 스크롤 없음', async () => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await go('#/', '.page-home');
  const rail = await page.$eval('#tabbar', (e) => e.getBoundingClientRect().width);
  check('메뉴가 좁은 레일', rail >= 80 && rail <= 100, String(rail));
  check('레일에도 설정', await page.isVisible('#tabbar .tab-settings'));
  for (const [hash, sel] of [['#/', '.page-home'], ['#/records', '.page-list'], [`#/record/${encodeURIComponent(ids.mm)}`, '.page-detail'], [`#/edit/${encodeURIComponent(ids.mm)}`, '.page-form'], ['#/stats', '.page-stats'], ['#/settings', '.page-settings'], ['#/collection', '.page-collection']]) {
    await go(hash, sel);
    await noOverflow(`1024 ${hash}`);
    if (sel === '.page-form') { await page.click('.page-form .savebar button:has-text("취소")'); await sleep(150); }
  }
  await go('#/records', '.page-list');
  check('1024: 필터는 버튼으로 여닫음', await page.isVisible('.page-list .list-tools button[aria-controls="list-filter"]'));
  await page.setViewportSize({ width: 1440, height: 900 });
});

await step('노트북 잠금 화면: 표지 | 입장 코드 두 칸', async () => {
  const lc = await newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  const lp = await lc.newPage();
  watch(lp, '[desktop-lock] ');
  await lp.goto(`${BASE}/`);
  await lp.waitForSelector('.lock #lock-key');
  check('메뉴 숨김', await lp.$eval('#tabbar', (e) => e.getBoundingClientRect().width === 0));
  check('표지와 입장 코드가 나란히', await lp.evaluate(() => {
    const a = document.querySelector('.lock-brand').getBoundingClientRect();
    const b = document.querySelector('.lock-body').getBoundingClientRect();
    return Math.abs(a.top - b.top) < 2 && a.right <= b.left;
  }));
  await lp.screenshot({ path: path.join(SHOTS, 'desktop-lock.png') });
  await lc.close();
});

await dc.close();

// ── 마무리 ──────────────────────────────────────────────────
currentStep = '전체';
console.log('\n[전체]');
check('콘솔 오류 · 페이지 오류 없음', problems.length === 0, `${problems.slice(0, 10).join(' || ')} [HTTP 오류 응답: ${netLog.join(', ')}]`);
check('CSP 위반 없음', cspViolations.length === 0, cspViolations.slice(0, 10).join(' || '));
check('서버 오류 로그 없음', serverErrors.length === 0, serverErrors.slice(0, 5).join(' || '));

await browser.close();
await srv.close();

writeFileSync(path.join(SHOTS, '..', 'e2e-summary.txt'), `pass ${passN}\nfail ${failN}\n${failures.join('\n')}\n`);
console.log(`\n결과: 통과 ${passN} · 실패 ${failN}`);
if (failN) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exitCode = 1;
}
console.log(`스크린샷: ${SHOTS}`);
