// Поиск сессий (Ctrl+K) — как /resume в Claude Code: все сессии всех сред, включая запущенные Claude Code напрямую
// (вне Perimeter). Слова — в названии, репликах, папке и тексте; ↑↓ Enter — открыть; чужую — завести в Perimeter.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientSet, EnvId, FoundSession } from '../supervisor';
import { envLabel } from '../connections';
import { ago } from './labels';
import { Icon } from './Icon';

type Row = FoundSession & { env: EnvId };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const home = (p: string | null) => (p ?? '').replace(/^\/home\/[^/]+|^\/root|^[A-Z]:\\Users\\[^\\]+/i, '~');

export function SessionSearch({ clients, envs, foreignFirst, onOpen, onClose }: {
  clients: ClientSet;
  envs: EnvId[];
  /** открыть сразу с фильтром «вне Perimeter» (из уведомления фонового поиска) */
  foreignFirst?: boolean;
  onOpen: (env: EnvId, sid: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [foreign, setForeign] = useState(foreignFirst === true);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [errs, setErrs] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  // запрос — с паузой: поиск по тексту читает транскрипты (сотни мс на больших)
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      const live = envs.filter((e) => clients.get(e).status === 'live');
      void Promise.allSettled(live.map((e) => clients.get(e).searchSessions(q.trim(), foreign).then((r) => r.sessions.map((s) => ({ ...s, env: e })))))
        .then((res) => {
          if (!alive) return;
          const ok = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
          setErrs(res.flatMap((r, i) => (r.status === 'rejected' ? [`${envLabel(live[i]!)}: ${/неизвестн|unknown|BAD_FRAME|схем/i.test(errText(r.reason)) ? 'supervisor старой версии — обновите' : errText(r.reason)}`] : [])));
          setRows(ok.sort((a, b) => b.updatedAt - a.updatedAt));
          setSel(0);
        });
    }, q === '' ? 0 : 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, foreign]); // eslint-disable-line react-hooks/exhaustive-deps

  const many = new Set(rows?.map((r) => r.env)).size > 1 || envs.length > 1;
  const open = (r: Row) => {
    if (r.perimeterId) { onOpen(r.env, r.perimeterId); onClose(); return; }
    setBusy(r.claudeSessionId);
    clients.get(r.env).adoptSession(r.account, r.claudeSessionId, r.title)
      .then((sid) => { onOpen(r.env, sid); onClose(); }, (e: unknown) => setErrs([errText(e)]))
      .finally(() => setBusy(null));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (!rows || rows.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = rows[sel]; if (r) open(r); }
  };
  useEffect(() => { list.current?.querySelector('.ss-row.on')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const foreignCount = useMemo(() => rows?.filter((r) => !r.perimeterId).length ?? 0, [rows]);

  return (
    <div className="modal-backdrop ss-backdrop" onMouseDown={onClose}>
      <div className="modal ss" role="dialog" aria-label="Поиск сессий" onKeyDown={onKey} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ss-top">
          <Icon name="search" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти сессию: название, реплика, папка, текст…" aria-label="Запрос" />
          <div className="seg ss-seg" role="tablist">
            <button type="button" role="tab" aria-selected={!foreign} className={!foreign ? 'on' : ''} onClick={() => setForeign(false)}>все</button>
            <button type="button" role="tab" aria-selected={foreign} className={foreign ? 'on' : ''} onClick={() => setForeign(true)}>вне Perimeter</button>
          </div>
        </div>
        {errs.map((e) => <p key={e} className="err-text ss-note">{e}</p>)}
        {rows === null && <p className="dim ss-note">ищу…</p>}
        {rows !== null && rows.length === 0 && <p className="dim ss-note">{foreign ? 'Сессий Claude Code вне Perimeter нет' : 'Ничего не нашлось'}</p>}
        <ul className="ss-list" ref={list}>
          {rows?.map((r, i) => (
            <li key={`${r.env}:${r.claudeSessionId}`} className={`ss-row ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => open(r)}>
              <div className="ss-head">
                <b className="ss-title">{r.title}</b>
                {!r.perimeterId && <span className="ss-badge" data-tip="Запущена Claude Code напрямую — откроется здесь с историей">{busy === r.claudeSessionId ? 'завожу…' : 'вне Perimeter'}</span>}
                {r.archived && <span className="ss-badge dim">архив</span>}
                <span className="spacer" />
                <span className="dim ss-when">{ago(r.updatedAt)}</span>
              </div>
              <div className="dim ss-meta">
                {many && <>{envLabel(r.env)} · </>}{r.account} · {home(r.cwd) || '—'}{r.gitBranch ? ` · ${r.gitBranch}` : ''} · реплик {r.messages}
              </div>
              {(r.match ?? r.firstPrompt) && <div className="ss-snippet">{r.match ?? r.firstPrompt}</div>}
            </li>
          ))}
        </ul>
        <div className="ss-foot dim">
          <span><kbd>↑</kbd><kbd>↓</kbd> выбрать · <kbd>Enter</kbd> открыть · <kbd>Esc</kbd> закрыть</span>
          <span className="spacer" />
          {rows !== null && <span>{rows.length}{foreignCount ? ` · вне Perimeter: ${foreignCount}` : ''}</span>}
        </div>
      </div>
    </div>
  );
}
