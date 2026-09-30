// 설정 — 기록장 이름, 화면, 저장 위치와 범위, 접근 제어와 화면 가림의 차이, 예시 기록, 백업, 모두 지우기
import { h, icon } from '../dom.js';
import * as repo from '../repo.js';
import * as prefs from '../prefs.js';
import { APP_VERSION, DEFAULT_BOOK_NAME, LIMITS } from '../constants.js';
import { backupHead, backupTail, imageEntry, parseBackup } from '../backup.js';
import { dateStamp, fmtBytes } from '../format.js';
import { appBar, segmented, toast, confirmDialog, openDialog, counterFor } from '../ui.js';
import { loadSamples, removeSamplesWithConfirm } from './sample-actions.js';

function section(title, ...children) {
  return h('section', { class: 'set-section' }, h('h2', { class: 'set-title', text: title }), ...children);
}

function card(...children) {
  return h('div', { class: 'set-card' }, ...children);
}

function bullet(text, ic = 'check') {
  return h('li', {}, icon(ic), h('span', { text }));
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, class: 'sr-only' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 진행 표시 다이얼로그 */
function progressDialog(title) {
  const text = h('p', { class: 'dlg-text', text: '준비 중…' });
  const bar = h('progress', { class: 'progress', max: '1', value: '0' });
  const st = { cancelled: false };
  let closeFn = null;
  openDialog({
    title, body: h('div', {}, text, bar), dismissible: false,
    actions: [{ label: '중단', value: 'stop', kind: 'ghost', handler: () => { st.cancelled = true; return true; } }],
    bind: (c) => { closeFn = c; },
  });
  st.set = (msg, v) => { text.textContent = msg; bar.value = v; };
  st.close = () => { if (closeFn) closeFn(null); };
  return st;
}

async function exportBackup(withImages) {
  // 예시 기록은 백업에 넣지 않음 (내 기록만)
  const plays = repo.playsList().filter((p) => !p.sample);
  if (!plays.length) { toast('내보낼 내 기록이 없어요 (예시 기록은 백업에 넣지 않아요)', 'info', 3500); return; }
  const workIds = new Set(plays.map((p) => p.workId));
  const works = repo.worksList().filter((w) => workIds.has(w.id));
  const parts = [backupHead({ bookName: repo.state.bookName, works, plays, withImages })];
  let n = 0;
  if (withImages) {
    const ids = new Set();
    for (const p of plays) for (const id of p.photos) ids.add(id);
    for (const w of works) if (w.cover) ids.add(w.cover);
    const list = [...ids];
    const pg = list.length > 4 ? progressDialog('사진을 담는 중') : null;
    for (let i = 0; i < list.length; i++) {
      if (pg && pg.cancelled) { toast('내보내기를 중단했어요', 'info'); return; }
      if (pg) pg.set(`사진 ${i + 1} / ${list.length}`, i / list.length);
      const rec = await repo.getImage(list[i]);
      if (!rec) continue;
      parts.push(`${n ? ',' : ''}\n  `, JSON.stringify(imageEntry(rec)));
      n += 1;
    }
    if (pg) pg.close();
    parts.push(backupTail(true));
  }
  download(new Blob(parts, { type: 'application/json' }), `ddoddohouse-backup-${dateStamp()}.json`);
  toast(`기록 ${plays.length}개${withImages ? `, 사진 ${n}장` : ''}을 파일로 내보냈어요`, 'ok', 4000);
}

async function importBackup(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    toast('파일을 읽지 못했어요', 'error');
    return;
  }
  const r = parseBackup(text);
  if (!r.ok) { toast(r.reason, 'error', 4500); return; }
  if (!r.plays.length) { toast('백업 파일에 가져올 기록이 없어요', 'info'); return; }
  const have = repo.playsList().length;
  const mode = await openDialog({
    title: '백업을 가져올까요?',
    body: h('div', { class: 'import-preview' },
      h('p', { class: 'dlg-text', text: `작품 ${r.works.length}개 · 플레이 기록 ${r.plays.length}개 · 사진 ${r.images.length}장${r.skipped ? ` (형식이 맞지 않는 ${r.skipped}개는 건너뜀)` : ''}` }),
      r.notes.map((t) => h('p', { class: 'dlg-note', text: t })),
      have ? h('p', { class: 'dlg-note', text: `이 브라우저에는 지금 기록 ${have}개가 있어요.` }) : null),
    actions: [
      { label: '취소', value: null, kind: 'ghost' },
      ...(have ? [{ label: '모두 바꾸기', value: 'replace', kind: 'danger' }] : []),
      { label: have ? '없는 것만 더하기' : '가져오기', value: 'merge', kind: 'primary' },
    ],
  });
  if (!mode) return;
  if (mode === 'replace') {
    const ok = await confirmDialog('이 브라우저의 기록을 바꿀까요?', `지금 있는 기록 ${have}개와 사진을 모두 지우고 백업 내용으로 바꿔요. 되돌릴 수 없어요.`, { ok: '바꾸기', danger: true });
    if (!ok) return;
  }
  try {
    const res = await repo.importData(r, { mode });
    toast(`기록 ${res.plays}개${res.images ? `, 사진 ${res.images}장` : ''}을 가져왔어요${res.skipped ? ` (이미 있는 ${res.skipped}개는 건너뜀)` : ''}`, 'ok', 4500);
  } catch (e) {
    toast(e && e.code === 'quota' ? '저장 공간이 부족해 다 가져오지 못했어요' : '가져오지 못했어요', 'error', 4500);
  }
}

async function wipe() {
  const n = repo.playsList().length;
  const ok = await confirmDialog('이 브라우저의 기록을 모두 지울까요?',
    `기록 ${n}개와 사진, 기록장 이름을 모두 지워요. 서버에 따로 남은 사본이 없어서 되돌릴 수 없어요. 필요하면 먼저 백업을 내보내 주세요.`,
    { ok: '모두 지우기', danger: true });
  if (!ok) return;
  const again = await confirmDialog('정말 지울까요?', '마지막 확인이에요.', { ok: '지우기', danger: true });
  if (!again) return;
  try {
    await repo.wipeAll();
    prefs.clearDraft();
    toast('모든 기록을 지웠어요', 'ok');
  } catch {
    toast('지우지 못했어요', 'error');
  }
}

export function mount(root, ctx) {
  // ── 기록장 이름 ──
  const nameInput = h('input', { type: 'text', class: 'input', value: repo.state.bookName, placeholder: DEFAULT_BOOK_NAME, autocomplete: 'off', 'aria-label': '기록장 이름' });
  nameInput.maxLength = LIMITS.bookName;
  const saveName = async () => {
    const v = nameInput.value;
    if (v.trim() === repo.state.bookName) return;
    try {
      const saved = await repo.setBookName(v);
      nameInput.value = saved;
      toast('기록장 이름을 바꿨어요', 'ok');
    } catch {
      toast('이름을 저장하지 못했어요', 'error');
    }
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); nameInput.blur(); } });
  nameInput.addEventListener('change', saveName);

  // ── 저장 공간 상태 ──
  const usage = h('dd', { text: '확인 중…' });
  const counts = h('dd');
  const persistDd = h('dd');
  async function refreshStorage() {
    const plays = repo.playsList();
    counts.textContent = `작품 ${repo.worksList().length}개 · 플레이 기록 ${plays.length}개${repo.sampleCount() ? ` (예시 ${repo.sampleCount()}개 포함)` : ''}`;
    try {
      const n = await repo.imageCount();
      counts.textContent += ` · 사진 ${n}장`;
    } catch { /* 무시 */ }
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      usage.textContent = est && Number.isFinite(est.usage)
        ? `${fmtBytes(est.usage)} 사용 중${est.quota ? ` (이 브라우저가 허용한 공간 약 ${fmtBytes(est.quota)})` : ''}`
        : '이 브라우저에서는 확인할 수 없어요';
    } catch {
      usage.textContent = '이 브라우저에서는 확인할 수 없어요';
    }
    let persisted = null;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch { persisted = null; }
    persistDd.replaceChildren(...[
      h('span', { text: persisted === true ? '보호됨 — 공간이 모자라도 브라우저가 먼저 지우지 않아요' : persisted === false ? '요청 전 — 공간이 모자라면 브라우저가 지울 수 있어요' : '이 브라우저에서는 확인할 수 없어요' }),
      persisted === false ? h('button', {
        type: 'button', class: 'btn btn-small btn-ghost',
        onClick: async () => {
          const ok = await navigator.storage.persist().catch(() => false);
          toast(ok ? '저장 공간 보호를 켰어요' : '브라우저가 아직 허락하지 않았어요. 자주 쓰거나 홈 화면에 추가하면 허락될 수 있어요', ok ? 'ok' : 'info', 4500);
          refreshStorage();
        },
      }, '보호 요청') : null,
    ].filter(Boolean));
  }

  // ── 예시 기록 ──
  const sampleBox = h('div', { class: 'set-row' });
  function paintSamples() {
    const n = repo.sampleCount();
    sampleBox.replaceChildren(
      h('div', { class: 'set-row-text' },
        h('p', { class: 'set-row-title', text: n ? `예시 기록 ${n}개가 들어 있어요` : '예시 기록이 없어요' }),
        h('p', { class: 'set-row-desc', text: '예시는 ‘예시’ 표시가 붙어 내 기록과 구분되고, 백업에는 들어가지 않아요. 예시 작품에 내 기록을 더하면 그 기록은 남아요.' })),
      n
        ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => removeSamplesWithConfirm() }, icon('trash'), h('span', { text: '예시 지우기' }))
        : h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => loadSamples() }, icon('plus'), h('span', { text: '예시 넣기' })));
  }

  // ── 백업 ──
  let withImages = true;
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    importBackup(f);
  });
  const photoToggle = h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: true, onChange: (e) => { withImages = e.target.checked; } }),
    h('span', { text: '사진도 함께 담기 (파일이 커져요)' }));

  const themeSeg = segmented({
    options: [{ key: 'light', label: '밝게', icon: 'sun' }, { key: 'dark', label: '어둡게', icon: 'moon' }, { key: 'system', label: '기기 설정' }],
    value: prefs.getTheme(), label: '화면 밝기',
    onChange: (t) => { prefs.setTheme(t); ctx.applyTheme(); },
  });

  root.append(
    appBar({ title: '설정', back: '#/' }),
    h('div', { class: 'container narrow settings' },
      section('기록장',
        card(h('label', { class: 'field-label', text: '기록장 이름' }),
          h('div', { class: 'set-inline' }, nameInput, counterFor(nameInput, LIMITS.bookName)),
          h('p', { class: 'field-hint', text: '처음 화면 맨 위에 보여요.' }))),

      section('화면', card(h('span', { class: 'field-label', text: '밝기' }), themeSeg)),

      section('저장 위치와 범위',
        card(
          h('div', { class: 'notice notice-store' },
            icon('database'),
            h('div', {},
              h('p', { class: 'notice-title', text: '기록과 사진은 이 기기의 이 브라우저에만 저장돼요' }),
              h('ul', { class: 'bullets' },
                bullet('서버로 보내지 않아요. 인터넷이 없어도 쓰고 볼 수 있어요.'),
                bullet('다른 기기, 같은 기기의 다른 브라우저(예: 크롬과 사파리), 홈 화면에 추가한 앱 아이콘에서는 보이지 않아요. 옮기려면 아래 백업을 써요.', 'info'),
                bullet('브라우저에서 방문 기록과 함께 ‘쿠키 및 사이트 데이터’를 지우거나, 시크릿(사생활 보호) 창을 닫으면 기록도 지워져요.', 'alert'),
                bullet('아이폰·아이패드 사파리는 이 사이트를 7일 넘게 열지 않으면 데이터를 지울 수 있어요. 홈 화면에 추가해 쓰거나 백업을 자주 받아 두세요.', 'alert')))),
          h('dl', { class: 'set-dl' },
            h('div', {}, h('dt', { text: '담긴 기록' }), counts),
            h('div', {}, h('dt', { text: '사용 중인 공간' }), usage),
            h('div', {}, h('dt', { text: '저장 공간 보호' }), persistDd)))),

      section('개인정보와 스포일러 보호',
        h('div', { class: 'set-compare' },
          card(
            h('p', { class: 'compare-title' }, icon('shield'), h('span', { text: '실제 접근 제어 — 지금은 없어요' })),
            h('ul', { class: 'bullets' },
              bullet('로그인이나 비밀번호가 없어요. 이 기기·이 브라우저를 열 수 있는 사람은 스포일러를 포함한 모든 기록을 볼 수 있어요.', 'info'),
              bullet('기록을 지켜 주는 것은 기기의 화면 잠금과 브라우저 프로필이에요. 저장된 내용은 암호화되지 않아요.', 'info'),
              bullet('로그인·기기 간 동기화는 아직 정하지 않았어요. 도입하면 계정별로 서버에서 접근을 막는 실제 접근 제어가 생겨요.', 'info'))),
          card(
            h('p', { class: 'compare-title' }, icon('eyeOff'), h('span', { text: '화면에서 가리기 — 스포일러 접기' })),
            h('ul', { class: 'bullets' },
              bullet('스포일러 메모(역할·범인·결말, 문제·풀이)는 상세 화면에서 기본으로 접혀 있어요.'),
              bullet('목록 카드와 검색 결과 미리보기에는 스포일러가 나오지 않고, 검색도 스포일러 내용은 찾지 않아요.'),
              bullet('실수로 보는 것을 막는 표시 기능일 뿐 보안 기능은 아니에요. 백업 파일에도 스포일러가 그대로 들어가요.', 'info'))))),

      section('예시 기록', card(sampleBox)),

      section('백업 (다른 기기로 옮기기)',
        card(
          h('p', { class: 'set-desc', text: '내 기록을 JSON 파일 하나로 내보내고, 다른 기기·브라우저에서 가져올 수 있어요. 기기 간 자동 동기화는 아직 없어서 이 방법으로 옮겨요.' }),
          photoToggle,
          h('div', { class: 'set-buttons' },
            h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => exportBackup(withImages) }, icon('download'), h('span', { text: '백업 내보내기' })),
            h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => fileInput.click() }, icon('upload'), h('span', { text: '백업 가져오기' }))),
          h('p', { class: 'field-hint', text: '예전 모임용 기록장(서버 버전)에서 내보낸 백업도 가져올 수 있어요.' }),
          fileInput)),

      section('모두 지우기',
        card(h('div', { class: 'set-row' },
          h('div', { class: 'set-row-text' },
            h('p', { class: 'set-row-title', text: '이 브라우저의 기록 모두 지우기' }),
            h('p', { class: 'set-row-desc', text: '기록·사진·기록장 이름을 지워요. 화면 설정은 남아요.' })),
          h('button', { type: 'button', class: 'btn btn-danger-ghost', onClick: wipe }, icon('trash'), h('span', { text: '모두 지우기' }))))),

      h('p', { class: 'app-version', text: `또또하우스 기록장 ${APP_VERSION} · 기록은 이 브라우저에만 있어요` })));

  paintSamples();
  refreshStorage();

  return {
    update() {
      if (document.activeElement !== nameInput) nameInput.value = repo.state.bookName;
      paintSamples();
      refreshStorage();
    },
  };
}
