// 또또하우스 기록장 E2E — 정적 개발 서버를 띄우고 실제 Chromium 으로 전체 흐름 검증 (+ 스크린샷)
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
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 860 };
const TZ = 'Asia/Seoul';
mkdirSync(SHOTS, { recursive: true });
for (const f of readdirSync(SHOTS)) if (/\.png$/.test(f)) rmSync(path.join(SHOTS, f));

// ── 결과 집계 ───────────────────────────────────────────────
let passN = 0;
let failN = 0;
const failures = [];
let currentStep = '';
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
async function step(name, fn) {
  currentStep = name;
  console.log(`\n[${name}]`);
  try {
    await fn();
  } catch (err) {
    check('단계가 예외 없이 끝남', false, String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
    try { await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/[^\w가-힣-]+/g, '_')}.png`), fullPage: true }); } catch { /* 무시 */ }
    try { await closeDialogs(); } catch { /* 무시 */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); } catch { last = undefined; }
    if (last) return last;
    await sleep(60);
  }
  return last;
}
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// 브라우저(Asia/Seoul) 기준 날짜
const seoulDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = seoulDate(new Date());
const YESTERDAY = seoulDate(new Date(Date.now() - 86400e3));
const THIS_YEAR = TODAY.slice(0, 4);

// ── 서버 · 브라우저 ─────────────────────────────────────────
const srv = await startDevServer({ port: 0 });
const BASE = srv.url;
const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), headless: process.env.E2E_HEADED !== '1' });

const problems = [];
const cspViolations = [];
async function newContext(opts = {}) {
  const ctx = await browser.newContext({
    viewport: MOBILE, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: 'ko-KR', timezoneId: TZ, colorScheme: 'light', acceptDownloads: true, ...opts,
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
  p.on('console', (m) => { if (m.type() === 'error') problems.push(`${tag}console.error: ${m.text()}`); });
  p.on('pageerror', (e) => problems.push(`${tag}pageerror: ${e.message}`));
}

let ctx = await newContext();
let page = await ctx.newPage();
watch(page);

// ── 페이지 도우미 ───────────────────────────────────────────
async function shot(name, { full = true } = {}) {
  await page.evaluate(() => {
    document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
    window.scrollTo(0, 0);
  });
  // 화면 밖 사진도 불러오도록 한 번 훑고 돌아옴 (지연 불러오기)
  await page.evaluate(async () => {
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    window.scrollTo(0, 0);
  });
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
}
async function noOverflow(label) {
  const r = await page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const offenders = [];
    // 넘친 요소라도 overflow 로 잘린 조상 안에 있으면(말줄임 등) 화면 밖으로 나가지 않음
    const clipped = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox !== 'visible' && a.getBoundingClientRect().right <= cw + 1) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.gtabs')) continue; // 분류 탭은 좁은 화면에서 가로로 넘겨 봄 (의도)
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.right > cw + 1 && !clipped(el)) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ').join('.')}`);
      if (offenders.length > 4) break;
    }
    return { sw: document.scrollingElement.scrollWidth, cw, offenders };
  });
  return check(`${label}: 가로 스크롤 없음`, r.sw <= r.cw + 1 && !r.offenders.length, JSON.stringify(r));
}
const route = (name) => page.waitForSelector(`body[data-route="${name}"]`, { timeout: 8000 });
async function go(hash, name) {
  await page.evaluate((hh) => { location.hash = hh; }, hash);
  if (name) await route(name);
  await sleep(120);
}
const dlg = 'dialog.dlg[open]';
async function closeDialogs() {
  for (let i = 0; i < 3; i++) {
    if (!(await page.$(dlg))) return;
    await page.keyboard.press('Escape');
    await sleep(120);
  }
}
async function dialogButton(label) {
  await page.click(`${dlg} .dlg-actions button:has-text("${label}")`);
}
async function choice(label) {
  await page.click(`${dlg} .choice:has(.choice-label:has-text("${label}"))`);
}
async function toastSeen(re, timeout = 5000) {
  return until(async () => {
    const t = await page.$$eval('.toast', (els) => els.map((e) => e.textContent));
    return t.find((x) => re.test(x));
  }, timeout);
}
async function text(sel) {
  const el = await page.$(sel);
  return el ? squash(await el.textContent()) : '';
}
async function texts(sel) {
  return (await page.$$eval(sel, (els) => els.map((e) => e.textContent))).map(squash);
}
const fieldSel = (label) => `.field:has(> .field-head .field-label:text-is("${label}"))`;
async function fill(label, value, tag = 'input') {
  await page.fill(`${fieldSel(label)} ${tag}`, value);
}
async function pickGenre(label) {
  await page.click(`.seg-genre label:has-text("${label}")`);
}
async function openExtra() {
  if ((await page.getAttribute('.extra-fold > .fold-btn', 'aria-expanded')) !== 'true') await page.click('.extra-fold > .fold-btn');
}
async function setRating(sel, keys) {
  await page.focus(sel);
  for (const k of keys) await page.keyboard.press(k);
}
async function save() {
  await page.click('.form-actions .btn-save');
}
/** 새 기록 쓰기 (빠르게) */
async function quickRecord({ genre, title, store, branch, date, rating, oneLiner }) {
  await go('#/new', 'new');
  await pickGenre(genre);
  await page.fill('.input-title', title);
  if (store !== undefined) await page.fill('.field-place input[aria-label="매장"]', store);
  if (branch !== undefined) await page.fill('.field-place input[aria-label="지점"]', branch);
  if (date) await page.fill('.input-date', date);
  if (rating) await setRating('.form-card .rating-track', rating);
  if (oneLiner) await fill('한 줄 감상', oneLiner);
}
async function playIdFromHash() {
  return page.evaluate(() => decodeURIComponent((/#\/play\/([^/?]+)/.exec(location.hash) || [])[1] || ''));
}
async function jpegBuffer(w = 1200, h = 900, hue = 210) {
  const b64 = await page.evaluate(([ww, hh, hu]) => {
    const c = document.createElement('canvas');
    c.width = ww; c.height = hh;
    const g = c.getContext('2d');
    g.fillStyle = `hsl(${hu} 40% 35%)`; g.fillRect(0, 0, ww, hh);
    g.fillStyle = '#F6F1E7'; g.beginPath(); g.arc(ww / 2, hh / 2, Math.min(ww, hh) / 4, 0, Math.PI * 2); g.fill();
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, [w, h, hue]);
  return Buffer.from(b64, 'base64');
}

// ═════════════════════════════════════════════════════════════
await step('보안 헤더 · 첫 화면 (기록 없음)', async () => {
  const res = await page.goto(`${BASE}/`);
  const hdr = res.headers();
  check('CSP self', /default-src 'self'/.test(hdr['content-security-policy'] || ''));
  check('noindex', /noindex/.test(hdr['x-robots-tag'] || ''));
  await route('home');
  await page.waitForSelector('.empty-ticket');
  check('빈 화면 안내', /아직 남긴 기록이 없어요/.test(await text('.empty-ticket')));
  check('‘첫 기록 남기기’ 버튼', !!(await page.$('.empty-ticket a:has-text("첫 기록 남기기")')));
  check('예시 둘러보기 버튼', !!(await page.$('.empty-ticket button:has-text("예시 기록 둘러보기")')));
  check('기록이 없으면 탭·검색 숨김', await page.$eval('.controls', (e) => e.hidden));
  check('상단: 기록장 이름 + 새 기록', /또또하우스 기록장/.test(await text('.brand-title')) && !!(await page.$('.topbar a.btn-new:has-text("새 기록")')));
  await noOverflow('빈 화면');
  await shot('m-01-empty');
});

await step('빠른 기록: 장르·제목·날짜만 (날짜는 오늘로 기본)', async () => {
  await page.click('.empty-ticket a:has-text("첫 기록 남기기")');
  await route('new');
  check('날짜 기본값 = 오늘', (await page.inputValue('.input-date')) === TODAY, await page.inputValue('.input-date'));
  check('추가 기록은 접혀 있음', (await page.getAttribute('.extra-fold > .fold-btn', 'aria-expanded')) === 'false');
  check('필수 표시: 장르·제목·날짜', (await page.$$('.form-card .is-required')).length === 3);
  await shot('m-02-form-empty');
  // 필수 확인
  await save();
  await until(() => page.$('.field-error:not([hidden])'));
  const errs = await texts('.field-error:not([hidden])');
  check('장르·제목 오류 표시', errs.some((t) => /장르를 골라/.test(t)) && errs.some((t) => /제목을 적어/.test(t)), errs.join(' | '));
  await pickGenre('보드게임');
  check('보드게임을 고르면 제목 칸 이름이 ‘게임 이름’', (await text('.field-title .field-label')) === '게임 이름');
  await page.fill('.input-title', '카탄');
  await save();
  await route('play');
  check('저장 후 상세 화면', (await text('.td-title')) === '카탄');
  check('저장 알림', !!(await toastSeen(/기록했어요/)));
  check('평점 미평가 표시', /미평가/.test(await text('.td-meta')));
  await go('#/', 'home');
  const titles = await texts('.feed .tk-title');
  check('메인에 카드 1장', titles.length === 1 && titles[0] === '카탄', titles.join(','));
  check('카드 날짜', (await text('.tk-date')).startsWith(TODAY.replace(/-/g, '.')));
});

await step('장르를 고르면 그 장르 항목만', async () => {
  await go('#/new', 'new');
  await pickGenre('방탈출');
  check('방탈출: 매장·지점 칸 보임', await page.isVisible('.field-place'));
  await openExtra();
  const erLabels = await texts('.genre-box .field-label');
  check('방탈출 항목', ['탈출 결과', '남은 시간', '힌트 수', '체감 난이도', '공포도'].every((l) => erLabels.some((t) => t.startsWith(l))), erLabels.join(','));
  check('방탈출: 보드게임 항목 없음', !erLabels.some((t) => /플레이 인원|내 점수/.test(t)));
  await pickGenre('보드게임');
  check('보드게임: 매장·지점 숨김', !(await page.isVisible('.field-place')));
  const bgLabels = await texts('.genre-box .field-label');
  check('보드게임 항목', ['플레이 인원', '사용한 확장', '내 점수', '내 순위', '플레이 시간'].every((l) => bgLabels.some((t) => t.startsWith(l))), bgLabels.join(','));
  check('보드게임: 방탈출 항목 없음', !bgLabels.some((t) => /탈출 결과|공포도/.test(t)));
  await pickGenre('머더미스터리');
  const mmLabels = await texts('.genre-box .field-label');
  check('머더미스터리 항목', ['플레이 방식', '플레이 시간', '스토리', '몰입도', '스토리·몰입 감상'].every((l) => mmLabels.some((t) => t.startsWith(l))), mmLabels.join(','));
  await page.click('.spoiler-zone > .fold-btn');
  const spLabels = await texts('.spoiler-zone .field-label');
  check('머더미스터리 스포일러: 역할·범인·결말', ['맡은 역할', '범인', '결말'].every((l) => spLabels.some((t) => t.startsWith(l))), spLabels.join(','));
  await shot('m-03-form-mm');
  // 버리고 나가기
  await page.click('.form-bar .icon-btn[aria-label="닫기"]');
  await until(() => page.$(dlg));
  if (await page.$(dlg)) await dialogButton('버리기');
  await route('home');
});

let erPlayId = '';
await step('방탈출 기록: 추가 기록 + 스포일러, 저장 직후 도장 한 번', async () => {
  await quickRecord({ genre: '방탈출', title: '시계탑의 비밀', store: '달빛방탈출', branch: '강남점', rating: ['End', 'ArrowLeft'], oneLiner: '마지막 방 연출이 최고' });
  check('평점 4.5', (await page.getAttribute('.form-card .rating-track', 'aria-valuenow')) === '4.5');
  await openExtra();
  await page.click('.seg-result label:has-text("성공")');
  await page.fill('input[aria-label="남은 시간 분"]', '12');
  await page.fill('input[aria-label="남은 시간 초"]', '40');
  await page.fill('input[aria-label="힌트 수"]', '1');
  await page.press('input[aria-label="힌트 수"]', 'Tab');
  await page.click('.level-difficulty .level-btn[data-level="4"]');
  await page.click('.level-fear .level-btn[data-level="1"]');
  await fill('상세 후기', '인테리어가 탄탄했다.', 'textarea');
  await page.fill('.people-input', '민지');
  await page.press('.people-input', 'Enter');
  await page.fill('.people-input', '준호');
  await page.press('.people-input', 'Enter');
  await page.click('.spoiler-zone > .fold-btn');
  await fill('문제·풀이 메모', '비밀코드 0315 로 금고', 'textarea');
  await shot('m-04-form-er-filled');
  await save();
  await route('play');
  erPlayId = await playIdFromHash();
  check('저장 직후 도장', !!(await page.$('.save-stamp.is-success')));
  check('성공은 작은 상태 표시', /탈출 성공/.test(await text('.td-head .rtag')));
  const body = await text('.ticket-detail');
  check('남은 시간·힌트·난이도·공포도', /12:40/.test(body) && /1개/.test(body) && /어려움/.test(body) && /약함/.test(body), body);
  check('함께한 사람', /민지/.test(body) && /준호/.test(body));
  check('스포일러는 접힌 채로 (내용이 화면에 없음)', !body.includes('0315') && (await page.getAttribute('.spoiler-fold .fold-btn', 'aria-expanded')) === 'false');
  await page.waitForTimeout(1800);
  check('도장은 잠깐만 보이고 사라짐', !(await page.$('.save-stamp')));
  await page.reload();
  await route('play');
  await sleep(300);
  check('새로고침하면 도장 없음', !(await page.$('.save-stamp')));
  await page.click('.spoiler-fold .fold-btn');
  check('펼치면 스포일러 보임', (await text('.spoilers')).includes('0315'));
  await shot('m-05-detail-er');
});

await step('스포일러는 목록·검색에 나오지 않음', async () => {
  await go('#/', 'home');
  const feed = await text('.feed');
  check('카드에 스포일러 없음', !feed.includes('0315') && feed.includes('마지막 방 연출이 최고'));
  check('카드: 방탈출 성공 표시', /탈출 성공/.test(feed));
  await page.fill('.search-input', '0315');
  await sleep(300);
  check('스포일러 내용으로는 검색 안 됨', (await page.$$('.feed .tk-card')).length === 0);
  await page.fill('.search-input', '시계');
  await sleep(300);
  check('제목 검색', (await texts('.feed .tk-title')).join() === '시계탑의 비밀');
  await page.fill('.search-input', 'ㅅㄱㅌ');
  await sleep(300);
  check('초성 검색', (await texts('.feed .tk-title')).join() === '시계탑의 비밀');
  await page.fill('.search-input', '강남점');
  await sleep(300);
  check('매장·지점으로 검색', (await page.$$('.feed .tk-card')).length === 1);
  const preview = await text('.feed');
  check('검색 결과 미리보기에도 스포일러 없음', !preview.includes('0315'));
  await page.click('.search-clear');
  await sleep(200);
});

await step('이름만 같은 방탈출 테마는 자동으로 합치지 않음', async () => {
  await quickRecord({ genre: '방탈출', title: '시계탑의 비밀', store: '열쇠공방', branch: '홍대점', date: YESTERDAY });
  await save();
  await until(() => page.$(dlg));
  const dtext = await text(dlg);
  check('같은 이름 작품이 있다고 물어봄', /같은 이름의 작품이 있어요/.test(dtext) && /달빛방탈출 강남점/.test(dtext), dtext);
  check('자동으로 합치지 않는다는 안내', /자동으로 합치지 않아요/.test(dtext));
  await choice('새 작품으로 저장');
  await route('play');
  check('다른 작품이라는 안내', /이름이 같은 다른 작품 1개/.test(await text('.td-work')));
  await go('#/', 'home');
  await page.click('.feed-opts .toggle');
  await sleep(200);
  const works = await texts('.feed .tk-card .tk-sub');
  check('작품별로 묶어도 두 작품', works.filter((t) => /강남점|홍대점/.test(t)).length === 2, works.join(','));
  await page.click('.feed-opts .toggle');
  await sleep(150);
});

let catanWork = '';
await step('반복 플레이: 기존 작품을 골라 새 플레이 추가', async () => {
  await go('#/', 'home');
  await page.click('.feed .tk-card:has(.tk-title:text-is("카탄"))');
  await route('play');
  await page.click('.work-link');
  await route('work');
  catanWork = await page.evaluate(() => decodeURIComponent((/#\/work\/([^/?]+)/.exec(location.hash) || [])[1] || ''));
  await page.click('.tw-actions a:has-text("플레이 기록 추가")');
  await route('new');
  check('작품이 연결된 채로 열림', await page.isVisible('.linked') && /카탄/.test(await text('.linked')));
  check('연결되면 장르는 잠김', await page.$eval('.seg-genre', (e) => e.classList.contains('is-disabled')));
  await page.fill('.input-date', YESTERDAY);
  await setRating('.form-card .rating-track', ['4']);
  await openExtra();
  await page.fill('input[aria-label="플레이 인원"]', '4');
  await page.press('input[aria-label="플레이 인원"]', 'Tab');
  await fill('내 점수', '10');
  await page.fill('input[aria-label="내 순위"]', '1');
  await page.press('input[aria-label="내 순위"]', 'Tab');
  await save();
  await route('play');
  check('두 번째 플레이로 저장 (같은 작품)', /카탄/.test(await text('.td-title')));
  const body = await text('.ticket-detail');
  check('내 점수·순위', /10점/.test(body) && /1위 \/ 4명/.test(body), body);
  // 제목 제안에서 기존 작품 고르기
  await go('#/new', 'new');
  await pickGenre('보드게임');
  await page.fill('.input-title', '카');
  await page.waitForSelector('.suggest:not([hidden]) .suggest-item');
  check('제목 제안에 기존 작품', /카탄/.test(await text('.suggest')));
  await page.click('.suggest-item:has-text("카탄")');
  check('제안을 누르면 연결', await page.isVisible('.linked'));
  await page.fill('.input-date', '2025-03-02');
  await save();
  await route('play');
  await go(`#/work/${encodeURIComponent(catanWork)}`, 'work');
  const rows = await page.$$('.tw-plays .tl-row');
  check('작품 화면에 날짜별 플레이 3개', rows.length === 3, String(rows.length));
  check('회차 표시', /3회차/.test(await text('.tw-plays')) && /1회차/.test(await text('.tw-plays')));
  check('작품 통계 줄', /3회/.test(await text('.tw-stats')));
  await shot('m-06-work');
});

await step('제목만 쳐서 저장해도 같은 이름이면 물어봄 → 기존 작품에 추가', async () => {
  await quickRecord({ genre: '보드게임', title: '카탄', date: '2024-11-11' });
  await save();
  await until(() => page.$(dlg));
  check('물어봄', /같은 이름의 작품이 있어요/.test(await text(dlg)));
  await choice('기존 작품에 추가');
  await route('play');
  await go(`#/work/${encodeURIComponent(catanWork)}`, 'work');
  check('기존 작품에 붙음 (4회)', (await page.$$('.tw-plays .tl-row')).length === 4);
});

await step('수정 · 삭제', async () => {
  await go(`#/play/${encodeURIComponent(erPlayId)}`, 'play');
  await page.click('.appbar a[aria-label="수정"]');
  await route('edit');
  check('수정할 때 추가 기록은 펼쳐 둠 (적힌 내용 있음)', (await page.getAttribute('.extra-fold > .fold-btn', 'aria-expanded')) === 'true');
  await fill('한 줄 감상', '다시 생각해도 최고의 테마');
  await save();
  await route('play');
  check('고친 내용 반영', /다시 생각해도 최고의 테마/.test(await text('.td-oneliner')));
  check('수정 알림', !!(await toastSeen(/기록을 고쳤어요/)));
  await page.click('.spoiler-fold .fold-btn');
  check('스포일러가 그대로', (await text('.spoilers')).includes('0315'));
  // 삭제: 같은 작품에 기록이 더 있는 경우 → 작품 화면으로
  await go(`#/work/${encodeURIComponent(catanWork)}`, 'work');
  await page.click('.tw-plays .tl-row >> nth=0');
  await route('play');
  await page.click('.appbar button[aria-label="삭제"]');
  await until(() => page.$(dlg));
  check('삭제 확인 창', /이 기록을 지울까요/.test(await text(dlg)));
  await dialogButton('지우기');
  await route('work');
  check('삭제 후 작품 화면 (3회 남음)', (await page.$$('.tw-plays .tl-row')).length === 3);
  // 작품의 마지막 기록을 지우면 작품도 함께 → 메인으로
  await quickRecord({ genre: '보드게임', title: '지울 게임' });
  await save();
  await route('play');
  await page.click('.appbar button[aria-label="삭제"]');
  await until(() => page.$(dlg));
  check('마지막 기록이면 작품도 지운다고 알림', /작품 정보\(표지 포함\)도 함께 지워져요/.test(await text(dlg)));
  await dialogButton('지우기');
  await route('home');
  check('작품째 사라짐', !(await texts('.feed .tk-title')).includes('지울 게임'));
});

await step('필터 · 탭 · 보기 방식', async () => {
  await go('#/', 'home');
  await page.click('.gtab[data-genre="escaperoom"]');
  await sleep(150);
  const t = await texts('.feed .tk-title');
  check('방탈출 탭', t.length === 2 && t.every((x) => x === '시계탑의 비밀'), t.join(','));
  await page.click('.gtab[data-genre=""]');
  await sleep(150);
  await page.selectOption('.filters select >> nth=1', 'none');
  await sleep(150);
  const unrated = await texts('.feed .tk-card .stars');
  check('평점 필터: 미평가만', unrated.length > 0 && unrated.every((x) => x === '미평가'), unrated.join(','));
  check('조건 지우기 버튼', !!(await page.$('.result-line .link-btn')));
  await page.click('.result-line .link-btn');
  await sleep(150);
  await page.selectOption('.filters select >> nth=0', '2024');
  await sleep(150);
  check('연도 필터', (await page.$$('.feed .tk-card')).length === 1);
  await page.selectOption('.filters select >> nth=0', '');
  await sleep(150);
  await page.click('.vt-btn[data-view="list"]');
  await sleep(150);
  check('목록형', (await page.$$('.feed-list .row')).length >= 4);
  check('목록형은 달마다 묶음', (await page.$$('.month-head')).length >= 2);
  await page.reload();
  await route('home');
  await sleep(300);
  check('보기 방식 기억 (새로고침 후에도 목록형)', !!(await page.$('.feed-list')));
  await noOverflow('목록형');
  await shot('m-07-list');
  await page.click('.vt-btn[data-view="card"]');
  await sleep(150);
  await noOverflow('카드형');
});

await step('사진: 올리고 새로고침해도 남음', async () => {
  await quickRecord({ genre: '머더미스터리', title: '붉은 저택의 초대', rating: ['5'] });
  const buf = await jpegBuffer();
  await page.setInputFiles('.form-card .pf input[type=file]', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: buf });
  await until(() => page.$('.form-card .pf-tile .ph img[src^="blob:"]'), 8000);
  check('폼에 사진 칸', (await page.$$('.form-card .pf-tile:not(.is-busy)')).length === 1);
  await save();
  await route('play');
  await until(() => page.$('.gallery img[src^="blob:"]'), 8000);
  check('상세 갤러리에 사진', !!(await page.$('.gallery img[src^="blob:"]')));
  await page.reload();
  await route('play');
  const ok = await until(() => page.$eval('.gallery img', (im) => im.complete && im.naturalWidth > 0), 8000);
  check('새로고침 후에도 사진이 보임', !!ok);
  await page.click('.gal-main');
  await page.waitForSelector('dialog.viewer[open]');
  check('누르면 전체화면', !!(await page.$('dialog.viewer[open] img')));
  await page.keyboard.press('Escape');
  await sleep(200);
  await go('#/', 'home');
  const cover = await until(() => page.$eval('.feed .tk-card:has(.tk-title:text-is("붉은 저택의 초대")) .tk-cover img', (im) => im.complete && im.naturalWidth > 0), 8000);
  check('카드 표지로 보임', !!cover);
  const stored = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ddoddohouse-record');
    r.onsuccess = () => {
      const t = r.result.transaction('images', 'readonly').objectStore('images').getAll();
      t.onsuccess = () => res(t.result.map((x) => ({ type: x.type, size: x.size, w: x.width })));
    };
  }));
  check('IndexedDB 에 줄여서 저장 (WebP/JPEG, 1600px 이하)', stored.length === 1 && /image\/(webp|jpeg)/.test(stored[0].type) && stored[0].w <= 1600, JSON.stringify(stored));
});

await step('작성 중인 기록은 초안으로 남음', async () => {
  await go('#/new', 'new');
  await pickGenre('보드게임');
  await page.fill('.input-title', '아그리콜라');
  await sleep(500);
  await go('#/', 'home');
  await go('#/new', 'new');
  check('이어 쓰기 안내', await page.isVisible('.form-restored'));
  check('쓰던 제목 복원', (await page.inputValue('.input-title')) === '아그리콜라');
  await page.click('.form-restored .link-btn');
  await route('new');
  await sleep(200);
  check('처음부터 다시', !(await page.$('.form-restored')) && (await page.inputValue('.input-title')) === '');
  await go('#/', 'home');
});

await step('다른 탭에서 저장하면 이 탭도 바뀜', async () => {
  const other = await ctx.newPage();
  watch(other, '[tab2] ');
  await other.goto(`${BASE}/#/`);
  await other.waitForSelector('body[data-route="home"]');
  const before = (await other.$$('.feed .tk-card')).length;
  await quickRecord({ genre: '보드게임', title: '스플렌더' });
  await save();
  await route('play');
  const after = await until(async () => ((await other.$$('.feed .tk-card')).length === before + 1 ? true : null), 5000);
  check('다른 탭 목록 갱신', !!after);
  await other.close();
});

await step('예시 기록: 구분 표시 · 한 번에 지우기', async () => {
  await go('#/settings', 'settings');
  const s = await text('.settings');
  check('저장 범위 안내', /이 기기의 이 브라우저에만 저장돼요/.test(s));
  check('다른 기기에서는 안 보인다는 안내', /다른 기기/.test(s));
  check('실제 접근 제어 설명', /실제 접근 제어 — 지금은 없어요/.test(s));
  check('화면 가림 설명', /화면에서 가리기/.test(s) && /보안 기능은 아니에요/.test(s));
  await page.click('.settings button:has-text("예시 넣기")');
  await until(async () => /예시 기록 6개/.test(await text('.settings')), 6000);
  await go('#/', 'home');
  check('예시 표시', (await page.$$('.feed .stag')).length === 6);
  check('예시 안내 띠', await page.isVisible('.sample-note'));
  const real = (await page.$$('.feed .tk-card')).length - 6;
  await shot('m-08-home-samples');
  await page.click('.sample-note button');
  await until(() => page.$(dlg));
  await dialogButton('예시 지우기');
  await until(async () => (await page.$$('.feed .stag')).length === 0, 5000);
  check('예시만 지워짐', (await page.$$('.feed .tk-card')).length === real, String(real));
  const imgs = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ddoddohouse-record');
    r.onsuccess = () => { const t = r.result.transaction('images', 'readonly').objectStore('images').count(); t.onsuccess = () => res(t.result); };
  }));
  check('예시 사진도 지워짐 (내 사진 1장만)', imgs === 1, String(imgs));
});

let backupFile = '';
await step('백업 내보내기 · 다른 브라우저에서 가져오기', async () => {
  await go('#/settings', 'settings');
  await shot('m-09-settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.settings button:has-text("백업 내보내기")')]);
  backupFile = path.join(SHOTS, '..', 'backup.json');
  await dl.saveAs(backupFile);
  const data = JSON.parse(readFileSync(backupFile, 'utf8'));
  check('백업 형식', data.app === 'ddoddohouse-record' && data.version === 2);
  check('기록·작품·사진 포함', data.plays.length >= 6 && data.works.length >= 4 && data.images.length === 1, `${data.plays.length}/${data.works.length}/${data.images.length}`);
  check('예시는 백업에 없음', !data.plays.some((p) => p.sample));
  const fresh = await newContext();
  const p2 = await fresh.newPage();
  watch(p2, '[fresh] ');
  await p2.goto(`${BASE}/#/settings`);
  await p2.waitForSelector('body[data-route="settings"]');
  await p2.setInputFiles('.settings input[type=file]', backupFile);
  await p2.waitForSelector('dialog.dlg[open]');
  check('가져오기 미리보기', /플레이 기록 \d+개/.test(squash(await p2.textContent('dialog.dlg[open]'))));
  await p2.click('dialog.dlg[open] .dlg-actions button:has-text("가져오기")');
  await p2.waitForTimeout(800);
  await p2.evaluate(() => { location.hash = '#/'; });
  await p2.waitForSelector('.feed .tk-card');
  check('가져온 기록이 보임', (await p2.$$('.feed .tk-card')).length === data.plays.length);
  const img = await p2.waitForSelector('.feed .tk-cover img', { timeout: 8000 }).catch(() => null);
  check('가져온 사진도 보임', !!img);
  await fresh.close();
});

await step('예전 버전(모임용 서버) 백업 가져오기', async () => {
  const v1 = {
    app: 'ddoddohouse-record', version: 1, exportedAt: new Date().toISOString(),
    members: [{ id: 'm1', name: '민지', emoji: '', color: 'c1' }],
    records: [
      { id: 'r1', type: 'escaperoom', date: '2025-05-05', title: '옛날 테마', members: ['m1'], rating: 4, oneLiner: '재밌었다', review: '결말은 비밀', spoiler: true, tags: [], er: { brand: '어딘가', branch: '신촌점', cleared: true, remainingSec: 300, hints: 2, difficulty: 3.5, fear: 0 } },
      { id: 'r2', type: 'boardgame', date: '2025-05-06', title: '뱅', members: [], rating: 0, oneLiner: '', review: '', spoiler: false, tags: [], bg: { playTimeMin: 30, results: [] } },
    ],
  };
  const fresh = await newContext();
  const p2 = await fresh.newPage();
  watch(p2, '[v1] ');
  await p2.goto(`${BASE}/#/settings`);
  await p2.waitForSelector('body[data-route="settings"]');
  const f = path.join(SHOTS, '..', 'backup-v1.json');
  writeFileSync(f, JSON.stringify(v1));
  await p2.setInputFiles('.settings input[type=file]', f);
  await p2.waitForSelector('dialog.dlg[open]');
  check('예전 버전 안내', /예전 버전 백업/.test(squash(await p2.textContent('dialog.dlg[open]'))));
  await p2.click('dialog.dlg[open] .dlg-actions button:has-text("가져오기")');
  await p2.waitForTimeout(600);
  await p2.evaluate(() => { location.hash = '#/'; });
  await p2.waitForSelector('.feed .tk-card');
  check('예전 기록 2개', (await p2.$$('.feed .tk-card')).length === 2);
  check('스포일러 후기는 카드에 안 나옴', !/결말은 비밀/.test(squash(await p2.textContent('.feed'))));
  await fresh.close();
});

await step('예전 버전이 이 브라우저에 남긴 기록 사본 가져오기', async () => {
  const fresh = await newContext();
  const p2 = await fresh.newPage();
  watch(p2, '[legacy] ');
  await p2.goto(`${BASE}/`);
  await p2.waitForSelector('body[data-route="home"]');
  await p2.evaluate(() => {
    localStorage.setItem('ddh:key', 'old-secret-key-1234567890');
    localStorage.setItem('ddh:cache', JSON.stringify({
      savedAt: '2026-09-29T10:00:00.000Z',
      members: [{ id: 'm1', name: '민지' }],
      records: [{ id: 'r9', type: 'boardgame', date: '2026-09-28', title: '스컬킹', members: ['m1'], rating: 4.5, oneLiner: '또 하고 싶다', review: '', spoiler: false, bg: {} }],
    }));
  });
  await p2.reload();
  await p2.waitForSelector('.legacy-note:not([hidden])');
  check('남은 사본 안내', /기록 사본 1개/.test(squash(await p2.textContent('.legacy-note'))));
  await p2.click('.legacy-note button:has-text("가져오기")');
  await p2.waitForSelector('.feed .tk-card');
  check('사본 기록을 가져옴', squash(await p2.textContent('.feed')).includes('스컬킹'));
  const left = await p2.evaluate(() => [localStorage.getItem('ddh:key'), localStorage.getItem('ddh:cache')]);
  check('예전 입장 코드·사본은 지움', left.every((x) => x === null), JSON.stringify(left));
  check('안내가 사라짐', await p2.$eval('.legacy-note', (e) => e.hidden));
  await fresh.close();
});

await step('작품 정보 수정 · 합치기', async () => {
  // 방탈출 홍대점 작품을 강남점 작품으로 합치기
  await go('#/', 'home');
  await page.fill('.search-input', '홍대');
  await sleep(250);
  await page.click('.feed .tk-card >> nth=0');
  await route('play');
  await page.click('.work-link');
  await route('work');
  await page.click('.tw-actions a:has-text("작품 정보 수정")');
  await route('work-edit');
  check('작품 정보 수정 화면', /작품 정보는 이 작품의 모든 플레이 기록에/.test(await text('.form-lead')));
  await page.click('.danger-zone button:has-text("합치기")');
  await until(() => page.$(dlg));
  await choice('시계탑의 비밀 · 달빛방탈출 강남점');
  await until(async () => /작품을 합칠까요/.test(await text(dlg)));
  await dialogButton('합치기');
  await route('work');
  check('합친 작품에 기록 2개', (await page.$$('.tw-plays .tl-row')).length === 2);
  await go('#/', 'home');
  await page.click('.search-clear');
});

await step('오프라인에서도 열림 (서비스 워커)', async () => {
  await go('#/', 'home');
  const ready = await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 6000)),
  ]));
  check('서비스 워커 준비', ready);
  await page.waitForTimeout(500);
  await ctx.setOffline(true);
  try {
    await page.reload();
    await route('home');
    check('오프라인 새로고침 후에도 기록이 보임', (await page.$$('.feed .tk-card, .feed .row')).length > 0);
  } finally {
    await ctx.setOffline(false);
  }
});

await step('모든 기록 지우기 → 빈 화면', async () => {
  await go('#/settings', 'settings');
  await page.click('.settings button:has-text("모두 지우기")');
  await until(() => page.$(dlg));
  await dialogButton('모두 지우기');
  await until(async () => /정말 지울까요/.test(await text(dlg)));
  await dialogButton('지우기');
  await toastSeen(/모든 기록을 지웠어요/);
  await go('#/', 'home');
  check('빈 화면으로', !!(await page.$('.empty-ticket')));
});

// ── 데스크톱 · 어두운 화면 스크린샷 ─────────────────────────
await step('데스크톱 화면', async () => {
  await ctx.close();
  ctx = await newContext({ viewport: DESKTOP, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  page = await ctx.newPage();
  watch(page, '[desktop] ');
  await page.goto(`${BASE}/#/`);
  await route('home');
  await page.click('.empty-ticket button:has-text("예시 기록 둘러보기")');
  await page.waitForSelector('.feed .tk-card');
  await sleep(500);
  await noOverflow('데스크톱 카드형');
  await shot('d-01-cards');
  await page.click('.vt-btn[data-view="list"]');
  await sleep(200);
  await shot('d-02-list');
  await page.click('.vt-btn[data-view="card"]');
  await go('#/play/p_sample_redmansion', 'play');
  await shot('d-03-detail');
  await go('#/work/w_sample_splendor', 'work');
  await shot('d-04-work');
  await go('#/new', 'new');
  await shot('d-05-form');
  await go('#/settings', 'settings');
  await shot('d-06-settings');
  await page.click('.settings .seg label:has-text("어둡게")');
  await go('#/', 'home');
  await sleep(300);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('어둡게 테마', /rgb\(27, 26, 23\)/.test(bg), bg);
  await shot('d-07-dark');
  await go('#/play/p_sample_clock_gn', 'play');
  await shot('d-08-dark-detail');
});

// ── 마무리 ──────────────────────────────────────────────────
currentStep = '콘솔';
check('콘솔 오류 없음', problems.length === 0, problems.slice(0, 5).join(' | '));
check('CSP 위반 없음', cspViolations.length === 0, cspViolations.slice(0, 3).join(' | '));

await browser.close();
await srv.close();
console.log(`\n${passN} passed, ${failN} failed`);
if (failN) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exitCode = 1;
}
