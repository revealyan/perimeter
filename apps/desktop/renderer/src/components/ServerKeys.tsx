// «С сервера» (владелец 2026-11-26: «в настройках видеть, что нужно взять с сервера — ключи ssh для гита»):
// открытые SSH-ключи пользователя службы — скопировать в GitHub или на другие машины; создать ключ; проверить,
// пускает ли GitHub. Только открытые части — приватные ключи сервер не отдаёт.
import { useEffect, useState } from 'react';
import type { GithubCheck, ServerKey, SupervisorClient } from '../supervisor';
import { Icon } from './Icon';

const GITHUB_NEW_KEY = 'https://github.com/settings/ssh/new';

function openExternal(url: string): void {
  const ipc = window.perimeterIPC;
  if (ipc?.openExternal) void ipc.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ServerKeys({ client, local }: { client: SupervisorClient; local: boolean }) {
  const live = client.status === 'live';
  const [keys, setKeys] = useState<ServerKey[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'check' | null>(null);
  const [check, setCheck] = useState<GithubCheck | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const who = local ? 'этого компьютера' : 'пользователя службы на сервере';

  const load = () => {
    setErr(null);
    client.keysList().then(setKeys, (e: unknown) => {
      // старый supervisor без cmd:keys.* — понятная подсказка вместо «неизвестной команды»
      setErr(/неизвестн|unknown|BAD_FRAME|схем/i.test(errText(e)) ? 'supervisor старой версии — обновите его (блок «Supervisor на сервере» во вкладке «Подключение»)' : errText(e));
    });
  };
  useEffect(() => { if (live) load(); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = (k: ServerKey) => {
    void navigator.clipboard.writeText(k.publicKey).then(() => {
      setCopied(k.fingerprint);
      setTimeout(() => setCopied((c) => (c === k.fingerprint ? null : c)), 2000);
    });
  };
  const create = () => {
    setBusy('create');
    setErr(null);
    client.keysCreate().then(() => load(), (e: unknown) => setErr(errText(e))).finally(() => setBusy(null));
  };
  const runCheck = () => {
    setBusy('check');
    setCheck(null);
    client.keysCheck().then(setCheck, (e: unknown) => setCheck({ ok: false, message: errText(e), hostKeysAdded: false })).finally(() => setBusy(null));
  };

  const ghKey = keys?.find((k) => k.github);
  return (
    <div className="srv-keys">
      <p className="dim st-sub">
        Что нужно взять отсюда. SSH-ключ {who}: его открытую часть добавьте в GitHub — агенты смогут клонировать
        и пушить по git@github.com; или на другую машину в <span className="mono">authorized_keys</span>. Приватный ключ остаётся на месте.
      </p>
      {!live && <p className="dim">нет связи с supervisor — ключи покажутся, когда подключение поднимется</p>}
      {err && <p className="err-text">{err}</p>}
      {keys && keys.length === 0 && <p className="dim">SSH-ключей у {who} нет.</p>}
      {keys && keys.length > 0 && (
        <ul className="srv-keys-list">
          {keys.map((k) => (
            <li key={k.file} className="srv-key">
              <div className="srv-key-head">
                <span className="mono srv-key-file">~/.ssh/{k.file}.pub</span>
                {k.github && <span className="badge-soft" data-tip="ssh возьмёт этот ключ для github.com">для GitHub</span>}
                {!k.hasPrivate && <span className="badge-soft warn-text" data-tip="рядом нет приватной части — войти с ним отсюда нельзя">без приватного</span>}
                <span className="spacer" />
                <button type="button" className="btn sm" onClick={() => copy(k)}>
                  {copied === k.fingerprint ? <><Icon name="check" size={12} /> скопирован</> : 'Копировать'}
                </button>
              </div>
              <div className="dim srv-key-meta"><span className="mono">{k.fingerprint}</span>{k.comment ? ` · ${k.comment}` : ''} · {k.type.replace(/^ssh-/, '')}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="srv-keys-actions">
        {keys && !ghKey && (
          <button type="button" className="btn primary sm" disabled={!live || busy !== null} onClick={create}>
            {busy === 'create' ? 'создаю…' : 'Создать ключ'}
          </button>
        )}
        <button type="button" className="btn sm" disabled={!live || busy !== null} onClick={runCheck}>
          {busy === 'check' ? 'проверяю…' : 'Проверить GitHub'}
        </button>
        <button type="button" className="link-btn" onClick={() => openExternal(GITHUB_NEW_KEY)}>
          <Icon name="externalLink" size={12} /> добавить ключ в GitHub
        </button>
        {keys && <button type="button" className="link-btn" disabled={!live} onClick={load}><Icon name="refresh" size={12} /> обновить</button>}
      </div>
      {check && (
        <p className={`srv-keys-result ${check.ok ? 'ok-text' : 'err-text'}`}>
          {check.ok ? <Icon name="check" size={12} /> : null} {check.message}
          {check.hostKeysAdded && <span className="dim"> · ключи хоста github.com записаны в known_hosts (опубликованные GitHub)</span>}
        </p>
      )}
    </div>
  );
}
