// 작품 정보 수정 — 제목·장르·매장·지점·표지, 다른 작품과 합치기, 작품 지우기
// (날짜별 플레이 기록은 각 기록의 '수정'에서)
import { h, icon } from '../dom.js';
import * as repo from '../repo.js';
import { GENRES, GENRE_KEYS, LIMITS } from '../constants.js';
import { workLabel } from '../model.js';
import { sameTitleWorks } from '../query.js';
import { fmtDate } from '../format.js';
import { navigate, goBack } from '../nav.js';
import { appBar, field, setFieldError, counterFor, segmented, toast, confirmDialog, choiceSheet, emptyState } from '../ui.js';
import { photoField } from './photos.js';

export function mount(root, ctx) {
  const work = repo.getWork(ctx.params[0]);
  if (!work) {
    root.append(appBar({ title: '작품 정보 수정', back: '#/' }), h('div', { class: 'container narrow' },
      emptyState({ icon: 'stack', title: '작품을 찾을 수 없어요', actions: [h('a', { class: 'btn btn-ghost', href: '#/' }, '처음 화면으로')] })));
    return {};
  }
  const m = { genre: work.genre, title: work.title, store: work.store || '', branch: work.branch || '', cover: work.cover || null };
  const added = new Set();
  let saved = false;
  const fields = {};
  const back = `#/work/${encodeURIComponent(work.id)}`;
  const count = repo.playsOfWork(work.id).length;

  const genreSeg = segmented({
    options: GENRE_KEYS.map((k) => ({ key: k, label: GENRES[k].label, icon: GENRES[k].icon, cls: GENRES[k].cls })),
    value: m.genre, label: '장르', cls: 'seg-genre',
    onChange: (g) => { m.genre = g; sync(); },
  });
  fields.genre = field('장르', genreSeg);

  const title = h('input', { type: 'text', class: 'input input-title', value: m.title, autocomplete: 'off' });
  title.maxLength = LIMITS.title * 2;
  title.addEventListener('input', () => { m.title = title.value; setFieldError(fields.title, ''); });
  fields.title = field('제목', title, { counter: counterFor(title, LIMITS.title) });

  const store = h('input', { type: 'text', class: 'input', value: m.store, placeholder: '예) 달빛방탈출', autocomplete: 'off', 'aria-label': '매장' });
  const branch = h('input', { type: 'text', class: 'input', value: m.branch, placeholder: '예) 강남점', autocomplete: 'off', 'aria-label': '지점' });
  store.addEventListener('input', () => { m.store = store.value; });
  branch.addEventListener('input', () => { m.branch = branch.value; });
  fields.store = h('div', { class: 'field field-place' },
    h('div', { class: 'field-head' }, h('span', { class: 'field-label' }, '매장 · 지점', h('span', { class: 'field-opt', text: ' 선택' }))),
    h('div', { class: 'two' }, store, branch),
    h('p', { class: 'field-hint', text: '같은 테마명이라도 매장·지점이 다르면 다른 작품이에요.' }),
    h('p', { class: 'field-error', role: 'alert', hidden: true }));
  fields.branch = fields.store;

  const cover = photoField({
    ids: m.cover ? [m.cover] : [], max: 1, label: '표지',
    onChange: (ids) => { m.cover = ids[0] || null; },
    onAdded: (id) => added.add(id),
  });
  fields.cover = field('작품 표지', cover, { optional: true, hint: '그날 사진이 없는 기록의 카드에 이 표지가 보여요 (예: 게임 상자, 테마 포스터).' });

  function sync() {
    const g = GENRES[m.genre];
    fields.title.querySelector('.field-label').firstChild.textContent = g ? g.titleLabel : '제목';
    fields.store.hidden = m.genre !== 'escaperoom';
  }

  async function save() {
    if (cover.isBusy()) { toast('표지를 저장하는 중이에요. 잠시 뒤에 다시 눌러 주세요', 'info'); return; }
    if (m.genre !== work.genre) {
      const loss = repo.genreChangeLoss(work.id, m.genre);
      const ok = await confirmDialog('장르를 바꿀까요?',
        `‘${GENRES[work.genre].label}’에서 ‘${GENRES[m.genre].label}’(으)로 바꿔요.${loss ? ` 플레이 기록 ${loss}개에 적힌 ${GENRES[work.genre].label} 전용 항목(예: 탈출 결과·순위·범인)은 지워져요.` : ''} 공통 항목(날짜·평점·감상·후기·사진·함께한 사람)은 그대로예요.`,
        { ok: '바꾸기', danger: loss > 0 });
      if (!ok) return;
    }
    try {
      await repo.saveWork({ ...work, genre: m.genre, title: m.title, store: m.store, branch: m.branch, cover: m.cover });
      saved = true;
      const leftover = [...added].filter((id) => id !== m.cover);
      if (leftover.length) repo.discardImages(leftover).catch(() => {});
      toast('작품 정보를 고쳤어요', 'ok');
      navigate(back, { replace: true });
    } catch (e) {
      if (e && e.errors) {
        for (const [k, msg] of Object.entries(e.errors)) setFieldError(fields[k] || fields.title, msg);
        toast('입력한 내용을 확인해 주세요', 'error');
      } else {
        toast('저장하지 못했어요', 'error');
      }
    }
  }

  async function merge() {
    const stats = repo.stats();
    const others = repo.worksList().filter((w) => w.id !== work.id && w.genre === work.genre);
    if (!others.length) { toast(`합칠 수 있는 다른 ${GENRES[work.genre].label} 작품이 없어요`, 'info'); return; }
    // 이름이 같은 작품을 앞에
    const same = new Set(sameTitleWorks(others, work.genre, work.title).map((w) => w.id));
    others.sort((a, b) => Number(same.has(b.id)) - Number(same.has(a.id)) || String((stats.get(b.id) || {}).latest?.date || '').localeCompare(String((stats.get(a.id) || {}).latest?.date || '')));
    const target = await choiceSheet('어느 작품과 합칠까요?', others.slice(0, 30).map((w) => {
      const s = stats.get(w.id);
      return { value: w.id, icon: 'merge', label: workLabel(w), desc: `${s ? `${s.count}회 플레이 · 최근 ${fmtDate(s.latest.date)}` : ''}${same.has(w.id) ? ' · 이름 같음' : ''}` };
    }), { text: `‘${workLabel(work)}’의 플레이 기록 ${count}개를 고른 작품으로 옮기고, 이 작품은 지워요.` });
    if (!target) return;
    const to = repo.getWork(target);
    const ok = await confirmDialog('작품을 합칠까요?', `‘${workLabel(work)}’의 기록 ${count}개를 ‘${workLabel(to)}’(으)로 옮겨요. 되돌릴 수 없어요.`, { ok: '합치기', danger: true });
    if (!ok) return;
    try {
      await repo.mergeWork(work.id, target);
      saved = true;
      toast('작품을 합쳤어요', 'ok');
      navigate(`#/work/${encodeURIComponent(target)}`, { replace: true });
    } catch {
      toast('합치지 못했어요', 'error');
    }
  }

  async function remove() {
    const ok = await confirmDialog('작품을 지울까요?', `‘${workLabel(work)}’와 플레이 기록 ${count}개, 사진을 모두 지워요. 되돌릴 수 없어요.`, { ok: `기록 ${count}개와 함께 지우기`, danger: true });
    if (!ok) return;
    try {
      await repo.deleteWork(work.id);
      saved = true;
      toast('작품과 기록을 지웠어요', 'ok');
      navigate('#/', { replace: true });
    } catch {
      toast('지우지 못했어요', 'error');
    }
  }

  const form = h('form', { class: 'form', novalidate: true },
    h('section', { class: 'form-card' }, fields.genre, fields.title, fields.store, fields.cover),
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => goBack(back) }, '취소'),
      h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, icon('check'), h('span', { text: '작품 정보 저장' }))),
    h('section', { class: 'form-card danger-zone' },
      h('h2', { class: 'form-group-title', text: '작품 정리' }),
      h('div', { class: 'danger-row' },
        h('div', {}, h('p', { class: 'danger-title', text: '다른 작품과 합치기' }), h('p', { class: 'field-hint', text: '같은 작품을 둘로 나눠 기록했을 때 써요.' })),
        h('button', { type: 'button', class: 'btn btn-ghost', onClick: merge }, icon('merge'), h('span', { text: '합치기' }))),
      h('div', { class: 'danger-row' },
        h('div', {}, h('p', { class: 'danger-title', text: '작품 지우기' }), h('p', { class: 'field-hint', text: `플레이 기록 ${count}개도 함께 지워져요.` })),
        h('button', { type: 'button', class: 'btn btn-danger-ghost', onClick: remove }, icon('trash'), h('span', { text: '지우기' })))));
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  root.append(
    h('header', { class: 'appbar form-bar' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫기', onClick: () => goBack(back) }, icon('x')),
      h('h1', { class: 'appbar-title', text: '작품 정보 수정' }),
      h('div', { class: 'appbar-actions' }, h('button', { type: 'button', class: 'btn btn-primary btn-save', onClick: save }, '저장'))),
    h('div', { class: 'container narrow form-wrap' },
      h('p', { class: 'form-lead', text: '작품 정보는 이 작품의 모든 플레이 기록에 함께 쓰여요. 날짜별 기록은 각 기록의 ‘수정’에서 고쳐요.' }),
      form));
  sync();

  return {
    destroy() {
      // 저장하지 않고 나가면 새로 올린 표지는 지움
      if (!saved && added.size) repo.discardImages([...added]).catch(() => {});
    },
  };
}
