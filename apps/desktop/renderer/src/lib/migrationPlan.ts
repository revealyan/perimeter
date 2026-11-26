// План переезда (docs/design/migration.md): описи источника и цели → что поедет, как, что уже есть, что сделать
// на цели заново. Чистые функции без React.
import type { Inventory, InventoryProject } from '@perimeter/protocol';

export type PlanGroup = 'accounts' | 'mcp' | 'projects' | 'sessions' | 'data' | 'todo';
/** copy — поедет; bundle/archive — как поедет проект (clone — оставлено для совместимости подписей); exists — уже есть на цели; manual — сделать на цели; skip — не везём */
export type PlanAction = 'copy' | 'clone' | 'bundle' | 'archive' | 'exists' | 'manual' | 'skip';

export interface PlanItem {
  id: string;
  group: PlanGroup;
  title: string;
  action: PlanAction;
  /** что именно и почему (одна строка) */
  detail: string;
  /** галка по умолчанию (для exists/manual/skip — не применимо) */
  on: boolean;
  bytes?: number;
  warn?: string;
}

export const GROUP_TITLE: Record<PlanGroup, string> = {
  accounts: 'Аккаунты', mcp: 'Общие MCP-серверы', projects: 'Проекты', sessions: 'Сессии', data: 'Данные', todo: 'Сделать на новом сервере',
};

/** Проект больше — предупреждаем: через приложение поедет медленно (канал владельца). */
export const BIG_PROJECT_BYTES = 200 * 1024 * 1024;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} МБ`;
  return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ`;
}

/**
 * Как поедет проект пакетом: git — целиком бандлом (вся история, ветки, stash; remote остаётся прежним — цели доступ
 * к нему для переезда не нужен), сверху правки патчем и файлы вне git архивом; не git — архивом.
 */
export function projectRoute(p: InventoryProject): { action: 'bundle' | 'archive'; extras: string[] } {
  const g = p.git;
  if (!g) return { action: 'archive', extras: [] };
  const extras: string[] = [];
  if (g.localBranches.length > 0) extras.push(`ветки: ${g.localBranches.slice(0, 3).join(', ')}${g.localBranches.length > 3 ? '…' : ''}`);
  if ((g.unpushed ?? 0) > 0) extras.push(`${g.unpushed} коммит. не на remote`);
  if (g.stash > 0) extras.push(`stash ${g.stash}`);
  if (g.dirty > 0) extras.push(`правки в ${g.dirty} файл.`);
  if (g.untracked > 0) extras.push(`новых файлов ${g.untracked}`);
  if (g.ignored.length > 0) extras.push(`${g.ignored.slice(0, 3).join(', ')}${g.ignored.length > 3 ? '…' : ''} (вне git)`);
  return { action: 'bundle', extras };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function migrationPlan(src: Inventory, dst: Inventory): PlanItem[] {
  const items: PlanItem[] = [];
  // ─── аккаунты ───
  for (const a of src.accounts) {
    const there = dst.accounts.find((d) => sameName(d.name, a.name));
    const extras = [
      a.settings ? 'настройки' : '', a.claudeMd ? 'CLAUDE.md' : '',
      a.mcpServers.length ? `MCP: ${a.mcpServers.join(', ')}` : '',
      a.skills + a.commands + a.agents > 0 ? `свои skills/commands/agents: ${a.skills + a.commands + a.agents}` : '',
    ].filter(Boolean).join(' · ');
    if (there) {
      const mismatch = there.kind !== a.kind || (there.baseUrl ?? '') !== (a.baseUrl ?? '');
      items.push({ id: `acc:${a.name}`, group: 'accounts', title: a.name, action: 'exists', on: false, detail: `уже есть на новом сервере${extras ? ` · дополню: ${extras}` : ''}`, ...(mismatch ? { warn: 'на новом сервере этот аккаунт другого типа или с другим шлюзом — сессии поедут в него' } : {}) });
    } else if (a.kind === 'subscription-login') {
      items.push({ id: `acc:${a.name}`, group: 'accounts', title: a.name, action: 'manual', on: false, detail: 'вход подписки Claude не делится между серверами — войти заново на новом (настройки → аккаунты)' });
    } else if (a.kind === 'none') {
      items.push({ id: `acc:${a.name}`, group: 'accounts', title: a.name, action: 'skip', on: false, detail: 'без ключа и входа — нечего переносить' });
    } else {
      const how = a.kind === 'gateway' ? `шлюз ${a.baseUrl ?? ''} с ключом` : a.kind === 'subscription-token' ? 'токен подписки' : 'ключ API';
      items.push({ id: `acc:${a.name}`, group: 'accounts', title: a.name, action: 'copy', on: true, detail: `${how}${extras ? ` · ${extras}` : ''}` });
    }
  }
  // ─── общие MCP ───
  for (const m of src.mcpShared) {
    const there = dst.mcpShared.some((d) => sameName(d, m));
    items.push({ id: `mcp:${m}`, group: 'mcp', title: m, action: there ? 'exists' : 'copy', on: !there, detail: there ? 'уже есть на новом сервере' : 'с настройками и токенами' });
  }
  // ─── проекты ───
  for (const p of src.projects) {
    const there = dst.projects.find((d) => sameName(d.name, p.name));
    if (!p.exists) {
      items.push({ id: `prj:${p.name}`, group: 'projects', title: p.name, action: 'skip', on: false, detail: `папки ${p.path} нет — переносить нечего (сессии проекта поедут без файлов)` });
      continue;
    }
    if (there) {
      items.push({ id: `prj:${p.name}`, group: 'projects', title: p.name, action: 'exists', on: false, detail: `уже есть: ${there.path}${there.git?.head && p.git?.head && there.git.head !== p.git.head ? ' · другой коммит — сверьте' : ''}` });
      continue;
    }
    const r = projectRoute(p);
    const how = r.action === 'bundle' ? `git целиком${p.git?.remote ? ` · remote ${p.git.remote}` : ' · без remote'}` : 'файлами (не git)';
    const heavy = p.heavy.length ? ` · не везём: ${p.heavy.slice(0, 3).join(', ')}${p.heavy.length > 3 ? '…' : ''} (пересоберётся)` : '';
    items.push({
      id: `prj:${p.name}`, group: 'projects', title: p.name, action: r.action, on: true, bytes: p.bytes,
      detail: `${how}${r.extras.length ? ` · ${r.extras.join(' · ')}` : ''}${heavy}`,
      ...(p.bytes > BIG_PROJECT_BYTES ? { warn: `${fmtBytes(p.bytes)} через приложение — долго` } : {}),
      ...(p.truncated ? { warn: 'очень много файлов — размер посчитан не полностью' } : {}),
    });
  }
  // ─── сессии ───
  const s = src.sessions;
  const movable = s.total - s.archived - s.noTranscript;
  items.push({ id: 'ses:active', group: 'sessions', title: 'Сессии', action: movable > 0 ? 'copy' : 'skip', on: movable > 0, detail: `${movable} с историей — с задачами и размышлениями; на новом сервере «остывшие», первый ход поднимет с историей${s.withoutProject ? ` · ${s.withoutProject} вне проектов — в папку по умолчанию` : ''}` });
  if (s.archived > 0) items.push({ id: 'ses:archived', group: 'sessions', title: 'Архив сессий', action: 'copy', on: false, detail: `${s.archived} в архиве` });
  if (s.noTranscript > 0) items.push({ id: 'ses:empty', group: 'sessions', title: 'Без истории', action: 'skip', on: false, detail: `${s.noTranscript} — истории на диске нет, переносить нечего` });
  // ─── данные ───
  if (src.thinking.bytes > 0) items.push({ id: 'data:thinking', group: 'data', title: 'Журнал размышлений', action: 'copy', on: true, bytes: src.thinking.bytes, detail: 'тексты размышлений перенесённых сессий — без него старые размышления пропадут' });
  if (src.browserProfile.exists) items.push({ id: 'data:browser', group: 'data', title: 'Профиль браузера', action: 'copy', on: false, bytes: src.browserProfile.bytes, detail: 'входы на сайты во вкладке «Браузер»; проще войти заново — при смене IP сайты часто просят вход' });
  if (src.git.name && !dst.git.name) items.push({ id: 'data:gitid', group: 'data', title: 'Имя и почта для git', action: 'copy', on: true, detail: `${src.git.name}${src.git.email ? ` <${src.git.email}>` : ''}` });
  // ─── сделать на цели ───
  if (src.github.keyComment !== null) {
    items.push(dst.github.keyComment !== null
      ? { id: 'todo:github', group: 'todo', title: 'Ключ GitHub', action: 'exists', on: false, detail: `на новом сервере есть (${dst.github.keyComment}) — «С сервера» → «Проверить GitHub»` }
      : { id: 'todo:github', group: 'todo', title: 'Ключ GitHub', action: 'manual', on: false, detail: `приватный ключ не копируем: «С сервера» → «Создать ключ» → добавить в GitHub (на старом был ${src.github.keyComment})` });
  }
  if (src.extras.crontab) items.push({ id: 'todo:cron', group: 'todo', title: 'crontab', action: 'manual', on: false, detail: 'вне Perimeter — перенесите руками, если нужен' });
  if (src.extras.userUnits.length) items.push({ id: 'todo:units', group: 'todo', title: 'Службы пользователя', action: 'manual', on: false, detail: `вне Perimeter: ${src.extras.userUnits.join(', ')}` });
  if (src.extras.dockerData) items.push({ id: 'todo:docker', group: 'todo', title: 'Docker', action: 'manual', on: false, detail: 'образы перекачаются; тома с данными — руками, если есть' });
  return items;
}
