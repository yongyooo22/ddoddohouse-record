// 또또하우스 기록장 서비스 워커 — 앱 파일(정적 셸)만 캐시해서 오프라인에서도 열리게.
// 기록·사진은 여기가 아니라 브라우저 IndexedDB 에 있음 (서버로 보내지 않음).
// 배포 전에 npm run bump-sw 로 CACHE_VERSION 을 올리면 새 파일이 바로 반영돼요.
// (깜빡해도 정적 파일은 뒤에서 새로 받아 두므로 한 번 더 열면 반영돼요)
const CACHE_VERSION = 'ddh-v5';
const CACHE = `ddoddohouse-record-${CACHE_VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/js/backup.js',
  '/js/compress.js',
  '/js/constants.js',
  '/js/db.js',
  '/js/dom.js',
  '/js/format.js',
  '/js/images.js',
  '/js/legacy.js',
  '/js/main.js',
  '/js/model.js',
  '/js/nav.js',
  '/js/prefs.js',
  '/js/query.js',
  '/js/repo.js',
  '/js/sample-art.js',
  '/js/samples.js',
  '/js/ui.js',
  '/js/views/cards.js',
  '/js/views/form.js',
  '/js/views/home.js',
  '/js/views/photos.js',
  '/js/views/play.js',
  '/js/views/sample-actions.js',
  '/js/views/settings.js',
  '/js/views/work-form.js',
  '/js/views/work.js',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ddoddohouse-record-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function cacheable(res) {
  return res && res.ok && res.type === 'basic';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 페이지(HTML)는 네트워크 우선 → 새 배포가 바로 반영, 오프라인이면 캐시
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    // 앱 셸(/, /index.html)의 HTML 응답만 저장 (주소창으로 /robots.txt 등을 열어도 셸이 덮어써지지 않게)
    const isShell = url.pathname === '/' || url.pathname === '/index.html';
    event.respondWith(
      fetch(req)
        .then((res) => {
          const html = (res.headers.get('content-type') || '').includes('text/html');
          if (isShell && html && cacheable(res)) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put('/index.html', copy)));
          }
          return res;
        })
        .catch(() => caches.match(isShell ? '/index.html' : req, { ignoreSearch: true })
          .then((r) => r || caches.match('/index.html'))),
    );
    return;
  }

  // 정적 파일은 캐시 먼저 보여 주고 뒤에서 새로 받아 둠 (stale-while-revalidate)
  // → CACHE_VERSION 올리는 걸 깜빡해도 다음 실행 때는 새 파일이 쓰임
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const update = fetch(req).then((res) => {
        if (cacheable(res)) return cache.put(req, res.clone()).then(() => res, () => res);
        return res;
      });
      if (hit) {
        event.waitUntil(update.catch(() => {}));
        return hit;
      }
      return update;
    }),
  );
});
