// 입장(잠금) 화면 — 공유 링크(#k=…) 없이 들어왔거나 키가 무효일 때
// 담백한 티켓 한 장: 위는 제목, 반원 홈과 점선 아래는 입력
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

const ENTER = '기록장 들어가기';

export function mount(root, ctx) {
  const input = h('input', {
    type: 'password', id: 'lock-key', class: 'input lock-field', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: 'false', inputmode: 'text', enterkeyhint: 'go', placeholder: '코드 또는 링크 붙여넣기',
    'aria-describedby': 'lock-err',
  });
  // 오류 칸은 늘 그려 두고(비면 높이 0) 글자만 바꿈 — 스크린리더가 새 오류를 놓치지 않게
  const err = h('p', { class: 'lock-err', id: 'lock-err', role: 'alert' });
  const label = h('span', { text: ENTER });
  const btn = h('button', { type: 'submit', class: 'btn btn-block lock-go' }, label);
  const show = h('button', { type: 'button', class: 'lock-show', 'aria-pressed': 'false', 'aria-label': '코드 보이기' }, icon('eye'));
  show.addEventListener('click', () => {
    const on = input.type === 'password';
    input.type = on ? 'text' : 'password';
    show.setAttribute('aria-pressed', on ? 'true' : 'false');
    show.replaceChildren(icon(on ? 'eyeOff' : 'eye'));
  });

  /** 오류 표시. field: 입력값 문제면 칸을 빨갛게 하고 고치도록 칸으로 초점 */
  function showError(msg, field) {
    err.replaceChildren(icon('info'), h('span', { text: msg }));
    if (!field) return;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
  function clearError() {
    err.replaceChildren();
    input.removeAttribute('aria-invalid');
  }
  input.addEventListener('input', () => { if (err.firstChild) clearError(); });

  let busy = false;
  const form = h('form', { class: 'lock-form', novalidate: true },
    h('label', { class: 'lock-label', htmlFor: 'lock-key', text: '입장 코드 또는 초대 링크' }),
    h('div', { class: 'lock-input' }, input, show),
    err,
    btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const key = extractKey(input.value);
    clearError();
    if (!key) { showError('입장 코드나 초대 링크를 입력해 주세요.', true); return; }
    if (!isValidKeyFormat(key)) { showError('코드 형식이 올바르지 않아요. 받은 코드나 링크를 그대로 붙여넣어 주세요.', true); return; }
    busy = true;
    btn.disabled = true;
    label.textContent = '확인 중…';
    try {
      await ctx.unlock(key);
    } catch (ex) {
      const wrong = ex && ex.code === 'unauthorized';
      showError(wrong ? '입장 코드가 맞지 않아요. 코드나 초대 링크를 다시 확인해 주세요.' : errorMessage(ex, '연결'), wrong);
      btn.disabled = false;
      label.textContent = ENTER;
      busy = false;
    }
  });

  const view = h('section', { class: 'lock' },
    h('div', { class: 'lock-card' },
      h('header', { class: 'lock-head' },
        icon('ticket', 'lock-ico'),
        h('p', { class: 'lock-kicker', text: '우리 모임의 놀이 일기' }),
        h('h1', { class: 'lock-title', text: APP_NAME }),
        // 좁은 화면에서도 구절 단위로만 줄바꿈 ('입장 코드나 초대 링크를 / 입력해 주세요.')
        h('p', { class: 'lock-desc' }, h('span', { text: '입장 코드나 초대 링크를' }), ' ', h('span', { text: '입력해 주세요.' }))),
      // 티켓 절취선: 양옆 반원 홈 + 얇은 점선 하나
      h('div', { class: 'lock-perf', 'aria-hidden': 'true' }),
      h('div', { class: 'lock-body' },
        ctx.message ? h('p', { class: 'lock-notice', role: 'status' }, icon('info'), h('span', { text: ctx.message })) : null,
        form,
        h('div', { class: 'lock-foot' },
          standalone() ? h('p', { class: 'lock-hint' }, icon('info'), h('span', { text: '홈 화면 앱은 브라우저와 저장 공간이 달라요. 받은 초대 링크를 통째로 복사해 위 칸에 붙여넣어 주세요.' })) : null,
          h('p', { class: 'lock-hint' }, icon('lock'), h('span', { text: '입장 코드는 이 기기에 저장돼요.' })),
          h('details', { class: 'lock-more' },
            h('summary', { class: 'lock-more-sum' }, h('span', { class: 'lock-hint' }, icon('chevron'), h('span', { text: '공용 기기 이용 안내' }))),
            h('p', { class: 'lock-more-text', text: '입장 코드와 초대 링크는 다른 사람에게 전달하지 마세요. 공용 기기에서는 시크릿(비공개) 창을 이용해 주세요.' }))))));
  root.appendChild(view);
  setTimeout(() => { if (!ctx.message) input.focus({ preventScroll: true }); }, 50);
  return {};
}
