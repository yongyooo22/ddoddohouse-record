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
async function scoreRow(label, keys) {
  await setRating(`.page-form .score-row:has(.score-label:text-is("${label}")) .rating-track`, keys);
}
async function pickMembers(names) {
  for (const n of names) await page.click(`.chips-members .chip-member:has(.chip-label:text-is("${n}"))`);
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
  await page.click('.page-members .mlist-row:has(.mlist-name:text-is("민지"))');
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

await step('보드게임 기록 (점수·자동 순위·승자)', async () => {
  await page.click('#tabbar .tab-add');
  await page.waitForSelector('.page-picker');
  await noOverflow('종류 선택');
  await shot('07-picker');
  await page.click('.pick.t-boardgame');
  await page.waitForSelector('.page-form');
  check('폼에서는 탭바 숨김', await page.$eval('#tabbar', (e) => e.hidden));
  check('날짜 기본값 (새벽 5시 전이면 어제, 아니면 오늘)', (await page.inputValue('[data-field="date"]')) === DEFAULT_DATE, `${await page.inputValue('[data-field="date"]')} vs ${DEFAULT_DATE} (${seoulHour}시)`);
  const pressedChip = await page.$$eval('.date-quick .chip[aria-pressed="true"]', (els) => els.map((e) => e.textContent));
  check('기본 날짜에 맞는 빠른 선택 칩 표시', JSON.stringify(pressedChip) === JSON.stringify([seoulHour < 5 ? '어제' : '오늘']), JSON.stringify(pressedChip));
  await page.click('.date-quick .chip:text-is("어제")');
  check('‘어제’ 한 번에 선택', (await page.inputValue('[data-field="date"]')) === YESTERDAY);
  await page.click('.date-quick .chip:text-is("오늘")');
  check('‘오늘’ 한 번에 선택', (await page.inputValue('[data-field="date"]')) === TODAY &&
    (await page.getAttribute('.date-quick .chip:text-is("오늘")', 'aria-pressed')) === 'true');

  // 제목 없이 저장 → 오류
  await page.click('.save-btn');
  check('제목 없으면 저장 안 됨', !!(await toastSeen(/게임 이름을 적어 주세요/)));
  check('제목 칸 aria-invalid', (await page.getAttribute('[data-field="title"]', 'aria-invalid')) === 'true');

  await page.fill('[data-field="title"]', '테라포밍 마스');
  // 별점: 탭(반 별) → 4번째 별 왼쪽 절반 = 3.5
  const track = '.fsec-main .rating-track';
  const u4 = await page.$(`${track} .r-unit:nth-child(4)`);
  const b = await u4.boundingBox();
  await page.mouse.click(b.x + b.width * 0.25, b.y + b.height / 2);
  check('반 별 탭 → 3.5', (await ratingOf(track)) === '3.5', await ratingOf(track));
  // 드래그 → 5점
  const u1 = await (await page.$(`${track} .r-unit:nth-child(1)`)).boundingBox();
  const u5 = await (await page.$(`${track} .r-unit:nth-child(5)`)).boundingBox();
  await page.mouse.move(u1.x + 4, u1.y + u1.height / 2);
  await page.mouse.down();
  await page.mouse.move(u5.x + u5.width * 0.5, u5.y + u5.height / 2, { steps: 8 });
  await page.mouse.move(u5.x + u5.width - 2, u5.y + u5.height / 2, { steps: 2 });
  await page.mouse.up();
  check('드래그 → 5점', (await ratingOf(track)) === '5', await ratingOf(track));
  // 키보드 → 4.5
  await setRating(track, ['4', 'ArrowRight']);
  check('키보드 → 4.5', (await ratingOf(track)) === '4.5', await ratingOf(track));

  await pickMembers(['연경', '영식', '민지짱']);
  await page.fill('.page-form input[placeholder="예) 또또하우스"]', '또또하우스 거실');
  await page.fill('.page-form input[aria-label="플레이 시간(분)"]', '150');
  await page.fill('.page-form input[placeholder="사용한 확장판 (선택)"]', '서곡');
  const row = (n) => `.result-row:has(.rr-name:text-is("${n}"))`;
  await page.fill(`${row('연경')} .input-score`, '85');
  await page.fill(`${row('영식')} .input-score`, '92');
  await page.fill(`${row('민지짱')} .input-score`, '85');
  const ranks = {
    연경: await text(`${row('연경')} .rank-badge`),
    영식: await text(`${row('영식')} .rank-badge`),
    민지짱: await text(`${row('민지짱')} .rank-badge`),
  };
  check('자동 순위(동점 포함)', ranks.연경 === '2등' && ranks.영식 === '1등' && ranks.민지짱 === '2등', JSON.stringify(ranks));
  const wins = await page.$$eval('.result-row .win-toggle', (els) => els.map((e) => e.getAttribute('aria-pressed')));
  check('승자 자동 표시(영식만)', JSON.stringify(wins) === JSON.stringify(['false', 'true', 'false']), JSON.stringify(wins));
  // 낮은 점수 1등으로 바꾸면 순위가 뒤집힘
  await page.selectOption('.page-form select[aria-label="순위 계산 방식"]', 'low');
  const lowRanks = await texts('.result-row .rank-badge');
  check('낮은 점수 1등 모드', JSON.stringify(lowRanks) === JSON.stringify(['1등', '3등', '1등']), JSON.stringify(lowRanks));
  await page.selectOption('.page-form select[aria-label="순위 계산 방식"]', 'high');
  const wins2 = await page.$$eval('.result-row .win-toggle', (els) => els.map((e) => e.getAttribute('aria-pressed')));
  check('높은 점수 모드로 돌아오면 다시 영식 승', JSON.stringify(wins2) === JSON.stringify(['false', 'true', 'false']), JSON.stringify(wins2));

  await page.fill('.page-form input[placeholder="한 문장으로 남긴다면?"]', '화성 개척은 역시 재밌다');
  await page.fill('.page-form textarea', '영식이 막판 도시 타일로 역전했다.\n다음엔 확장 더 넣어서!');
  await page.click('.chip-tag:has(.chip-label:text-is("#전략"))');
  // 소장 여부: 기본 미기록, ‘대여’일 때만 빌려준 사람 칸
  const lenderIn = '.page-form input[placeholder="예) 영식 (선택)"]';
  check('소장 여부 기본은 미기록', (await page.$eval('.page-form .seg-own .seg-input:checked', (e) => e.value)) === 'none');
  check('빌려준 사람 칸은 처음엔 숨김', await page.isHidden(lenderIn));
  await page.click('.page-form .seg-own .seg-item:has-text("대여")');
  check('대여 → 빌려준 사람 칸', await page.isVisible(lenderIn));
  await page.fill(lenderIn, '영식');
  await page.click('.page-form .seg-own .seg-item:has-text("내 소장")');
  check('내 소장 → 빌려준 사람 칸 숨김', await page.isHidden(lenderIn));
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
  ids.bg = decodeURIComponent(page.url().split('#/record/')[1] || '');
  const rows = await texts('.page-detail .rank-row');
  check('상세: 순위 3줄, 영식 1등', rows.length === 3 && rows[0].startsWith('1') && rows[0].includes('영식'), rows.join(' | '));
  check('상세: 우승자 표시', (await texts('.page-detail .rank-row.is-winner .mrow-name')).join() === '영식');
  check('상세: 우승 도장', (await text('.dhero-stamp')).includes('우승'));
  const info = await text('.page-detail .info-grid');
  check('상세: 장소·시간·확장판', info.includes('또또하우스 거실') && info.includes('2시간 30분') && info.includes('서곡'), info);
  check('상세: 소장 여부 내 소장', info.includes('소장 여부') && info.includes('내 소장'), info);
  check('상세: 별점 4.5', (await text('.dhero-rating .stars-num')) === '4.5');
  check('상세: 태그', (await texts('.page-detail .dtags .tag')).includes('#전략'));
  const saved = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.bg);
  check('서버 저장: 결과·순위·승자', saved && saved.bg.results.length === 3 && saved.bg.results.find((x) => x.memberId === ids['영식']).winner === true &&
    saved.bg.results.find((x) => x.memberId === ids['연경']).rank === 2 && saved.bg.playTimeMin === 150, JSON.stringify(saved && saved.bg));
  check('서버 저장: 내 소장 (빌려준 사람은 비움)', saved && saved.bg.ownership === 'mine' && saved.bg.lender === '', JSON.stringify(saved && saved.bg));
  await noOverflow('보드게임 상세');
  await shot('09-detail-boardgame');
});

await step('머더미스터리 기록 (역할·범인·세부 점수·스포일러)', async () => {
  await page.click('.page-detail .appbar button[aria-label="뒤로"]');
  await page.waitForSelector('.page-picker, .page-list, .page-home', { timeout: 5000 }).catch(() => {});
  await go('#/new/murdermystery', '.page-form.t-murdermystery');
  await page.click('.date-quick .chip:text-is("오늘")');
  await page.fill('[data-field="title"]', '붉은 저택의 초대');
  await setRating('.fsec-main .rating-track', ['4']);
  await pickMembers(['연경', '영식', '도윤']);
  await page.fill('.page-form input[placeholder="예) 머더랩"]', '머더랩');
  await page.click('.page-form .seg-item:has-text("매장형")');
  // 소장 여부는 집에서 하는 보드게임형만
  check('머미 매장형: 소장 여부 칸 없음', await page.isHidden('.page-form .own-fields'));
  await page.click('.page-form .seg-item:has-text("보드게임형")');
  check('머미 보드게임형: 소장 여부 칸', await page.isVisible('.page-form .own-fields .seg-own'));
  await page.click('.page-form .seg-item:has-text("매장형")');
  check('다시 매장형: 소장 여부 칸 숨김', await page.isHidden('.page-form .own-fields'));
  await page.fill('.page-form input[placeholder="예) 강남점"]', '강남점');
  await page.fill('.page-form input[placeholder="선택"]', '하람');
  await page.fill('.page-form input[aria-label="인원"]', '6');
  await page.fill('.page-form input[aria-label="플레이 시간(분)"]', '240');
  const role = (n) => `.role-card:has(.rr-name:text-is("${n}"))`;
  await page.fill(`${role('연경')} .role-char-input`, '집사 세바스찬');
  await page.click(`${role('연경')} .chip-culprit`);
  await page.click(`${role('연경')} .chip-mvp`);
  await page.click(`${role('연경')} .seg-item:has-text("승")`);
  await page.fill(`${role('영식')} .role-char-input`, '탐정 조수');
  await page.click(`${role('영식')} .seg-item:has-text("패")`);
  await page.fill(`${role('도윤')} .role-char-input`, '정원사');
  check('범인 카드 강조', await page.$eval(role('연경'), (e) => e.classList.contains('is-culprit')));
  await page.click('.page-form [aria-label="범인 검거 결과"] .seg-item:has-text("범인 도주")');
  await scoreRow('스토리', ['4', 'ArrowRight']);
  await scoreRow('추리', ['4']);
  await scoreRow('롤플레이', ['5']);
  await scoreRow('밸런스', ['3', 'ArrowRight']);
  await scoreRow('연출·구성물', ['4']);
  await scoreRow('추리 난이도', ['3']);
  await page.click('.page-form label.switch-row:has-text("다시 하고 싶어요")');
  await page.fill('.page-form input[placeholder="한 문장으로 남긴다면?"]', '범인이 집사였다니');
  await page.fill('.page-form textarea', '집사가 범인이었고 끝까지 안 들켰다. 마지막 투표에서 영식이 엉뚱한 사람을 찍음.');
  await page.click('.page-form label.switch-row:has-text("스포일러 포함")');
  await page.click('.chip-tag:has(.chip-label:text-is("#반전"))');
  await page.click('.chip-tag:has(.chip-label:text-is("#추리중심"))');
  await page.fill('.page-form input[aria-label="태그 직접 입력"]', '#인생 시나리오');
  await page.press('.page-form input[aria-label="태그 직접 입력"]', 'Enter');
  const on = await texts('.page-form .chip-tag[aria-pressed="true"] .chip-label');
  check('태그 3개 선택(직접 입력 포함, # 과 공백 제거)', on.length === 3 && on.includes('#인생시나리오'), on.join(','));
  await noOverflow('머미 폼');
  await shot('10-form-murdermystery');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  ids.mm = decodeURIComponent(page.url().split('#/record/')[1] || '');

  // 상세: 스포일러는 가려져 있다가 탭하면 보임 (한줄평 · 범인/배역 · 후기)
  const reviewSec = '.page-detail .dsec:has(.dsec-title:text-is("후기"))';
  const rolesSec = '.page-detail .dsec:has(.dsec-title:text-is("역할과 결과"))';
  const blurred = await page.$$eval('.page-detail .spoiler .spoiler-content', (els) => els.map((e) => getComputedStyle(e).filter));
  check('상세: 한줄평·범인/배역·후기 모두 가림', blurred.length === 3 && blurred.every((f) => f.includes('blur')), JSON.stringify(blurred));
  check('상세: 가린 내용은 스크린리더에도 숨김', await page.$eval(`${reviewSec} .spoiler-content`, (e) => e.getAttribute('aria-hidden') === 'true'));
  check('상세: 가린 배역의 멤버 링크는 키보드로도 못 감(inert)', await page.$eval(`${rolesSec} .spoiler-content`, (e) => e.inert === true && e.getAttribute('aria-hidden') === 'true'));
  check('상세: 범인 도주 결과 도장은 그대로 보임', (await text(`${rolesSec} .result-big`)).includes('범인 도주'));
  check('상세: 배역 가림 버튼', (await text(`${rolesSec} .spoiler-btn`)) === '범인·배역 보기', await text(`${rolesSec} .spoiler-btn`));
  await shot('11-detail-murdermystery-hidden');
  await page.click(`${reviewSec} .spoiler .spoiler-btn`);
  const after = await until(() => page.$eval(`${reviewSec} .spoiler-content`, (e) => (getComputedStyle(e).filter === 'none' ? 'none' : '')), 2000);
  check('탭하면 후기 보임', after === 'none', await page.$eval(`${reviewSec} .spoiler-content`, (e) => getComputedStyle(e).filter));
  check('후기를 펼쳐도 범인/배역은 계속 가림', !!(await page.$(`${rolesSec} .spoiler:not(.is-revealed) .spoiler-btn`)));
  check('후기 내용', (await text('.page-detail .review-text')).includes('집사가 범인이었고'));
  // 백그라운드 새로고침(다시 온라인 등)으로 화면을 다시 그려도 펼친 스포일러는 그대로
  const reqs = [];
  const onReq = (r) => { if (r.url().endsWith('/api/data')) reqs.push(r); };
  page.on('request', onReq);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => reqs.length > 0, 3000);
  await sleep(400);
  page.off('request', onReq);
  check('새로고침 후에도 펼친 후기 유지', reqs.length > 0 && !!(await page.$(`${reviewSec} .spoiler.is-revealed`)) && !(await page.$(`${reviewSec} .spoiler-btn`)));
  check('안 펼친 한줄평은 계속 가림', !!(await page.$('.page-detail .dhero .spoiler:not(.is-revealed) .spoiler-btn')));
  await page.click(`${rolesSec} .spoiler-btn`);
  check('범인·배역 펼침', !!(await until(() => page.$(`${rolesSec} .spoiler.is-revealed`), 2000)) &&
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
  const tags = await texts('.page-detail .dtags .tag');
  check('태그 표시', ['#반전', '#추리중심', '#인생시나리오'].every((t) => tags.includes(t)), tags.join(','));
  const saved = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.mm);
  check('서버 저장: 역할·범인·점수', saved && saved.mm.roles.length === 3 && saved.mm.culpritResult === 'escaped' &&
    saved.mm.scores.story === 4.5 && saved.mm.difficulty === 3 && saved.mm.replay === true && saved.spoiler === true &&
    saved.mm.roles.find((x) => x.memberId === ids['연경']).culprit === true, JSON.stringify(saved && saved.mm));
  await noOverflow('머미 상세');
  await shot('12-detail-murdermystery');
});

await step('방탈출 기록 (성공·남은 시간·힌트)', async () => {
  await go('#/new/escaperoom', '.page-form.t-escaperoom');
  await page.click('.date-quick .chip:text-is("오늘")');
  check('누적 번호 미리보기 (2번째)', (await text('.ordinal-note')).includes('2번째'), await text('.ordinal-note'));
  await page.fill('[data-field="title"]', '잊혀진 연구소');
  await setRating('.fsec-main .rating-track', ['5']);
  await pickMembers(['연경', '영식', '민지짱']);
  await page.fill('.page-form input[placeholder="예) 키이스케이프"]', '키이스케이프');
  await page.fill('.page-form input[placeholder="예) 홍대점"]', '홍대점');
  await page.fill('.page-form input[placeholder="예) 추리"]', 'SF');
  await page.fill('.page-form input[aria-label="제한 시간(분)"]', '75');
  // 성공/실패 안 고르면 저장 안 됨
  const stampOpacity = await page.$eval('label.stamp-choice-clear .stamp', (e) => Number(getComputedStyle(e).opacity));
  check('고르기 전 도장도 읽힘 (흐리게만, 흑백 아님)', stampOpacity >= 0.55 && (await page.$eval('label.stamp-choice-clear .stamp', (e) => getComputedStyle(e).filter)) === 'none', String(stampOpacity));
  await page.click('.save-btn');
  check('성공/실패 필수', !!(await toastSeen(/탈출 성공\/실패를 골라 주세요/)));
  check('성공/실패 묶음에 오류 표시', (await page.getAttribute('.stamp-choices', 'aria-invalid')) === 'true');
  const dangerColor = await page.evaluate(() => { const d = document.createElement('span'); d.style.color = 'var(--danger)'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  const choiceBorder = await until(async () => {
    const c = await page.$eval('label.stamp-choice-clear', (e) => getComputedStyle(e).borderTopColor);
    return c === dangerColor ? c : null;
  }, 2000);
  check('성공/실패 도장 테두리 빨갛게', choiceBorder === dangerColor, `${await page.$eval('label.stamp-choice-clear', (e) => getComputedStyle(e).borderTopColor)} vs ${dangerColor}`);
  check('초점이 성공/실패 선택으로 이동', await page.evaluate(() => document.activeElement && document.activeElement.name && document.activeElement.type === 'radio'));
  await page.click('label.stamp-choice-clear');
  check('고르면 오류 표시 사라짐', (await page.getAttribute('.stamp-choices', 'aria-invalid')) === null);
  await page.fill('.page-form input[aria-label="제한 시간(분)"]', '500');
  await page.click('.save-btn');
  check('제한 시간 범위 확인', !!(await toastSeen(/제한 시간은 1~300분 사이로/)));
  check('제한 시간 칸 표시', (await page.getAttribute('.page-form input[aria-label="제한 시간(분)"]', 'aria-invalid')) === 'true');
  await page.fill('.page-form input[aria-label="제한 시간(분)"]', '75');
  check('고치면 제한 시간 오류 표시 사라짐', (await page.getAttribute('.page-form input[aria-label="제한 시간(분)"]', 'aria-invalid')) === null);
  await page.fill('input[aria-label="남은 시간 분"]', '300');
  await page.fill('input[aria-label="남은 시간 초"]', '59');
  await page.click('.save-btn');
  check('남은 시간 300분 초과 거부', !!(await toastSeen(/남은 시간은 300분 이하로/)));
  await page.fill('input[aria-label="남은 시간 분"]', '12');
  await page.fill('input[aria-label="남은 시간 초"]', '34');
  await page.click('button[aria-label="힌트 수 늘리기"]');
  await page.click('button[aria-label="힌트 수 늘리기"]');
  check('힌트 2', (await page.inputValue('.stepper-input')) === '2');
  await scoreRow('스토리', ['4']);
  await scoreRow('인테리어', ['5']);
  await scoreRow('문제', ['4', 'ArrowRight']);
  await scoreRow('장치·연출', ['3']);
  await scoreRow('난이도', ['3', 'ArrowRight']);
  check('공포도 0 은 ‘없음/미평가’로 안내', (await text('.page-form .score-row:has(.score-label:text-is("공포도")) .rating-out')) === '없음/미평가',
    await text('.page-form .score-row:has(.score-label:text-is("공포도")) .rating-out'));
  await scoreRow('공포도', ['1']);
  await scoreRow('활동성', ['2']);
  await page.click('.page-form label.switch-row:has-text("추천해요")');
  await page.fill('.page-form input[placeholder="한 문장으로 남긴다면?"]', '장치가 끝내준다');
  await noOverflow('방탈출 폼');
  await shot('13-form-escaperoom');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  ids.er = decodeURIComponent(page.url().split('#/record/')[1] || '');
  const nums = await texts('.page-detail .er-num');
  check('남은 시간 12:34 · 힌트 2', nums.some((n) => n.includes('12:34')) && nums.some((n) => n.startsWith('2')), nums.join(' | '));
  check('탈출 성공 도장', (await text('.dhero-stamp')).includes('탈출 성공'));
  check('2번째 방탈출', (await text('.dhero-top .ordinal')) === '2번째 방탈출', await text('.dhero-top .ordinal'));
  const gauges = await texts('.page-detail .gauge-item');
  check('난이도·공포도·활동성 게이지', gauges.length === 3 && gauges[0].includes('3.5'), gauges.join(' | '));
  const saved = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.er);
  check('서버 저장: remainingSec=754, hints=2', saved && saved.er.cleared === true && saved.er.remainingSec === 754 && saved.er.hints === 2 &&
    saved.er.timeLimitMin === 75 && saved.er.playerCount === 3 && saved.er.scores.puzzle === 4.5, JSON.stringify(saved && saved.er));
  await noOverflow('방탈출 상세');
  await shot('14-detail-escaperoom');
});

await step('초안 이어 쓰기 (같은 id 로 저장)', async () => {
  await page.click('#tabbar .tab-add');
  await page.waitForSelector('.page-picker');
  await page.click('.pick.t-boardgame');
  await page.waitForSelector('.page-form');
  await page.fill('[data-field="title"]', '삭제할 게임');
  const draft = await until(() => page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('ddh:draft') || 'null');
    return d && d.model && d.model.title === '삭제할 게임' ? d : null;
  }), 3000);
  check('입력 중 초안 저장', !!draft);
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await page.waitForSelector('.page-home, .page-picker, .page-detail, .page-list', { timeout: 5000 });
  await page.click('#tabbar .tab-add');
  await page.waitForSelector('.page-picker .draft-card');
  check('종류 선택에 초안 카드', (await text('.page-picker .draft-card')).includes('삭제할 게임'));
  await page.click('.page-picker .draft-card button:has-text("이어 쓰기")');
  await page.waitForSelector('.page-form');
  check('제목 복원', (await page.inputValue('[data-field="title"]')) === '삭제할 게임');
  await pickMembers(['연경']);
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
  check('머미 배지', (await text(`${cardOf('붉은 저택의 초대')} .badge`)) === '머미');
  check('방탈출 배지', (await text(`${cardOf('잊혀진 연구소')} .badge`)) === '방탈출');
  // 티켓 카드: 장르 태그 → 제목(최대 두 줄) → 날짜 · 점선 아래 ★ 평점 · 한줄평
  // 우승자·참여자·배역·범인·스포일러·남은 시간·누적 번호는 상세 화면에서
  const bgCard = cardOf('테라포밍 마스');
  check('카드 날짜: 2026.10.01 꼴 회색 글씨', /^\d{4}\.\d{2}\.\d{2}$/.test(await text(`${bgCard} .rcard-date`)), await text(`${bgCard} .rcard-date`));
  check('카드 평점: ★ 4.5 (별 다섯 개 대신)', (await text(`${bgCard} .rcard-rating`)) === '4.5' &&
    (await page.getAttribute(`${bgCard} .rcard-rating`, 'aria-label')) === '별점 4.5점' && !(await page.$('.page-list .rcard .stars')));
  check('카드 한줄평', (await text(`${bgCard} .rcard-one`)) === '화성 개척은 역시 재밌다', await text(`${bgCard} .rcard-one`));
  const bgText = await text(bgCard);
  check('보드게임 카드: 우승 도장·승자·참여자는 상세로', !bgText.includes('우승') && !bgText.includes('영식') && !(await page.$(`${bgCard} .avatar`)), bgText);
  check('카드 대표 사진 칸 72px 정사각형', await page.$eval(`${bgCard} .rcard-thumb`, (e) => { const b = e.getBoundingClientRect(); return Math.round(b.width) === 72 && Math.round(b.height) === 72; }));
  check('카드 제목은 최대 두 줄', await page.$eval(`${bgCard} .rcard-title`, (e) => getComputedStyle(e).webkitLineClamp === '2'));
  // 스포일러 머미 기록: 범인·배역·한줄평(스포일러)·후기는 카드에 아예 안 보임 — 가린 칸도 두지 않고 생략
  const mmCard = cardOf('붉은 저택의 초대');
  const mmText = await text(mmCard);
  check('스포일러 머미 카드: 범인·배역·한줄평 생략', !mmText.includes('범인') && !mmText.includes('세바스찬') && !mmText.includes('집사') &&
    !(await page.$(`${mmCard} .spoiler`)) && !(await page.$(`${mmCard} .rcard-one`)), mmText);
  check('스포일러 머미 카드: 평점은 보임', (await text(`${mmCard} .rcard-rating`)) === '4.0', await text(`${mmCard} .rcard-rating`));
  check('방탈출 카드: 작은 성공 배지', (await text(`${cardOf('잊혀진 연구소')} .rbadge`)) === '탈출 성공');
  check('실패 방탈출: 작은 실패 배지', (await text(`${cardOf('저주받은 인형의 집')} .rbadge`)) === '탈출 실패');
  check('보드게임·머미 카드엔 결과 배지 없음', !(await page.$(`${bgCard} .rbadge-clear, ${bgCard} .rbadge-fail`)) && !(await page.$(`${mmCard} .rbadge`)));
  check('보드게임 카드: 작은 내 소장 배지 (매장형 머미는 없음)', (await text(`${bgCard} .rbadge`)) === '내 소장');
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
  await page.click('.page-list .seg-type .seg-item:has-text("머미")');
  let t = await until(async () => { const x = await cardTitles(); return x.length === 1 && x; });
  check('머미 필터 → 1개', t && t[0] === '붉은 저택의 초대', String(t));
  await page.click('.page-list .seg-type .seg-item:has-text("방탈출")');
  t = await until(async () => { const x = await cardTitles(); return x.length === 2 && x; });
  check('방탈출 필터 → 2개', !!t, String(t));
  await page.click('.page-list .seg-type .seg-item:has-text("전체")');
  // 검색 (제목 · 매장 · 태그 · 후기)
  const search = async (q, expect) => {
    await page.fill('.page-list .search-input', q);
    const got = await until(async () => { const x = await cardTitles(); return JSON.stringify(x.sort()) === JSON.stringify([...expect].sort()) && x; }, 3000);
    check(`검색 "${q}" → ${expect.length}개`, !!got, String(await cardTitles()));
  };
  await search('연구소', ['잊혀진 연구소']);
  await search('강남점', ['붉은 저택의 초대', '저주받은 인형의 집']);
  await search('#반전', ['붉은 저택의 초대']);
  await search('역전했다', ['테라포밍 마스']);
  await search('없는검색어', []);
  check('결과 없음 안내', !!(await page.$('.page-list .empty')));
  await search('', ['테라포밍 마스', '붉은 저택의 초대', '잊혀진 연구소', '저주받은 인형의 집', '삭제할 게임']);
  // 멤버 필터
  await page.click('.page-list .list-tools button:has-text("필터")');
  await page.click('.page-list .filter-panel .chip-member:has(.chip-label:text-is("민지짱"))');
  t = await until(async () => { const x = await cardTitles(); return x.length === 2 && x; });
  check('멤버 필터(민지짱) → 2개', !!t, String(await cardTitles()));
  await page.click('.page-list .filter-panel .chip-tag:has(.chip-label:text-is("#전략"))');
  t = await until(async () => { const x = await cardTitles(); return x.length === 1 && x; });
  check('멤버+태그 필터 → 1개', t && t[0] === '테라포밍 마스', String(await cardTitles()));
  await noOverflow('필터 열린 목록');
  await shot('16-list-filtered');
  await page.click('.page-list .filter-panel button:has-text("필터 초기화")');
  t = await until(async () => { const x = await cardTitles(); return x.length === 5 && x; });
  check('필터 초기화 → 5개', !!t);
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

await step('기록 수정', async () => {
  await go(`#/record/${encodeURIComponent(ids.bg)}`, '.page-detail');
  await page.click('.page-detail .dactions a:has-text("수정하기")');
  await page.waitForSelector('.page-form');
  check('수정 폼에 기존 제목', (await page.inputValue('[data-field="title"]')) === '테라포밍 마스');
  check('수정 폼에 기존 별점', (await ratingOf('.fsec-main .rating-track')) === '4.5');
  const ranks = await page.$$eval('.result-row select.select-rank', (els) => els.map((e) => e.value));
  check('수정 폼: 저장된 순위 유지(직접 입력)', JSON.stringify(ranks) === JSON.stringify(['2', '1', '2']), JSON.stringify(ranks));
  await page.fill('.page-form input[placeholder="한 문장으로 남긴다면?"]', '화성 개척은 언제나 옳다');
  await setRating('.fsec-main .rating-track', ['ArrowRight']);
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  check('수정 토스트', !!(await toastSeen(/수정했어요/)));
  check('수정된 한줄평', (await text('.page-detail .hero-one')).includes('언제나 옳다'));
  check('수정된 별점 5.0', (await text('.dhero-rating .stars-num')) === '5.0');
  check('수정 시각 표시', (await text('.page-detail .dmeta')).includes('수정'));
  const rows = await texts('.page-detail .rank-row');
  check('수정 후에도 순위 유지', rows[0] && rows[0].includes('영식'), rows.join(' | '));
});

await step('동시 수정 충돌 (409) — 취소 후 초안으로 덮어쓰기', async () => {
  await go(`#/edit/${encodeURIComponent(ids.er)}`, '.page-form');
  // 다른 사람이 먼저 수정
  const cur = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.er);
  const other = await api('POST', '/api/records', { record: { ...cur, title: '잊혀진 연구소 (리뉴얼)' }, baseUpdatedAt: cur.updatedAt });
  check('다른 기기 수정 성공', other.status === 200);
  await page.fill('.page-form input[placeholder="한 문장으로 남긴다면?"]', '장치가 정말 끝내준다 (내 수정)');
  await allowing([/status of 409/], async () => {
    await page.click('.save-btn');
    await page.waitForSelector(dlg, { timeout: 8000 });
  });
  check('충돌 다이얼로그 제목', (await text(`${dlg} .dlg-title`)) === '다른 사람이 먼저 수정했어요');
  check('최신본 표시', (await text(`${dlg} .conflict-title`)) === '잊혀진 연구소 (리뉴얼)', await text(`${dlg} .conflict-title`));
  const diff = await text(`${dlg} .conflict-diff`);
  check('다른 부분 안내', diff.includes('제목') && diff.includes('한줄평'), diff);
  await noOverflow('충돌 다이얼로그');
  await shot('17-conflict-dialog');
  await dialogButton('취소');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  check('취소 → 최신본 상세', (await text('.dhero-title')) === '잊혀진 연구소 (리뉴얼)');
  check('내 내용은 초안으로 보관', await page.evaluate(() => (JSON.parse(localStorage.getItem('ddh:draft') || 'null') || {}).key || null) === `edit:${ids.er}`);

  // 다시 수정 → 초안 불러오기 → 저장 → 또 충돌 → 덮어쓰기
  await page.click('.page-detail .dactions a:has-text("수정하기")');
  await page.waitForSelector('.page-form .draft-banner:not([hidden])');
  check('초안 배너', true);
  await page.click('.page-form .draft-banner button:has-text("불러오기")');
  check('초안의 내 한줄평 복원', (await page.inputValue('.page-form input[placeholder="한 문장으로 남긴다면?"]')) === '장치가 정말 끝내준다 (내 수정)');
  await allowing([/status of 409/], async () => {
    await page.click('.save-btn');
    await page.waitForSelector(dlg, { timeout: 8000 });
  });
  check('초안의 오래된 기준 → 다시 충돌', (await text(`${dlg} .dlg-title`)) === '다른 사람이 먼저 수정했어요');
  await dialogButton('내 내용으로 덮어쓰기');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  check('덮어쓰기 → 내 제목', (await text('.dhero-title')) === '잊혀진 연구소', await text('.dhero-title'));
  check('덮어쓰기 → 내 한줄평', (await text('.page-detail .hero-one')).includes('(내 수정)'));
  check('덮어쓴 뒤 초안 삭제', (await page.evaluate(() => localStorage.getItem('ddh:draft'))) === null);
  const saved = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.er);
  check('서버에도 내 내용', saved.title === '잊혀진 연구소' && saved.oneLiner.includes('(내 수정)') && saved.er.remainingSec === 754, JSON.stringify(saved));
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
  await go(`#/edit/${encodeURIComponent(ids.mm)}`, '.page-form');
  check('수정 폼: 떠난 멤버 칩 유지', (await texts('.page-form .chip-member.is-gone .chip-label')).includes('(떠난 멤버)'));
  await page.click('.page-form .savebar button:has-text("취소")');
  await page.waitForSelector('.page-detail', { timeout: 5000 });
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
  check('종류별 1·1·2', tl['보드게임'] === '1회' && tl['머미'] === '1회' && tl['방탈출'] === '2회', JSON.stringify(tl));
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

  await page.click('.page-stats .seg-type .seg-item:has-text("머미")');
  await page.waitForSelector('.page-stats .stable');
  tl = await tiles();
  check('머미 1회 · 1편 · 평균 4.0 · 검거율 0%', tl['플레이'] === '1회' && tl['시나리오'] === '1편' && tl['평균 별점'].startsWith('4.0') && tl['범인 검거율'] === '0%|1번 중 0번', JSON.stringify(tl));
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
  await noOverflow('통계 머미');
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
  check('요약 띠: 전체 4회 · 이번 달 3회 · 보드게임 1회 · 머미 1회 · 방탈출 2회',
    JSON.stringify(sums) === JSON.stringify(['전체 4회', '이번 달 3회', '보드게임 1회', '머미 1회', '방탈출 2회']), JSON.stringify(sums));
  check('큰 표지·이번 달 멤버 카드는 홈에 없음', !(await page.$('.page-home .cover')) && !(await page.$('.page-home .mate')));
  const mobRows = await page.$eval('.page-home .summary', (e) => new Set([...e.querySelectorAll('.sum-item')].map((x) => Math.round(x.getBoundingClientRect().top))).size);
  check('휴대폰: 요약 띠는 두 줄', mobRows === 2, String(mobRows));
  check('휴대폰: 최근 기록 한 칸', await page.evaluate(() => {
    const c = [...document.querySelectorAll('.page-home .rlist > .rcard')];
    return c.length > 1 && c[1].getBoundingClientRect().top >= c[0].getBoundingClientRect().bottom;
  }));
  check('최근 기록이 요약 띠 바로 아래', await page.$eval('.page-home .summary', (e) => !!(e.nextElementSibling && e.nextElementSibling.matches('.home-recent'))));
  check('최근 기록 4개', (await page.$$('.page-home .rcard')).length === 4);
  check('‘전체 보기’ → 기록 목록', (await page.getAttribute('.page-home .home-recent .link-more', 'href')) === '#/records');
  await noOverflow('홈');
  await shot('23-home');
  // 요약 띠의 종류 칸 → 그 종류 목록, 전체 칸 → 전체 목록
  await page.click('.page-home .sum-item:has(.sum-label:text-is("방탈출")) .sum-link');
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
  check('프로필: 보드게임 0승 · 머미 범인 1번 · 방탈출 50%', tiles[0].includes('1회') && tiles[0].includes('0승') && tiles[1].includes('범인 1번') && tiles[2].includes('2회') && tiles[2].includes('성공률 50%'), tiles.join(' | '));
  check('프로필: 최근 기록 4개', (await page.$$('.page-profile .rcard')).length === 4);
  await noOverflow('멤버 프로필');
  await shot('24-member-profile');
});

await step('소장 탭 · 소장 여부 필터 · 이전 기록에서 불러오기', async () => {
  // 대여한 같은 게임 두 판 + 집에서 한 보드게임형 머미(내 소장) 한 판 — 이 단계 끝에 지움
  const mk = async (record) => (await api('POST', '/api/records', { record })).data.record.id;
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

    // 소장 탭: 내 소장으로 남긴 게임만 게임별로 (최근 순), 대여한 게임은 아래에
    await tab('collection', '.page-collection');
    check('소장 탭 선택 표시', (await page.getAttribute('#tabbar [data-tab="collection"]', 'aria-current')) === 'page');
    const owned = await texts('.page-collection .gcard-title');
    check('소장 게임 2개 (최근 순)', JSON.stringify(owned) === JSON.stringify(['테라포밍 마스', '마지막 야간열차']), JSON.stringify(owned));
    check('소장 개수', (await text('.page-collection .list-count')) === '보드게임·머미 2개', await text('.page-collection .list-count'));
    const tera = '.page-collection .gcard:has(.card-link:text-is("테라포밍 마스"))';
    const teraRec = (await api('GET', '/api/data')).data.records.find((r) => r.title === '테라포밍 마스');
    check('게임 카드: 횟수·최근 날짜·평균 별점', (await text(`${tera} .gcard-plays`)) === '1번 했어요' &&
      (await text(`${tera} .gcard-last`)) === `최근 ${teraRec.date.replace(/-/g, '.')}` && (await text(`${tera} .gcard-rating`)) === teraRec.rating.toFixed(1), await text(tera));
    const lent = await texts('.page-collection .borrowed .brow');
    check('대여한 게임: 스플렌더 (2번 · 빌려준 사람 최근 순)', lent.length === 1 && lent[0].includes('스플렌더') && lent[0].includes('2번 · 빌려준 사람 도윤, 영식') &&
      (await text('.page-collection .borrowed .sec-title')) === '대여한 게임', JSON.stringify(lent));
    await page.click('.page-collection .seg-type .seg-item:has-text("머미")');
    check('종류 고르기: 머미만', JSON.stringify(await texts('.page-collection .gcard-title')) === JSON.stringify(['마지막 야간열차']) && !(await page.$('.page-collection .borrowed')));
    await page.click('.page-collection .seg-type .seg-item:has-text("전체")');
    await page.selectOption('.page-collection select[aria-label="정렬"]', 'name');
    check('이름순 정렬', JSON.stringify(await texts('.page-collection .gcard-title')) === JSON.stringify(['마지막 야간열차', '테라포밍 마스']));
    await page.selectOption('.page-collection select[aria-label="정렬"]', 'recent');
    await noOverflow('소장 탭');
    await shot('25-collection');

    // 게임 카드 → 그 게임 기록만 (제목 필터)
    await page.click(`${tera} .card-link`);
    await page.waitForSelector('.page-list');
    const only = await until(async () => { const x = await cardTitles(); return x.length === 1 && x; });
    check('게임 카드 → 그 게임 기록만', !!only && only[0] === '테라포밍 마스' && (await text('.page-list .achips-title')).includes('테라포밍 마스'), String(await cardTitles()));
    check('종류도 보드게임으로', (await text('.page-list .seg-type .seg-input:checked + .seg-item')) === '보드게임');
    check('카드에 내 소장 배지', (await text('.page-list .rcard .rbadge')) === '내 소장');
    await page.click('.page-list .achips-title .achip');
    const allBg = await until(async () => { const x = await cardTitles(); return x.length === 3 && x; });
    check('제목 필터 해제 → 보드게임 3개', !!allBg, String(await cardTitles()));
    check('대여한 판 카드에 대여 배지', (await texts('.page-list .rcard .rbadge')).filter((x) => x === '대여').length === 2, JSON.stringify(await texts('.page-list .rcard .rbadge')));

    // 소장 여부 필터 (하나만 고름)
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

    // ‘대여 기록 보기’ → 대여 필터만 (다른 조건은 비움)
    await tab('collection', '.page-collection');
    await page.click('.page-collection .borrowed a.link-more');
    await page.waitForSelector('.page-list');
    check('대여 기록 보기 → 대여한 판 2개 · 종류 전체', !!(await until(async () => { const x = await cardTitles(); return x.length === 2 && x; })) &&
      (await page.$eval('.page-list .seg-type input:checked', (e) => e.value)) === 'all', String(await cardTitles()));
    await page.click('.page-list .achip:has-text("대여")');

    // 같은 제목 새 기록: 이전 판의 소장 여부·빌려준 사람도 불러오기
    await go('#/new/boardgame', '.page-form');
    await page.fill('[data-field="title"]', '스플렌더');
    const sug = await until(async () => { const tt = await text('.page-form .suggest-text'); return tt.includes('불러올까요') && tt; }, 3000);
    check('제안에 소장 여부·빌려준 사람', !!sug && sug.includes('소장 여부') && sug.includes('빌려준 사람'), String(sug));
    await page.click('.page-form .suggest button:has-text("불러오기")');
    await sleep(150);
    check('불러오면 대여 · 도윤', (await page.$eval('.page-form .seg-own .seg-input:checked', (e) => e.value)) === 'borrowed' &&
      (await page.inputValue('.page-form input[placeholder="예) 영식 (선택)"]')) === '도윤');
    await page.click('.page-form .savebar button:has-text("취소")');
    await page.waitForSelector(dlg);
    await dialogButton('그만 쓰기');
    await page.waitForSelector('.page-form', { state: 'detached', timeout: 5000 });
  } finally {
    // 다음 단계의 개수 검사에 섞이지 않게 (중간에 실패해도) 지움
    for (const id of extra) await api('DELETE', `/api/records?id=${encodeURIComponent(id)}`);
    await syncFromServer();
  }
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
  check('JSON: 앱 표시·세부 블록 포함', json.app === 'ddoddohouse-record' && json.records.find((r) => r.id === ids.mm).mm.roles.length === 3);

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
  await api('POST', '/api/records', { record: { ...cur, oneLiner: '다른 기기에서 바꿈' }, baseUpdatedAt: cur.updatedAt });
  await page.setInputFiles('#import-file', exportFile);
  await page.waitForSelector(dlg);
  await page.click(`${dlg} .seg-item:has-text("덮어쓰기")`);
  // 화면이 모르는 서버 쪽 변경 → 409 한 번 받은 뒤 최신 기준으로 다시 저장 (의도된 409)
  await allowing([/status of 409/], async () => {
    await dialogButton('가져오기');
    check('덮어쓰기 가져오기 완료', !!(await toastSeen(/가져오기 완료: 성공 7/, 10000)), String(await texts('.toast')));
  });
  const after = (await api('GET', '/api/data')).data.records.find((r) => r.id === ids.bg);
  check('덮어쓰기로 백업 내용 복원', after.oneLiner === '화성 개척은 언제나 옳다', after.oneLiner);
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
    await page.fill('.page-form input[placeholder="한 문장으로 남긴다면?"]', '오프라인 수정 시도');
    await page.click('.save-btn');
    check('오프라인 저장 안내', !!(await toastSeen(/오프라인이라 저장할 수 없어요/)));
    check('초안 보관', await page.evaluate(() => (JSON.parse(localStorage.getItem('ddh:draft') || 'null') || {}).model?.oneLiner) === '오프라인 수정 시도');
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
    ['#/new', '.page-picker', 'picker'],
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
    if (name.startsWith('form-')) await pickMembers(['연경', '영식']);
    await noOverflow(`다크 ${name}`);
    await shot(name);
  }
  for (const seg of ['보드게임', '머미', '방탈출']) {
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
  for (const seg of ['보드게임', '머미', '방탈출']) {
    await go('#/stats', '.page-stats');
    await page.click(`.page-stats .seg-type .seg-item:has-text("${seg}")`);
    await noOverflow(`320px 통계 ${seg}`);
  }
  await go('#/stats', '.page-stats');
  await page.click('.page-stats .seg-type .seg-item:has-text("머미")');
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
  check('키·캐시·초안 삭제', await page.evaluate(() => ['ddh:key', 'ddh:cache', 'ddh:draft'].every((k) => localStorage.getItem(k) === null)));
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
const serverRecord = async (id) => (await api('GET', '/api/data')).data.records.find((r) => r.id === id) || null;
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
  await page.fill('[data-field="title"]', '응답 유실 테스트');
  await page.fill('.page-form textarea', '첫 버전 후기');
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
    await page.fill('.page-form textarea', '첫 버전 후기 + 나중에 고친 내용');
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
  await page.fill('[data-field="title"]', '응답 유실 그대로');
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
  await page.fill('[data-field="title"]', '레이스 테스트 게임');
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
  await page.fill('.page-form input[placeholder="한 문장으로 남긴다면?"]', '삭제된 줄 모르고 고침');
  await allowing([/status of 404/], async () => {
    await page.click('.save-btn');
    await page.waitForSelector(dlg, { timeout: 8000 });
  });
  check('삭제 안내 다이얼로그', (await text(`${dlg} .dlg-title`)) === '다른 사람이 삭제한 기록이에요', await text(`${dlg} .dlg-title`));
  check('저장 전에는 서버에 없음 (되살아나지 않음)', (await serverRecord(rec.id)) === null);
  await dialogButton('새 기록으로 다시 저장');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const back = await serverRecord(rec.id);
  check('고른 경우에만 다시 저장 (원래 작성 시각 유지)', back && back.oneLiner === '삭제된 줄 모르고 고침' && back.createdAt === rec.createdAt, JSON.stringify(back));
  await api('DELETE', `/api/records?id=${encodeURIComponent(rec.id)}`);
  await syncFromServer();
});

await step('데이터: 지워진 기록의 수정 초안도 이어 쓸 수 있음', async () => {
  const rec = (await api('POST', '/api/records', { record: { type: 'boardgame', date: PAST, title: '초안 남은 게임', members: [] } })).data.record;
  await syncFromServer();
  await go(`#/edit/${encodeURIComponent(rec.id)}`, '.page-form');
  await page.fill('.page-form textarea', '길게 쓴 후기를 잃으면 안 돼요');
  check('수정 초안 저장', !!(await until(async () => (await draftNow())?.key === `edit:${rec.id}`, 3000)));
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await sleep(300);
  await api('DELETE', `/api/records?id=${encodeURIComponent(rec.id)}`);
  await syncFromServer();
  await go('#/new', '.page-picker .draft-card');
  check('초안 카드', (await text('.page-picker .draft-card')).includes('수정하던 기록이 있어요'));
  await page.click('.page-picker .draft-card button:has-text("이어 쓰기")');
  await page.waitForSelector('.page-form', { timeout: 8000 });
  check('‘삭제됐어요’ 안내와 함께 폼이 열림', (await text('.page-form .draft-banner')).includes('삭제됐어요'), await text('.page-form .draft-banner'));
  check('초안 내용 복원', (await page.inputValue('.page-form textarea')) === '길게 쓴 후기를 잃으면 안 돼요');
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
  await go('#/new', '.page-picker');
  check('종류 선택에 그 초안 카드', (await text('.page-picker .draft-card')).includes('보관된 초안'));
  // 취소(작성 안 함)도 남의 초안을 지우지 않음
  await go('#/new/escaperoom', '.page-form');
  await page.fill('[data-field="title"]', '잠깐');
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

await step('폼: 멤버를 빼면 자동 승자도 다시 계산 · 입력만 한 태그도 저장', async () => {
  await go('#/new/boardgame', '.page-form');
  await page.fill('[data-field="title"]', '승자 재계산 게임');
  await pickMembers(['연경', '영식']);
  const row = (n) => `.result-row:has(.rr-name:text-is("${n}"))`;
  await page.fill(`${row('연경')} .input-score`, '10');
  await page.fill(`${row('영식')} .input-score`, '5');
  check('처음엔 연경 승', (await page.getAttribute(`${row('연경')} .win-toggle`, 'aria-pressed')) === 'true');
  await pickMembers(['연경']); // 연경 빼기
  await page.waitForSelector(`${row('영식')}`);
  check('남은 영식이 1등', (await text(`${row('영식')} .rank-badge`)) === '1등');
  check('영식에게 승리 표시도 옮겨감', (await page.getAttribute(`${row('영식')} .win-toggle`, 'aria-pressed')) === 'true');
  await page.fill('.page-form input[aria-label="태그 직접 입력"]', '#인생게임');
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  const id = decodeURIComponent(page.url().split('#/record/')[1] || '');
  const saved = await serverRecord(id);
  check('저장된 승자: 영식', saved && saved.bg.results.length === 1 && saved.bg.results[0].memberId === ids['영식'] && saved.bg.results[0].winner === true, JSON.stringify(saved && saved.bg));
  check('‘추가’를 안 눌러도 태그 저장', saved && saved.tags.includes('인생게임'), JSON.stringify(saved && saved.tags));
  check('상세에 우승 도장', (await text('.dhero-stamp')).includes('우승'));
  await api('DELETE', `/api/records?id=${encodeURIComponent(id)}`);
  await syncFromServer();
});

await step('목록: 멤버 ‘모두 보기’·태그 링크는 예전 검색·종류 필터를 비움', async () => {
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
  // 태그 링크
  await page.click('.page-list .seg-type .seg-item:has-text("보드게임")');
  await go(`#/record/${encodeURIComponent(ids.er0)}`, '.page-detail');
  await page.click('.page-detail .dtags .tag:has-text("#공포")');
  await page.waitForSelector('.page-list');
  const t2 = await until(async () => { const t = await cardTitles(); return t.includes('저주받은 인형의 집') && t; }, 3000);
  check('태그 링크 → 다른 종류 필터에 안 막힘', !!t2, String(await cardTitles()));
  await page.click('.page-list .seg-type .seg-item:has-text("전체")');
});

await step('머미: 같은 시나리오를 이미 해 본 멤버 안내', async () => {
  await go('#/new/murdermystery', '.page-form');
  await page.fill('[data-field="title"]', '붉은 저택의 초대');
  const played = await until(async () => text('.page-form .suggest-played'), 3000);
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
  await page.click('.page-stats .seg-type .seg-item:has-text("머미")');
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
  await ps.waitForSelector('.page-picker');
  await ps.click('.pick.t-boardgame');
  await ps.waitForSelector('.loading');
  check('새 기록 폼은 데이터 전에는 안 그림', !(await ps.$('.page-form')));
  open();
  await ps.waitForSelector('.page-form', { timeout: 8000 });
  const chips = await ps.$$eval('.page-form .chips-members .chip-member', (els) => els.length);
  check('데이터가 오면 멤버 칩이 보임', chips >= 3, String(chips));
  check('제목 자동완성 목록도 채워짐', (await ps.$$eval('.page-form datalist option', (els) => els.length)) > 0);
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
const formPhotoIds = () => page.$$eval('.fsec-photos .ph-cell:not(.ph-cell-add)', (els) => els.map((e) => (e.querySelector('.pimg[data-photo]') || { dataset: {} }).dataset.photo || null));
const photoInput = '.fsec-photos input[type="file"]';
async function photosSettled(n, timeout = 20000) {
  return until(async () => {
    const st = await page.$$eval('.fsec-photos .ph-tile', (els) => els.map((e) => (e.classList.contains('is-busy') ? 'busy' : e.classList.contains('is-error') ? 'error' : 'ok')));
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
  check('사진 칸: 빈 상태는 큰 추가 버튼', !!(await page.$('.fsec-photos .ph-grid.is-empty .ph-add')) && (await text('.fsec-photos .counter')) === '0/4');
  await page.fill('[data-field="title"]', '카탄');
  await pickMembers(['연경', '영식']);
  // 동시에 몇 장을 올리는지 (느린 연결에서 한꺼번에 올리면 모두 시간 초과가 나므로 한 장씩)
  const upl = { now: 0, max: 0, n: 0 };
  const isUpload = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/images';
  const onReq = (r) => { if (isUpload(r)) { upl.n++; upl.now++; upl.max = Math.max(upl.max, upl.now); } };
  const onDone = (r) => { if (isUpload(r)) upl.now--; };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  await page.setInputFiles(photoInput, [P.exif, P.png]);
  check('고르자마자 칸 2개 (줄이는 중/대기 표시)', (await page.$$('.fsec-photos .ph-tile')).length === 2);
  const st = await photosSettled(2);
  page.off('request', onReq);
  page.off('requestfinished', onDone);
  page.off('requestfailed', onDone);
  check('두 장 모두 올라감', st && st.every((x) => x === 'ok'), JSON.stringify(st));
  check('여러 장을 골라도 한 장씩 차례로 올림 (동시에 1장)', upl.n === 2 && upl.max === 1, JSON.stringify(upl));
  check('첫 장에 ‘대표’ 표시, 둘째 장엔 ‘대표로’ 버튼', (await text('.fsec-photos .ph-cell:nth-child(1) .ph-badge')) === '대표' &&
    !!(await page.$('.fsec-photos .ph-cell:nth-child(2) .ph-cover-btn')));
  check('썸네일이 blob: 주소로 보임', await page.$$eval('.fsec-photos .ph-cell:not(.ph-cell-add) img', (els) => els.length === 2 && els.every((e) => e.src.startsWith('blob:') && e.complete && e.naturalWidth > 0)));
  const ids = await formPhotoIds();
  photoIds.exif = ids[0];
  photoIds.png = ids[1];
  check('서버에 2장 추가', (await imgStats()).count === before.count + 2);
  const full = await imgBytes(photoIds.exif, 'f');
  const thumb = await imgBytes(photoIds.exif, 't');
  check('원본: WebP/JPEG 로 다시 인코딩 (600KB 이하)', /image\/(webp|jpeg)/.test(full.type) && full.buf.length <= 600 * 1024, `${full.type} ${full.buf.length}`);
  check('썸네일: 80KB 이하', thumb.buf.length <= 80 * 1024 && /image\/(webp|jpeg)/.test(thumb.type), String(thumb.buf.length));
  check('EXIF·위치 정보 문구가 남지 않음', !full.buf.includes(Buffer.from('GPS-SECRET')) && !full.buf.includes(Buffer.from('Exif')) && !thumb.buf.includes(Buffer.from('GPS-SECRET')));
  const d = await imgDims(photoIds.exif, 'f');
  check('EXIF 회전(6) 반영 → 세로 사진, 긴 변 1600px 이하', d.h > d.w && Math.max(d.w, d.h) <= 1600, JSON.stringify(d));
  const dt = await imgDims(photoIds.exif, 't');
  check('썸네일 긴 변 480px 이하', Math.max(dt.w, dt.h) <= 480, JSON.stringify(dt));
  const png = await imgBytes(photoIds.png, 'f');
  check('PNG 도 WebP/JPEG 로 바꿔 올림', /image\/(webp|jpeg)/.test(png.type) && png.buf[0] !== 0x89, png.type);
  check('사진 응답 헤더 (nosniff·private 캐시·CSP)', full.headers.get('x-content-type-options') === 'nosniff' && /private/.test(full.headers.get('cache-control') || '') &&
    /img-src 'self' data: blob:/.test(full.headers.get('content-security-policy') || ''), `${full.headers.get('cache-control')} | ${full.headers.get('content-security-policy')}`);
});

await step('사진: 큰 사진 줄이기 · 4장 제한 · 열 수 없는 형식(HEIC)', async () => {
  await page.setInputFiles(photoInput, [P.heic]);
  check('열 수 없는 형식(HEIC) 안내 + 해결 방법', !!(await toastSeen(/이 사진 형식\(HEIC 등\)은 열 수 없어요\. 카메라 설정의 ‘고효율’ 사진을 끄거나 JPG로 저장해서 올려 주세요/, 10000)), String(await texts('.toast')));
  check('열지 못한 사진은 칸에서 빠짐', !!(await until(async () => (await page.$$('.fsec-photos .ph-tile')).length === 2, 3000)));
  await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
  await page.setInputFiles(photoInput, [P.heic, P.heic2]);
  check('여러 장이 같은 이유로 실패하면 알림은 하나 (몇 장인지)', !!(await toastSeen(/사진 2장은 열 수 없는 형식\(HEIC 등\)이라 뺐어요/, 10000)) &&
    (await texts('.toast')).filter((t) => t.includes('HEIC')).length === 1, String(await texts('.toast')));
  check('두 장 모두 칸에서 빠짐', !!(await until(async () => (await page.$$('.fsec-photos .ph-tile')).length === 2, 3000)));
  await page.setInputFiles(photoInput, [P.noisy, P.s3]);
  const st = await photosSettled(4, 30000);
  check('큰 사진 포함 4장', st && st.length === 4 && st.every((x) => x === 'ok'), JSON.stringify(st));
  check('4장이면 추가 칸 사라짐 · 4/4', !(await page.$('.fsec-photos .ph-cell-add')) && (await text('.fsec-photos .counter')) === '4/4');
  const ids = await formPhotoIds();
  photoIds.noisy = ids[2];
  photoIds.s3 = ids[3];
  const big = await imgBytes(photoIds.noisy, 'f');
  const dims = await imgDims(photoIds.noisy, 'f');
  check('잡음 가득한 큰 사진도 600KB·1600px 안으로', big.buf.length <= 600 * 1024 && Math.max(dims.w, dims.h) <= 1600, `${big.buf.length} ${JSON.stringify(dims)}`);
  check('썸네일도 80KB 이하', (await imgBytes(photoIds.noisy, 't')).buf.length <= 80 * 1024);
  await page.setInputFiles(photoInput, [P.s4]);
  check('5장째는 안내만', !!(await toastSeen(/사진은 4장까지/)) && (await page.$$('.fsec-photos .ph-tile')).length === 4);
  await noOverflow('사진 4장 폼');
});

await step('사진: 대표 바꾸기 · 순서 · 빼기 · 붙여넣기', async () => {
  const [a, b, c, d] = await formPhotoIds();
  await page.click('.fsec-photos .ph-cell:nth-child(2) .ph-cover-btn');
  check('‘대표로’ → 둘째 장이 맨 앞', JSON.stringify(await formPhotoIds()) === JSON.stringify([b, a, c, d]), JSON.stringify(await formPhotoIds()));
  check('새 대표에 배지', !!(await page.$(`.fsec-photos .ph-cell:nth-child(1).is-cover .pimg[data-photo="${b}"]`)));
  // 사진을 누르면 순서 바꾸기 시트
  await page.click('.fsec-photos .ph-cell:nth-child(3) .ph-open');
  await page.waitForSelector(`${dlg}.dlg-photo`);
  check('시트: 크게 보기·대표로·앞 순서로·뒤 순서로·빼기', JSON.stringify(await texts(`${dlg} .ph-sheet-actions .btn`)) === JSON.stringify(['크게 보기', '대표로', '앞 순서로', '뒤 순서로', '사진 빼기']), JSON.stringify(await texts(`${dlg} .ph-sheet-actions .btn`)));
  check('순서 버튼 이름에 몇 번 사진인지 (앱의 ‘뒤로’와 다름)', (await page.getAttribute(`${dlg} .ph-sheet-actions .btn:has-text("뒤 순서로")`, 'aria-label')) === '3번 사진을 뒤 순서로');
  await shot('31-photo-sheet');
  await page.click(`${dlg} .ph-sheet-actions .btn:has-text("앞 순서로")`);
  await page.waitForSelector(dlg, { state: 'detached' });
  check('‘앞 순서로’ → 3번째가 2번째로', JSON.stringify(await formPhotoIds()) === JSON.stringify([b, c, a, d]), JSON.stringify(await formPhotoIds()));
  check('대표로 버튼 이름: ‘2번 사진을 대표 사진으로’', (await page.getAttribute('.fsec-photos .ph-cell:nth-child(2) .ph-cover-btn', 'aria-label')) === '2번 사진을 대표 사진으로');
  // ✕ 로 빼기: 잠깐 되돌릴 수 있고, 그 뒤 이 폼에서 올린 사진이라 서버에서도 지움
  const before = (await imgStats()).count;
  // ✕ 누르는 영역이 사진을 크게 덮지 않음 (사진 모서리만)
  const xCover = await page.$eval('.fsec-photos .ph-cell:nth-child(2) .ph-tile', (tile) => {
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
  await page.click('.fsec-photos .ph-cell:nth-child(4) .ph-x');
  check('✕ → 3장', JSON.stringify(await formPhotoIds()) === JSON.stringify([b, c, a]));
  check('빼고 나면 초점이 남은 칸으로', await page.evaluate(() => !!document.activeElement.closest('.fsec-photos')));
  check('‘되돌리기’ 알림', !!(await toastSeen(/4번 사진을 뺐어요/)) && !!(await page.$('.toast .toast-btn:text-is("되돌리기")')));
  await page.click('.toast .toast-btn:text-is("되돌리기")');
  check('되돌리기 → 같은 자리로', JSON.stringify(await formPhotoIds()) === JSON.stringify([b, c, a, d]), JSON.stringify(await formPhotoIds()));
  check('되돌리는 동안 서버 사진 그대로', (await imgStats()).count === before);
  await page.click('.fsec-photos .ph-cell:nth-child(4) .ph-x');
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
    const input = document.querySelector('.page-form input[placeholder="한 문장으로 남긴다면?"]');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('글 칸에 글자+그림 붙여넣기는 방해 안 함', hijacked === false && (await page.$$('.fsec-photos .ph-tile')).length === 4);
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

await step('사진: 같은 제목 새 기록에서 ‘이전 대표 사진 쓰기’ (다시 올리지 않고 같은 사진)', async () => {
  const before = (await imgStats()).count;
  await go('#/new/boardgame', '.page-form');
  check('제목 전에는 제안 없음', await page.$eval('.fsec-photos .ph-suggest', (e) => e.hidden));
  await page.fill('[data-field="title"]', '카탄');
  await page.waitForSelector('.fsec-photos .ph-suggest:not([hidden])', { timeout: 3000 });
  check('제안에 이전 대표 사진 미리보기', (await page.getAttribute('.ph-suggest .pimg', 'data-photo')) === photoIds.order[0] &&
    (await text('.ph-suggest')).includes('이전 대표 사진이 있어요'));
  await shot('37-reuse-suggest');
  await page.click('.ph-suggest button:has-text("이전 대표 사진 쓰기")');
  check('같은 사진 id 로 들어감', JSON.stringify(await formPhotoIds()) === JSON.stringify([photoIds.order[0]]), JSON.stringify(await formPhotoIds()));
  check('넣고 나면 제안 사라짐', await page.$eval('.fsec-photos .ph-suggest', (e) => e.hidden));
  check('다시 올리지 않음 (사진 수 그대로)', (await imgStats()).count === before);
  await pickMembers(['민지짱']);
  await page.click('.save-btn');
  await page.waitForSelector('.page-detail', { timeout: 8000 });
  ids.catan2 = decodeURIComponent(page.url().split('#/record/')[1] || '');
  check('저장된 기록이 같은 사진을 가리킴', JSON.stringify((await serverRecord(ids.catan2)).photos) === JSON.stringify([photoIds.order[0]]));
  check('사진 1장이면 넘기기·썸네일 줄 없음', (await page.$$('.page-detail .dg-slide')).length === 1 && !(await page.$('.page-detail .dg-thumbs')) && !(await page.$('.page-detail .dg-count')));
});

await step('사진: 올리기 실패 → 다시 시도 · 올리는 중에 저장하면 기다렸다 저장', async () => {
  await go('#/new/escaperoom', '.page-form');
  await page.fill('[data-field="title"]', '사진 테스트 방');
  await page.click('label.stamp-choice-clear');
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
    check('실패하면 그 칸에 다시 시도', st && st[0] === 'error' && (await text('.fsec-photos .ph-state')).includes('다시'), JSON.stringify(st));
    check('실패 안내', !!(await toastSeen(/업로드하지 못했어요/)), String(await texts('.toast')));
  });
  await page.click('.save-btn');
  check('실패한 사진이 있으면 저장 안 하고 안내', !!(await toastSeen(/올리지 못한 사진이 있어요/)) && !!(await page.$('.page-form')));
  await page.click('.fsec-photos .ph-cell:nth-child(1) .ph-open');
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
  await page.waitForSelector('.fsec-photos .ph-tile.is-busy');
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
  await page.fill('[data-field="title"]', '사라진 사진 방');
  await page.click('label.stamp-choice-clear');
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
  await page.fill('[data-field="title"]', '사진 초안');
  await page.setInputFiles(photoInput, [P.s3]);
  await photosSettled(1);
  const [pid] = await formPhotoIds();
  const draft = await until(() => page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('ddh:draft') || 'null');
    return d && d.model && Array.isArray(d.model.photos) && d.model.photos.length ? d : null;
  }), 3000);
  check('초안에 사진 id', draft && draft.model && JSON.stringify(draft.model.photos) === JSON.stringify([pid]), JSON.stringify(draft && draft.model && draft.model.photos));
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await page.waitForSelector('.page-home, .page-detail, .page-list, .page-picker', { timeout: 5000 });
  await page.click('#tabbar .tab-add');
  await page.click('.page-picker .draft-card button:has-text("이어 쓰기")');
  await page.waitForSelector('.page-form');
  check('이어 쓰면 사진도 그대로', JSON.stringify(await formPhotoIds()) === JSON.stringify([pid]) &&
    !!(await until(() => page.$eval('.fsec-photos .ph-cell:nth-child(1) img', (e) => e.complete && e.naturalWidth > 0), 5000)));
  await page.click('.page-form .savebar button:has-text("취소")');
  await page.waitForSelector(dlg);
  await dialogButton('그만 쓰기');
  await sleep(200);
  check('그만 쓰면 초안 삭제', (await draftNow()) === null);
  check('초안에만 있던 사진도 서버에서 지움', !!(await until(async () => (await imgBytes(pid, 't')).status === 404, 4000)));

  // 초안 배너의 ‘버리기’도 초안에만 있던 사진을 지움
  await go('#/new/murdermystery', '.page-form');
  await page.fill('[data-field="title"]', '버릴 초안');
  await page.setInputFiles(photoInput, [P.s4]);
  await photosSettled(1);
  const [pid2] = await formPhotoIds();
  await until(async () => JSON.stringify(((await draftNow()) || { model: {} }).model.photos) === JSON.stringify([pid2]), 3000);
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await page.waitForSelector('.page-home, .page-detail, .page-list, .page-picker', { timeout: 5000 });
  await go('#/new/murdermystery', '.page-form');
  await page.click('.draft-banner button:has-text("버리기")');
  check('초안 버리기 → 그 사진도 지움', !!(await until(async () => (await imgBytes(pid2, 't')).status === 404, 4000)) && (await draftNow()) === null);
  await page.click('.page-form .appbar button[aria-label="뒤로"]');
  await page.waitForSelector('.page-home, .page-detail, .page-list, .page-picker', { timeout: 5000 });
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
  await page.click('.fsec-photos .ph-cell:nth-child(4) .ph-x');
  // 대표(0번)는 ‘카탄’ 두 번째 기록도 쓰므로 빼도 남아야 함 → 대표를 빼고 원래 둘째 장이 대표가 되게
  await page.click('.fsec-photos .ph-cell:nth-child(1) .ph-x');
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
  const want = [...new Set(json.records.flatMap((r) => r.photos || []))];
  check('images: 기록이 쓰는 사진 모두', Array.isArray(json.images) && json.images.length === want.length && want.every((id) => json.images.some((im) => im.id === id)), `${json.images && json.images.length} vs ${want.length}`);
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
  await page.click('.fsec-photos .ph-cell:nth-child(1) .ph-open');
  await page.waitForSelector(`${dlg}.dlg-photo`);
  await page.click(`${dlg} .ph-sheet-actions .btn:has-text("크게 보기")`);
  await page.waitForSelector('dialog.viewer[open]');
  await lockBy401();
  check('잠금 화면 위에 폼의 뷰어·사진 시트가 남지 않음', !(await page.$('dialog')) && !(await photoVisible()));
  await unlockAgain();
  // 사진 시트만 열린 채로
  await go(`#/edit/${encodeURIComponent(ids.erPhoto)}`, '.page-form');
  await page.click('.fsec-photos .ph-cell:nth-child(1) .ph-open');
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
      check('사진 없는 백업도 실패 없이 가져옴', !!(await toastSeen(new RegExp(`가져오기 완료: 성공 ${json.records.length + json.members.length}(?!\\d)(?!.*실패)`), 15000)), String(await texts('.toast')));
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
      check('사진까지 가져오기 완료 (실패 없음 — 한 번 실패한 사진은 다시 올림)', !!(await toastSeen(new RegExp(`가져오기 완료: 성공 ${json.members.length + json.images.length + json.records.length}(?!\\d)(?!.*실패)`), 20000)) && !failOnce, String(await texts('.toast')));
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
  const targets = await page.$$eval('.fsec-photos .ph-x, .fsec-photos .ph-cover-btn, .fsec-photos .ph-open, .fsec-photos .ph-add', (els) => els.map((el) => {
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
  check('메뉴가 왼쪽 사이드바 (화면 높이 전체)', side.l === 0 && side.w >= 200 && side.w <= 300 && side.h === 900 && side.dir === 'column', JSON.stringify(side));
  check('사이드바: 이름 · 새 기록 버튼 · 설정', await page.isVisible('#tabbar .side-brand') && await page.isVisible('#tabbar .side-cta') && await page.isVisible('#tabbar .tab-settings') && !(await page.isVisible('#tabbar .tab-add')));
  check('본문이 사이드바 오른쪽에서 시작', await page.$eval('#view', (e) => e.getBoundingClientRect().left >= 248));
  const sideTabs = await page.$$eval('#tabbar a.tab', (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent.trim()));
  check('사이드바 메뉴: 홈 · 기록 · 소장 · 통계 · 멤버 · 설정', JSON.stringify(sideTabs) === JSON.stringify(['홈', '기록', '소장', '통계', '멤버', '설정']), JSON.stringify(sideTabs));
  // 홈: 낮은 요약 띠(80~100px) 바로 아래 최근 기록 — 첫 줄 카드가 스크롤 없이 다 보임
  const strip = await page.$eval('.page-home .summary', (e) => {
    const b = e.getBoundingClientRect();
    return { h: Math.round(b.height), rows: new Set([...e.querySelectorAll('.sum-item')].map((x) => Math.round(x.getBoundingClientRect().top))).size };
  });
  check('홈: 요약 띠는 한 줄 · 높이 80~100px', strip.h >= 80 && strip.h <= 100 && strip.rows === 1, JSON.stringify(strip));
  check('홈: 이번 달 멤버 카드는 멤버 화면으로 (홈엔 없음)', !(await page.$('.page-home .mate')));
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
  check('목록: 필터가 왼쪽에 늘 보임 (필터 버튼 없음)', await page.isVisible('.page-list .filter-panel') && !(await page.isVisible('.page-list .list-tools button[aria-controls="list-filter"]')));
  check('목록: 필터 | 결과 두 단', await page.evaluate(() => {
    const f = document.querySelector('.page-list .filter-panel').getBoundingClientRect();
    const r = document.querySelector('.page-list .list-results').getBoundingClientRect();
    return f.right <= r.left;
  }));
  const chipSel = '.page-list .filter-panel .chip-member:has(.chip-label:text-is("영식"))';
  await page.click(chipSel);
  const found = await until(async () => { const t = await text('.page-list .list-count'); return t.includes('찾았어요') && t; }, 3000);
  const shown = (await cardTitles()).length;
  const expected = (await api('GET', '/api/data')).data.records.filter((r) => (r.members || []).includes(ids['영식'])).length;
  check('필터 칩을 누르면 바로 걸러짐', !!found && (await page.getAttribute(chipSel, 'aria-pressed')) === 'true' && shown === expected, `${found} · 카드 ${shown} / 기대 ${expected}`);
  await page.click('.page-list .filter-panel button:has-text("필터 초기화")');
  await noOverflow('1440 목록');
  await shot('desktop-list');

  await page.click('#tabbar [data-tab="collection"]');
  await page.waitForSelector('.page-collection');
  check('소장: 사이드바에서 열림 · 표시', (await page.getAttribute('#tabbar [data-tab="collection"]', 'aria-current')) === 'page');
  await noOverflow('1440 소장');
  await shot('desktop-collection');

  await go(`#/record/${encodeURIComponent(ids.erPhoto)}`, '.page-detail');
  check('상세: (사진·요약) | (기록) 두 단', await sideBySide('.page-detail .detail-col-a', '.page-detail .detail-col-b'));
  check('상세: 사진이 왼쪽 단 맨 위', !!(await page.$('.page-detail .detail-col-a > .dgallery:first-child')));
  await noOverflow('1440 상세');
  await shot('desktop-detail');

  await go(`#/edit/${encodeURIComponent(ids.erPhoto)}`, '.page-form');
  check('폼: 두 단', await sideBySide('.page-form .form-col-a', '.page-form .form-col-b'));
  check('폼에서도 사이드바는 그대로 (휴대폰만 숨김)', await page.$eval('#tabbar', (e) => e.hidden && e.getBoundingClientRect().width > 0));
  check('저장 버튼이 오른쪽 아래에 보임', await page.$eval('.page-form .save-btn', (e) => { const b = e.getBoundingClientRect(); return b.bottom <= innerHeight && b.right > innerWidth - 120; }));
  await noOverflow('1440 폼');
  await shot('desktop-form');
  await page.click('.page-form .savebar button:has-text("취소")');
  await sleep(150);

  await go('#/stats', '.page-stats');
  check('통계: 숫자 타일이 한 줄 (전체·이번 달 | 종류별)', await sideBySide('.page-stats .stats-body > .tiles-2', '.page-stats .stats-body > .tiles-3'));
  check('통계: 월별 · 요일별 차트가 나란히', await sideBySide('.page-stats .stats-body > .chart-card:nth-child(3)', '.page-stats .stats-body > .chart-card:nth-child(4)'));
  await noOverflow('1440 통계');
  await shot('desktop-stats');
  for (const seg of ['보드게임', '머미', '방탈출']) {
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
  await page.waitForSelector('.page-picker');
  check('새 기록: 세 종류가 한 줄', await sideBySide('.page-picker .pick.t-boardgame', '.page-picker .pick.t-murdermystery'));
  await noOverflow('1440 종류 선택');
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
