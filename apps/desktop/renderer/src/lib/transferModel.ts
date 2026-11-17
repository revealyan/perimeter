// Перенос сессии между средами (T-ряд): план переноса — чистая функция над данными двух сред
// (проект по имени, аккаунт, сверка коммитов для патча правок), сам перенос и отмена — тонкие обёртки
// над cmd:session.export / cmd:session.import. Диалог T1 рисует план, T2 (лента/уведомление) — его итог.

import type { EnvId, ExportedSession, ProjectInfo, ProfileInfo, SessionView, SupervisorClient } from '../supervisor';
import { projectSlug } from './naming';

/** Ветки двух сред для патча правок. */
export type PatchBase = 'same' | 'diverged' | 'nogit';

/** Вход плана: снимок того, что знает клиент об обеих средах. */
export interface TransferInput {
  session: Pick<SessionView, 'name' | 'profile' | 'model' | 'permissionMode' | 'effort' | 'ultracode' | 'projectId' | 'state'>;
  /** проект сессии на источнике (по projectId); нет — сессия без проекта */
  srcProject?: Pick<ProjectInfo, 'name'>;
  /** проекты среды-цели (связь по имени, как в синке) */
  dstProjects: Array<Pick<ProjectInfo, 'name'>>;
  /** аккаунты среды-цели (внешние имена; undefined у сессии = аккаунт supervisor'а — есть всегда) */
  dstProfiles: Array<Pick<ProfileInfo, 'name'>>;
  /** HEAD папки проекта источника; null — не git */
  srcHead: string | null;
  /** HEAD папки-цели (проект цели или превью его будущей папки); null — не git */
  dstHead: string | null;
}

export interface TransferPlan {
  /** проект поедет по имени; нет на цели — создадим папку в хранилище цели */
  projectName?: string;
  /** проекта на цели нет — создаём (slug для папки) */
  createProject: string | null;
  /** аккаунт сессии есть на цели; false — переносим с дефолтным аккаунтом цели */
  profileKnown: boolean;
  /** база патча правок */
  base: PatchBase;
  /** патч правок можно везти (коммиты совпали и есть что везти) */
  patchAllowed: boolean;
}

export function planTransfer(input: TransferInput): TransferPlan {
  const name = input.srcProject?.name;
  const exists = name !== undefined && input.dstProjects.some((p) => p.name === name);
  const profileKnown = input.session.profile === undefined || input.dstProfiles.some((p) => p.name === input.session.profile);
  const bothGit = input.srcHead !== null && input.dstHead !== null;
  const base: PatchBase = !bothGit ? 'nogit' : input.srcHead === input.dstHead ? 'same' : 'diverged';
  return {
    ...(name !== undefined ? { projectName: name } : {}),
    // папку на цели заводим только под проект-известное имя (slug из названия, как в диалоге нового проекта)
    createProject: name !== undefined && !exists ? projectSlug(name) : null,
    profileKnown,
    base,
    // расхождение веток (решение владельца 16.11): правки не везём, только предупреждаем
    patchAllowed: base === 'same',
  };
}

/** Перенос: (создать проект на цели) → export источника → import цели. Возвращает сессию на цели. */
export async function runTransfer(
  src: SupervisorClient,
  dst: SupervisorClient,
  dstEnv: EnvId,
  sid: string,
  plan: TransferPlan,
  opts: { withPatch: boolean; dstLabel: string; srcLabel: string; profileOverride?: string },
): Promise<{ env: EnvId; sessionId: string; source: ExportedSession }> {
  if (plan.projectName !== undefined && plan.createProject !== null) {
    await dst.createProject({ name: plan.projectName, source: 'empty', slug: plan.createProject });
  }
  const exported = await src.exportSession(sid, opts.dstLabel);
  const r = await dst.importSession({
    name: exported.meta.name,
    claudeSessionId: exported.meta.claudeSessionId,
    transcript: exported.transcript,
    movedFrom: opts.srcLabel,
    ...(plan.projectName !== undefined ? { project: plan.projectName } : {}),
    ...(opts.profileOverride !== undefined ? { profile: opts.profileOverride } : {}),
    ...(exported.meta.model !== undefined ? { model: exported.meta.model } : {}),
    ...(exported.meta.permissionMode !== undefined ? { permissionMode: exported.meta.permissionMode } : {}),
    ...(exported.meta.effort !== undefined ? { effort: exported.meta.effort } : {}),
    ...(exported.meta.ultracode === true ? { ultracode: true } : {}),
    // патч везём только на совпавшей базе; untracked-файлы патчем не едут — о них предупредил диалог
    ...(opts.withPatch && plan.patchAllowed && exported.patch !== null
      ? { patch: exported.patch, ...(exported.headCommit !== null ? { baseCommit: exported.headCommit } : {}) }
      : {}),
  });
  return { env: dstEnv, sessionId: r.sessionId, source: exported };
}

/** Отмена переноса (до первого хода на цели): цель в архив, источник возвращается в строй. */
export function undoTransfer(src: SupervisorClient, dst: SupervisorClient, srcSid: string, dstSid: string): void {
  dst.archiveSession(dstSid, true);
  src.archiveSession(srcSid, false); // разархивирование снимает и пометку «переехала → …»
}
