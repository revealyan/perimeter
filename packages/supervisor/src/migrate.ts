// Переезд с сервера на сервер (docs/design/migration.md), этап 1 — опись: что этот сервер хранит и сколько.
// Только чтение; секреты — флагом «есть», значения не покидают сервер.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join, relative } from 'node:path';
import type { AccountKind, Inventory, InventoryAccount, InventoryGit, InventoryProject } from '@perimeter/protocol';
import type { Profile } from './profiles.js';
import { profileConfigDir } from './profiles.js';
import type { SessionInfo } from './session/manager.js';
import { listKeys } from './serverKeys.js';

/** Пересобираемое тяжёлое — не везём (пересоберётся на цели). */
export const HEAVY_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'target', '.cache', '.turbo', '.gradle', '.tox', '.mypy_cache', '.pytest_cache']);
/** Внутренние папки, которые не считаем ни своими, ни тяжёлыми (worktrees воркеров едут ветками в бандле). */
const SKIP_DIRS = new Set(['.git']);
const WORKTREES = join('.perimeter', 'wt');

export interface DirSize { bytes: number; files: number; heavy: string[]; truncated: boolean }

/** Размер папки без тяжёлого (его — списком); обход ограничен maxEntries, симлинки не раскрываем. */
export function dirSize(root: string, maxEntries = 200_000): DirSize {
  const out: DirSize = { bytes: 0, files: 0, heavy: [], truncated: false };
  let seen = 0;
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (++seen > maxEntries) { out.truncated = true; return; }
      const p = join(dir, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        const rel = relative(root, p);
        if (SKIP_DIRS.has(n) || rel === WORKTREES) continue;
        if (HEAVY_DIRS.has(n)) { if (out.heavy.length < 30) out.heavy.push(rel); continue; }
        walk(p);
        if (out.truncated) return;
      } else if (st.isFile()) {
        out.bytes += st.size;
        out.files++;
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

type Run = (cmd: string, args: string[], cwd?: string) => Promise<{ code: number | null; stdout: string }>;
export const run: Run = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout: 15_000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0, stdout: String(stdout ?? '') });
  });
});

/** Состояние git проекта: что поедет клоном, что — бандлом/патчем/архивом. Не git — null. */
export async function gitState(path: string, exec: Run = run): Promise<InventoryGit | null> {
  const inside = await exec('git', ['-C', path, 'rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
  const top = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel']);
  // папка проекта внутри чужого репозитория (например, проект в ~ под git) — это не его git
  if (top.code === 0 && relative(top.stdout.trim(), path) !== '') return null;
  const [remote, branch, head, status, unpushed, refs, stash, ignored] = await Promise.all([
    exec('git', ['-C', path, 'remote', 'get-url', 'origin']),
    exec('git', ['-C', path, 'branch', '--show-current']),
    exec('git', ['-C', path, 'rev-parse', 'HEAD']),
    exec('git', ['-C', path, 'status', '--porcelain']),
    exec('git', ['-C', path, 'rev-list', '--count', '@{u}..HEAD']),
    exec('git', ['-C', path, 'for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(upstream:track)', 'refs/heads']),
    exec('git', ['-C', path, 'stash', 'list']),
    exec('git', ['-C', path, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory']),
  ]);
  const lines = status.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  const localBranches = refs.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split('|')).filter(([, up, track]) => !up || /ahead/.test(track ?? '')).map(([b]) => b!);
  const heavyOrInner = (p: string) => p.split('/').some((seg) => HEAVY_DIRS.has(seg)) || p.startsWith(`${WORKTREES.replace(/\\/g, '/')}`) || p.startsWith('.perimeter/');
  return {
    remote: remote.code === 0 ? remote.stdout.trim() || null : null,
    branch: branch.stdout.trim(),
    head: head.code === 0 ? head.stdout.trim() : null,
    dirty: lines.filter((l) => !l.startsWith('??')).length,
    untracked: lines.filter((l) => l.startsWith('??')).length,
    unpushed: unpushed.code === 0 ? Number(unpushed.stdout.trim()) || 0 : null,
    localBranches,
    stash: stash.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length,
    ignored: ignored.stdout.split(/\r?\n/).map((l) => l.trim().replace(/\/$/, '')).filter((l) => l !== '' && !heavyOrInner(l)).slice(0, 20),
  };
}

/** Как аккаунт входит (по env и папке Claude Code). */
export function accountKind(p: Profile, configDir: string): AccountKind {
  const env = p.env ?? {};
  if (env['ANTHROPIC_BASE_URL']) return 'gateway';
  if (env['CLAUDE_CODE_OAUTH_TOKEN']) return 'subscription-token';
  if (env['ANTHROPIC_API_KEY'] || env['ANTHROPIC_AUTH_TOKEN']) return 'api-key';
  if (existsSync(join(configDir, '.credentials.json'))) return 'subscription-login';
  return 'none';
}

/** Своих элементов в папке (не симлинк на общее). */
function ownCount(dir: string): number {
  try {
    if (lstatSync(dir).isSymbolicLink()) return 0;
    return readdirSync(dir).filter((n) => !n.startsWith('.')).length;
  } catch { return 0; }
}

function transcriptsOf(configDir: string): { files: number; bytes: number } {
  const root = join(configDir, 'projects');
  let files = 0;
  let bytes = 0;
  try {
    for (const d of readdirSync(root)) {
      let names: string[];
      try { names = readdirSync(join(root, d)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        try { bytes += statSync(join(root, d, n)).size; files++; } catch { /* исчез */ }
      }
    }
  } catch { /* нет папки */ }
  return { files, bytes };
}

export function accountInventory(p: Profile, external: string, base: string): InventoryAccount {
  const dir = profileConfigDir(p);
  const env = p.env ?? {};
  let mcpServers: string[] = [];
  try {
    const j = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    mcpServers = Object.keys(j.mcpServers ?? {}).sort();
  } catch { /* нет файла */ }
  let plugins = 0;
  try {
    const j = JSON.parse(readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, unknown> };
    plugins = Object.keys(j.plugins ?? {}).length;
  } catch { /* нет плагинов */ }
  return {
    name: external,
    kind: accountKind(p, dir),
    ...(env['ANTHROPIC_BASE_URL'] ? { baseUrl: env['ANTHROPIC_BASE_URL'] } : {}),
    hasSecret: Object.keys(env).some((k) => /TOKEN|KEY|SECRET/i.test(k) && (env[k] ?? '') !== ''),
    ownConfigDir: dir !== base,
    settings: existsSync(join(dir, 'settings.json')),
    claudeMd: existsSync(join(dir, 'CLAUDE.md')),
    mcpServers,
    skills: ownCount(join(dir, 'skills')),
    commands: ownCount(join(dir, 'commands')),
    agents: ownCount(join(dir, 'agents')),
    plugins,
    transcripts: transcriptsOf(dir),
  };
}

export interface InventoryDeps {
  profiles: Array<{ profile: Profile; external: string }>;
  projects: Array<{ name: string; path: string }>;
  storageRoot: string;
  sessions: SessionInfo[];
  /** транскрипт сессии на диске (по аккаунту и cwd) */
  hasTranscript: (s: SessionInfo) => boolean;
  /** внешнее имя аккаунта сессии */
  externalOf: (profile: string | undefined) => string;
  thinkingFile: string;
  mcpSharedFile: string | undefined;
  rbProfileDir: string;
  version: string;
  home?: string;
  exec?: Run;
}

export async function collectInventory(d: InventoryDeps): Promise<Inventory> {
  const home = d.home ?? homedir();
  const exec = d.exec ?? run;
  const base = join(home, '.claude');
  const projects: InventoryProject[] = [];
  for (const p of d.projects) {
    const exists = existsSync(p.path);
    const size = exists ? dirSize(p.path) : { bytes: 0, files: 0, heavy: [], truncated: false };
    projects.push({
      name: p.name, path: p.path, exists, ...size,
      git: exists ? await gitState(p.path, exec) : null,
      sessions: d.sessions.filter((s) => s.projectId !== undefined && s.cwd !== undefined && (s.cwd === p.path || s.cwd.startsWith(`${p.path}/`))).length,
    });
  }
  const inProject = (s: SessionInfo) => d.projects.some((p) => s.cwd !== undefined && (s.cwd === p.path || s.cwd.startsWith(`${p.path}/`)));
  const byAccount: Record<string, number> = {};
  for (const s of d.sessions) { const a = d.externalOf(s.profile); byAccount[a] = (byAccount[a] ?? 0) + 1; }
  let mcpShared: string[] = [];
  try {
    const j = JSON.parse(readFileSync(d.mcpSharedFile ?? '', 'utf8')) as { servers?: Record<string, unknown> };
    mcpShared = Object.keys(j.servers ?? {}).sort();
  } catch { /* нет общих */ }
  const fileSize = (f: string) => { try { return statSync(f).size; } catch { return 0; } };
  const [gName, gEmail, cron] = await Promise.all([
    exec('git', ['config', '--global', 'user.name']),
    exec('git', ['config', '--global', 'user.email']),
    process.platform === 'win32' ? Promise.resolve({ code: 1, stdout: '' }) : exec('crontab', ['-l']),
  ]);
  const keys = await listKeys(home).catch(() => []);
  const gh = keys.find((k) => k.github);
  let userUnits: string[] = [];
  try { userUnits = readdirSync(join(home, '.config', 'systemd', 'user')).filter((n) => /\.(service|timer)$/.test(n)); } catch { /* нет */ }
  const rb = existsSync(d.rbProfileDir) ? dirSize(d.rbProfileDir, 50_000) : null;
  return {
    server: { host: hostname(), user: userInfo().username, home, platform: process.platform, version: d.version, storageRoot: d.storageRoot },
    accounts: d.profiles.map(({ profile, external }) => accountInventory(profile, external, base)),
    mcpShared,
    projects,
    sessions: {
      total: d.sessions.length,
      archived: d.sessions.filter((s) => s.archived === true).length,
      withoutProject: d.sessions.filter((s) => !inProject(s)).length,
      noTranscript: d.sessions.filter((s) => !d.hasTranscript(s)).length,
      byAccount,
    },
    thinking: { bytes: fileSize(d.thinkingFile) },
    browserProfile: { exists: rb !== null, bytes: rb?.bytes ?? 0 },
    git: { name: gName.code === 0 ? gName.stdout.trim() || null : null, email: gEmail.code === 0 ? gEmail.stdout.trim() || null : null },
    github: { keyComment: gh?.comment || null, fingerprint: gh?.fingerprint ?? null },
    extras: {
      crontab: cron.code === 0 && cron.stdout.split(/\r?\n/).some((l) => l.trim() !== '' && !l.trim().startsWith('#')),
      userUnits,
      dockerData: existsSync(join(home, '.local', 'share', 'docker')),
    },
  };
}
