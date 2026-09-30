// 예시 기록 넣기·지우기 (메인 화면과 설정에서 같이 씀)
import * as repo from '../repo.js';
import { buildSamples } from '../samples.js';
import { makeSampleArt } from '../sample-art.js';
import { toast, confirmDialog } from '../ui.js';

let busy = false;

export async function loadSamples() {
  if (busy) return false;
  if (repo.sampleCount() > 0) { toast('예시 기록이 이미 있어요', 'info'); return false; }
  busy = true;
  try {
    const art = await makeSampleArt();
    await repo.addSamples({ ...buildSamples({ art }) });
    toast(`예시 기록 ${repo.sampleCount()}개를 넣었어요`, 'ok');
    return true;
  } catch (e) {
    toast(e && e.code === 'quota' ? '저장 공간이 부족해 예시를 넣지 못했어요' : '예시 기록을 넣지 못했어요', 'error');
    return false;
  } finally {
    busy = false;
  }
}

export async function removeSamplesWithConfirm() {
  const n = repo.sampleCount();
  if (!n) return false;
  const ok = await confirmDialog('예시 기록을 지울까요?',
    `예시 기록 ${n}개와 예시 사진을 지워요. 직접 남긴 기록은 그대로예요.`, { ok: '예시 지우기', danger: true });
  if (!ok) return false;
  try {
    const removed = await repo.removeSamples();
    toast(`예시 기록 ${removed}개를 지웠어요`, 'ok');
    return true;
  } catch {
    toast('예시 기록을 지우지 못했어요', 'error');
    return false;
  }
}
