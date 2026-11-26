// Переезд — пакет (docs/design/migration.md; владелец 2026-11-26: «либо на готовый сервер бамбамбам — с учётом, что
// там уже что-то есть, чтобы не сломать тамошний периметр, — либо скачать архив, а потом загрузить его; галками»).
// Один формат на оба пути: источник собирает выбранное в tar.gz, окно передаёт его цели (или сохраняет файлом),
// цель показывает превью и импортирует, ничего своего не перезаписывая.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { create as tarCreate, extract as tarExtract } from 'tar';
import type { Profile } from './profiles.js';
import { profileConfigDir } from './profiles.js';
import type { SessionInfo } from './session/manager.js';
import { HEAVY_DIRS, accountKind, gitState } from './migrate.js';
import { transcriptPath } from './transcript.js';

export const PACKAGE_FORMAT = 'perimeter-migration';
export const PACKAGE_VERSION = 1;

/** Что взять (галки окна). Имена аккаунтов — внешние. */
export interface MigrateSelection {
  accounts: string[];
  mcp: string[];
  projects: string[];
  /** active — с историей, кроме архива; all — и архив; none */
  sessions: 'active' | 'all' | 'none';
  thinking: boolean;
  browser: boolean;
  gitIdentity: boolean;
  /** ключи и токены аккаунтов/MCP в пакет (для архива на диске — осознанно) */
  secrets: boolean;
}

export interface ManifestAccount { name: string; kind: string; needsLogin: boolean; secretIncluded: boolean }
export interface ManifestProject { name: string; route: 'bundle' | 'archive'; remote: string | null; branch: string | null; head: string | null; patch: boolean; files: boolean; profile?: string; model?: string }
export interface ManifestSession { id: string; name: string; account: string; project: string | null; archived: boolean; parentSessionId?: string }
export interface Manifest {
  format: typeof PACKAGE_FORMAT;
  version: number;
  createdAt: string;
  source: { host: string; user: string; home: string; storageRoot: string };
  secretsIncluded: boolean;
  accounts: ManifestAccount[];
  mcp: string[];
  projects: ManifestProject[];
  sessions: ManifestSession[];
  thinking: boolean;
  browser: boolean;
  git: { name: string | null; email: string | null } | null;
}

/** Ключи окружения с секретом — без них аккаунт поедет «без ключа» (на цели вписать). */
export const isSecretKey = (k: string): boolean => /TOKEN|KEY|SECRET|PASSWORD/i.test(k);

type Run = (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
export const runGit: Run = (cmd, args, opts = {}) => new Promise((resolve) => {
  const child = execFile(cmd, args, { cwd: opts.cwd, timeout: 10 * 60_000, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
  if (opts.input !== undefined) { child.stdin?.end(opts.input); }
});

export interface ExportDeps {
  profiles: Array<{ profile: Profile; external: string }>;
  projects: Array<{ name: string; path: string; profile?: string; model?: string }>;
  storageRoot: string;
  sessions: SessionInfo[];
  externalOf: (profile: string | undefined) => string;
  mcpShared: Record<string, unknown>;
  thinkingFile: string;
  rbProfileDir: string;
  /** где складывать пакеты: <dir>/out/<id>.tgz */
  workDir: string;
  home?: string;
  run?: Run;
}

/** Не рекурсивный ли симлинк/тяжёлое: папки, которые в архив проекта не идут. */
function heavyFilter(root: string) {
  return (p: string): boolean => {
    const rel = relative(root, join(root, p)).replace(/\\/g, '/');
    const segs = rel.split('/');
    if (segs.some((s) => HEAVY_DIRS.has(s))) return false;
    if (segs[0] === '.git') return false;
    if (rel.startsWith('.perimeter/')) return false;
    return true;
  };
}

/** Своё (не симлинк на общее) — копируем папкой. */
function copyOwnDir(src: string, dst: string): boolean {
  try {
    if (!existsSync(src) || lstatSync(src).isSymbolicLink()) return false;
    cpSync(src, dst, { recursive: true, dereference: false });
    return true;
  } catch { return false; }
}

async function packProject(p: ExportDeps['projects'][number], dir: string, run: Run): Promise<ManifestProject> {
  mkdirSync(dir, { recursive: true });
  const g = await gitState(p.path, async (cmd, args) => { const r = await run(cmd, args); return { code: r.code, stdout: r.stdout }; });
  const base = { name: p.name, ...(p.profile !== undefined ? { profile: p.profile } : {}), ...(p.model !== undefined ? { model: p.model } : {}) };
  if (!g) {
    // не git — весь проект без тяжёлого
    await tarCreate({ gzip: true, file: join(dir, 'files.tgz'), cwd: p.path, portable: true, filter: heavyFilter(p.path) }, ['.']);
    return { ...base, route: 'archive', remote: null, branch: null, head: null, patch: false, files: true };
  }
  // все refs (ветки, теги, stash) — бандлом: цель клонирует из него, remote ей не нужен
  const hasCommits = g.head !== null;
  if (hasCommits) {
    const b = await run('git', ['-C', p.path, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
    if (b.code !== 0) throw new Error(`git bundle «${p.name}»: ${b.stderr.trim().slice(0, 300)}`);
  }
  let patch = false;
  if (hasCommits && g.dirty > 0) {
    const d = await run('git', ['-C', p.path, 'diff', 'HEAD', '--binary']);
    if (d.code === 0 && d.stdout.trim() !== '') { writeFileSync(join(dir, 'patch.diff'), d.stdout); patch = true; }
  }
  // новые файлы вне git и игнорируемое не-тяжёлое (.env и т. п.) — архивом
  const others = await run('git', ['-C', p.path, 'ls-files', '--others', '--exclude-standard', '-z']);
  const ignored = await run('git', ['-C', p.path, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  const keep = heavyFilter(p.path);
  const list = [...new Set([...others.stdout.split('\0'), ...ignored.stdout.split('\0')])].filter((f) => f !== '' && keep(f));
  let files = false;
  if (list.length > 0) {
    await tarCreate({ gzip: true, file: join(dir, 'files.tgz'), cwd: p.path, portable: true }, list);
    files = true;
  }
  return { ...base, route: 'bundle', remote: g.remote, branch: g.branch || null, head: g.head, patch, files };
}

export interface ExportResult { id: string; file: string; bytes: number; sha256: string; manifest: Manifest }

export async function exportPackage(sel: MigrateSelection, d: ExportDeps): Promise<ExportResult> {
  const run = d.run ?? runGit;
  const home = d.home ?? homedir();
  const id = randomUUID();
  const outDir = join(d.workDir, 'out');
  const stage = join(outDir, id);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const manifest: Manifest = {
      format: PACKAGE_FORMAT, version: PACKAGE_VERSION, createdAt: new Date().toISOString(),
      source: { host: hostname(), user: userInfo().username, home, storageRoot: d.storageRoot },
      secretsIncluded: sel.secrets, accounts: [], mcp: [], projects: [], sessions: [], thinking: false, browser: false, git: null,
    };
    // ─── аккаунты ───
    for (const name of sel.accounts) {
      const a = d.profiles.find((x) => x.external === name);
      if (!a) continue;
      const dir = join(stage, 'accounts', name);
      mkdirSync(dir, { recursive: true });
      const cfg = profileConfigDir(a.profile);
      const kind = accountKind(a.profile, cfg);
      const { configDir: _c, name: _n, ...rest } = a.profile;
      const env = Object.fromEntries(Object.entries(rest.env ?? {}).filter(([k]) => k !== 'CLAUDE_CONFIG_DIR' && (sel.secrets || !isSecretKey(k))));
      writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...rest, env }, null, 2), { mode: 0o600 });
      for (const f of ['settings.json', 'CLAUDE.md']) if (existsSync(join(cfg, f))) cpSync(join(cfg, f), join(dir, f));
      for (const f of ['skills', 'commands', 'agents']) copyOwnDir(join(cfg, f), join(dir, f));
      try {
        const j = JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
        if (j.mcpServers && Object.keys(j.mcpServers).length > 0) writeFileSync(join(dir, 'mcp.json'), JSON.stringify(sel.secrets ? j.mcpServers : {}, null, 2), { mode: 0o600 });
      } catch { /* нет MCP аккаунта */ }
      const secretIncluded = sel.secrets && Object.keys(env).some(isSecretKey);
      manifest.accounts.push({ name, kind, needsLogin: kind === 'subscription-login', secretIncluded });
    }
    // ─── общие MCP ───
    const mcp = Object.fromEntries(Object.entries(d.mcpShared).filter(([k]) => sel.mcp.includes(k)));
    if (Object.keys(mcp).length > 0 && sel.secrets) {
      writeFileSync(join(stage, 'mcp-shared.json'), JSON.stringify({ version: 1, servers: mcp }, null, 2), { mode: 0o600 });
      manifest.mcp = Object.keys(mcp).sort();
    }
    // ─── проекты ───
    for (const name of sel.projects) {
      const p = d.projects.find((x) => x.name === name);
      if (!p || !existsSync(p.path)) continue;
      manifest.projects.push(await packProject(p, join(stage, 'projects', String(manifest.projects.length)), run));
    }
    // ─── сессии ───
    if (sel.sessions !== 'none') {
      const projOf = (cwd: string | undefined) => d.projects.find((p) => cwd !== undefined && (cwd === p.path || cwd.startsWith(`${p.path}/`)));
      for (const s of d.sessions) {
        if (s.archived === true && sel.sessions !== 'all') continue;
        if (!s.claudeSessionId || !s.cwd) continue;
        const prof = d.profiles.find((x) => x.profile.name === s.profile)?.profile;
        const cfg = profileConfigDir(prof);
        const tp = transcriptPath(cfg, s.cwd, s.claudeSessionId);
        if (!existsSync(tp)) continue;
        const dir = join(stage, 'sessions', s.id);
        mkdirSync(dir, { recursive: true });
        cpSync(tp, join(dir, 'transcript.jsonl'));
        if (existsSync(join(cfg, 'tasks', s.claudeSessionId))) cpSync(join(cfg, 'tasks', s.claudeSessionId), join(dir, 'tasks'), { recursive: true });
        try {
          for (const f of readdirSync(join(cfg, 'todos')).filter((n) => n.startsWith(s.claudeSessionId!))) {
            mkdirSync(join(dir, 'todos'), { recursive: true });
            cpSync(join(cfg, 'todos', f), join(dir, 'todos', f));
          }
        } catch { /* нет todos */ }
        const project = projOf(s.cwd);
        const { state: _st, needs: _ne, ...rec } = s as SessionInfo & Record<string, unknown>;
        writeFileSync(join(dir, 'session.json'), JSON.stringify({
          ...rec, account: d.externalOf(s.profile), project: project?.name ?? null,
          cwdRel: project ? relative(project.path, s.cwd).replace(/\\/g, '/') : null,
        }, null, 2));
        manifest.sessions.push({ id: s.id, name: s.name, account: d.externalOf(s.profile), project: project?.name ?? null, archived: s.archived === true, ...(s.parentSessionId !== undefined ? { parentSessionId: s.parentSessionId } : {}) });
      }
    }
    // ─── журнал размышлений, браузер, git-имя ───
    if (sel.thinking && existsSync(d.thinkingFile)) { cpSync(d.thinkingFile, join(stage, 'thinking.log')); manifest.thinking = true; }
    if (sel.browser && existsSync(d.rbProfileDir)) {
      const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'Crashpad', 'CacheStorage', 'ScriptCache']);
      await tarCreate({ gzip: true, file: join(stage, 'browser.tgz'), cwd: d.rbProfileDir, portable: true, filter: (p) => !p.split('/').some((s) => skip.has(s)) && !/Singleton/.test(p) }, ['.']);
      manifest.browser = true;
    }
    if (sel.gitIdentity) {
      const [n, e] = await Promise.all([run('git', ['config', '--global', 'user.name']), run('git', ['config', '--global', 'user.email'])]);
      const g = { name: n.stdout.trim() || null, email: e.stdout.trim() || null };
      if (g.name || g.email) manifest.git = g;
    }
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const file = join(outDir, `${id}.tgz`);
    await tarCreate({ gzip: true, file, cwd: stage, portable: true }, readdirSync(stage));
    return { id, file, bytes: statSync(file).size, sha256: await sha256File(file), manifest };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Кусок готового пакета (base64) — окно забирает его частями: туннель и WS не любят сотни мегабайт одним кадром. */
export function readChunk(file: string, offset: number, length: number): { data: string; eof: boolean; bytes: number } {
  const size = statSync(file).size;
  const n = Math.max(0, Math.min(length, size - offset));
  const buf = Buffer.alloc(n);
  if (n > 0) {
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, n, offset); } finally { closeSync(fd); }
  }
  return { data: buf.toString('base64'), eof: offset + n >= size, bytes: size };
}

/** Приём пакета частями: кусок строго по порядку (offset = текущий размер) — повтор/пропуск отвергаем. */
export function appendChunk(file: string, offset: number, data: string): number {
  const have = existsSync(file) ? statSync(file).size : 0;
  if (offset !== have) throw new Error(`кусок не по порядку: ждал ${have}, пришёл ${offset}`);
  appendFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 });
  return statSync(file).size;
}

/** Только манифест из пакета (превью до распаковки всего). */
export async function readManifest(file: string): Promise<Manifest> {
  const dir = `${file}.manifest`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    await tarExtract({ file, cwd: dir, strict: true, filter: (p) => p.replace(/^\.\//, '') === 'manifest.json' });
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    if (m.format !== PACKAGE_FORMAT) throw new Error('это не пакет переезда Perimeter');
    if (m.version > PACKAGE_VERSION) throw new Error(`пакет новее этого supervisor'а (формат ${m.version}) — обновите сервер`);
    return m;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
