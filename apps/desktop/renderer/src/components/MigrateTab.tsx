// «Переезд» (docs/design/migration.md): этот сервер — цель, источник — другое подключение. Опись обоих → план:
// что поедет, как, что уже есть, что сделать на новом сервере. Этап 1 — только план; перенос — следующими этапами.
import { useEffect, useState } from 'react';
import type { Inventory } from '@perimeter/protocol';
import type { ClientSet, EnvId } from '../supervisor';
import type { Conn } from '../connections';
import { fmtBytes, GROUP_TITLE, migrationPlan, type PlanAction, type PlanGroup, type PlanItem } from '../lib/migrationPlan';
import { Icon, type IconName } from './Icon';

const ACTION: Record<PlanAction, { label: string; icon: IconName; cls: string }> = {
  copy: { label: 'перенесу', icon: 'arrowRight', cls: 'go' },
  clone: { label: 'клон', icon: 'gitBranch', cls: 'go' },
  bundle: { label: 'бандл', icon: 'gitBranch', cls: 'go' },
  archive: { label: 'архив', icon: 'archive', cls: 'go' },
  exists: { label: 'уже есть', icon: 'check', cls: 'ok' },
  manual: { label: 'сделать', icon: 'pointer', cls: 'todo' },
  skip: { label: 'не везём', icon: 'x', cls: 'dim' },
};
const ORDER: PlanGroup[] = ['accounts', 'mcp', 'projects', 'sessions', 'data', 'todo'];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function MigrateTab({ clients, conns, target }: { clients: ClientSet; conns: Conn[]; target: EnvId }) {
  const dstClient = clients.get(target);
  const sources = conns.filter((c) => c.id !== target && c.enabled);
  const [srcId, setSrcId] = useState<EnvId | null>(sources[0]?.id ?? null);
  const [inv, setInv] = useState<{ src: Inventory; dst: Inventory } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const load = () => {
    if (!srcId) return;
    setLoading(true);
    setErr(null);
    setInv(null);
    Promise.all([clients.get(srcId).migrateInventory(), dstClient.migrateInventory()])
      .then(([src, dst]) => { setInv({ src, dst }); setPicked({}); })
      .catch((e: unknown) => setErr(/неизвестн|unknown|BAD_FRAME|схем/i.test(errText(e)) ? 'на одном из серверов supervisor старой версии — обновите его (вкладка «Подключение»)' : errText(e)))
      .finally(() => setLoading(false));
  };
  const srcLive = srcId !== null && clients.get(srcId).status === 'live';
  const dstLive = dstClient.status === 'live';
  useEffect(() => { if (srcLive && dstLive) load(); }, [srcId, srcLive, dstLive]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = inv ? migrationPlan(inv.src, inv.dst) : [];
  const isOn = (i: PlanItem) => picked[i.id] ?? i.on;
  const checkable = (i: PlanItem) => i.action === 'copy' || i.action === 'clone' || i.action === 'bundle' || i.action === 'archive';
  const chosen = plan.filter((i) => checkable(i) && isOn(i));
  const name = (id: EnvId) => conns.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="migrate">
      <p className="dim st-sub">
        Перенести сюда всё с другого сервера: аккаунты, MCP, проекты, сессии с историей. Старый сервер не трогаем,
        пока не скажете. Приватные ключи и входы подписки не копируются — их план покажет делом на новом сервере.
      </p>
      {sources.length === 0
        ? <p className="dim">Нет другого подключения — добавьте старый сервер в «Подключения», чтобы переехать с него.</p>
        : (
          <div className="migrate-src">
            <span>Откуда:</span>
            <select value={srcId ?? ''} onChange={(e) => setSrcId(e.target.value)}>
              {sources.map((c) => <option key={c.id} value={c.id}>{c.name}{clients.get(c.id).status === 'live' ? '' : ' — нет связи'}</option>)}
            </select>
            <Icon name="arrowRight" size={14} className="dim" />
            <b>{name(target)}</b>
            <span className="spacer" />
            <button type="button" className="link-btn" disabled={!srcLive || !dstLive || loading} onClick={load}><Icon name="refresh" size={12} /> пересчитать</button>
          </div>
        )}
      {srcId && !srcLive && <p className="dim">нет связи с «{name(srcId)}» — опись появится, когда подключение поднимется</p>}
      {!dstLive && <p className="dim">нет связи с этим сервером</p>}
      {loading && <p className="dim">собираю опись обоих серверов…</p>}
      {err && <p className="err-text">{err}</p>}
      {inv && (
        <>
          <p className="dim migrate-servers">
            {inv.src.server.user}@{inv.src.server.host} ({inv.src.server.storageRoot}) <Icon name="arrowRight" size={12} /> {inv.dst.server.user}@{inv.dst.server.host} ({inv.dst.server.storageRoot})
          </p>
          {ORDER.map((g) => {
            const items = plan.filter((i) => i.group === g);
            if (items.length === 0) return null;
            return (
              <section key={g} className="migrate-group">
                <div className="psec-title"><span>{GROUP_TITLE[g]}</span></div>
                <ul className="migrate-list">
                  {items.map((i) => {
                    const a = ACTION[i.action];
                    return (
                      <li key={i.id} className={`migrate-item m-${a.cls}`}>
                        {checkable(i)
                          ? <input type="checkbox" checked={isOn(i)} onChange={(e) => setPicked((p) => ({ ...p, [i.id]: e.target.checked }))} aria-label={i.title} />
                          : <span className="migrate-ico"><Icon name={a.icon} size={13} /></span>}
                        <div className="migrate-body">
                          <div className="migrate-head">
                            <b>{i.title}</b>
                            <span className={`migrate-badge m-${a.cls}`}>{a.label}</span>
                            {i.bytes !== undefined && i.bytes > 0 && <span className="dim">{fmtBytes(i.bytes)}</span>}
                          </div>
                          <div className="dim migrate-detail">{i.detail}</div>
                          {i.warn && <div className="warn-text migrate-detail">{i.warn}</div>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          <div className="migrate-actions">
            <span className="dim">выбрано: {chosen.length}</span>
            <span className="spacer" />
            <button type="button" className="btn primary" disabled data-tip="Перенос — следующим обновлением; сейчас — опись и план">Перенести выбранное</button>
          </div>
        </>
      )}
    </div>
  );
}
