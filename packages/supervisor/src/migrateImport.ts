// Переезд — импорт пакета на цель, не ломая её (владелец: «с учётом, что там уже что-то есть установленное»):
// есть такой аккаунт/MCP/проект/сессия — не трогаем (сессии идут в существующее); папка проекта занята чужим —
// кладём рядом под другим именем; файлы аккаунта (settings, CLAUDE.md, skills…) — только недостающие.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extract as tarExtract } from 'tar';
import type { Manifest, ManifestSession } from './migratePackage.js';
import { runGit } from './migratePackage.js';
import type { Profile } from './profiles.js';
import type { SavedSession } from './session/manager.js';
import { retargetTranscript, writeTranscript } from './transcript.js';

export type ImportAction = 'add' | 'exists' | 'rename' | 'login' | 'nokey' | 'skip';
export interface ImportDecision {
  /** acc:<имя> · mcp:<имя> · prj:<индекс> · ses:<id> · thinking · browser · git */
  id: string;
  group: 'accounts' | 'mcp' | 'projects' | 'sessions' | 'data';
  title: string;
  action: ImportAction;
  detail: string;
  /** галка по умолчанию (exists/skip — нечего делать) */
  on: boolean;
}

export interface ImportTarget {
  /** аккаунт по внешнему имени */
  accountExists: (external: string) => boolean;
  mcpExists: (name: string) => boolean;
  projectByName: (name: string) => { path: string } | undefined;
  storageRoot: string;
  sessionExists: (id: string) => boolean;
  browserProfileBusy: boolean;
  gitIdentitySet: boolean;
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9а-яё._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'project';

/** Папка нового проекта на цели: <корень>/<слаг>; занята — <слаг>-2… (чужое не трогаем). */
export function freeProjectPath(root: string, name: string, taken: (p: string) => boolean = existsSync): string {
  const base = join(root, slug(name));
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

/** Превью: что из пакета встанет на этот сервер и как. */
export function previewImport(m: Manifest, t: ImportTarget): ImportDecision[] {
  const out: ImportDecision[] = [];
  for (const a of m.accounts) {
    if (t.accountExists(a.name)) out.push({ id: `acc:${a.name}`, group: 'accounts', title: a.name, action: 'exists', on: false, detail: 'такой аккаунт здесь уже есть — его не трогаю, сессии пойдут в него' });
    else if (a.needsLogin) out.push({ id: `acc:${a.name}`, group: 'accounts', title: a.name, action: 'login', on: true, detail: 'заведу аккаунт с его настройками; вход подписки — заново здесь (настройки → аккаунты)' });
    else if (!a.secretIncluded && a.kind !== 'none') out.push({ id: `acc:${a.name}`, group: 'accounts', title: a.name, action: 'nokey', on: true, detail: 'пакет без ключей — заведу аккаунт, ключ впишете здесь' });
    else out.push({ id: `acc:${a.name}`, group: 'accounts', title: a.name, action: 'add', on: true, detail: 'добавлю с ключом и настройками' });
  }
  for (const n of m.mcp) {
    const there = t.mcpExists(n);
    out.push({ id: `mcp:${n}`, group: 'mcp', title: n, action: there ? 'exists' : 'add', on: !there, detail: there ? 'уже есть — не трогаю' : 'добавлю в общие MCP' });
  }
  m.projects.forEach((p, i) => {
    const there = t.projectByName(p.name);
    if (there) { out.push({ id: `prj:${i}`, group: 'projects', title: p.name, action: 'exists', on: false, detail: `уже есть (${there.path}) — файлы не трогаю, сессии пойдут в него` }); return; }
    const path = freeProjectPath(t.storageRoot, p.name);
    const how = p.route === 'bundle' ? `git из бандла${p.remote ? `, remote ${p.remote}` : ''}${p.patch ? ' + правки' : ''}${p.files ? ' + файлы вне git' : ''}` : 'файлы';
    out.push({ id: `prj:${i}`, group: 'projects', title: p.name, action: path.endsWith(slug(p.name)) ? 'add' : 'rename', on: true, detail: `${how} → ${path}${path.endsWith(slug(p.name)) ? '' : ' (папка с этим именем занята — рядом)'}` });
  });
  for (const s of m.sessions) {
    const there = t.sessionExists(s.id);
    out.push({ id: `ses:${s.id}`, group: 'sessions', title: s.name, action: there ? 'exists' : 'add', on: !there && !s.archived, detail: there ? 'уже есть' : `${s.account}${s.project ? ` · ${s.project}` : ''}${s.archived ? ' · в архиве' : ''}` });
  }
  if (m.thinking) out.push({ id: 'thinking', group: 'data', title: 'Журнал размышлений', action: 'add', on: true, detail: 'допишу недостающие записи' });
  if (m.browser) out.push({ id: 'browser', group: 'data', title: 'Профиль браузера', action: t.browserProfileBusy ? 'exists' : 'add', on: !t.browserProfileBusy, detail: t.browserProfileBusy ? 'здесь уже есть свой — не трогаю' : 'входы на сайты' });
  if (m.git) out.push({ id: 'git', group: 'data', title: 'Имя и почта для git', action: t.gitIdentitySet ? 'exists' : 'add', on: !t.gitIdentitySet, detail: `${m.git.name ?? ''}${m.git.email ? ` <${m.git.email}>` : ''}${t.gitIdentitySet ? ' — здесь уже задано' : ''}` });
  return out;
}

export interface ImportDeps extends ImportTarget {
  /** завести аккаунт (имя свободно); вернёт внутреннее имя и папку Claude Code */
  createAccount: (external: string, profile: Omit<Profile, 'name' | 'configDir'>) => { internal: string; configDir: string };
  /** внешнее имя → внутреннее + папка Claude Code (существующего аккаунта) */
  accountDir: (external: string) => { internal: string | undefined; configDir: string } | undefined;
  /** аккаунт по умолчанию — куда сессии, если их аккаунта нет */
  defaultAccount: () => { internal: string | undefined; configDir: string };
  putMcp: (name: string, entry: unknown) => void;
  createProject: (p: { name: string; path: string; profile?: string; model?: string }) => { id: string; path: string };
  projectIdByName: (name: string) => string | undefined;
  importSession: (s: SavedSession) => boolean;
  /** журнал размышлений цели — по хэшу подписи (ThinkingStore.putKey/hasKey) */
  thinkingPut: (key: string, text: string) => void;
  thinkingHas: (key: string) => boolean;
  browserDir: string;
  run?: typeof runGit;
}

export interface ImportLine { id: string; ok: boolean; text: string }

/** Карточку аккаунта дополнить недостающим: settings/CLAUDE.md/skills/commands/agents и MCP аккаунта. */
function fillAccountFiles(src: string, cfg: string, lines: string[]): void {
  mkdirSync(cfg, { recursive: true });
  for (const f of ['settings.json', 'CLAUDE.md']) {
    if (existsSync(join(src, f)) && !existsSync(join(cfg, f))) { cpSync(join(src, f), join(cfg, f)); lines.push(f); }
  }
  for (const d of ['skills', 'commands', 'agents']) {
    if (!existsSync(join(src, d))) continue;
    for (const n of readdirSync(join(src, d))) {
      if (existsSync(join(cfg, d, n))) continue;
      mkdirSync(join(cfg, d), { recursive: true });
      cpSync(join(src, d, n), join(cfg, d, n), { recursive: true });
      lines.push(`${d}/${n}`);
    }
  }
  if (existsSync(join(src, 'mcp.json'))) {
    const add = JSON.parse(readFileSync(join(src, 'mcp.json'), 'utf8')) as Record<string, unknown>;
    const file = join(cfg, '.claude.json');
    const j = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> } & Record<string, unknown> : {};
    const have = j.mcpServers ?? {};
    const fresh = Object.keys(add).filter((k) => !(k in have));
    if (fresh.length > 0) {
      j.mcpServers = { ...have, ...Object.fromEntries(fresh.map((k) => [k, add[k]])) };
      writeFileSync(file, JSON.stringify(j, null, 2), { mode: 0o600 });
      lines.push(`MCP: ${fresh.join(', ')}`);
    }
  }
}

/** Распаковать пакет и применить выбранные решения превью. */
export async function importPackage(file: string, m: Manifest, chosen: Set<string>, d: ImportDeps, onLine?: (l: ImportLine) => void): Promise<ImportLine[]> {
  const run = d.run ?? runGit;
  const lines: ImportLine[] = [];
  const say = (id: string, ok: boolean, text: string) => { const l = { id, ok, text }; lines.push(l); onLine?.(l); };
  const dir = `${file}.x`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    await tarExtract({ file, cwd: dir, strict: true });
    // ─── аккаунты ───
    const accMap = new Map<string, { internal: string | undefined; configDir: string }>();
    for (const a of m.accounts) {
      const id = `acc:${a.name}`;
      const src = join(dir, 'accounts', a.name);
      const existing = d.accountDir(a.name);
      if (existing) { accMap.set(a.name, existing); continue; }
      if (!chosen.has(id)) continue;
      try {
        const prof = JSON.parse(readFileSync(join(src, 'profile.json'), 'utf8')) as Omit<Profile, 'name' | 'configDir'>;
        const made = d.createAccount(a.name, prof);
        accMap.set(a.name, made);
        const extra: string[] = [];
        fillAccountFiles(src, made.configDir, extra);
        say(id, true, `аккаунт «${a.name}» заведён${extra.length ? ` (${extra.join(', ')})` : ''}${a.needsLogin ? ' — войдите в подписку здесь' : !a.secretIncluded ? ' — впишите ключ' : ''}`);
      } catch (e) { say(id, false, `аккаунт «${a.name}»: ${(e as Error).message}`); }
    }
    // ─── общие MCP ───
    if (existsSync(join(dir, 'mcp-shared.json'))) {
      const j = JSON.parse(readFileSync(join(dir, 'mcp-shared.json'), 'utf8')) as { servers?: Record<string, unknown> };
      for (const [n, e] of Object.entries(j.servers ?? {})) {
        const id = `mcp:${n}`;
        if (!chosen.has(id) || d.mcpExists(n)) continue;
        try { d.putMcp(n, e); say(id, true, `MCP «${n}» добавлен`); } catch (err) { say(id, false, `MCP «${n}»: ${(err as Error).message}`); }
      }
    }
    // ─── проекты ───
    const projPath = new Map<string, { id: string | undefined; path: string }>();
    for (const [i, p] of m.projects.entries()) {
      const id = `prj:${i}`;
      const there = d.projectByName(p.name);
      if (there) { projPath.set(p.name, { id: d.projectIdByName(p.name), path: there.path }); continue; }
      if (!chosen.has(id)) continue;
      const src = join(dir, 'projects', String(i));
      const dest = freeProjectPath(d.storageRoot, p.name);
      try {
        if (p.route === 'bundle' && existsSync(join(src, 'repo.bundle'))) {
          const c = await run('git', ['clone', '-q', join(src, 'repo.bundle'), dest]);
          if (c.code !== 0) throw new Error(`git clone: ${c.stderr.trim().slice(0, 300)}`);
          // все ветки бандла — локальными (воркеры, недопушенное); stash — обратно
          const refs = await run('git', ['-C', dest, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin']);
          for (const r of refs.stdout.split('\n').map((x) => x.trim()).filter((x) => x && !x.endsWith('/HEAD'))) {
            const b = r.replace('refs/remotes/origin/', '');
            await run('git', ['-C', dest, 'branch', '--no-track', b, r]);
          }
          // stash клон не тянет: забрать объект из бандла и положить в список stash (store пишет и журнал ссылки)
          const heads = await run('git', ['ls-remote', join(src, 'repo.bundle'), 'refs/stash']);
          const stash = heads.stdout.trim().split(/\s+/)[0];
          if (stash) {
            await run('git', ['-C', dest, 'fetch', '-q', join(src, 'repo.bundle'), 'refs/stash']);
            await run('git', ['-C', dest, 'stash', 'store', '-m', 'перенесено с другого сервера', stash]);
          }
          if (p.branch) await run('git', ['-C', dest, 'checkout', '-q', p.branch]);
          // remote — как был у источника (бандл был только способом доставки)
          if (p.remote) await run('git', ['-C', dest, 'remote', 'set-url', 'origin', p.remote]);
          else await run('git', ['-C', dest, 'remote', 'remove', 'origin']);
          if (p.patch) {
            const patch = readFileSync(join(src, 'patch.diff'), 'utf8');
            const a = await run('git', ['-C', dest, 'apply', '--binary', '-'], { input: patch });
            if (a.code !== 0) say(id, false, `«${p.name}»: правки не легли (${a.stderr.trim().slice(0, 200)}) — патч оставлен в .perimeter-migration.patch`);
            if (a.code !== 0) writeFileSync(join(dest, '.perimeter-migration.patch'), patch);
          }
        } else {
          mkdirSync(dest, { recursive: true });
        }
        if (p.files && existsSync(join(src, 'files.tgz'))) await tarExtract({ file: join(src, 'files.tgz'), cwd: dest, strict: true, keep: true });
        const acc = p.profile !== undefined ? accMap.get(p.profile) : undefined;
        const made = d.createProject({ name: p.name, path: dest, ...(acc?.internal !== undefined ? { profile: acc.internal } : {}), ...(p.model !== undefined ? { model: p.model } : {}) });
        projPath.set(p.name, { id: made.id, path: made.path });
        say(id, true, `проект «${p.name}» → ${dest}`);
      } catch (e) {
        rmSync(dest, { recursive: true, force: true });
        say(id, false, `проект «${p.name}»: ${(e as Error).message}`);
      }
    }
    // ─── сессии ───
    const imported = new Set<string>();
    const ordered = [...m.sessions].sort((a, b) => Number(a.parentSessionId !== undefined) - Number(b.parentSessionId !== undefined));
    for (const s of ordered) {
      const id = `ses:${s.id}`;
      if (!chosen.has(id) || d.sessionExists(s.id)) continue;
      try {
        importSessionDir(join(dir, 'sessions', s.id), s, d, accMap, projPath, imported);
        imported.add(s.id);
        say(id, true, `сессия «${s.name}»`);
      } catch (e) { say(id, false, `сессия «${s.name}»: ${(e as Error).message}`); }
    }
    // ─── журнал размышлений: только недостающие записи ───
    if (chosen.has('thinking') && existsSync(join(dir, 'thinking.log'))) {
      let added = 0;
      // строка журнала: «<32 hex хэш подписи> <JSON-строка текста>» (thinkingStore.ts)
      for (const line of readFileSync(join(dir, 'thinking.log'), 'utf8').split('\n')) {
        const key = line.slice(0, 32);
        if (line.length < 34 || line[32] !== ' ' || d.thinkingHas(key)) continue;
        try {
          const text = JSON.parse(line.slice(33)) as unknown;
          if (typeof text !== 'string') continue;
          d.thinkingPut(key, text);
          added++;
        } catch { /* не строка журнала */ }
      }
      say('thinking', true, `журнал размышлений: +${added}`);
    }
    if (chosen.has('browser') && existsSync(join(dir, 'browser.tgz')) && !d.browserProfileBusy) {
      mkdirSync(d.browserDir, { recursive: true, mode: 0o700 });
      await tarExtract({ file: join(dir, 'browser.tgz'), cwd: d.browserDir, strict: true });
      say('browser', true, 'профиль браузера');
    }
    if (chosen.has('git') && m.git && !d.gitIdentitySet) {
      if (m.git.name) await run('git', ['config', '--global', 'user.name', m.git.name]);
      if (m.git.email) await run('git', ['config', '--global', 'user.email', m.git.email]);
      say('git', true, `git: ${m.git.name ?? ''} <${m.git.email ?? ''}>`);
    }
    return lines;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function importSessionDir(
  src: string, s: ManifestSession, d: ImportDeps,
  accMap: Map<string, { internal: string | undefined; configDir: string }>,
  projPath: Map<string, { id: string | undefined; path: string }>,
  imported: Set<string>,
): void {
  const rec = JSON.parse(readFileSync(join(src, 'session.json'), 'utf8')) as SavedSession & { account: string; project: string | null; cwdRel: string | null };
  const acc = accMap.get(s.account) ?? d.accountDir(s.account) ?? d.defaultAccount();
  const proj = s.project !== null ? projPath.get(s.project) : undefined;
  // без проекта (или проект не поехал) — папка на цели: проект, иначе корень хранилища (cwd источника здесь может не быть)
  const cwd = proj ? (rec.cwdRel ? join(proj.path, rec.cwdRel) : proj.path) : (rec.cwd && existsSync(rec.cwd) ? rec.cwd : d.storageRoot);
  if (!rec.claudeSessionId) throw new Error('у сессии нет id Claude Code');
  const transcript = readFileSync(join(src, 'transcript.jsonl'), 'utf8');
  writeTranscript(acc.configDir, cwd, rec.claudeSessionId, retargetTranscript(transcript, cwd));
  if (existsSync(join(src, 'tasks')) && !existsSync(join(acc.configDir, 'tasks', rec.claudeSessionId))) {
    cpSync(join(src, 'tasks'), join(acc.configDir, 'tasks', rec.claudeSessionId), { recursive: true });
  }
  if (existsSync(join(src, 'todos'))) {
    mkdirSync(join(acc.configDir, 'todos'), { recursive: true });
    for (const f of readdirSync(join(src, 'todos'))) if (!existsSync(join(acc.configDir, 'todos', f))) cpSync(join(src, 'todos', f), join(acc.configDir, 'todos', f));
  }
  const { account: _a, project: _p, cwdRel: _r, projectId: _pid, profile: _prof, movedTo: _mt, ...keep } = rec as SavedSession & { account: string; project: string | null; cwdRel: string | null; movedTo?: string };
  const ok = d.importSession({
    ...keep,
    cwd,
    ...(acc.internal !== undefined ? { profile: acc.internal } : {}),
    ...(proj?.id !== undefined ? { projectId: proj.id } : {}),
    ...(rec.parentSessionId !== undefined && !imported.has(rec.parentSessionId) && !d.sessionExists(rec.parentSessionId) ? { parentSessionId: undefined } : {}),
    lastSeq: -1,
  } as SavedSession);
  if (!ok) throw new Error('не зарегистрировалась');
}
