// Персистентность реестра сессий: переживает kill -9 supervisor'а (инвариант 2).
// Файл маленький, пишем атомарно (tmp + rename).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EffortLevelSchema, type EffortLevel } from '@perimeter/protocol';

export interface PersistedSession {
  id: string;
  name: string;
  claudeSessionId?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  profile?: string;
  projectId?: string;
  archived?: boolean;
  /** усилие сессии (переживает рестарт supervisor'а и respawn) */
  effort?: EffortLevel;
  ultracode?: boolean;
  /** окно автокомпакта сессии */
  compactWindow?: number;
  /** воркер делегирования: родитель и инструмент */
  parentSessionId?: string;
  agentOf?: string;
  /** сессия переехала в другую среду: метка среды-цели (архивная пометка) */
  movedTo?: string;
  /** сессия приехала из другой среды: метка среды-источника */
  movedFrom?: string;
  lastSeq: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTIONAL_STRINGS = ['claudeSessionId', 'cwd', 'model', 'permissionMode', 'profile', 'projectId', 'movedTo', 'movedFrom'] as const;

/**
 * Запись реестра → сессия. Поле не той формы иначе доезжает до event:hello (sessionSummary:
 * id — uuid, name — строка), кадр не проходит схему, и UI не может подключиться вовсе.
 */
function normalizeSession(raw: unknown): PersistedSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = r['id'];
  const lastSeq = r['lastSeq'];
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  if (typeof lastSeq !== 'number' || !Number.isInteger(lastSeq) || lastSeq < -1) return null;
  const out: PersistedSession = {
    id,
    name: typeof r['name'] === 'string' && r['name'] !== '' ? r['name'] : `сессия-${id.slice(0, 8)}`,
    lastSeq,
  };
  for (const k of OPTIONAL_STRINGS) if (typeof r[k] === 'string') out[k] = r[k] as string;
  // родитель воркера — только uuid: кривое значение уронит sessionSummary (event:hello) и весь UI
  if (typeof r['parentSessionId'] === 'string' && UUID.test(r['parentSessionId'])) out.parentSessionId = r['parentSessionId'];
  if (typeof r['agentOf'] === 'string' && r['agentOf'] !== '') out.agentOf = r['agentOf'];
  if (typeof r['archived'] === 'boolean') out.archived = r['archived'];
  const effort = EffortLevelSchema.safeParse(r['effort']);
  if (effort.success) out.effort = effort.data;
  if (r['ultracode'] === true) out.ultracode = true;
  if (typeof r['compactWindow'] === 'number' && Number.isInteger(r['compactWindow']) && r['compactWindow'] >= 20_000) out.compactWindow = r['compactWindow'];
  return out;
}

export interface PersistedState {
  version: 1;
  savedAt: number;
  sessions: PersistedSession[];
}

export class StateStore {
  constructor(private readonly file: string) {}

  load(): PersistedSession[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedState;
      if (raw.version !== 1 || !Array.isArray(raw.sessions)) return [];
      return (raw.sessions as unknown[]).map(normalizeSession).filter((s): s is PersistedSession => s !== null);
    } catch {
      return []; // нет файла или битый — стартуем с пустым реестром
    }
  }

  save(sessions: PersistedSession[]): void {
    const state: PersistedState = { version: 1, savedAt: Date.now(), sessions };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
