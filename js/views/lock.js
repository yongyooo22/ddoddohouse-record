// 잠금 화면 — 공유 링크(#k=…) 없이 들어왔거나 키가 무효일 때
import { h, icon } from '../dom.js';
import { APP_NAME } from '../constants.js';
import { errorMessage, isValidKeyFormat } from '../api.js';

/** 붙여넣은 값이 링크면 #k= / ?key= 에서 코드만 꺼냄 */
export function extractKey(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  const m = /[#&?]k(?:ey)?=([^&#\s]+)/.exec(v);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return v;
}

function standalone() {
  try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; }
}

export function mount(root, ctx) {
  const input = h('input', {
    type: 'password', id: 'lock-key', class: 'input input-lg', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: 'false', inputmode: 'text', enterkeyhint: 'go', placeholder: '입장 코드 또는 링크 붙여넣기',
  });
  const err = h('p', { class: 'lock-err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block btn-lg' }, icon('key'), h('span', { text: '열기' }));
  const show = h('button', { type: 'button', class: 'lock-show', 'aria-pressed': 'false', 'aria-label': '코드 보이기' }, icon('eye'));
  show.addEventListener('click', () => {
    const on = input.type === 'password';
    input.type = on ? 'text' : 'password';
    show.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  let busy = false;
  const form = h('form', { class: 'lock-form', novalidate: true },
    h('label', { class: 'field-label', htmlFor: 'lock-key', text: '입장 코드' }),
    h('div', { class: 'lock-input' }, input, show),
    btn, err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const key = extractKey(input.value);
    err.textContent = '';
    if (!key) { err.textContent = '코드를 입력해 주세요'; input.focus(); return; }
    if (!isValidKeyFormat(key)) { err.textContent = '코드 형식이 올바르지 않아요'; return; }
    busy = true;
    btn.disabled = true;
    btn.lastChild.textContent = '확인 중…';
    try {
      await ctx.unlock(key);
    } catch (ex) {
      err.textContent = errorMessage(ex, '연결');
      btn.disabled = false;
      btn.lastChild.textContent = '열기';
      busy = false;
    }
  });

  // 위(넓은 화면은 왼쪽)는 어두운 표지, 아래(오른쪽)는 입장 코드 칸
  const view = h('section', { class: 'lock' },
    h('div', { class: 'lock-paper' },
      h('div', { class: 'lock-brand' },
        h('span', { class: 'logo-mark lock-logo', 'aria-hidden': 'true' }, icon('logo')),
        h('p', { class: 'lock-kicker', text: '우리 모임의 놀이 일기' }),
        h('h1', { class: 'lock-title', text: APP_NAME }),
        h('p', { class: 'lock-desc', text: '공유받은 링크로 들어와 주세요' })),
      h('div', { class: 'lock-body' },
        ctx.message ? h('p', { class: 'lock-notice', role: 'status' }, icon('info'), h('span', { text: ctx.message })) : null,
        form,
        standalone() ? h('p', { class: 'lock-hint' }, icon('info'), h('span', { text: '홈 화면 앱은 브라우저와 저장 공간이 달라요. 공유받은 링크를 통째로 복사해 위 칸에 붙여넣어 주세요.' })) : null,
        h('p', { class: 'lock-hint' }, icon('lock'), h('span', { text: '코드는 이 기기에만 저장돼요. 다른 사람에게 링크를 보여주지 마세요. 공용 기기라면 시크릿(비공개) 창에서 코드를 붙여넣어 여세요.' })))));
  root.appendChild(view);
  setTimeout(() => { if (!ctx.message) input.focus({ preventScroll: true }); }, 50);
  return {};
}
