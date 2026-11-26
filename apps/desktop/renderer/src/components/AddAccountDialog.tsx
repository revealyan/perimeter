// Окно «Добавить аккаунт» (эталон 003-accounts-add): подписка Claude — вход на стороне сервера, страница Anthropic
// открыта во вкладке браузера на сервере, код со страницы-ответа supervisor забирает сам; запасной путь — открыть
// страницу у себя и вставить код. Ключ API — шаблоны Anthropic / z.ai / свой адрес, ключ только уходит на сервер.
// Пароль от Claude вводится только на сайте Anthropic; токены остаются в папке аккаунта на сервере.
// Токен подписки можно выпустить, не выходя из приложения: «Получить токен» — локальный supervisor запускает
// `claude setup-token`, вход идёт в браузере владельца (Cloudflare не мешает), токен сам встаёт в форму.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CmdError, envLabel, profileLabel, type EnvId, type KeyCheck, type KeyTemplate, type LoginEvent, type ProfileInfo, type SupervisorClient } from '../supervisor';
import { explainApiError } from '../lib/apiErrors';
import { Icon } from './Icon';
import { RemoteBrowser } from './RemoteBrowser';

function errText(e: unknown): string {
  return e instanceof CmdError || e instanceof Error ? e.message : String(e);
}

function openExternal(url: string): void {
  const ipc = window.perimeterIPC;
  if (ipc?.openExternal) void ipc.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

const TEMPLATES: Array<{ id: KeyTemplate; label: string; name: string; url?: string; hint: string }> = [
  { id: 'claude-token', label: 'Токен подписки Claude', name: 'claude', url: 'подписка Claude — через Claude Code', hint: 'кнопка «Получить токен» — вход на странице Anthropic в вашем браузере, токен подставится сам; или выпустите у себя командой «claude setup-token» и вставьте sk-ant-oat…; живёт около года' },
  { id: 'anthropic', label: 'Anthropic', name: 'api', hint: 'ключ с console.anthropic.com; модели — из Claude Code' },
  { id: 'zai', label: 'z.ai GLM', name: 'zai', url: 'https://api.z.ai/api/anthropic', hint: 'ключ со вкладки «Personal Coding Plan»: ключи со «Standard» кодинг-план не берут (429 · 1113)' },
  { id: 'custom', label: 'Свой адрес', name: 'gw', hint: 'сервис, совместимый с Anthropic API; модели добавите в карточке аккаунта' },
];
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Вход на стороне сервера (браузер на сервере + запасной путь руками). По умолчанию — подписка Claude
 * (profile — войти в существующий аккаунт); mcp — вход OAuth в MCP-сервер аккаунта (`claude mcp login`).
 */
export function SubscriptionLogin({ client, profile, mcp, onDone, setBusy, setDone, onUseToken }: { client: SupervisorClient; profile?: ProfileInfo; mcp?: { profile: string; name: string }; onDone: () => void; setBusy: (b: boolean) => void; setDone: (d: boolean) => void; onUseToken?: () => void }) {
  const [loginId, setLoginId] = useState<string | null>(null);
  const [ev, setEv] = useState<LoginEvent | null>(null);
  const [startErr, setStartErr] = useState('');
  const [fallback, setFallback] = useState(false);
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const seen = useRef(new Map<string, LoginEvent>());
  const current = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // свой компьютер: страницу входа открыл сам Claude Code в обычном браузере — вкладки и кода нет, вход завершится сам
  const [own, setOwn] = useState(false);
  // страница входа дольше 10 с на проверке Cloudflare («Just a moment…») — предложить токен или код
  const [cfSince, setCfSince] = useState<number | null>(null);
  const [cfStuck, setCfStuck] = useState(false);
  const onPage = useCallback((st: { title: string }) => {
    const cf = /just a moment|security verification|attention required/i.test(st.title);
    setCfSince((s) => (cf ? s ?? Date.now() : null));
    if (!cf) setCfStuck(false);
  }, []);
  useEffect(() => {
    if (cfSince === null) return;
    const t = setTimeout(() => setCfStuck(true), Math.max(0, 10_000 - (Date.now() - cfSince)));
    return () => clearTimeout(t);
  }, [cfSince]);
  const onTabExit = useCallback(() => setFallback(true), []);

  // события входа могут прийти раньше ответа на start — копим по loginId
  useEffect(() => client.onLogin((e) => {
    seen.current.set(e.loginId, e);
    if (e.loginId === current.current) setEv(e);
  }), [client]);

  useEffect(() => {
    let on = true;
    setEv(null); setStartErr(''); setCode(''); setCodeErr(''); setFallback(false);
    void (mcp
      ? client.mcpLoginStart({ profile: mcp.profile, name: mcp.name, width: 1100, height: 720 })
      : client.loginStart({ ...(profile ? { profile: profile.name } : {}), width: 1100, height: 720 })).then(
      (r) => {
        if (!on) { client.loginCancel(r.loginId); return; }
        current.current = r.loginId;
        setLoginId(r.loginId);
        setOwn('ownBrowser' in r && r.ownBrowser === true);
        const early = seen.current.get(r.loginId);
        setEv(early ?? { loginId: r.loginId, state: 'waiting', ...(r.rbId ? { rbId: r.rbId } : {}), ...(r.url ? { url: r.url } : {}) });
      },
      (e) => { if (on) setStartErr(errText(e)); },
    );
    return () => {
      on = false;
      const id = current.current;
      current.current = null;
      if (id && !['done', 'failed', 'cancelled'].includes(seen.current.get(id)?.state ?? '')) client.loginCancel(id);
    };
  }, [client, profile?.name, mcp?.profile, mcp?.name, attempt]);

  const state = startErr ? 'failed' : ev?.state ?? 'starting';
  const busy = state === 'starting' || state === 'waiting' || state === 'verifying';
  useEffect(() => { setBusy(busy); }, [busy, setBusy]);
  useEffect(() => { setDone(state === 'done'); }, [state, setDone]);
  useEffect(() => { if (ev?.rbError) setFallback(true); }, [ev?.rbError]);
  const doneProfile = ev?.state === 'done' ? client.profiles.find((p) => p.name === ev.profile) : undefined;
  useEffect(() => { if (doneProfile && !name) setName(doneProfile.displayName ?? ev?.email ?? doneProfile.name); }, [doneProfile?.name]);

  const sendCode = async () => {
    if (!loginId || !code.trim()) return;
    setCodeErr('');
    try { await client.loginCode(loginId, code.trim()); } catch (e) { setCodeErr(errText(e)); }
  };
  const finish = async () => {
    if (!doneProfile) { onDone(); return; }
    const want = name.trim();
    if (want && want !== (doneProfile.displayName ?? doneProfile.name)) {
      setSaving(true);
      try { await client.updateProfile(doneProfile.name, { displayName: want }); } catch { /* имя — не главное */ } finally { setSaving(false); }
    }
    onDone();
  };

  if (state === 'done' && mcp) {
    return (
      <>
        <div className="aa-done" role="status">
          <span className="dot dot-green" />
          <div>
            <b>Вход выполнен — «{mcp.name}» подключён</b>
            <div className="dim">доступ сохранён в аккаунте на «{envLabel(client.environment)}»; сессии аккаунта увидят сервер со следующего запуска</div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn primary" autoFocus onClick={onDone}>Готово</button>
        </div>
      </>
    );
  }

  if (state === 'done') {
    return (
      <>
        <label className="aa-field">
          <span>Имя</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Имя аккаунта" />
          <span className="dim aa-hint">так аккаунт будет подписан в выборе «аккаунт · модель»</span>
        </label>
        <div className="aa-done" role="status">
          <span className="dot dot-green" />
          <div>
            <b>{ev?.email ? `Вошли: ${ev.email}` : 'Вход выполнен'}</b>
            <div className="dim">{[ev?.plan, `вход сохранён на «${envLabel(client.environment)}» и сам обновляется`].filter(Boolean).join(' · ')}</div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn primary" disabled={saving} onClick={() => void finish()}>{profile ? 'Готово' : 'Добавить аккаунт'}</button>
        </div>
      </>
    );
  }

  if (own && !mcp) {
    return (
      <>
        <div className="aa-fallback">
          <div className="aa-banner" role="status">Открыли страницу входа в вашем браузере: войдите на claude.ai (если ещё не вошли) и нажмите «Разрешить» — вход здесь завершится сам. Это вход Claude Code этого компьютера — заодно войдёт и <span className="mono">claude</span> в терминале.</div>
          <div className="aa-step"><span className="aa-num">?</span><span>Браузер не открылся</span><span className="spacer" /><button className="btn sm" disabled={!ev?.url} onClick={() => ev?.url && openExternal(ev.url)}><Icon name="externalLink" size={12} /> Открыть самому</button></div>
          <details className="aa-own-code">
            <summary className="dim">Страница показала код — вставить вручную</summary>
            <form className="aa-code" onSubmit={(e) => { e.preventDefault(); void sendCode(); }}>
              <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="код со страницы Anthropic" aria-label="Код входа" spellCheck={false} autoComplete="off" />
              <button className="btn primary" type="submit" disabled={!code.trim() || !loginId || state === 'verifying'}>Войти</button>
            </form>
            {codeErr && <div className="err-text">{codeErr}</div>}
          </details>
        </div>
        <div className="aa-status" role="status">
          <span className={`dot ${state === 'failed' ? 'dot-red' : 'dot-acc'}`} />
          <span>
            {state === 'waiting' && 'Ждём входа в браузере — завершится сам'}
            {state === 'verifying' && 'Проверяем вход…'}
            {state === 'failed' && (startErr || ev?.error || 'вход не удался')}
            {state === 'cancelled' && 'Вход прерван'}
          </span>
          <span className="spacer" />
          {(state === 'failed' || state === 'cancelled') && <button className="btn sm" onClick={() => setAttempt((a) => a + 1)}>Начать заново</button>}
        </div>
      </>
    );
  }

  return (
    <>
      {!fallback && (ev?.rbId
        ? <div className="aa-browser"><RemoteBrowser client={client} tab={ev.rbId} onExit={onTabExit} onState={onPage} /></div>
        : <div className="aa-browser aa-loading">
            {state === 'failed'
              ? <div className="err-text">{startErr || ev?.error}</div>
              : <><Icon name="loader" size={18} className="spin" /><span className="dim">Открываем страницу входа на сервере…</span></>}
          </div>)}
      {fallback && (
        <div className="aa-fallback">
          {ev?.rbError && <div className="aa-banner warn" role="status">Браузер на сервере недоступен ({ev.rbError}) — войдите у себя и вставьте {mcp ? 'адрес возврата' : 'код'}</div>}
          <div className="aa-step"><span className="aa-num">1</span><span>Откройте страницу входа у себя в браузере</span><span className="spacer" /><button className="btn sm" disabled={!ev?.url} onClick={() => ev?.url && openExternal(ev.url)}><Icon name="externalLink" size={12} /> Открыть у себя</button></div>
          <div className="aa-step"><span className="aa-num">2</span><span>{mcp ? 'Разрешите доступ — браузер перебросит на адрес localhost (страница может не открыться, так и задумано)' : 'Войдите в Claude — страница покажет код'}</span></div>
          <div className="aa-step"><span className="aa-num">3</span><span>{mcp ? 'Скопируйте адрес из адресной строки и вставьте сюда' : 'Вставьте код сюда'}</span></div>
          <form className="aa-code" onSubmit={(e) => { e.preventDefault(); void sendCode(); }}>
            <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder={mcp ? 'http://localhost:…/callback?code=…' : 'код со страницы Anthropic'} aria-label={mcp ? 'Адрес возврата' : 'Код входа'} spellCheck={false} autoComplete="off" />
            <button className="btn primary" type="submit" disabled={!code.trim() || !loginId || state === 'verifying'}>Войти</button>
          </form>
          {codeErr && <div className="err-text">{codeErr}</div>}
        </div>
      )}
      <div className="aa-status" role="status">
        <span className={`dot ${state === 'failed' ? 'dot-red' : state === 'starting' ? 'dot-off' : 'dot-acc'}`} />
        <span>
          {state === 'starting' && (mcp ? `Запускаем вход в «${mcp.name}» на сервере…` : 'Запускаем вход в Claude Code на сервере…')}
          {state === 'waiting' && (fallback ? (mcp ? 'Ждём адрес возврата' : 'Ждём код') : (mcp ? 'Ждём входа — вход завершится сам' : 'Ждём входа — код со страницы подхватится сам'))}
          {state === 'verifying' && 'Проверяем код…'}
          {state === 'failed' && (startErr || ev?.error || 'вход не удался')}
          {state === 'cancelled' && 'Вход прерван'}
        </span>
        <span className="spacer" />
        {(state === 'failed' || state === 'cancelled') && <button className="btn sm" onClick={() => setAttempt((a) => a + 1)}>Начать заново</button>}
      </div>
      {!fallback && cfStuck && (
        <div className="aa-banner warn aa-cf" role="status">
          <span>{mcp ? 'Сайт не пускает браузер на сервере дальше проверки — войдите у себя и вставьте адрес возврата.' : <>Cloudflare не пускает браузер на сервере дальше проверки. Надёжнее войти токеном подписки — «Войти токеном», там кнопка «Получить токен» откроет вход в вашем браузере — или кодом.</>}</span>
          <span className="aa-cf-actions">
            {onUseToken && <button className="btn sm primary" onClick={onUseToken}>Войти токеном</button>}
            <button className="btn sm" onClick={() => setFallback(true)}>{mcp ? 'Войти у себя' : 'Ввести код'}</button>
          </span>
        </div>
      )}
      {!fallback && busy && <button className="link-btn aa-link" onClick={() => setFallback(true)}>Не открывается? Открыть страницу у себя и вставить {mcp ? 'адрес возврата' : 'код'}</button>}
      {fallback && ev?.rbId && <button className="link-btn aa-link" onClick={() => setFallback(false)}>Вернуться к браузеру на сервере</button>}
    </>
  );
}

/**
 * Выпуск токена подписки на этом компьютере: локальный supervisor запускает `claude setup-token`, Claude Code
 * открывает страницу Anthropic в вашем браузере; войдёте — токен придёт сюда сам (забирается один раз).
 * Браузер не открылся — ссылка «открыть самому» и код со страницы.
 */
function LocalToken({ local, onToken }: { local: SupervisorClient; onToken: (token: string) => void }) {
  const [loginId, setLoginId] = useState<string | null>(null);
  const [ev, setEv] = useState<LoginEvent | null>(null);
  const [url, setUrl] = useState<string | undefined>();
  const [err, setErr] = useState('');
  const [manual, setManual] = useState(false);
  const [code, setCode] = useState('');
  const [got, setGot] = useState(false);
  const current = useRef<string | null>(null);
  const seen = useRef(new Map<string, LoginEvent>());

  useEffect(() => local.onLogin((e) => {
    seen.current.set(e.loginId, e);
    if (e.loginId === current.current) setEv(e);
  }), [local]);
  // окно закрыли посреди входа — отменить
  useEffect(() => () => {
    const id = current.current;
    if (id && !['done', 'failed', 'cancelled'].includes(seen.current.get(id)?.state ?? '')) local.loginCancel(id);
  }, [local]);
  // вход прошёл — забрать токен
  useEffect(() => {
    if (ev?.state !== 'done' || !loginId) return;
    void local.tokenTake(loginId).then(
      (t) => { if (t) { setGot(true); onToken(t); } else setErr('токен не пришёл — начните заново'); },
      (e) => setErr(errText(e)),
    );
  }, [ev?.state, loginId]);

  const start = async () => {
    setErr(''); setEv(null); setCode(''); setManual(false); setGot(false);
    try {
      const r = await local.tokenStart();
      current.current = r.loginId;
      setLoginId(r.loginId);
      setUrl(r.url);
      setEv(seen.current.get(r.loginId) ?? { loginId: r.loginId, state: 'waiting', ...(r.url ? { url: r.url } : {}) });
    } catch (e) { setErr(errText(e)); }
  };
  const sendCode = async () => {
    if (!loginId || !code.trim()) return;
    setErr('');
    try { await local.loginCode(loginId, code.trim()); } catch (e) { setErr(errText(e)); }
  };
  const state = ev?.state;
  const running = !err && (state === 'starting' || state === 'waiting' || state === 'verifying');
  const link = ev?.url ?? url;

  if (got) {
    return <div className="aa-status" role="status"><span className="dot dot-green" /><span>Токен получен на этом компьютере и подставлен ниже</span></div>;
  }
  if (!running) {
    return (
      <div className="aa-token">
        <button type="button" className="btn primary" onClick={() => void start()}>
          <Icon name="externalLink" size={12} /> Получить токен — вход в вашем браузере
        </button>
        <span className="dim aa-hint">Откроется страница Anthropic в вашем браузере; войдёте — токен встанет сюда сам. Приложение запускает «claude setup-token» на этом компьютере.</span>
        {(err || state === 'failed') && <div className="err-text">{err || ev?.error || 'не получилось'}</div>}
        {state === 'cancelled' && !err && <div className="dim">Выпуск токена прерван</div>}
      </div>
    );
  }
  return (
    <div className="aa-token">
      <div className="aa-status" role="status">
        <Icon name="loader" size={14} className="spin" />
        <span>{state === 'verifying' ? 'Проверяем код…' : 'Войдите на странице Anthropic — она открылась в вашем браузере. Токен подставится сам.'}</span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => { if (loginId) local.loginCancel(loginId); }}>Отмена</button>
      </div>
      {!manual
        ? <button type="button" className="link-btn aa-link" onClick={() => setManual(true)}>Браузер не открылся?</button>
        : (
          <div className="aa-fallback">
            <div className="aa-step"><span className="aa-num">1</span><span>Откройте страницу входа сами</span><span className="spacer" /><button type="button" className="btn sm" disabled={!link} onClick={() => link && openExternal(link)}><Icon name="externalLink" size={12} /> Открыть</button></div>
            <div className="aa-step"><span className="aa-num">2</span><span>Войдите в Claude — страница покажет код; вставьте его</span></div>
            <div className="aa-code">
              <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="код со страницы Anthropic" aria-label="Код входа" spellCheck={false} autoComplete="off"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void sendCode(); } }} />
              <button type="button" className="btn primary" disabled={!code.trim() || state === 'verifying'} onClick={() => void sendCode()}>Отправить</button>
            </div>
          </div>
        )}
    </div>
  );
}

/** Ошибка проверки токена подписки — по ответу Claude Code (401 — токен не принят, остальное — как есть). */
function tokenError(r: KeyCheck): { title: string; hint?: string } {
  if (r.status === 401 || /OAuth access token is invalid|invalid.*token|401/i.test(r.message ?? '')) {
    return { title: 'Anthropic не принял токен (401)', hint: 'скопируйте токен целиком — sk-ant-oat01-… одной строкой (терминал мог перенести его на две) или выпустите заново: claude setup-token' };
  }
  if (r.status === 403) return { title: 'токен не даёт доступа (403)', hint: 'у подписки нет доступа к Claude Code или токен отозван — выпустите заново' };
  if (r.status === 429) return { title: 'лимит подписки на сейчас исчерпан (429)', hint: 'сам токен рабочий — можно добавлять' };
  return { title: 'Claude Code не смог проверить токен' };
}

/** Ключ API по шаблону: проверка мини-запросом, затем добавление. */
function KeyAccount({ client, local, onDone }: { client: SupervisorClient; local?: SupervisorClient; onDone: () => void }) {
  const [tpl, setTpl] = useState<KeyTemplate>('claude-token');
  const t = TEMPLATES.find((x) => x.id === tpl)!;
  const [name, setName] = useState(t.name);
  const [nameTouched, setNameTouched] = useState(false);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [check, setCheck] = useState<{ kind: 'idle' | 'busy' | 'done' | 'err'; r?: KeyCheck; text?: string }>({ kind: 'idle' });
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState('');
  const taken = client.profiles.some((p) => p.name === name);
  const pick = (id: KeyTemplate) => {
    setTpl(id);
    setCheck({ kind: 'idle' });
    if (!nameTouched) setName(TEMPLATES.find((x) => x.id === id)!.name);
  };
  const cleanKey = key.trim();
  const keyOk = cleanKey.length >= 8 && !/\s/.test(cleanKey);
  const urlOk = tpl !== 'custom' || /^https?:\/\/\S+$/.test(url.trim());
  const nameOk = NAME_RE.test(name) && !taken;
  const runCheck = async (k: string = cleanKey) => {
    setCheck({ kind: 'busy' });
    try {
      const r = await client.checkKey({ template: tpl, apiKey: k, ...(tpl === 'custom' ? { baseUrl: url.trim() } : {}) });
      setCheck({ kind: 'done', r });
    } catch (e) { setCheck({ kind: 'err', text: errText(e) }); }
  };
  const add = async () => {
    setAdding(true);
    setAddErr('');
    try {
      await client.addKeyProfile({ name, template: tpl, apiKey: cleanKey, ...(tpl === 'custom' ? { baseUrl: url.trim() } : {}) });
      onDone();
    } catch (e) { setAddErr(errText(e)); } finally { setAdding(false); }
  };
  const fail = check.kind === 'done' && !check.r!.ok
    ? tpl === 'claude-token' ? tokenError(check.r!) : explainApiError({ status: check.r!.status ?? null, text: check.r!.message ?? '', gateway: tpl !== 'anthropic' })
    : null;

  return (
    <form className="aa-key" onSubmit={(e) => { e.preventDefault(); if (keyOk && urlOk && nameOk) void add(); }}>
      <div className="aa-field">
        <span>Шаблон</span>
        <div className="aa-chips" role="radiogroup" aria-label="Шаблон">
          {TEMPLATES.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={tpl === x.id} className={`aa-chip ${tpl === x.id ? 'on' : ''}`} onClick={() => pick(x.id)}>{x.label}</button>
          ))}
        </div>
      </div>
      <div className="aa-row2">
        <label className="aa-field">
          <span>Имя</span>
          <input className="mono" value={name} onChange={(e) => { setName(e.target.value.toLowerCase()); setNameTouched(true); }} maxLength={32} aria-label="Имя аккаунта" />
          {!NAME_RE.test(name) && <span className="err-text aa-hint">латиница, цифры, «-» и «_»</span>}
          {taken && <span className="err-text aa-hint">такой аккаунт уже есть</span>}
        </label>
        <label className="aa-field grow">
          <span>Адрес</span>
          {tpl === 'custom'
            ? <input className="mono" value={url} onChange={(e) => { setUrl(e.target.value); setCheck({ kind: 'idle' }); }} placeholder="https://…/api/anthropic" aria-label="Адрес API" spellCheck={false} />
            : <input className="mono" value={t.url ?? 'api.anthropic.com (по умолчанию)'} readOnly aria-label="Адрес API" />}
        </label>
      </div>
      {tpl === 'claude-token' && local?.status === 'live' && (
        <LocalToken local={local} onToken={(t) => { setKey(t); void runCheck(t); }} />
      )}
      <label className="aa-field">
        <span>{tpl === 'claude-token' ? 'Токен' : 'Ключ API'}</span>
        <input type="password" className="mono" autoFocus autoComplete="off" spellCheck={false} value={key} onChange={(e) => { setKey(e.target.value); setCheck({ kind: 'idle' }); }} placeholder="вставьте ключ" aria-label="Ключ API" />
        <span className="dim aa-hint">Ключ уходит только на «{envLabel(client.environment)}» и обратно не показывается — видны последние 4 символа. {t.hint}.</span>
      </label>
      <div className="aa-status" role="status">
        {check.kind === 'idle' && <span className="dim">{tpl === 'claude-token' ? 'Проверка — один короткий запрос через сам Claude Code на сервере (пара токенов подписки, до минуты)' : 'Проверка — один короткий запрос к API (max_tokens 1)'}</span>}
        {check.kind === 'busy' && <><Icon name="loader" size={14} className="spin" /><span>{tpl === 'claude-token' ? 'Спрашиваем Claude Code на сервере…' : 'Проверяем ключ…'}</span></>}
        {check.kind === 'done' && check.r!.ok && <><span className="dot dot-green" /><span>{tpl === 'claude-token' ? 'Токен работает' : 'Ключ работает'} · ответ за {(check.r!.ms / 1000).toFixed(1).replace('.', ',')} с</span></>}
        {fail && <><span className="dot dot-red" /><span><b>{fail.title}</b>{fail.hint ? ` — ${fail.hint}` : ''}{check.r!.message ? <span className="dim"> · {check.r!.message}</span> : null}</span></>}
        {check.kind === 'err' && <><span className="dot dot-red" /><span>{check.text}</span></>}
      </div>
      {addErr && <div className="err-text">{addErr}</div>}
      <div className="modal-actions">
        <button className="btn" type="button" disabled={!keyOk || !urlOk || check.kind === 'busy'} onClick={() => void runCheck()}>Проверить</button>
        <button className="btn primary" type="submit" disabled={!keyOk || !urlOk || !nameOk || adding}>{adding ? 'Добавляю…' : 'Добавить'}</button>
      </div>
    </form>
  );
}

export function AddAccountDialog({ client, env, local, loginProfile, onClose }: { client: SupervisorClient; env: EnvId; local?: SupervisorClient; loginProfile?: ProfileInfo; onClose: () => void }) {
  const [kind, setKind] = useState<'sub' | 'key'>('sub');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginDone, setLoginDone] = useState(false);
  const live = client.status === 'live';
  // идущий вход прерывается сам: окно закрылось или выбран другой тип — SubscriptionLogin снимается и отменяет его
  const close = () => onClose();
  return (
    <div className="modal-backdrop aa-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal aa" role="dialog" aria-label={loginProfile ? 'Вход в аккаунт' : 'Добавить аккаунт'} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.rb-stage')) { e.stopPropagation(); close(); } }}>
        <div className="aa-head">
          <div>
            <div className="modal-title">{loginProfile ? `Вход: ${profileLabel(loginProfile)}` : 'Добавить аккаунт'}</div>
            <div className="dim aa-sub">Подключение «{envLabel(env)}» · аккаунт появится в выборе «аккаунт · модель» у новых сессий</div>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Закрыть"><Icon name="x" size={16} /></button>
        </div>
        {!loginProfile && (
          <div className="aa-types" role="radiogroup" aria-label="Тип аккаунта">
            <button type="button" role="radio" aria-checked={kind === 'sub'} className={`aa-type ${kind === 'sub' ? 'on' : ''}`} onClick={() => setKind('sub')}>
              <b>Подписка Claude</b><span>Pro или Max · вход на странице Anthropic</span>
            </button>
            <button type="button" role="radio" aria-checked={kind === 'key'} className={`aa-type ${kind === 'key' ? 'on' : ''}`} onClick={() => setKind('key')}>
              <b>Ключ API</b><span>шаблоны Anthropic и z.ai или свой адрес</span>
            </button>
          </div>
        )}
        {!live && <div className="warn-text">Нет связи с «{envLabel(env)}» — добавить аккаунт можно, когда подключение оживёт.</div>}
        {live && kind === 'sub' && <SubscriptionLogin client={client} {...(loginProfile ? { profile: loginProfile } : {})} onDone={onClose} setBusy={setLoginBusy} setDone={setLoginDone} {...(!loginProfile ? { onUseToken: () => setKind('key') } : {})} />}
        {live && kind === 'sub' && !loginProfile && local?.status === 'live' && local !== client && (
          <button className="link-btn aa-link" onClick={() => setKind('key')}>Не хотите входить в браузере на сервере? Получите токен подписки в своём браузере →</button>
        )}
        {live && kind === 'key' && <KeyAccount client={client} {...(local ? { local } : {})} onDone={onClose} />}
        {kind === 'sub' && !loginDone && (
          <div className="modal-actions aa-foot">
            <button className="btn" onClick={close}>{loginBusy ? 'Отмена' : 'Закрыть'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
