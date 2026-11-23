// Статусы MCP в списке среды: быстрый ответ (без проверки серверов) приходит со статусом «unknown» у всех —
// подменять им уже известные статусы нельзя, иначе после каждого действия список моргает
// «подключён» → «не проверялся» → «подключён», пока не придёт ответ с проверкой.
import type { McpShared } from '../supervisor';

/** Свежий список без проверки + известные статусы из прошлого (тот же сервер, тот же адрес, та же цель). */
export function keepKnownStatuses(prev: McpShared | null, next: McpShared): McpShared {
  if (!prev) return next;
  const old = new Map(prev.servers.map((r) => [r.name, r]));
  return {
    ...next,
    servers: next.servers.map((r) => {
      const was = old.get(r.name);
      if (!was || was.target !== r.target || was.transport !== r.transport) return r;
      let changed = false;
      const on: typeof r.on = {};
      for (const [id, st] of Object.entries(r.on)) {
        const known = was.on[id];
        if (st.status === 'unknown' && known && known.status !== 'unknown') { on[id] = known; changed = true; } else on[id] = st;
      }
      return changed ? { ...r, on } : r;
    }),
  };
}
