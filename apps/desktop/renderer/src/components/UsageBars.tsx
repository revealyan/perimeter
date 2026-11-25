// Лимиты аккаунта (как /usage в Claude Code Desktop): окна с заполненностью и временем сброса.
import { useEffect } from 'react';
import type { SupervisorClient } from '../supervisor';
import { barWindows, resetIn, shortLabel, usageTone } from '../lib/usageModel';
import { Icon } from './Icon';

export function UsageBars({ client, profile }: { client: SupervisorClient; profile: string }) {
  const live = client.status === 'live';
  useEffect(() => { if (live) void client.loadUsage(profile); }, [live, profile]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = client.usage.get(profile);
  const u = st?.usage;
  return (
    <div className="usage">
      {u && u.windows.length > 0 ? (
        <ul className="usage-list">
          {u.windows.map((w) => (
            <li key={w.id}>
              <span className="usage-label">{w.label}</span>
              <span className={`usage-bar tone-${usageTone(w.pct)}`} aria-hidden><span style={{ width: `${Math.max(1, Math.min(100, w.pct))}%` }} /></span>
              <span className="mono usage-pct">{Math.round(w.pct)}%</span>
              <span className="dim usage-reset">{w.used !== undefined && w.limit !== undefined ? `${w.used.toLocaleString('ru')} из ${w.limit.toLocaleString('ru')} · ` : ''}{resetIn(w.resetsAt)}</span>
            </li>
          ))}
        </ul>
      ) : <div className="dim acct-note">{st?.note ?? (live ? 'загружаю…' : 'нет связи с supervisor')}</div>}
      <div className="usage-foot dim">
        {u?.plan && <span>тариф {u.plan}</span>}
        {u && <span>обновлено {new Date(u.at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</span>}
        <button type="button" className="link-btn" disabled={!live} onClick={() => void client.loadUsage(profile, true)}><Icon name="refresh" size={12} /> обновить</button>
      </div>
    </div>
  );
}

/** Сводка лимитов в шапке карточки аккаунта: окна мини-шкалами (видно и у свёрнутой карточки). */
export function UsageMini({ client, profile }: { client: SupervisorClient; profile: string }) {
  const live = client.status === 'live';
  useEffect(() => { if (live) client.refreshUsageIfStale(profile); }, [live, profile]); // eslint-disable-line react-hooks/exhaustive-deps
  const u = client.usage.get(profile)?.usage;
  if (!u || u.windows.length === 0) return null;
  return (
    <span className="usage-mini" data-tip={u.windows.map((w) => `${w.label} — ${Math.round(w.pct)}%${w.resetsAt ? `, сброс ${resetIn(w.resetsAt)}` : ''}`).join('; ')}>
      {barWindows(u.windows).map((w) => (
        <span key={w.id} className={`usage-mini-w tone-${usageTone(w.pct)}`}>
          <span className="dim">{shortLabel(w)}</span>
          <span className={`usage-bar tone-${usageTone(w.pct)}`} aria-hidden><span style={{ width: `${Math.max(2, Math.min(100, w.pct))}%` }} /></span>
          <span className="mono">{Math.round(w.pct)}%</span>
        </span>
      ))}
    </span>
  );
}
