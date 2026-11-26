// «Переезд» (владелец 2026-11-26): галками — что взять с этого сервера; дальше либо сразу на другой сервер
// («бамбамбам», но не ломая то, что там уже есть), либо скачать архив. И обратно: загрузить архив сюда.
// Перед импортом — превью цели: что добавится, что уже есть (не трогаем), что встанет рядом.
import { useEffect, useRef, useState } from 'react';
import type { Inventory } from '@perimeter/protocol';
import type { ClientSet, EnvId, MigrateDecision, MigrateSelection, SupervisorClient } from '../supervisor';
import type { Conn } from '../connections';
import { fmtBytes, GROUP_TITLE, migrationPlan, type PlanGroup, type PlanItem } from '../lib/migrationPlan';
import { archiveName, download, relay, sha256Hex, upload } from '../lib/migrateTransfer';
import { Icon } from './Icon';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oldSup = (e: unknown) => (/неизвестн|unknown|BAD_FRAME|схем/i.test(errText(e)) ? 'supervisor старой версии — обновите его (вкладка «Подключение»)' : errText(e));
const EMPTY: Inventory = {
  server: { host: '', user: '', home: '', platform: '', version: '', storageRoot: '' }, accounts: [], mcpShared: [], projects: [],
  sessions: { total: 0, archived: 0, withoutProject: 0, noTranscript: 0, byAccount: {} }, thinking: { bytes: 0 }, browserProfile: { exists: false, bytes: 0 },
  git: { name: null, email: null }, github: { keyComment: null, fingerprint: null }, extras: { crontab: false, userUnits: [], dockerData: false },
};
const PICKABLE = new Set(['copy', 'clone', 'bundle', 'archive']);
const OUT_GROUPS: PlanGroup[] = ['accounts', 'mcp', 'projects', 'sessions', 'data', 'todo'];

/** Галки плана → что положить в пакет. */
export function selectionOf(items: PlanItem[], on: (i: PlanItem) => boolean, secrets: boolean): MigrateSelection {
  const picked = (prefix: string) => items.filter((i) => i.id.startsWith(prefix) && PICKABLE.has(i.action) && on(i)).map((i) => i.id.slice(prefix.length));
  const has = (id: string) => items.some((i) => i.id === id && on(i));
  return {
    accounts: picked('acc:'), mcp: picked('mcp:'), projects: picked('prj:'),
    sessions: has('ses:archived') ? 'all' : has('ses:active') ? 'active' : 'none',
    thinking: has('data:thinking'), browser: has('data:browser'), gitIdentity: has('data:gitid'), secrets,
  };
}

type Phase = { step: string; done?: number; total?: number } | null;

function Progress({ phase }: { phase: Phase }) {
  if (!phase) return null;
  const pct = phase.total ? Math.round((100 * (phase.done ?? 0)) / phase.total) : null;
  return (
    <div className="migrate-progress" role="status">
      <span className="dim">{phase.step}{pct !== null ? ` · ${fmtBytes(phase.done ?? 0)} из ${fmtBytes(phase.total ?? 0)}` : '…'}</span>
      {pct !== null && <span className="usage-bar" aria-hidden><span style={{ width: `${Math.max(2, pct)}%` }} /></span>}
    </div>
  );
}

/** Превью на цели и импорт: что добавится / уже есть (не трогаем) / встанет рядом. */
function ImportReview({ target, targetName, pkg, decisions, onDone }: { target: SupervisorClient; targetName: string; pkg: string; decisions: MigrateDecision[]; onDone: () => void }) {
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Array<{ id: string; ok: boolean; text: string }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const on = (d: MigrateDecision) => picked[d.id] ?? d.on;
  const can = (d: MigrateDecision) => d.action !== 'exists' && d.action !== 'skip';
  const chosen = decisions.filter((d) => can(d) && on(d)).map((d) => d.id);
  const run = () => {
    setBusy(true);
    setErr(null);
    target.migrateImport(pkg, chosen).then((l) => { setLines(l); target.migrateDrop(pkg); onDone(); }, (e: unknown) => setErr(errText(e))).finally(() => setBusy(false));
  };
  if (lines) {
    return (
      <div className="migrate-report">
        <b>Готово — перенесено на «{targetName}»</b>
        <ul className="migrate-list">{lines.map((l, i) => <li key={i} className={`migrate-item ${l.ok ? 'm-ok' : 'm-todo'}`}><span className="migrate-ico"><Icon name={l.ok ? 'check' : 'alert'} size={13} /></span><span>{l.text}</span></li>)}</ul>
        {lines.length === 0 && <p className="dim">Нечего было переносить — всё уже есть.</p>}
      </div>
    );
  }
  const groups: Array<MigrateDecision['group']> = ['accounts', 'mcp', 'projects', 'sessions', 'data'];
  return (
    <div className="migrate-review">
      <p className="dim st-sub">Что встанет на «{targetName}». Своё там не перезаписывается: что уже есть — не трогаю.</p>
      {groups.map((g) => {
        const ds = decisions.filter((d) => d.group === g);
        if (ds.length === 0) return null;
        return (
          <section key={g} className="migrate-group">
            <div className="psec-title"><span>{GROUP_TITLE[g]}</span></div>
            <ul className="migrate-list">
              {ds.map((d) => (
                <li key={d.id} className={`migrate-item ${can(d) ? 'm-go' : 'm-ok'}`}>
                  {can(d) ? <input type="checkbox" checked={on(d)} onChange={(e) => setPicked((p) => ({ ...p, [d.id]: e.target.checked }))} aria-label={d.title} /> : <span className="migrate-ico"><Icon name="check" size={13} /></span>}
                  <div className="migrate-body">
                    <div className="migrate-head"><b>{d.title}</b><span className={`migrate-badge m-${can(d) ? 'go' : 'ok'}`}>{({ add: 'добавлю', exists: 'уже есть', rename: 'рядом', login: 'вход заново', nokey: 'без ключа', skip: 'не везём' } as const)[d.action]}</span></div>
                    <div className="dim migrate-detail">{d.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {err && <p className="err-text">{err}</p>}
      <div className="migrate-actions">
        <span className="dim">выбрано: {chosen.length}</span>
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={busy || chosen.length === 0} onClick={run}>{busy ? 'импортирую…' : 'Импортировать'}</button>
      </div>
    </div>
  );
}

export function MigrateTab({ clients, conns, here }: { clients: ClientSet; conns: Conn[]; here: EnvId }) {
  const me = clients.get(here);
  const live = me.status === 'live';
  const others = conns.filter((c) => c.id !== here && c.enabled);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [secrets, setSecrets] = useState(true);
  const [dest, setDest] = useState<string>(others[0]?.id ?? 'archive');
  const [phase, setPhase] = useState<Phase>(null);
  const [review, setReview] = useState<{ target: SupervisorClient; targetName: string; pkg: string; decisions: MigrateDecision[] } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => { setErr(null); me.migrateInventory().then(setInv, (e: unknown) => setErr(oldSup(e))); };
  useEffect(() => { if (live) load(); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = inv ? migrationPlan(inv, EMPTY) : [];
  const on = (i: PlanItem) => picked[i.id] ?? i.on;
  const sel = selectionOf(plan, on, secrets);
  const empty = sel.accounts.length + sel.mcp.length + sel.projects.length === 0 && sel.sessions === 'none' && !sel.thinking && !sel.browser && !sel.gitIdentity;
  const busy = phase !== null;

  const fail = (e: unknown) => { setErr(oldSup(e)); setPhase(null); };
  const exportAnd = async (then: (pkg: string, bytes: number, sha256: string) => Promise<void>) => {
    setErr(null); setSaved(null); setReview(null);
    setPhase({ step: 'собираю пакет на этом сервере' });
    const ex = await me.migrateExport(sel);
    try { await then(ex.pkg, ex.bytes, ex.sha256); } finally { me.migrateDrop(ex.pkg); }
  };
  const toServer = () => {
    const target = clients.get(dest);
    void exportAnd(async (pkg, _b, sha) => {
      const name = conns.find((c) => c.id === dest)?.name ?? dest;
      const dstPkg = await relay(me, pkg, target, (done, total) => setPhase({ step: `передаю на «${name}»`, done, total }));
      setPhase({ step: `«${name}» проверяет, что встанет` });
      const pv = await target.migratePreview(dstPkg, sha);
      setReview({ target, targetName: name, pkg: dstPkg, decisions: pv.decisions });
      setPhase(null);
    }).catch(fail);
  };
  const toArchive = () => {
    void exportAnd(async (pkg) => {
      const blob = await download(me, pkg, (done, total) => setPhase({ step: 'скачиваю архив', done, total }));
      const name = archiveName(inv?.server.host ?? 'server');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      setSaved(`${name} · ${fmtBytes(blob.size)}${sel.secrets ? ' — внутри ключи и токены: храните как пароль' : ''}`);
      setPhase(null);
    }).catch(fail);
  };
  const fromFile = (file: File) => {
    setErr(null); setSaved(null); setReview(null);
    void (async () => {
      setPhase({ step: 'проверяю архив' });
      const sha = await sha256Hex(file);
      const pkg = await upload(me, file, (done, total) => setPhase({ step: 'загружаю архив на сервер', done, total }));
      setPhase({ step: 'смотрю, что встанет' });
      const pv = await me.migratePreview(pkg, sha);
      setReview({ target: me, targetName: conns.find((c) => c.id === here)?.name ?? 'этот сервер', pkg, decisions: pv.decisions });
      setPhase(null);
    })().catch(fail);
  };

  if (review) {
    return (
      <div className="migrate">
        <button type="button" className="link-btn migrate-back" onClick={() => { review.target.migrateDrop(review.pkg); setReview(null); }}><Icon name="arrowLeft" size={12} /> назад</button>
        <ImportReview target={review.target} targetName={review.targetName} pkg={review.pkg} decisions={review.decisions} onDone={() => load()} />
      </div>
    );
  }
  return (
    <div className="migrate">
      <section className="migrate-group">
        <div className="psec-title"><span>Перенести отсюда</span></div>
        <p className="dim st-sub">Отметьте, что взять. Дальше — сразу на другой сервер (там покажу, что уже есть, и ничего своего не трону) или архивом к себе на компьютер.</p>
        {!live && <p className="dim">нет связи с этим сервером</p>}
        {err && <p className="err-text">{err}</p>}
        {inv && OUT_GROUPS.map((g) => {
          const items = plan.filter((i) => i.group === g && i.action !== 'skip');
          if (items.length === 0) return null;
          return (
            <div key={g} className="migrate-subgroup">
              <div className="dim migrate-gtitle">{GROUP_TITLE[g]}</div>
              <ul className="migrate-list">
                {items.map((i) => (
                  <li key={i.id} className={`migrate-item ${PICKABLE.has(i.action) ? 'm-go' : 'm-todo'}`}>
                    {PICKABLE.has(i.action)
                      ? <input type="checkbox" checked={on(i)} disabled={busy} onChange={(e) => setPicked((p) => ({ ...p, [i.id]: e.target.checked }))} aria-label={i.title} />
                      : <span className="migrate-ico"><Icon name="pointer" size={13} /></span>}
                    <div className="migrate-body">
                      <div className="migrate-head"><b>{i.title}</b>{i.bytes !== undefined && i.bytes > 0 && <span className="dim">{fmtBytes(i.bytes)}</span>}</div>
                      <div className="dim migrate-detail">{i.detail}</div>
                      {i.warn && <div className="warn-text migrate-detail">{i.warn}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {inv && (
          <>
            <label className="migrate-opt"><input type="checkbox" checked={secrets} disabled={busy} onChange={(e) => setSecrets(e.target.checked)} /> с ключами и токенами аккаунтов и MCP <span className="dim">— без них аккаунты переедут пустыми, ключи впишете на новом</span></label>
            <div className="migrate-actions">
              <span>Куда:</span>
              <select value={dest} disabled={busy} onChange={(e) => setDest(e.target.value)}>
                {others.map((c) => <option key={c.id} value={c.id}>на сервер «{c.name}»{clients.get(c.id).status === 'live' ? '' : ' — нет связи'}</option>)}
                <option value="archive">архивом на этот компьютер</option>
              </select>
              <span className="spacer" />
              {dest === 'archive'
                ? <button type="button" className="btn primary" disabled={busy || empty || !live} onClick={toArchive}>Скачать архив</button>
                : <button type="button" className="btn primary" disabled={busy || empty || !live || clients.get(dest).status !== 'live'} onClick={toServer}>Перенести</button>}
            </div>
          </>
        )}
        <Progress phase={phase} />
        {saved && <p className="ok-text">Сохранено: {saved}</p>}
      </section>
      <section className="migrate-group">
        <div className="psec-title"><span>Загрузить архив сюда</span></div>
        <p className="dim st-sub">Архив переезда с другого сервера: покажу, что встанет на этот, — отметите галками и импортируете.</p>
        <input ref={fileRef} type="file" accept=".tgz,.tar.gz,application/gzip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) fromFile(f); }} />
        <div><button type="button" className="btn" disabled={busy || !live} onClick={() => fileRef.current?.click()}>Выбрать архив…</button></div>
      </section>
    </div>
  );
}
