// Настройки → подключение → «MCP»: общий список серверов среды (2026-11-12, владелец: «одни на всех, уметь
// выключать»). Строка — сервер, под ней аккаунты-переключатели: кому включён. Серверы живут у самого Claude Code
// в настройках каждого аккаунта (`claude mcp … -s user`), запасная копия — у supervisor'а: выключенный у всех
// не теряется, новый аккаунт получает всё. Аккаунты с общим файлом настроек — один переключатель.
// Статусы — из `claude mcp list` у каждого аккаунта (до минуты): список сначала приходит без них, потом с ними.
// Добавление — McpInstall.tsx (каталог MCP, вставка из документации, вручную) — сразу всем аккаунтам.
import { useEffect, useRef, useState } from 'react';
import { CmdError, envLabel, profileLabel, type McpServer, type McpShared, type McpSharedRow, type ProfileInfo, type SupervisorClient } from '../supervisor';
import { Icon } from './Icon';
import { SubscriptionLogin } from './AddAccountDialog';
import { AddMcp } from './McpInstall';
import { keepKnownStatuses } from '../lib/mcpStatus';

function errText(e: unknown): string {
  return e instanceof CmdError || e instanceof Error ? e.message : String(e);
}

const STATUS: Record<McpServer['status'], { dot: string; text: string }> = {
  connected: { dot: 'dot-green', text: 'подключён' },
  'needs-auth': { dot: 'dot-amber', text: 'нужен вход' },
  failed: { dot: 'dot-red', text: 'не подключается' },
  pending: { dot: 'dot-off', text: 'ждёт одобрения' },
  unknown: { dot: 'dot-off', text: 'не проверялся' },
};

/** Худший статус по аккаунтам, где сервер включён: точка строки. */
function rowStatus(r: McpSharedRow): McpServer['status'] | null {
  const all = Object.values(r.on).map((x) => x.status);
  if (all.length === 0) return null;
  for (const s of ['failed', 'needs-auth', 'pending', 'connected'] as const) if (all.includes(s)) return s;
  return 'unknown';
}

function McpDialog({ client, profile, servers, login, onClose, onChanged }: {
  client: SupervisorClient; profile: ProfileInfo; servers: McpServer[]; login?: { profile: string; name: string };
  onClose: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  // не у всех встал: окно не закрываем, чтобы было видно у кого и почему (состояние в замыкании ещё старое)
  const partial = useRef('');
  const loginLabel = login ? profileLabel(client.profiles.find((p) => p.name === login.profile) ?? { name: login.profile }) : '';
  // ставим всем аккаунтам; где не встал — пишем, у кого и почему
  const add = async (name: string, config: Parameters<SupervisorClient['mcpSharedAdd']>[1]): Promise<McpServer[]> => {
    const res = await client.mcpSharedAdd(name, config);
    const bad = res.filter((r) => !r.ok);
    if (res.length > 0 && bad.length === res.length) throw new Error(bad[0]?.error ?? 'не добавился');
    if (bad.length > 0) {
      partial.current = `Добавлен не у всех: ${bad.map((b) => `${profileLabel(client.profiles.find((p) => p.name === b.profile) ?? { name: b.profile })} — ${b.error ?? 'ошибка'}`).join('; ')}`;
      setErr(partial.current);
    }
    return [];
  };
  return (
    <div className="modal-backdrop aa-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal aa" role="dialog" aria-label={login ? 'Вход в MCP-сервер' : 'Добавить MCP-сервер'} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.rb-stage')) { e.stopPropagation(); onClose(); } }}>
        <div className="aa-head">
          <div>
            <div className="modal-title">{login ? `Вход: ${login.name}` : 'Добавить MCP-сервер'}</div>
            <div className="dim aa-sub">{login
              ? `Аккаунт «${loginLabel}» на «${envLabel(client.environment)}»`
              : `Всем аккаунтам на «${envLabel(client.environment)}» — выключить у отдельного аккаунта можно в списке`}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><Icon name="x" size={16} /></button>
        </div>
        {login
          ? <SubscriptionLogin client={client} mcp={login} setBusy={setBusy} setDone={setDone} onDone={() => { onChanged(); onClose(); }} />
          : <AddMcp client={client} profile={profile} servers={servers} taken={new Set(servers.map((s) => s.name))} add={add}
              onAdded={() => { onChanged(); if (!partial.current) onClose(); }} />}
        {err && <div className="warn-text acct-note" role="status">{err}</div>}
        {login && !done && (
          <div className="modal-actions aa-foot">
            <button className="btn" onClick={onClose}>{busy ? 'Отмена' : 'Закрыть'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function McpSettings({ client }: { client: SupervisorClient }) {
  const [data, setData] = useState<McpShared | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [old, setOld] = useState(false);
  const [dlg, setDlg] = useState<null | { login?: { profile: string; name: string } }>(null);
  const [confirm, setConfirm] = useState('');
  const live = client.status === 'live';

  const load = async (check: boolean) => {
    setErr('');
    if (check) setChecking(true);
    try {
      const res = await client.mcpShared(check);
      // без проверки статусы приходят «unknown» — известные не затираем (иначе список моргает после каждого действия)
      setData((prev) => (check ? res : keepKnownStatuses(prev, res)));
    } catch (e) {
      // supervisor до общего списка MCP: команды не знает
      if (e instanceof CmdError && /unknown|неизвест|BAD_FRAME|PARSE/i.test(`${e.code} ${e.message}`)) setOld(true);
      else setErr(errText(e));
    } finally {
      if (check) setChecking(false);
    }
  };
  // сначала быстро (по файлам настроек), затем со статусами
  // другая среда — список с нуля; переподключение той же — старый список виден, пока не придёт новый
  useEffect(() => { setData(null); }, [client]);
  useEffect(() => {
    if (live) void load(false).then(() => load(true));
  }, [live, client]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = (t: { profiles: string[] }) => t.profiles.map((n) => profileLabel(client.profiles.find((p) => p.name === n) ?? { name: n })).join(' · ');
  const toggle = async (t: { id: string }, r: McpSharedRow, on: boolean) => {
    setBusy(`${t.id}:${r.name}`);
    setErr('');
    try {
      await client.mcpToggle(t.id, r.name, on);
      await load(false);
      void load(true);
    } catch (e) { setErr(errText(e)); } finally { setBusy(''); }
  };
  const removeAll = async (name: string) => {
    if (confirm !== name) { setConfirm(name); return; }
    setConfirm('');
    setBusy(`rm:${name}`);
    try {
      const res = await client.mcpSharedRemove(name);
      const bad = res.filter((x) => !x.ok);
      if (bad.length) setErr(`Не удалился у: ${bad.map((b) => `${b.profile} — ${b.error ?? 'ошибка'}`).join('; ')}`);
      await load(false);
    } catch (e) { setErr(errText(e)); } finally { setBusy(''); }
  };

  const installZai = async () => {
    setBusy('preset');
    setErr('');
    try {
      const r = await client.mcpPreset('zai');
      const bad = Object.entries(r.results).flatMap(([n, res]) => res.filter((x) => !x.ok).map((x) => `${n} у ${x.profile} — ${x.error ?? 'ошибка'}`));
      if (bad.length) setErr(`Не всё встало: ${bad.join('; ')}`);
      await load(false);
      void load(true);
    } catch (e) { setErr(errText(e)); } finally { setBusy(''); }
  };

  if (old) return <div className="warn-text acct-note">supervisor этой среды старой версии — общего списка MCP он не знает. Обновите его.</div>;
  const targets = data?.targets ?? [];
  // аккаунт для подсказки «ключ аккаунта» при добавлении: шлюз с ключом, иначе первый
  const keyProfile = client.profiles.find((p) => p.keyEditable && p.keyHint && p.gatewayHost && targets.some((t) => t.profiles.includes(p.name)))
    ?? client.profiles.find((p) => targets.some((t) => t.profiles.includes(p.name)))
    ?? client.profiles[0];
  const asServers: McpServer[] = (data?.servers ?? []).map((r) => ({ name: r.name, transport: r.transport, target: r.target, status: 'unknown', statusText: '', scope: 'user' }));

  const row = (r: McpSharedRow) => {
    const st = rowStatus(r);
    const needAuth = targets.filter((t) => r.on[t.id]?.status === 'needs-auth');
    return (
      <div key={r.name} className="mcp-row">
        <span className={`dot ${st ? STATUS[st].dot : 'dot-off'}`} />
        <div className="mcp-main">
          <div>
            <b>{r.name}</b> <span className="dim mcp-tr">{r.transport === 'stdio' ? 'stdio' : r.transport.toUpperCase()}</span>
            {st && st !== 'unknown' && <> <span className={`mcp-st ${st}`}>{STATUS[st].text}</span></>}
            {r.accountKey && <> <span className="mcp-keytag" data-tip="У каждого аккаунта-шлюза — его собственный ключ; у остальных — ключ, с которым сервер добавили">ключ аккаунта</span></>}
          </div>
          <div className="dim mono mcp-target" title={r.target}>{r.target}{r.headerNames?.length ? ` · заголовки: ${r.headerNames.join(', ')}` : ''}{r.envNames?.length ? ` · переменные: ${r.envNames.join(', ')}` : ''}</div>
          <div className="mcp-accts" role="group" aria-label={`Аккаунты · ${r.name}`}>
            {targets.map((t) => {
              const s = r.on[t.id];
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`mcp-acct ${s ? 'on' : ''}`}
                  aria-pressed={!!s}
                  disabled={busy !== ''}
                  onClick={() => void toggle(t, r, !s)}
                  data-tip={s ? `Включён у «${label(t)}»: ${STATUS[s.status].text}. Нажмите, чтобы выключить — уберётся из настроек Claude Code этого аккаунта` : `Выключен у «${label(t)}». Нажмите, чтобы включить`}
                >
                  {s ? <span className={`dot ${STATUS[s.status].dot}`} /> : <Icon name="plus" size={10} />}
                  {busy === `${t.id}:${r.name}` ? '…' : label(t)}
                </button>
              );
            })}
            {needAuth.map((t) => (
              <button key={`login-${t.id}`} type="button" className="link-btn" onClick={() => setDlg({ login: { profile: t.id, name: r.name } })}>Войти · {label(t)}</button>
            ))}
          </div>
        </div>
        <button
          className={`btn sm ${confirm === r.name ? 'danger-ghost' : 'ghost'}`}
          disabled={busy !== ''}
          onClick={() => void removeAll(r.name)}
          onBlur={() => setConfirm('')}
          data-tip="Убрать у всех аккаунтов и из общего списка"
        >{confirm === r.name ? 'Точно удалить у всех?' : 'Удалить'}</button>
      </div>
    );
  };

  return (
    <div className="field accounts mcp">
      <div className="acct-top">
        <span>MCP-серверы — общие для аккаунтов на «{envLabel(client.environment)}»: включайте и выключайте у каждого</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!live || checking} onClick={() => void load(true)} data-tip="Claude Code проверит каждый сервер у каждого аккаунта — до минуты">
          <Icon name="refresh" size={12} /> {checking ? 'Проверяю…' : 'Проверить'}
        </button>
        <button className="btn sm primary" disabled={!live || targets.length === 0 || !keyProfile} onClick={() => setDlg({})}><Icon name="plus" size={12} /> Добавить MCP-сервер</button>
      </div>
      {!live && <div className="warn-text acct-note">Нет связи с «{envLabel(client.environment)}».</div>}
      {data === null && live && !err && <div className="dim acct-note"><Icon name="loader" size={12} className="spin" /> Читаю настройки аккаунтов…</div>}
      {data !== null && targets.length === 0 && <div className="dim acct-note">Нет аккаунтов, в которые выполнен вход, — сначала добавьте аккаунт.</div>}
      {data !== null && targets.length > 0 && data.servers.length === 0 && (
        <div className="dim acct-note">MCP-серверов пока нет. «Добавить MCP-сервер» — из каталога MCP, вставкой из документации сервера или вручную; сервер появится у всех аккаунтов.</div>
      )}
      {data?.presets?.map((pr) => (
        <div key={pr.id} className="mcp-preset">
          <Icon name="sparkles" size={14} />
          <span>Стандартные MCP-серверы z.ai — поиск, чтение страниц, zread (репозитории GitHub), распознавание изображений: <span className="dim mono">{pr.missing.join(', ')}</span></span>
          <span className="spacer" />
          <button className="btn sm primary" disabled={busy !== ''} onClick={() => void installZai()} data-tip="Всем аккаунтам, с ключом z.ai; у аккаунта z.ai — его собственный ключ">
            {busy === 'preset' ? 'Ставлю…' : 'Поставить'}
          </button>
        </div>
      ))}
      {checking && data !== null && <div className="dim acct-note"><Icon name="loader" size={12} className="spin" /> Claude Code проверяет серверы…</div>}
      {data !== null && data.servers.length > 0 && <div className="mcp-list">{data.servers.map(row)}</div>}
      {data !== null && data.other.length > 0 && (
        <>
          <div className="dim acct-note">Ещё доступны сессиям — из проекта, плагина или claude.ai (здесь не переключаются):</div>
          <div className="mcp-list">
            {data.other.map((o) => (
              <div key={o.name} className="mcp-row">
                <span className="dot dot-off" />
                <div className="mcp-main">
                  <div><b>{o.name}</b> <span className="dim mcp-tr">{o.transport === 'stdio' ? 'stdio' : o.transport.toUpperCase()}</span></div>
                  <div className="dim mono mcp-target" title={o.target}>{o.target}</div>
                </div>
                <span className="dim mcp-other">{o.targets.map((id) => label(targets.find((t) => t.id === id) ?? { profiles: [id] })).join(', ')}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {err && <div className="err-text acct-err">{err}</div>}
      {dlg && keyProfile && (
        <McpDialog client={client} profile={keyProfile} servers={asServers} {...(dlg.login ? { login: dlg.login } : {})}
          onClose={() => setDlg(null)} onChanged={() => { void load(false).then(() => load(true)); }} />
      )}
    </div>
  );
}
