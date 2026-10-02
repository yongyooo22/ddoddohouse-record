// 기록 폼의 종류별 입력 — '결과'와 '자세한 정보' 영역 (보드게임 / 머더미스터리 / 방탈출)
// 공통 입력(종류·게임·날짜·별점·감상)은 form.js. 여기 값은 모두 폼 모델(m)에 바로 씀 (영역을 접어도 그대로)
import { h, icon, append } from '../dom.js';
import { BG_MODES, MM_FORMATS, MM_OUTCOMES, MM_SCORES, ER_SCORES, LIMITS, CULPRIT_RESULTS } from '../constants.js';
import { memberInfo, membersSorted, state } from '../store.js';
import { norm, fmtRemaining } from '../format.js';
import { segmented, chip, switchRow, stepper, ratingInput, avatar, field, nextId, stamp } from '../ui.js';

// ── 공용 입력 ──
export function textInput(value, { max, placeholder, onInput, list, id, inputmode, cls = '', label } = {}) {
  const el = h('input', {
    type: 'text', class: `input ${cls}`, value: value || '', maxlength: max ? String(max) : null,
    placeholder, list, id, inputmode, autocomplete: 'off', 'aria-label': label,
  });
  el.addEventListener('input', () => onInput && onInput(el.value));
  return el;
}

export function numInput(value, { min, max, placeholder, onInput, unit, label } = {}) {
  const el = h('input', {
    type: 'number', class: 'input input-num', inputmode: 'numeric', min: String(min), max: String(max),
    value: value === null || value === undefined ? '' : String(value), placeholder, 'aria-label': label,
  });
  el.addEventListener('input', () => {
    el.removeAttribute('aria-invalid'); // 고치면 오류 표시도 바로 지움
    if (onInput) onInput(el.value === '' ? '' : el.value);
  });
  return unit ? h('div', { class: 'input-unit' }, el, h('span', { class: 'unit', text: unit })) : el;
}

/** 이전 기록에서 뽑은 값 목록 (datalist) */
export function datalist(values) {
  const id = nextId('dl');
  return { id, el: h('datalist', { id }, values.slice(0, 50).map((v) => h('option', { value: v }))) };
}

export function distinct(type, getter) {
  const seen = new Set();
  const out = [];
  for (const r of state.records) {
    if (r.type !== type) continue;
    let v;
    try { v = getter(r); } catch { v = ''; }
    if (!v || typeof v !== 'string') continue;
    const k = norm(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function subHead(text, extra) {
  return h('div', { class: 'fsub-head' }, h('h3', { class: 'fsub-title', text }), extra || null);
}

function scoreRows(obj, defs, onChange) {
  return h('div', { class: 'score-rows' }, defs.map((d) =>
    h('div', { class: 'score-row' },
      h('span', { class: 'score-label', text: d.label }),
      ratingInput({ value: obj[d.key], size: 'sm', label: d.label, onChange: (v) => { obj[d.key] = v; onChange(); } }))));
}

function gaugeRow(label, value, onChange, hint) {
  return h('div', { class: 'score-row' },
    h('span', { class: 'score-label', text: label }),
    ratingInput({ value, size: 'sm', kind: 'dot', label, onChange, hint }));
}

/**
 * 사람 고르기 칩 (함께한 사람 영역 · 결과 영역에서 같은 목록을 씀) + 새 멤버 바로 등록.
 * ctl.toggleMember(id, on, origin) · ctl.addMember(origin)
 */
export function memberChips(m, ctl, origin, { label = '함께한 사람' } = {}) {
  const mems = membersSorted();
  const known = new Set(mems.map((x) => x.id));
  const gone = m.members.filter((id) => !known.has(id));
  const one = (id, name, gone2) => {
    const c = chip({
      label: name, pressed: m.members.includes(id), cls: `chip-member${gone2 ? ' is-gone' : ''}`, lead: avatar(id, 'xs'),
      onToggle: (on) => ctl.toggleMember(id, on, origin),
    });
    c.dataset.memberId = id;
    return c;
  };
  return h('div', { class: 'chips chips-members', role: 'group', 'aria-label': label },
    mems.map((mb) => one(mb.id, mb.name, false)),
    gone.map((id) => one(id, memberInfo(id).name, true)),
    h('button', { type: 'button', class: 'chip chip-add', onClick: () => ctl.addMember(origin) },
      icon('plus'), h('span', { class: 'chip-label', text: '새 멤버' })));
}

// ── 보드게임 ──
/** 점수 → 순위, (직접 고치지 않았다면) 1등 → 승자. 멤버를 더하거나 뺄 때도 같은 규칙으로 */
export function recalcResults(bg, ui) {
  computeRanks(bg, ui.rankMode);
  if (ui.rankMode !== 'manual' && !ui.winnerManual) {
    const any = bg.results.some((r) => r.rank);
    for (const r of bg.results) r.winner = any && r.rank === 1;
  }
}

export function computeRanks(bg, rankMode) {
  if (rankMode === 'manual') return;
  const rs = bg.results;
  const scored = rs.filter((r) => r.score !== null && r.score !== '' && Number.isFinite(Number(r.score)));
  for (const r of rs) {
    if (!scored.includes(r)) { r.rank = null; continue; }
    const s = Number(r.score);
    const better = scored.filter((o) => (rankMode === 'low' ? Number(o.score) < s : Number(o.score) > s)).length;
    r.rank = Math.min(20, better + 1);
  }
}

/** 결과: 게임 방식(결과를 읽는 데 필요) · 참여자 · 점수·순위·승자 또는 협력 성공 여부 */
function bgResult(m, ctl) {
  const bg = m.bg;
  const box = h('div', { class: 'rp-fields' });
  box.append(field('게임 방식', segmented({
    label: '게임 방식', value: bg.mode, options: BG_MODES,
    onChange: (v) => { bg.mode = v; ctl.changed(); ctl.rerender('result'); },
  })));

  if (bg.mode === 'coop') {
    box.append(field('협력 결과', segmented({
      label: '협력 결과', value: bg.coopWin === true ? 'win' : bg.coopWin === false ? 'lose' : 'none',
      options: [{ key: 'win', label: '성공' }, { key: 'lose', label: '실패' }, { key: 'none', label: '미기록' }],
      onChange: (v) => { bg.coopWin = v === 'win' ? true : v === 'lose' ? false : null; ctl.changed(); },
    })));
    return box;
  }

  box.append(field('참여자', memberChips(m, ctl, 'result', { label: '참여자' })));

  const rankSel = h('select', { class: 'select select-sm', 'aria-label': '순위 계산 방식' },
    [['high', '높은 점수가 1등'], ['low', '낮은 점수가 1등'], ['manual', '순위 직접 입력']].map(([v, l]) =>
      h('option', { value: v, selected: m.ui.rankMode === v }, l)));
  rankSel.addEventListener('change', () => {
    m.ui.rankMode = rankSel.value;
    m.ui.winnerManual = false;
    recalcResults(bg, m.ui);
    ctl.changed();
    ctl.rerender('result');
  });

  box.append(subHead(bg.mode === 'team' ? '팀전 결과' : '점수와 순위', m.members.length ? rankSel : null));
  if (!m.members.length) {
    box.append(h('p', { class: 'fhint', text: '참여자를 고르면 점수와 순위를 적을 수 있어요' }));
    return box;
  }
  if (bg.mode === 'team') box.append(h('p', { class: 'fhint', text: '이긴 팀 멤버에게 왕관을 표시해 주세요' }));

  const refs = [];
  function paintRows() {
    refs.forEach(({ r, rankEl, winBtn }) => {
      if (rankEl.tagName === 'SPAN') {
        rankEl.textContent = r.rank ? `${r.rank}등` : '–';
        rankEl.classList.toggle('is-first', r.rank === 1);
      }
      winBtn.setAttribute('aria-pressed', r.winner ? 'true' : 'false');
    });
  }

  const rows = h('ul', { class: 'result-rows' });
  for (const r of bg.results) {
    const info = memberInfo(r.memberId);
    const score = h('input', {
      type: 'number', step: 'any', class: 'input input-score', value: r.score === null || r.score === undefined ? '' : String(r.score),
      placeholder: '점수', 'aria-label': `${info.name} 점수`,
    });
    score.addEventListener('input', () => {
      r.score = score.value === '' ? null : Number(score.value);
      recalcResults(bg, m.ui);
      paintRows();
      ctl.changed();
    });
    let rankEl;
    if (m.ui.rankMode === 'manual') {
      rankEl = h('select', { class: 'select select-rank', 'aria-label': `${info.name} 순위` },
        h('option', { value: '', selected: !r.rank }, '–'),
        Array.from({ length: Math.max(bg.results.length, 1) }, (_, i) => h('option', { value: String(i + 1), selected: r.rank === i + 1 }, `${i + 1}등`)));
      rankEl.addEventListener('change', () => { r.rank = rankEl.value ? Number(rankEl.value) : null; ctl.changed(); });
    } else {
      rankEl = h('span', { class: 'rank-badge', 'aria-label': `${info.name} 순위` });
    }
    const winBtn = h('button', { type: 'button', class: 'win-toggle', 'aria-pressed': r.winner ? 'true' : 'false', 'aria-label': `${info.name} 승리` }, icon('crown'));
    winBtn.addEventListener('click', () => {
      r.winner = !r.winner;
      m.ui.winnerManual = true;
      paintRows();
      ctl.changed();
    });
    refs.push({ r, rankEl, winBtn });
    rows.append(h('li', { class: 'result-row' },
      h('span', { class: 'rr-who' }, avatar(info, 'sm'), h('span', { class: 'rr-name', text: info.name })),
      score, rankEl, winBtn));
  }
  paintRows();
  box.append(rows);
  return box;
}

/** 자세한 정보: 그날의 장소 · 실제 플레이 시간 · 사용한 확장판 (게임의 예상 시간과 별개) */
function bgDetails(m, ctl) {
  const bg = m.bg;
  return h('div', { class: 'rp-fields' },
    h('div', { class: 'grid-2' },
      field('장소', textInput(bg.place, { max: LIMITS.place, placeholder: '예) 또또하우스', onInput: (v) => { bg.place = v; ctl.changed(); } })),
      field('플레이 시간', numInput(bg.playTimeMin, { min: 0, max: 1440, placeholder: '실제', unit: '분', label: '플레이 시간(분)', onInput: (v) => { bg.playTimeMin = v; ctl.changed(); } }))),
    field('사용한 확장판', textInput(bg.expansion, { max: LIMITS.expansion, placeholder: '예) 서곡', onInput: (v) => { bg.expansion = v; ctl.changed(); } })));
}

// ── 머더미스터리 ──
/** 결과: 참여자 · 맡은 역할(캐릭터·범인·MVP·승패) · 범인 검거 · 역할 가리기 */
function mmResult(m, ctl) {
  const mm = m.mm;
  const box = h('div', { class: 'rp-fields' });
  box.append(field('참여자', memberChips(m, ctl, 'result', { label: '참여자' })));
  box.append(subHead('맡은 역할'));
  if (!m.members.length) box.append(h('p', { class: 'fhint', text: '참여자를 고르면 역할을 적을 수 있어요' }));
  else {
    box.append(h('ul', { class: 'role-rows' }, mm.roles.map((r) => {
      const info = memberInfo(r.memberId);
      const card = h('li', { class: `role-card${r.culprit ? ' is-culprit' : ''}` });
      return append(card, [
        h('div', { class: 'role-head' },
          avatar(info, 'sm'), h('span', { class: 'rr-name', text: info.name }),
          textInput(r.character, {
            max: LIMITS.character, placeholder: '맡은 역할', cls: 'input-sm role-char-input', label: `${info.name} 역할`,
            onInput: (v) => { r.character = v; ctl.changed(); },
          })),
        h('div', { class: 'role-opts' },
          chip({
            label: '범인', pressed: r.culprit, cls: 'chip-culprit chip-sm', lead: icon('mask'),
            onToggle: (on) => { r.culprit = on; card.classList.toggle('is-culprit', on); ctl.changed(); },
          }),
          chip({ label: 'MVP', pressed: r.mvp, cls: 'chip-mvp chip-sm', lead: icon('crown'), onToggle: (on) => { r.mvp = on; ctl.changed(); } }),
          segmented({
            label: `${info.name} 승패`, cls: 'seg-sm', value: r.outcome || 'none',
            options: [...MM_OUTCOMES, { key: 'none', label: '–' }],
            onChange: (v) => { r.outcome = v === 'none' ? null : v; ctl.changed(); },
          }))]);
    })));
  }
  box.append(field('범인 검거', segmented({
    label: '범인 검거 결과', value: mm.culpritResult || 'none',
    options: [...CULPRIT_RESULTS, { key: 'none', label: '미기록' }],
    onChange: (v) => { mm.culpritResult = v === 'none' ? null : v; ctl.changed(); },
  })));
  box.append(miniCheck('역할·범인 가리기', !!mm.roleSpoiler, (v) => { mm.roleSpoiler = v; ctl.changed(); },
    '목록과 상세에서 누가 어떤 역할·범인이었는지 열기 전까지 가려요'));
  return box;
}

/** 자세한 정보: 형태 · 매장 · 제작사 · GM · 인원 · 시간 · 세부 평가 */
function mmDetails(m, ctl) {
  const mm = m.mm;
  const box = h('div', { class: 'rp-fields' });
  const pubs = datalist(distinct('murdermystery', (r) => r.mm.publisher));
  const stores = datalist(distinct('murdermystery', (r) => r.mm.store));
  const storeField = field('매장·지점', textInput(mm.store, { max: LIMITS.store, placeholder: '예) 강남점', list: stores.id, onInput: (v) => { mm.store = v; ctl.changed(); } }));
  storeField.hidden = mm.format !== 'store';
  const pc = numInput(mm.playerCount, { min: 1, max: 20, placeholder: String(m.members.length || ''), unit: '인', label: '인원', onInput: (v) => { mm.playerCount = v; m.ui.pcAuto = false; ctl.changed(); } });
  box.append(pubs.el, stores.el,
    field('형태', segmented({
      label: '형태', value: mm.format, options: MM_FORMATS,
      onChange: (v) => { mm.format = v; storeField.hidden = v !== 'store'; ctl.changed(); },
    })),
    storeField,
    field('제작사·브랜드', textInput(mm.publisher, { max: LIMITS.publisher, placeholder: '예) 머더랩', list: pubs.id, onInput: (v) => { mm.publisher = v; ctl.changed(); } })),
    h('div', { class: 'grid-3' },
      field('GM', textInput(mm.gm, { max: LIMITS.gm, placeholder: '선택', onInput: (v) => { mm.gm = v; ctl.changed(); } })),
      field('인원', pc),
      field('시간', numInput(mm.playTimeMin, { min: 0, max: 1440, placeholder: '실제', unit: '분', label: '플레이 시간(분)', onInput: (v) => { mm.playTimeMin = v; ctl.changed(); } }))));
  const rows = scoreRows(mm.scores, MM_SCORES, ctl.changed);
  rows.append(gaugeRow('추리 난이도', mm.difficulty, (v) => { mm.difficulty = v; ctl.changed(); }));
  box.append(subHead('세부 평가'), rows,
    switchRow({ checked: !!mm.replay, label: '다시 하고 싶어요 · 추천해요', icon: 'heart', onChange: (v) => { mm.replay = v; ctl.changed(); } }));
  return box;
}

// ── 방탈출 ──
export function erOrdinalFor(m, editingId, createdAt) {
  let n = 1;
  for (const r of state.records) {
    if (r.type !== 'escaperoom' || r.id === editingId) continue;
    const d = String(r.date || '');
    if (d < m.date) n++;
    else if (d === m.date) {
      if (!editingId || String(r.createdAt || '') < String(createdAt || '')) n++;
    }
  }
  return n;
}

/** 결과: 매장·지점 · 탈출 성공 여부 · 남은 시간 · 힌트 수 */
function erResult(m, ctl) {
  const er = m.er;
  const box = h('div', { class: 'rp-fields' });
  const brands = datalist(distinct('escaperoom', (r) => r.er.brand));
  const branches = datalist(distinct('escaperoom', (r) => r.er.branch));
  box.append(brands.el, branches.el,
    h('div', { class: 'grid-2' },
      field('매장', textInput(er.brand, { max: LIMITS.brand, placeholder: '예) 키이스케이프', list: brands.id, label: '매장(브랜드)', onInput: (v) => { er.brand = v; ctl.changed(); } })),
      field('지점', textInput(er.branch, { max: LIMITS.branch, placeholder: '예) 홍대점', list: branches.id, label: '지점', onInput: (v) => { er.branch = v; ctl.changed(); } }))));

  const name = nextId('clear');
  const ord = h('p', { class: 'ordinal-note' });
  const paintOrd = () => { ord.textContent = `우리의 ${erOrdinalFor(m, ctl.editingId, ctl.createdAt)}번째 방탈출`; };
  paintOrd();
  box.paintOrdinal = paintOrd;

  const remain = h('div', { class: 'remain', hidden: er.cleared !== true });
  const clearBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm stamp-reset', hidden: er.cleared === null }, '선택 지우기');
  const inputs = [];
  const choice = (key, label, kind) => {
    const id = `${name}-${key}`;
    const input = h('input', { type: 'radio', class: 'seg-input', name, id, value: key, checked: er.cleared === (key === 'yes') });
    inputs.push(input);
    input.addEventListener('change', () => {
      if (!input.checked) return;
      er.cleared = key === 'yes';
      remain.hidden = !er.cleared;
      clearBtn.hidden = false;
      ctl.changed();
    });
    return [input, h('label', { class: `stamp-choice stamp-choice-${kind}`, htmlFor: id }, stamp(label, kind, { tilt: false }))];
  };
  const choices = h('div', { class: 'stamp-choices', role: 'radiogroup', 'aria-label': '탈출 결과', 'data-field': 'er.cleared' });
  choices.append(...choice('yes', '탈출 성공', 'clear'), ...choice('no', '탈출 실패', 'fail'));
  clearBtn.addEventListener('click', () => {
    er.cleared = null;
    for (const i of inputs) i.checked = false;
    remain.hidden = true;
    clearBtn.hidden = true;
    ctl.changed();
  });
  box.append(h('div', { class: 'fsub-head' }, h('h3', { class: 'fsub-title', text: '탈출 결과' }), clearBtn), ord, choices);

  // 남은 시간 mm:ss
  const mmIn = h('input', { type: 'number', inputmode: 'numeric', class: 'input input-time', min: '0', max: '300', placeholder: '00', 'aria-label': '남은 시간 분', value: m.ui.remainMM || '', 'data-field': 'er.remainingSec' });
  const ssIn = h('input', { type: 'number', inputmode: 'numeric', class: 'input input-time', min: '0', max: '59', placeholder: '00', 'aria-label': '남은 시간 초', value: m.ui.remainSS || '' });
  const updRemain = () => {
    m.ui.remainMM = mmIn.value;
    m.ui.remainSS = ssIn.value;
    mmIn.removeAttribute('aria-invalid');
    ctl.changed();
  };
  mmIn.addEventListener('input', updRemain);
  ssIn.addEventListener('input', updRemain);
  ssIn.addEventListener('blur', () => { if (ssIn.value !== '' && ssIn.value.length === 1) ssIn.value = ssIn.value.padStart(2, '0'); });
  remain.append(h('span', { class: 'field-label', text: '남은 시간' }),
    h('div', { class: 'time-input' }, mmIn, h('span', { class: 'time-colon', text: ':' }), ssIn,
      h('span', { class: 'fhint', text: '분 : 초' })));
  box.append(remain,
    field('사용한 힌트', stepper({ value: er.hints, min: 0, max: 99, label: '힌트 수', unit: '개', onChange: (v) => { er.hints = v; ctl.changed(); } })));
  return box;
}

/** 자세한 정보: 장르 · 인원 · 제한 시간 · 세부 평가 */
function erDetails(m, ctl) {
  const er = m.er;
  const genres = datalist(distinct('escaperoom', (r) => r.er.genre));
  const rows = scoreRows(er.scores, ER_SCORES, ctl.changed);
  rows.append(
    gaugeRow('난이도', er.difficulty, (v) => { er.difficulty = v; ctl.changed(); }),
    gaugeRow('공포도', er.fear, (v) => { er.fear = v; ctl.changed(); }, '없음/미평가'),
    gaugeRow('활동성', er.activity, (v) => { er.activity = v; ctl.changed(); }));
  return h('div', { class: 'rp-fields' }, genres.el,
    h('div', { class: 'grid-3' },
      field('장르', textInput(er.genre, { max: LIMITS.genre, placeholder: '예) 추리', list: genres.id, onInput: (v) => { er.genre = v; ctl.changed(); } })),
      field('인원', numInput(er.playerCount, { min: 1, max: 10, placeholder: String(Math.min(10, m.members.length) || ''), unit: '인', label: '인원', onInput: (v) => { er.playerCount = v; m.ui.pcAuto = false; ctl.changed(); } })),
      field('제한', numInput(er.timeLimitMin, { min: 1, max: 300, placeholder: '60', unit: '분', label: '제한 시간(분)', onInput: (v) => { er.timeLimitMin = v; ctl.changed(); } }))),
    subHead('세부 평가'), rows,
    switchRow({ checked: !!er.replay, label: '추천해요', icon: 'heart', onChange: (v) => { er.replay = v; ctl.changed(); } }));
}

/** 작은 체크 (스포일러 가리기 등) */
export function miniCheck(label, checked, onChange, title) {
  const input = h('input', { type: 'checkbox', class: 'mini-check-input', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'mini-check', title }, input, h('span', { class: 'mini-check-box', 'aria-hidden': 'true' }, icon('check')), h('span', { text: label }));
}

export function resultSection(m, ctl) {
  return m.type === 'boardgame' ? bgResult(m, ctl) : m.type === 'murdermystery' ? mmResult(m, ctl) : erResult(m, ctl);
}

export function detailSection(m, ctl) {
  return m.type === 'boardgame' ? bgDetails(m, ctl) : m.type === 'murdermystery' ? mmDetails(m, ctl) : erDetails(m, ctl);
}

// ── 접힌 영역의 요약 (버튼에 보여 줌. 빈 문자열 = 입력한 것 없음) ──
const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const names = (ids) => ids.map((id) => memberInfo(id).name);

export function resultSummary(m) {
  if (m.type === 'boardgame') {
    const bg = m.bg;
    if (bg.mode === 'coop') return bg.coopWin === true ? '협력 성공' : bg.coopWin === false ? '협력 실패' : '';
    const winners = names(bg.results.filter((r) => r.winner && m.members.includes(r.memberId)).map((r) => r.memberId));
    if (winners.length) return `${winners.slice(0, 2).join('·')}${winners.length > 2 ? ` 외 ${winners.length - 2}` : ''} ${bg.mode === 'team' ? '승리' : '우승'}`;
    const scored = bg.results.filter((r) => filled(r.score) || r.rank).length;
    return scored ? `점수 ${scored}명` : '';
  }
  if (m.type === 'murdermystery') {
    const mm = m.mm;
    const parts = [];
    const cr = CULPRIT_RESULTS.find((c) => c.key === mm.culpritResult);
    if (cr) parts.push(cr.label);
    const roles = mm.roles.filter((r) => m.members.includes(r.memberId) && (r.character.trim() || r.culprit || r.mvp || r.outcome)).length;
    if (roles) parts.push(`역할 ${roles}명`);
    return parts.join(' · ');
  }
  const er = m.er;
  const parts = [];
  if (er.cleared === true) {
    parts.push('탈출 성공');
    const sec = m.ui.remainMM !== '' || m.ui.remainSS !== '' ? (Number(m.ui.remainMM) || 0) * 60 + (Number(m.ui.remainSS) || 0) : null;
    if (sec !== null) parts.push(`${fmtRemaining(sec)} 남음`);
  } else if (er.cleared === false) parts.push('탈출 실패');
  if (filled(er.hints)) parts.push(`힌트 ${er.hints}`);
  if (!parts.length && (filled(er.brand) || filled(er.branch))) parts.push([er.brand, er.branch].filter(filled).join(' '));
  return parts.join(' · ');
}

export function detailSummary(m) {
  const parts = [];
  if (m.type === 'boardgame') {
    const bg = m.bg;
    if (filled(bg.place)) parts.push(bg.place.trim());
    if (filled(bg.playTimeMin) && Number(bg.playTimeMin) > 0) parts.push(`${Number(bg.playTimeMin)}분`);
    if (filled(bg.expansion)) parts.push(bg.expansion.trim());
  } else if (m.type === 'murdermystery') {
    const mm = m.mm;
    if (filled(mm.publisher)) parts.push(mm.publisher.trim());
    if (mm.format === 'store' && filled(mm.store)) parts.push(mm.store.trim());
    if (filled(mm.gm)) parts.push(`GM ${mm.gm.trim()}`);
    if (filled(mm.playTimeMin) && Number(mm.playTimeMin) > 0) parts.push(`${Number(mm.playTimeMin)}분`);
    if (MM_SCORES.some((s) => Number(mm.scores[s.key]) > 0) || mm.difficulty > 0) parts.push('세부 평가');
    if (mm.replay) parts.push('추천');
  } else {
    const er = m.er;
    if (filled(er.genre)) parts.push(er.genre.trim());
    if (filled(er.timeLimitMin)) parts.push(`제한 ${er.timeLimitMin}분`);
    if (ER_SCORES.some((s) => Number(er.scores[s.key]) > 0) || er.difficulty > 0 || er.fear > 0 || er.activity > 0) parts.push('세부 평가');
    if (er.replay) parts.push('추천');
  }
  return parts.length > 3 ? `${parts.slice(0, 3).join(' · ')} 외 ${parts.length - 3}` : parts.join(' · ');
}
