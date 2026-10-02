// 종류별 폼 섹션 (보드게임 / 머더미스터리 / 방탈출)
import { h, icon, append } from '../dom.js';
import { BG_MODES, MM_FORMATS, MM_OUTCOMES, MM_SCORES, ER_SCORES, LIMITS, CULPRIT_RESULTS, OWNERSHIPS } from '../constants.js';
import { memberInfo, state } from '../store.js';
import { norm } from '../format.js';
import { lenderOf } from '../stats.js';
import { segmented, chip, switchRow, stepper, ratingInput, avatar, field, nextId, stamp } from '../ui.js';

// ── 공용 입력 ──
export function textInput(value, { max, placeholder, onInput, list, id, inputmode, cls = '' } = {}) {
  const el = h('input', {
    type: 'text', class: `input ${cls}`, value: value || '', maxlength: max ? String(max) : null,
    placeholder, list, id, inputmode, autocomplete: 'off',
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

function needMembers() {
  return h('p', { class: 'fnote' }, icon('users'), h('span', { text: '함께한 멤버를 먼저 골라 주세요' }));
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

/** 빌려준 사람 후보: 예전에 적은 이름 + 멤버 이름 */
function lenderSuggestions() {
  const seen = new Set();
  const out = [];
  const add = (v) => {
    const k = norm(v);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  for (const r of state.records) add(lenderOf(r));
  for (const mb of state.members) add(mb.name);
  return out;
}

/** 소장 여부 (내 소장 · 빌림 · 미기록) + 빌렸으면 빌려준 사람 */
function ownershipFields(b, ctl) {
  const lenders = datalist(lenderSuggestions());
  const lenderField = field('빌려준 사람', textInput(b.lender, {
    max: LIMITS.lender, placeholder: '예) 영식 (선택)', list: lenders.id,
    onInput: (v) => { b.lender = v; ctl.changed(); },
  }));
  lenderField.hidden = b.ownership !== 'borrowed';
  const seg = segmented({
    label: '소장 여부', value: b.ownership || 'none', cls: 'seg-own',
    options: [...OWNERSHIPS, { key: 'none', label: '미기록' }],
    onChange: (v) => {
      b.ownership = v === 'none' ? null : v;
      lenderField.hidden = b.ownership !== 'borrowed';
      ctl.changed();
    },
  });
  return h('div', { class: 'own-fields' }, lenders.el,
    field('소장 여부', seg, { hint: '‘내 소장’으로 남긴 게임은 소장 탭에 모여요' }),
    lenderField);
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

export function bgSection(m, ctl) {
  const bg = m.bg;
  const box = h('div', { class: 'fsec-body' });

  const modeSeg = segmented({
    label: '게임 방식', value: bg.mode, options: BG_MODES,
    onChange: (v) => { bg.mode = v; ctl.changed(); ctl.rerender('type'); },
  });

  box.append(
    field('게임 방식', modeSeg),
    h('div', { class: 'grid-2' },
      field('장소', textInput(bg.place, { max: LIMITS.place, placeholder: '예) 또또하우스', onInput: (v) => { bg.place = v; ctl.changed(); } })),
      field('플레이 시간', numInput(bg.playTimeMin, { min: 0, max: 1440, placeholder: '0', unit: '분', label: '플레이 시간(분)', onInput: (v) => { bg.playTimeMin = v; ctl.changed(); } }))),
    field('확장판', textInput(bg.expansion, { max: LIMITS.expansion, placeholder: '사용한 확장판 (선택)', onInput: (v) => { bg.expansion = v; ctl.changed(); } })),
    ownershipFields(bg, ctl));

  if (bg.mode === 'coop') {
    box.append(subHead('협력 결과'),
      segmented({
        label: '협력 결과', value: bg.coopWin === true ? 'win' : bg.coopWin === false ? 'lose' : 'none',
        options: [{ key: 'win', label: '승리 🎉' }, { key: 'lose', label: '패배' }, { key: 'none', label: '미기록' }],
        onChange: (v) => { bg.coopWin = v === 'win' ? true : v === 'lose' ? false : null; ctl.changed(); },
      }));
    return box;
  }

  const rankSel = h('select', { class: 'select select-sm', 'aria-label': '순위 계산 방식' },
    [['high', '높은 점수가 1등'], ['low', '낮은 점수가 1등'], ['manual', '순위 직접 입력']].map(([v, l]) =>
      h('option', { value: v, selected: m.ui.rankMode === v }, l)));
  rankSel.addEventListener('change', () => {
    m.ui.rankMode = rankSel.value;
    m.ui.winnerManual = false;
    recalc();
    ctl.changed();
    ctl.rerender('type');
  });

  box.append(subHead(bg.mode === 'team' ? '팀전 결과' : '점수와 순위', rankSel));
  if (bg.mode === 'team') box.append(h('p', { class: 'fnote' }, icon('info'), h('span', { text: '이긴 팀 멤버에게 승리(왕관)를 표시해 주세요' })));

  if (!m.members.length) { box.append(needMembers()); return box; }

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
  function recalc() {
    recalcResults(bg, m.ui);
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
      recalc();
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

// ── 머더미스터리 ──
export function mmSection(m, ctl) {
  const mm = m.mm;
  const box = h('div', { class: 'fsec-body' });
  const pubs = datalist(distinct('murdermystery', (r) => r.mm.publisher));
  const stores = datalist(distinct('murdermystery', (r) => r.mm.store));

  const storeField = field('매장·지점', textInput(mm.store, { max: LIMITS.store, placeholder: '예) 강남점', list: stores.id, onInput: (v) => { mm.store = v; ctl.changed(); } }));
  storeField.hidden = mm.format !== 'store';
  // 소장 여부는 집에서 하는 보드게임형일 때만
  const ownField = ownershipFields(mm, ctl);
  ownField.hidden = mm.format !== 'box';

  const pc = numInput(mm.playerCount, { min: 1, max: 20, placeholder: String(m.members.length || ''), unit: '인', label: '인원', onInput: (v) => { mm.playerCount = v; m.ui.pcAuto = false; ctl.changed(); } });

  box.append(pubs.el, stores.el,
    field('제작사·브랜드', textInput(mm.publisher, { max: LIMITS.publisher, placeholder: '예) 머더랩', list: pubs.id, onInput: (v) => { mm.publisher = v; ctl.changed(); } })),
    field('형태', segmented({
      label: '형태', value: mm.format, options: MM_FORMATS,
      onChange: (v) => { mm.format = v; storeField.hidden = v !== 'store'; ownField.hidden = v !== 'box'; ctl.changed(); },
    })),
    storeField,
    ownField,
    h('div', { class: 'grid-3' },
      field('GM', textInput(mm.gm, { max: LIMITS.gm, placeholder: '선택', onInput: (v) => { mm.gm = v; ctl.changed(); } })),
      field('인원', pc),
      field('시간', numInput(mm.playTimeMin, { min: 0, max: 1440, placeholder: '0', unit: '분', label: '플레이 시간(분)', onInput: (v) => { mm.playTimeMin = v; ctl.changed(); } }))));

  // 역할
  box.append(subHead('맡은 역할'));
  if (!m.members.length) box.append(needMembers());
  else {
    box.append(h('ul', { class: 'role-rows' }, mm.roles.map((r) => {
      const info = memberInfo(r.memberId);
      const card = h('li', { class: `role-card${r.culprit ? ' is-culprit' : ''}` });
      return append(card, [
        h('div', { class: 'role-head' },
          avatar(info, 'sm'), h('span', { class: 'rr-name', text: info.name }),
          textInput(r.character, {
            max: LIMITS.character, placeholder: '맡은 캐릭터', cls: 'input-sm role-char-input',
            onInput: (v) => { r.character = v; ctl.changed(); },
          })),
        h('div', { class: 'role-opts' },
          chip({
            label: '범인', pressed: r.culprit, cls: 'chip-culprit', lead: icon('mask'),
            onToggle: (on) => { r.culprit = on; card.classList.toggle('is-culprit', on); ctl.changed(); },
          }),
          chip({ label: 'MVP', pressed: r.mvp, cls: 'chip-mvp', lead: icon('crown'), onToggle: (on) => { r.mvp = on; ctl.changed(); } }),
          segmented({
            label: `${info.name} 승패`, cls: 'seg-sm', value: r.outcome || 'none',
            options: [...MM_OUTCOMES, { key: 'none', label: '–' }],
            onChange: (v) => { r.outcome = v === 'none' ? null : v; ctl.changed(); },
          }))]);
    })));
  }

  append(box, [subHead('범인 검거'),
    segmented({
      label: '범인 검거 결과', value: mm.culpritResult || 'none',
      options: [...CULPRIT_RESULTS, { key: 'none', label: '미기록' }],
      onChange: (v) => { mm.culpritResult = v === 'none' ? null : v; ctl.changed(); },
    }),
    m.members.length ? h('p', { class: 'fhint', text: '멤버 중 범인이 있었다면 위 역할에서 ‘범인’을 눌러 표시해 주세요' }) : null]);

  // 난이도 게이지도 같은 목록 안에 둬서 구분선·간격을 맞춤
  const mmRows = scoreRows(mm.scores, MM_SCORES, ctl.changed);
  mmRows.append(gaugeRow('추리 난이도', mm.difficulty, (v) => { mm.difficulty = v; ctl.changed(); }));
  box.append(subHead('세부 평가'),
    mmRows,
    switchRow({ checked: !!mm.replay, label: '다시 하고 싶어요 · 추천해요', icon: 'heart', onChange: (v) => { mm.replay = v; ctl.changed(); } }));

  box.syncMembers = () => {
    if (m.ui.pcAuto) {
      const input = pc.querySelector('input');
      if (input) input.placeholder = String(m.members.length || '');
    }
  };
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

export function erSection(m, ctl) {
  const er = m.er;
  const box = h('div', { class: 'fsec-body' });
  const brands = datalist(distinct('escaperoom', (r) => r.er.brand));
  const branches = datalist(distinct('escaperoom', (r) => r.er.branch));
  const genres = datalist(distinct('escaperoom', (r) => r.er.genre));

  box.append(brands.el, branches.el, genres.el,
    h('div', { class: 'grid-2' },
      field('브랜드', textInput(er.brand, { max: LIMITS.brand, placeholder: '예) 키이스케이프', list: brands.id, onInput: (v) => { er.brand = v; ctl.changed(); } })),
      field('지점', textInput(er.branch, { max: LIMITS.branch, placeholder: '예) 홍대점', list: branches.id, onInput: (v) => { er.branch = v; ctl.changed(); } }))),
    h('div', { class: 'grid-3' },
      field('장르', textInput(er.genre, { max: LIMITS.genre, placeholder: '예) 추리', list: genres.id, onInput: (v) => { er.genre = v; ctl.changed(); } })),
      field('인원', numInput(er.playerCount, { min: 1, max: 10, placeholder: String(Math.min(10, m.members.length) || ''), unit: '인', label: '인원', onInput: (v) => { er.playerCount = v; m.ui.pcAuto = false; ctl.changed(); } })),
      field('제한', numInput(er.timeLimitMin, { min: 1, max: 300, placeholder: '60', unit: '분', label: '제한 시간(분)', onInput: (v) => { er.timeLimitMin = v; ctl.changed(); } }))));

  // 결과 도장
  const name = nextId('clear');
  const ord = h('p', { class: 'ordinal-note' });
  const paintOrd = () => { ord.textContent = `우리의 ${erOrdinalFor(m, ctl.editingId, ctl.createdAt)}번째 방탈출`; };
  paintOrd();
  box.paintOrdinal = paintOrd;

  const remain = h('div', { class: 'remain', hidden: er.cleared !== true });
  const choice = (key, label, kind) => {
    const id = `${name}-${key}`;
    const input = h('input', { type: 'radio', class: 'seg-input', name, id, value: key, checked: er.cleared === (key === 'yes') });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      er.cleared = key === 'yes';
      remain.hidden = !er.cleared;
      choices.removeAttribute('aria-invalid');
      ctl.changed();
    });
    return [input, h('label', { class: `stamp-choice stamp-choice-${kind}`, htmlFor: id }, stamp(label, kind, { tilt: false }))];
  };
  const choices = h('div', { class: 'stamp-choices', role: 'radiogroup', 'aria-label': '탈출 결과', 'data-field': 'er.cleared' });
  choices.append(...choice('yes', '탈출 성공', 'clear'), ...choice('no', '탈출 실패', 'fail'));
  box.append(subHead('탈출 결과'), ord, choices);

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
    h('div', { class: 'time-input' }, icon('clock'), mmIn, h('span', { class: 'time-colon', text: ':' }), ssIn,
      h('span', { class: 'fhint', text: '분 : 초' })));
  box.append(remain,
    field('사용한 힌트', stepper({ value: Number(er.hints) || 0, min: 0, max: 99, label: '힌트 수', unit: '개', onChange: (v) => { er.hints = v; ctl.changed(); } })));

  const erRows = scoreRows(er.scores, ER_SCORES, ctl.changed);
  erRows.append(
    gaugeRow('난이도', er.difficulty, (v) => { er.difficulty = v; ctl.changed(); }),
    gaugeRow('공포도', er.fear, (v) => { er.fear = v; ctl.changed(); }, '없음/미평가'),
    gaugeRow('활동성', er.activity, (v) => { er.activity = v; ctl.changed(); }));
  box.append(subHead('세부 평가'),
    erRows,
    switchRow({ checked: !!er.replay, label: '추천해요', icon: 'heart', onChange: (v) => { er.replay = v; ctl.changed(); } }));
  return box;
}
