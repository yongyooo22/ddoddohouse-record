// 설정 — 연결 상태, 내보내기/가져오기, 테마, 잠금 해제 정보 지우기
import { h, icon } from '../dom.js';
import { APP_NAME, APP_VERSION, TYPE_KEYS } from '../constants.js';
import { state, getTheme, setTheme, wipeLocal, upsertRecord, upsertMember, recordById } from '../store.js';
import { relTime, dateStamp, nameKey } from '../format.js';
import * as api from '../api.js';
import { segmented, openDialog, confirmDialog, toast, appBar } from '../ui.js';

let ctxRef = null;

function statusInfo() {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (!online || state.status === 'offline') return { cls: 'is-off', label: '오프라인', desc: '이 기기에 저장된 기록을 보여 주고 있어요 (읽기 전용)' };
  if (state.status === 'loading') return { cls: 'is-wait', label: '불러오는 중', desc: '서버에서 최신 기록을 받아오고 있어요' };
  if (state.status === 'error') {
    const desc = ['network', 'timeout', 'server_error'].includes(state.errorCode)
      ? '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요'
      : api.errorMessage({ code: state.errorCode }, '연결');
    return { cls: 'is-err', label: '연결 문제', desc };
  }
  if (state.status === 'ok') return { cls: 'is-ok', label: '연결됨', desc: '모든 변경이 바로 모두에게 저장돼요' };
  return { cls: 'is-wait', label: '확인 중', desc: '' };
}

function exportData() {
  const payload = {
    app: 'ddoddohouse-record',
    version: 1,
    exportedAt: new Date().toISOString(),
    records: state.records,
    members: state.members,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `ddoddohouse-backup-${dateStamp()}.json`, class: 'sr-only' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`기록 ${state.records.length}개, 멤버 ${state.members.length}명을 내보냈어요`, 'ok');
}

function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (data && data.data && typeof data.data === 'object') data = data.data;
  if (!data || typeof data !== 'object') return null;
  const records = Array.isArray(data.records) ? data.records.filter((r) => r && typeof r === 'object' && TYPE_KEYS.includes(r.type)) : [];
  const members = Array.isArray(data.members) ? data.members.filter((m) => m && typeof m === 'object' && typeof m.name === 'string') : [];
  if (!records.length && !members.length) return null;
  return { records, members };
}

async function importFlow(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast('파일이 너무 커요', 'error'); return; }
  const text = await file.text();
  const data = parseBackup(text);
  if (!data) { toast('또또하우스 기록장 백업 파일이 아니에요', 'error'); return; }

  const recIds = new Set(state.records.map((r) => r.id));
  const memIds = new Set(state.members.map((m) => m.id));
  // 이름이 같은 멤버가 이미 있으면(id 만 다름) 새로 만들지 않고 기존 멤버로 합침
  // → 서버의 '같은 이름' 거부로 실패하거나 기록에 '(떠난 멤버)'로 남는 것 방지
  const byName = new Map(state.members.map((m) => [nameKey(m.name), m.id]));
  const remap = new Map(); // 백업 멤버 id → 기존 멤버 id
  const sameName = new Set(); // id 없이 이름만 같은 백업 멤버
  for (const m of data.members) {
    const ex = byName.get(nameKey(m.name));
    if (!ex) continue;
    if (!m.id) sameName.add(m);
    else if (m.id !== ex && !memIds.has(m.id)) remap.set(m.id, ex);
  }
  const isMerged = (m) => (m.id ? remap.has(m.id) : sameName.has(m));
  const newRecs = data.records.filter((r) => !r.id || !recIds.has(r.id)).length;
  const newMems = data.members.filter((m) => (!m.id || !memIds.has(m.id)) && !isMerged(m)).length;
  const mergedN = data.members.filter(isMerged).length;

  let mode = 'add';
  const body = h('div', { class: 'import-preview' },
    h('ul', { class: 'import-counts' },
      h('li', {}, h('strong', { text: `기록 ${data.records.length}개` }), h('span', { text: ` — 새로 ${newRecs} · 이미 있음 ${data.records.length - newRecs}` })),
      h('li', {}, h('strong', { text: `멤버 ${data.members.length}명` }), h('span', { text: ` — 새로 ${newMems} · 이미 있음 ${data.members.length - newMems}` })),
      mergedN ? h('li', { class: 'import-merge' }, h('span', { text: `이름이 같은 멤버 ${mergedN}명은 지금 있는 멤버로 합쳐서 기록을 이어 붙여요` })) : null),
    h('p', { class: 'field-label', text: '이미 있는 항목은' }),
    segmented({
      label: '가져오기 방식', value: mode,
      options: [{ key: 'add', label: '건너뛰기 (없는 것만 추가)' }, { key: 'overwrite', label: '덮어쓰기' }],
      onChange: (v) => { mode = v; },
      cls: 'seg-stack',
    }),
    h('p', { class: 'fhint', text: '같은 id를 기준으로 비교해요. 가져온 내용은 모두에게 저장돼요.' }));
  const ok = await openDialog({
    title: '백업 가져오기',
    body,
    actions: [{ label: '취소', value: false, kind: 'ghost' }, { label: '가져오기', value: true, kind: 'primary' }],
  });
  if (!ok) return;
  if (navigator.onLine === false) { toast('오프라인이라 가져올 수 없어요', 'error'); return; }

  const progress = h('p', { class: 'dlg-text', text: '준비 중…' });
  const bar = h('span', { class: 'progress-fill' });
  let cancelled = false;
  let closeProgress = () => {};
  openDialog({
    title: '가져오는 중',
    body: h('div', {}, progress, h('div', { class: 'progress' }, bar)),
    dismissible: false,
    bind: (c) => { closeProgress = c; },
    actions: [{ label: '중단', value: 'stop', kind: 'ghost', handler: () => { cancelled = true; return true; } }],
  });

  const members = data.members.filter((m) => !isMerged(m) && (mode === 'overwrite' || !m.id || !memIds.has(m.id)));
  const mapId = (id) => remap.get(id) || id;
  const remapRecord = (r) => {
    if (!remap.size) return r;
    const out = { ...r };
    if (Array.isArray(r.members)) out.members = [...new Set(r.members.map(mapId))];
    if (r.bg && typeof r.bg === 'object' && Array.isArray(r.bg.results)) {
      out.bg = { ...r.bg, results: r.bg.results.map((x) => (x && typeof x === 'object' ? { ...x, memberId: mapId(x.memberId) } : x)) };
    }
    if (r.mm && typeof r.mm === 'object' && Array.isArray(r.mm.roles)) {
      out.mm = { ...r.mm, roles: r.mm.roles.map((x) => (x && typeof x === 'object' ? { ...x, memberId: mapId(x.memberId) } : x)) };
    }
    return out;
  };
  const records = data.records.filter((r) => mode === 'overwrite' || !r.id || !recIds.has(r.id)).map(remapRecord);
  const total = members.length + records.length;
  let done = 0, okN = 0, failN = 0;
  const tick = () => {
    done++;
    progress.textContent = `${done} / ${total}`;
    bar.style.width = `${total ? (done / total) * 100 : 100}%`;
  };

  for (const m of members) {
    if (cancelled) break;
    try {
      const res = await api.saveMember({ id: m.id, name: m.name, emoji: m.emoji || '', color: m.color, createdAt: m.createdAt });
      upsertMember(res.member);
      okN++;
    } catch (e) {
      failN++;
      if (['unauthorized', 'too_many_attempts', 'offline', 'network'].includes(e.code)) { cancelled = true; }
    }
    tick();
  }
  for (const r of records) {
    if (cancelled) break;
    const existing = r.id ? recordById(r.id) : null;
    const { updatedAt, ...rest } = r;
    try {
      let res;
      try {
        res = await api.saveRecord(rest, existing ? existing.updatedAt : null);
      } catch (e) {
        if (e.code === 'conflict' && e.data && e.data.current && mode === 'overwrite') {
          res = await api.saveRecord(rest, e.data.current.updatedAt || null);
        } else if (e.code === 'not_found') {
          // 이 기기엔 있지만 서버에선 지워진 기록 → 백업 내용으로 되살림
          res = await api.saveRecord(rest, null);
        } else if (e.code === 'conflict' && mode === 'add') {
          res = null; // 다른 기기에서 이미 추가됨 → 건너뜀
        } else throw e;
      }
      if (res && res.record) { upsertRecord(res.record); okN++; }
    } catch (e) {
      failN++;
      if (['unauthorized', 'too_many_attempts', 'offline', 'network', 'limit'].includes(e.code)) { cancelled = true; }
    }
    tick();
  }
  closeProgress(null);
  toast(`가져오기 완료: 성공 ${okN}${failN ? ` · 실패 ${failN}` : ''}${cancelled ? ' (중단됨)' : ''}`, failN ? 'error' : 'ok', 4500);
}

function render(root) {
  const st = statusInfo();
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-file', tabindex: '-1' });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    try { await importFlow(f); } catch { toast('가져오기 중 문제가 생겼어요', 'error'); }
  });

  const refreshBtn = h('button', {
    type: 'button', class: 'btn btn-soft btn-sm',
    onClick: async () => {
      if (!ctxRef) return;
      refreshBtn.disabled = true;
      try { await ctxRef.refresh(true); toast('최신 기록을 받아왔어요', 'ok'); } catch (e) { toast(api.errorMessage(e, '새로고침'), 'error'); }
      refreshBtn.disabled = false;
    },
  }, icon('refresh'), h('span', { text: '새로고침' }));

  const themeSeg = segmented({
    label: '테마', value: getTheme(),
    options: [{ key: 'system', label: '시스템' }, { key: 'light', label: '라이트' }, { key: 'dark', label: '다크' }],
    onChange: (v) => { setTheme(v); if (ctxRef) ctxRef.applyTheme(); },
  });

  root.replaceChildren(h('div', { class: 'page page-settings' },
    appBar({ title: '설정', back: '#/' }),
    h('section', { class: 'card set-sec' },
      h('h2', { class: 'set-title', text: '연결 상태' }),
      h('div', { class: `conn ${st.cls}` },
        h('span', { class: 'conn-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'conn-text' },
          h('p', { class: 'conn-label', text: st.label }),
          h('p', { class: 'conn-desc', text: st.desc }),
          h('p', { class: 'conn-meta', text: `기록 ${state.records.length}개 · 멤버 ${state.members.length}명${state.lastSync ? ` · ${relTime(state.lastSync)} 동기화` : ''}` })),
        refreshBtn)),
    h('section', { class: 'card set-sec' },
      h('h2', { class: 'set-title', text: '백업' }),
      h('p', { class: 'set-desc', text: '모든 기록과 멤버를 JSON 파일로 저장하거나, 백업 파일에서 다시 불러올 수 있어요.' }),
      h('div', { class: 'set-actions' },
        h('button', { type: 'button', class: 'btn btn-soft', onClick: exportData }, icon('download'), h('span', { text: '내보내기' })),
        // 진짜 버튼이어야 키보드(Tab)로도 닿음 — 숨긴 파일 입력을 대신 열어 줌
        h('button', { type: 'button', class: 'btn btn-soft', onClick: () => fileIn.click() }, icon('upload'), h('span', { text: '가져오기' })),
        fileIn)),
    h('section', { class: 'card set-sec' },
      h('h2', { class: 'set-title', text: '화면 테마' }),
      themeSeg),
    h('section', { class: 'card set-sec' },
      h('h2', { class: 'set-title', text: '이 기기' }),
      h('p', { class: 'set-desc', text: '입장 코드와 기기에 저장된 기록 사본을 지워요. 다시 들어오려면 공유 링크가 필요해요. 서버의 기록은 지워지지 않아요.' }),
      h('button', {
        type: 'button', class: 'btn btn-danger-soft btn-block',
        onClick: async () => {
          const ok = await confirmDialog('잠금 해제 정보를 지울까요?',
            '이 기기에서 입장 코드와 저장된 사본이 지워지고 잠금 화면으로 돌아가요. 공용·가족 기기라면 브라우저 방문 기록에서도 이 사이트를 지워 주세요 — 공유 링크에 코드가 들어 있어서 방문 기록·주소 자동완성에 남아 있을 수 있어요.',
            { ok: '지우기', danger: true });
          if (!ok) return;
          wipeLocal();
          if (ctxRef) ctxRef.lock('이 기기에서 잠금 해제 정보를 지웠어요');
        },
      }, icon('lock'), h('span', { text: '이 기기에서 잠금 해제 정보 지우기' }))),
    h('footer', { class: 'set-foot' },
      h('img', { src: '/icon-192.png', alt: '', width: '40', height: '40', class: 'set-logo' }),
      h('p', { text: `${APP_NAME} · v${APP_VERSION}` }),
      h('p', { class: 'muted small', text: '우리끼리만 보는 비공개 기록장이에요' }))));
}

export function mount(root, ctx) {
  ctxRef = ctx;
  render(root);
  return { update: () => render(root), destroy() { ctxRef = null; } };
}
