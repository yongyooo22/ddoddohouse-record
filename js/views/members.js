// 멤버 목록 · 프로필 · 추가/수정 다이얼로그
import { h, icon } from '../dom.js';
import { PALETTE, EMOJI_SUGGESTIONS, LIMITS, TYPES, TYPE_KEYS } from '../constants.js';
import { state, membersSorted, memberInfo, upsertMember, removeMember, isFirstLoad, loadFailed, getMeId, setMeId } from '../store.js';
import { memberProfile, memberRoles } from '../stats.js';
import { fmtDate, fmtPct, norm, codePoints, fmtDateDot } from '../format.js';
import * as api from '../api.js';
import { navigate } from '../nav.js';
import { appBar, avatar, openDialog, confirmDialog, toast, emptyState, nextId, loadingState, loadErrorState, typeName, starsView } from '../ui.js';
import { recordCard } from './bits.js';

// ── 추가/수정 다이얼로그 ──
/** @returns {Promise<object|null>} 저장된 멤버 */
export async function openMemberEditor(member) {
  const isNew = !member;
  const used = new Set(state.members.map((m) => m.color));
  let color = member ? member.color : (PALETTE.find((p) => !used.has(p.key)) || PALETTE[0]).key;
  let saved = null;

  const nameIn = h('input', { type: 'text', class: 'input', maxlength: String(LIMITS.memberName), value: member ? member.name : '', placeholder: '이름 또는 별명', autocomplete: 'off', id: nextId('mname') });
  const emojiIn = h('input', { type: 'text', class: 'input input-emoji', value: member ? member.emoji || '' : '', placeholder: '🙂', autocomplete: 'off', 'aria-label': '이모지 (선택)', id: nextId('memoji') });
  const err = h('p', { class: 'form-err', role: 'alert' });
  const preview = h('span', { class: 'mprev' });

  function paintPreview() {
    const name = nameIn.value.trim() || '?';
    const em = emojiIn.value.trim();
    preview.replaceChildren(avatar({ name, emoji: em, color, missing: false }, 'xl'),
      h('span', { class: 'mprev-name', text: nameIn.value.trim() || '새 멤버' }));
  }
  nameIn.addEventListener('input', () => { err.textContent = ''; paintPreview(); });
  emojiIn.addEventListener('input', () => { err.textContent = ''; paintPreview(); });

  const emojiPicks = h('div', { class: 'emoji-picks', role: 'group', 'aria-label': '이모지 추천' },
    EMOJI_SUGGESTIONS.map((e) => h('button', { type: 'button', class: 'emoji-pick', 'aria-label': `${e} 고르기`, onClick: () => { emojiIn.value = e; paintPreview(); } }, e)),
    h('button', { type: 'button', class: 'emoji-pick emoji-clear', 'aria-label': '이모지 없애기', onClick: () => { emojiIn.value = ''; paintPreview(); } }, icon('x')));

  const gname = nextId('mcolor');
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': '색' },
    PALETTE.map((p) => {
      const id = `${gname}-${p.key}`;
      const input = h('input', { type: 'radio', class: 'seg-input', name: gname, id, value: p.key, checked: p.key === color });
      input.addEventListener('change', () => { if (input.checked) { color = p.key; paintPreview(); } });
      return [input, h('label', { class: `swatch mc-${p.key}`, htmlFor: id, title: p.label },
        h('span', { class: 'sr-only', text: p.label }), icon('check', 'swatch-check'))];
    }).flat());

  paintPreview();

  // 색을 이모지 목록보다 위에 둬서 시트 아래쪽 버튼 줄과 겹치지 않게
  const body = h('div', { class: 'mform' },
    preview,
    h('div', { class: 'field' }, h('label', { class: 'field-label', htmlFor: nameIn.id, text: '이름' }), nameIn),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: '색' }), swatches),
    h('div', { class: 'field' }, h('label', { class: 'field-label', htmlFor: emojiIn.id, text: '이모지 (선택)' }), h('div', { class: 'emoji-row' }, emojiIn), emojiPicks),
    err);

  const v = await openDialog({
    title: isNew ? '새 멤버' : '멤버 수정',
    body,
    cls: 'dlg-member',
    onOpen: () => { if (isNew) nameIn.focus(); },
    actions: [
      { label: '취소', value: null, kind: 'ghost' },
      {
        label: '저장', value: 'ok', kind: 'primary',
        handler: async () => {
          const name = nameIn.value.trim().replace(/\s+/g, ' ');
          const emoji = emojiIn.value.trim();
          if (!name) { err.textContent = '이름을 적어 주세요'; nameIn.focus(); return false; }
          if (codePoints(name).length > LIMITS.memberName) { err.textContent = `이름은 ${LIMITS.memberName}자까지예요`; return false; }
          if (codePoints(emoji).length > 4) { err.textContent = '이모지는 하나만 넣어 주세요'; emojiIn.focus(); return false; }
          if (state.members.some((m) => m.id !== (member && member.id) && norm(m.name) === norm(name))) {
            err.textContent = '같은 이름의 멤버가 이미 있어요'; nameIn.focus(); return false;
          }
          try {
            const res = await api.saveMember({ ...(member ? { id: member.id } : {}), name, emoji, color });
            saved = res.member;
            upsertMember(saved);
            toast(isNew ? `${saved.name} 님을 추가했어요` : '멤버 정보를 수정했어요', 'ok');
            return true;
          } catch (e) {
            if (e.code === 'invalid' && e.data && e.data.field === 'name') err.textContent = e.data.reason === 'duplicate' ? '같은 이름의 멤버가 이미 있어요' : '이름을 확인해 주세요';
            else if (e.code === 'invalid' && e.data && e.data.field === 'emoji') err.textContent = '이모지를 확인해 주세요 (최대 4글자)';
            else err.textContent = api.errorMessage(e);
            return false;
          }
        },
      },
    ],
  });
  return v === 'ok' ? saved : null;
}

// ── 나 고르기 ──
/**
 * 이 기기에서 '나'가 누구인지 고르는 창 (기기마다 저장). 멤버를 누르면 바로 정해지고, 새 멤버를 만들어 나로 정할 수도 있어요.
 * @returns {Promise<string|null>} 정한 멤버 id (취소하면 null)
 */
export async function pickMe() {
  let picked = null;
  let closeDlg = () => {};
  const mems = membersSorted();
  const cur = getMeId();
  const choose = (id) => { picked = id; setMeId(id); closeDlg('ok'); };
  const list = mems.length
    ? h('ul', { class: 'me-pick' }, mems.map((m) => h('li', {},
      h('button', { type: 'button', class: `me-pick-row${m.id === cur ? ' is-current' : ''}`, 'aria-pressed': m.id === cur ? 'true' : 'false', 'data-member-id': m.id, onClick: () => choose(m.id) },
        avatar(m.id, 'md'), h('span', { class: 'me-pick-name', text: m.name }), m.id === cur ? icon('check') : null))))
    : h('p', { class: 'muted small', text: '아직 멤버가 없어요. 아래에서 나를 먼저 등록해 주세요.' });
  const body = h('div', { class: 'me-pick-body' },
    h('p', { class: 'fhint', text: '이 기기에서 기록하는 사람이에요. 기록할 때 나로 자동 표시되고, 내 역할이 내 이름으로 저장돼요. 기기마다 한 번씩 정해요.' }),
    list);
  const v = await openDialog({
    title: '나는 누구인가요?',
    body,
    cls: 'dlg-me',
    bind: (c) => { closeDlg = c; },
    actions: [
      { label: '취소', value: null, kind: 'ghost' },
      ...(cur ? [{ label: '나 해제', value: 'clear', kind: 'ghost', handler: () => { setMeId(null); return true; } }] : []),
      { label: '새 멤버로 등록', value: 'new', kind: 'soft' },
    ],
  });
  if (v === 'new') {
    const saved = await openMemberEditor(null);
    if (saved) { setMeId(saved.id); picked = saved.id; }
  }
  return picked;
}

// ── 목록 ──
/** 이번 달 기록에서 멤버별로 함께한 횟수 (떠난 멤버 제외, 많은 순) */
function monthTopMembers(records, now = new Date()) {
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const counts = new Map();
  for (const r of records) {
    if (!r || String(r.date || '').slice(0, 7) !== ym) continue;
    for (const id of Array.isArray(r.members) ? r.members : []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([id]) => !memberInfo(id).missing)
    .sort((a, b) => b[1] - a[1])
    .map(([memberId, count]) => ({ memberId, count }));
}

/** 이번 달 가장 많이 함께한 멤버 (홈에서 옮겨 옴) */
function monthMateCard() {
  const tops = monthTopMembers(state.records);
  const label = h('p', { class: 'mate-label', text: '이번 달 가장 많이 함께한 멤버' });
  if (!tops.length) {
    return h('section', { class: 'card mate mate-empty' }, label,
      h('p', { class: 'muted', text: '이번 달 기록이 아직 없어요. 첫 기록을 남겨 볼까요?' }));
  }
  const best = tops[0];
  const ties = tops.filter((t) => t.count === best.count);
  const info = memberInfo(best.memberId);
  return h('section', { class: 'card mate' }, label,
    h('div', { class: 'mate-row' },
      h('a', { class: 'mate-main', href: `#/member/${encodeURIComponent(best.memberId)}` },
        avatar(info, 'lg'),
        h('span', { class: 'mate-text' },
          h('span', { class: 'mate-name', text: ties.length > 1 ? `${info.name} 외 ${ties.length - 1}명` : info.name }),
          h('span', { class: 'mate-count', text: `${best.count}번 함께했어요` }))),
      tops.length > 1
        ? h('ol', { class: 'mate-others', 'aria-label': '다음 순위' }, tops.slice(1, 4).map((t) =>
          h('li', { class: 'mate-other' }, avatar(t.memberId, 'xs'),
            h('span', { class: 'mate-other-name', text: memberInfo(t.memberId).name }),
            h('span', { class: 'mate-other-n', text: `${t.count}` }))))
        : null));
}

function memberCounts() {
  const counts = new Map();
  for (const r of state.records) {
    for (const id of Array.isArray(r.members) ? r.members : []) {
      const c = counts.get(id) || { n: 0, last: '' };
      c.n += 1;
      if (String(r.date || '') > c.last) c.last = String(r.date || '');
      counts.set(id, c);
    }
  }
  return counts;
}

function renderList(root, ctx) {
  const mems = membersSorted();
  const counts = memberCounts();
  // 아직 못 받았거나 못 받은 경우를 "멤버 없음"으로 보이지 않게
  const pending = !mems.length && isFirstLoad();
  const failed = !mems.length && loadFailed();
  const addBtn = h('button', {
    type: 'button', class: 'icon-btn icon-btn-soft head-add', 'aria-label': '멤버 추가',
    onClick: () => openMemberEditor(null),
  }, icon('plus'), h('span', { class: 'head-label', text: '멤버 추가' }));
  root.replaceChildren(h('div', { class: 'page page-members' },
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: '멤버' }), addBtn),
    mems.length
      ? h('p', { class: 'page-sub', text: `함께하는 사람 ${mems.length}명` })
      : null,
    mems.length ? monthMateCard() : null,
    mems.length
      ? h('ul', { class: 'mlist card' }, mems.map((m) => {
        const c = counts.get(m.id);
        return h('li', {},
          h('a', { class: 'mlist-row', href: `#/member/${encodeURIComponent(m.id)}` },
            avatar(m.id, 'md'),
            h('span', { class: 'mlist-text' },
              h('span', { class: 'mlist-name' }, h('span', { text: m.name }), m.id === getMeId() ? h('span', { class: 'me-badge', text: '나' }) : null),
              h('span', { class: 'mlist-sub', text: c ? `기록 ${c.n}개 · 최근 ${fmtDate(c.last, { weekday: false, year: false })}` : '아직 함께한 기록이 없어요' })),
            icon('chevron', 'mlist-go')));
      }))
      : pending ? loadingState('멤버를 불러오는 중…')
      : failed ? loadErrorState(ctx && ctx.refresh)
      : emptyState({
        icon: 'users', title: '아직 멤버가 없어요', text: '함께 노는 친구들을 등록해 두면 기록할 때 바로 고를 수 있어요.',
        action: h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openMemberEditor(null) }, icon('plus'), h('span', { text: '멤버 추가' })),
      })));
}

// ── 프로필 ──
function tile(type, main, sub) {
  const t = TYPES[type];
  return h('div', { class: `ptile ${t.cls}` },
    h('span', { class: 'ptile-ico', 'aria-hidden': 'true' }, icon(t.icon)),
    h('span', { class: 'ptile-label' }, typeName(type)),
    h('span', { class: 'ptile-main', text: main }),
    h('span', { class: 'ptile-sub', text: sub }));
}

function renderProfile(root, id, ctx) {
  const m = state.members.find((x) => x.id === id);
  if (!m) {
    root.replaceChildren(h('div', { class: 'page' }, appBar({ title: '멤버', back: '#/members' }),
      isFirstLoad() || (state.status === 'loading' && !state.members.length)
        ? loadingState('불러오는 중…')
        : loadFailed() ? loadErrorState(ctx && ctx.refresh)
        : emptyState({ icon: 'users', title: '멤버를 찾을 수 없어요', text: '삭제된 멤버예요. 기록에는 ‘(떠난 멤버)’로 남아 있어요.', action: h('a', { class: 'btn btn-soft', href: '#/members' }, '멤버 목록') })));
    return;
  }
  let p;
  try { p = memberProfile(state.records, id); } catch { p = null; }
  const byType = (p && p.byType) || {};
  const total = TYPE_KEYS.reduce((a, k) => a + (byType[k] || 0), 0);
  const bg = (p && p.bg) || { plays: 0, decided: 0, wins: 0 };
  const mm = (p && p.mm) || { plays: 0, culpritCount: 0 };
  const er = (p && p.er) || { plays: 0, cleared: 0 };

  async function onDelete() {
    const ok = await confirmDialog(`${m.name} 님을 삭제할까요?`, '멤버 목록에서만 사라지고, 지난 기록에는 ‘(떠난 멤버)’로 남아요.', { ok: '삭제', danger: true });
    if (!ok) return;
    try {
      await api.deleteMember(m.id);
      removeMember(m.id);
      toast('멤버를 삭제했어요', 'ok');
      navigate('#/members', { replace: true });
    } catch (e) {
      if (e.code === 'not_found') { removeMember(m.id); navigate('#/members', { replace: true }); }
      else toast(api.errorMessage(e, '삭제'), 'error');
    }
  }

  // 종류 비율 막대
  const ratio = h('div', { class: 'ratio', role: 'img', 'aria-label': TYPE_KEYS.map((k) => `${TYPES[k].label} ${byType[k] || 0}회`).join(', ') });
  for (const k of TYPE_KEYS) {
    const n = byType[k] || 0;
    if (!n) continue;
    const seg = h('span', { class: `ratio-seg ${TYPES[k].cls}` });
    seg.style.flexGrow = String(n);
    ratio.appendChild(seg);
  }

  const recent = (p && Array.isArray(p.recent)) ? p.recent : [];
  const isMe = getMeId() === m.id;
  // 맡았던 역할 (머더미스터리): 스포일러로 가린 기록은 역할을 보이지 않고 기록으로만 이어 줌
  let roles = [];
  try { roles = memberRoles(state.records, m.id, { includeMyRole: isMe }); } catch { roles = []; }
  const roleList = roles.length
    ? h('section', { class: 'card prole' },
      h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title', text: isMe ? '내가 맡았던 역할' : '맡았던 역할' }), h('span', { class: 'sec-sub', text: `${roles.length}개` })),
      h('ul', { class: 'prole-list' }, roles.slice(0, 10).map((x) => h('li', { class: 'prole-row' },
        h('a', { class: 'prole-link', href: `#/record/${encodeURIComponent(x.record.id)}` },
          h('span', { class: 'prole-role', text: x.hidden ? '가려진 역할' : x.character }),
          h('span', { class: 'prole-title', text: x.record.title || '(제목 없음)' }),
          h('span', { class: 'prole-meta' },
            h('span', { text: fmtDateDot(x.record.date) }),
            Number(x.record.rating) > 0 ? starsView(x.record.rating, { size: 'xs' }) : null))))),
      roles.length > 10 ? h('p', { class: 'muted small', text: `최근 10개만 보여요 (전체 ${roles.length}개)` }) : null)
    : null;
  const meBtn = h('button', {
    type: 'button', class: `btn btn-sm ${isMe ? 'btn-soft' : 'btn-ghost'} phero-me`, 'aria-pressed': isMe ? 'true' : 'false',
    onClick: () => { setMeId(isMe ? null : m.id); toast(isMe ? '이 기기의 나를 해제했어요' : `이 기기에서는 ${m.name} 님이 나예요`, 'ok'); },
  }, icon(isMe ? 'check' : 'users'), h('span', { text: isMe ? '이 기기의 나예요 (해제)' : '이 기기에서 나로 설정' }));
  root.replaceChildren(h('div', { class: 'page page-profile' },
    appBar({
      title: '멤버', back: '#/members',
      actions: [
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': '수정', onClick: () => openMemberEditor(m) }, icon('edit')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': '삭제', onClick: onDelete }, icon('trash')),
      ],
    }),
    h('section', { class: 'phero card' },
      avatar(memberInfo(m.id), 'xl'),
      h('h1', { class: 'phero-name' }, h('span', { text: m.name }), isMe ? h('span', { class: 'me-badge', text: '나' }) : null),
      h('p', { class: 'phero-sub', text: total ? `함께한 기록 ${total}개` : '아직 함께한 기록이 없어요' }),
      total ? ratio : null,
      meBtn),
    h('div', { class: 'ptiles' },
      tile('boardgame', `${byType.boardgame || 0}회`,
        bg.decided ? `${bg.wins}승 · 승률 ${fmtPct(bg.wins / bg.decided)}` : bg.plays ? '결과 기록 없음' : '기록 없음'),
      tile('murdermystery', `${byType.murdermystery || 0}회`,
        mm.plays ? `범인 ${mm.culpritCount}번${mm.mvpCount ? ` · MVP ${mm.mvpCount}번` : ''}` : '기록 없음'),
      tile('escaperoom', `${byType.escaperoom || 0}회`, er.plays ? `성공률 ${fmtPct(er.cleared / er.plays)}` : '기록 없음')),
    roleList,
    h('section', { class: 'home-recent' },
      h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title', text: '최근 함께한 기록' }),
        total ? h('a', { class: 'link-more', href: `#/records?member=${encodeURIComponent(m.id)}` }, '모두 보기', icon('chevron')) : null),
      recent.length
        ? h('div', { class: 'rlist' }, recent.map((r) => recordCard(r)))
        : h('p', { class: 'muted small pad', text: '기록에서 이 멤버를 고르면 여기에 모여요.' }))));
}

export function mount(root, ctx) {
  const id = ctx.params[0];
  const render = () => (id ? renderProfile(root, id, ctx) : renderList(root, ctx));
  render();
  return { update: render };
}
