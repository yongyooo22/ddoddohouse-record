// 예전 모임용 기록장(서버 버전)이 이 브라우저에 남긴 것 — 기록 사본(localStorage)과 입장 코드
// 새 기록장은 서버를 쓰지 않으므로, 남은 사본을 한 번 가져올 수 있게 하고 입장 코드는 지운다.
import * as repo from './repo.js';
import { lsGet, lsRemove } from './prefs.js';
import { BACKUP_APP } from './constants.js';
import { parseBackup } from './backup.js';

const OLD_KEYS = ['ddh:key', 'ddh:cache', 'ddh:draft', 'ddh:theme'];

/** 남은 사본: { records, members, savedAt } 또는 null */
export function legacyCopy() {
  const raw = lsGet('ddh:cache');
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (!c || !Array.isArray(c.records) || !c.records.length) return null;
    return { records: c.records, members: Array.isArray(c.members) ? c.members : [], savedAt: typeof c.savedAt === 'string' ? c.savedAt : null };
  } catch {
    return null;
  }
}

/** 예전 버전이 남긴 사본·입장 코드·초안 지우기 */
export function clearLegacy() {
  for (const k of OLD_KEYS) lsRemove(k);
}

/** 남은 사본을 새 구조로 읽어 보기 (가져오기 전 미리보기용). 읽을 수 없으면 null */
export function parseLegacy() {
  const c = legacyCopy();
  if (!c) return null;
  const r = parseBackup(JSON.stringify({ app: BACKUP_APP, version: 1, records: c.records, members: c.members }));
  return r.ok ? r : null;
}

/**
 * 남은 사본을 새 기록장으로 가져오기 (사진은 서버에만 있었으므로 없음).
 * 형식이 맞지 않아 건너뛴 기록이 있으면 사본을 지우지 않고 남겨 둠 (나중에 지우기로 정리)
 * @returns {{plays:number, skipped:number, cleared:boolean}}
 */
export async function importLegacy(parsed = parseLegacy()) {
  if (!parsed) return { plays: 0, skipped: 0, cleared: false };
  const res = await repo.importData({ ...parsed, images: [] }, { mode: 'merge' });
  const cleared = parsed.skipped === 0;
  if (cleared) clearLegacy();
  return { plays: res.plays, skipped: parsed.skipped, cleared };
}
