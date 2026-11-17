// Настройки → Аккаунты (макет A1): у каждого аккаунта среды — модели (из Claude Code или ручной список для шлюзов),
// модель и усилие по умолчанию, разрешён ли ultracode. Токены и env сюда не ходят — правится только описание.
// Карточки сворачиваются (длинные списки моделей Anthropic), скрытые модели — под «Скрытые · N»,
// свои модели — та же модель с другим окном контекста (glm-5.3@400k).
import { useEffect, useState } from 'react';
import type { EnvId, ProfileInfo, SupervisorClient, ClientSet } from '../supervisor';
import { CmdError, envLabel, profileLabel } from '../supervisor';
import { EFFORT_LABEL, EFFORT_ORDER, addCustomModel, addManualModel, baseModelId, ctxLabel, customLabel, effortRange, findModel, type EffortLevel, type ModelChoice } from '../lib/modelsModel';
import { hiddenModels, setModelHidden, subscribeHidden } from '../lib/modelVisibility';
import { Icon } from './Icon';
import { AddAccountDialog } from './AddAccountDialog';

function errText(e: unknown): string {
  if (e instanceof CmdError && e.code === 'TIMEOUT') {
    return 'ответ не пришёл за 30 с — связь медленная или занята; изменение могло примениться, обновлённые данные придут сами';
  }
  return e instanceof Error ? e.message : String(e);
}

/** Ключ API: только запись. Для z.ai — ключ с вкладки Personal Coding Plan (ключи со Standard кодинг-план не берут). */
function KeyRow({ p, client }: { p: ProfileInfo; client: SupervisorClient }) {
  const [key, setKey] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; text?: string }>({ kind: 'idle' });
  const clean = key.trim();
  const valid = clean.length >= 8 && !/\s/.test(clean);
  const save = async () => {
    if (!valid) return;
    setState({ kind: 'saving' });
    try {
      const r = await client.setProfileKey(p.name, clean);
      setKey('');
      const parts = ['ключ сохранён'];
      if (r.restarted > 0) parts.push(`перезапущено сессий: ${r.restarted} — поднимутся с новым ключом`);
      if (r.busy > 0) parts.push(`заняты ещё ${r.busy} — новый ключ после «Стоп» или конца хода`);
      setState({ kind: 'ok', text: parts.join(' · ') });
    } catch (e) {
      setState({ kind: 'err', text: errText(e) });
    }
  };
  return (
    <div className="acct-key">
      <div className="acct-row">
        <span>Ключ API</span>
        <span className={p.keyHint ? 'mono' : 'dim'}>{p.keyHint ? `задан · ${p.keyHint}` : 'не задан'}</span>
      </div>
      <form className="field-inline acct-add acct-key-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input
          type="password"
          className="mono"
          autoComplete="off"
          spellCheck={false}
          placeholder={p.keyHint ? 'новый ключ — заменит текущий' : 'вставьте ключ'}
          value={key}
          onChange={(e) => { setKey(e.target.value); if (state.kind !== 'saving') setState({ kind: 'idle' }); }}
          aria-label={`Ключ API · ${profileLabel(p)}`}
        />
        <button className="btn sm" type="submit" disabled={!valid || state.kind === 'saving'}>{state.kind === 'saving' ? 'Сохраняю…' : 'Сохранить ключ'}</button>
      </form>
      <div className="dim acct-note">Ключ уходит только в supervisor этой среды и обратно не показывается. Для z.ai — ключ с вкладки «Personal Coding Plan»: ключи со вкладки «Standard» кодинг-план не берут (ошибка 429 · 1113).</div>
      {state.kind === 'ok' && <div className="ok-text acct-note" role="status">{state.text}</div>}
      {state.kind === 'err' && <div className="err-text acct-err" role="alert">{state.text}</div>}
    </div>
  );
}

/** 1 модель, 2 модели, 5 моделей */
function modelsCount(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  const w = d === 1 && dd !== 11 ? 'модель' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'модели' : 'моделей';
  return `${n} ${w}`;
}

function AccountCard({ p, client, env, onLogin, open, onToggle }: {
  p: ProfileInfo; client: SupervisorClient; env: EnvId; onLogin: (p: ProfileInfo) => void; open: boolean; onToggle: () => void;
}) {
  // скрытые модели (уходят в «Другие модели» в выборе модели) — хранятся в клиенте по подключению и аккаунту
  const [, setVis] = useState(0);
  useEffect(() => subscribeHidden(() => setVis((v) => v + 1)), []);
  const hidden = hiddenModels(env, p.name);
  const [busy, setBusy] = useState<'' | 'refresh' | 'save'>('');
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  // своя модель: база, окно в K, подпись
  const [cBase, setCBase] = useState('');
  const [cK, setCK] = useState('');
  const [cLabel, setCLabel] = useState('');
  const run = async (kind: 'refresh' | 'save', fn: () => Promise<unknown>) => {
    setBusy(kind);
    setErr('');
    try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(''); }
  };
  // модели ещё не известны клиенту — спросить у supervisor'а (кэш, без запуска claude); старый supervisor — молча
  useEffect(() => {
    if (!p.models && client.status === 'live') void client.profileModels(p.name).catch(() => undefined);
  }, [p.name, client.status]);

  // старый supervisor не знает моделей и правки аккаунтов: в hello у профиля нет modelsSource
  if (p.modelsSource === undefined) {
    return (
      <div className="acct">
        <div className="acct-head"><b>{profileLabel(p)}</b>{p.description && <span className="dim acct-desc">{p.description}</span>}</div>
        <div className="warn-text acct-note">supervisor этой среды старой версии — модели, усилие и ключ здесь не настраиваются. Обновите его.</div>
      </div>
    );
  }
  const manual = p.modelsSource === 'manual';
  const models = p.models ?? [];
  const long = new Set(p.long ?? []);
  const toggleLong = (id: string) => save({ long: long.has(id) ? [...long].filter((x) => x !== id) : [...long, id] });
  const source = manual ? 'модели вручную' : p.modelsFrom === 'claude-code' ? 'модели из Claude Code' : 'модели от провайдера';
  const anyEffort = models.some((m) => (m.efforts ?? []).length > 0);
  const next = addManualModel(models, draft);
  const save = (patch: Parameters<SupervisorClient['updateProfile']>[1]) => run('save', () => client.updateProfile(p.name, patch));
  const custom = p.custom ?? [];
  const nextCustom = addCustomModel(custom, cBase, cK.trim() === '' ? NaN : Number(cK), cLabel);
  // скрытые (глазом) — под «Скрытые · N»; модель по умолчанию видна всегда
  const shownModels = models.filter((m) => !hidden.has(m.id) || p.model === m.id);
  const hiddenList = models.filter((m) => hidden.has(m.id) && p.model !== m.id);
  const defLabel = p.model ? (findModel(p, p.model)?.label ?? p.model) : 'решает Claude Code';
  const summary = `${modelsCount(models.length + custom.length)} · по умолчанию: ${defLabel}`;

  const modelRow = (m: ModelChoice) => (
    <label key={m.id} className={`acct-model ${p.model === m.id ? 'on' : ''} ${hidden.has(m.id) ? 'is-hidden' : ''}`}>
      <input type="radio" name={`def-${p.name}`} checked={p.model === m.id} disabled={busy !== ''} onChange={() => void save({ model: m.id })} />
      <span className="acct-mname">{m.label ?? m.id}{m.label ? <span className="dim mono"> {m.id}</span> : m.description ? <span className="dim"> · {m.description}</span> : null}</span>
      <span className="dim acct-eff">{effortRange(m.efforts)}</span>
      {/\[1m\]$/i.test(m.id)
        ? <span className="acct-1m on is-fixed" data-tip="1M задан в самом идентификаторе модели">1M</span>
        : (
          <button
            type="button"
            className={`acct-1m ${long.has(m.id) ? 'on' : ''}`}
            aria-pressed={long.has(m.id)}
            disabled={busy !== ''}
            aria-label={`Контекст 1M · ${m.id}`}
            data-tip={`${long.has(m.id) ? 'Контекст 1M включён: Claude Code запускается с ' + m.id + '[1m]. Нажмите, чтобы выключить' : 'Включить контекст 1M — если он есть у вашего тарифа или шлюза'}${m.ctx ? ` · у провайдера окно ${ctxLabel(m.ctx)}` : ''}`}
            onClick={(e) => { e.preventDefault(); void toggleLong(m.id); }}
          >1M</button>
        )}
      {p.model === m.id && <span className="acct-def">по умолчанию</span>}
      <button
        type="button"
        className={`icon-btn sm acct-vis ${hidden.has(m.id) ? 'off' : ''}`}
        aria-pressed={!hidden.has(m.id)}
        aria-label={hidden.has(m.id) ? `Показывать ${m.id} в списке` : `Убрать ${m.id} в «Другие модели»`}
        data-tip={hidden.has(m.id) ? 'Скрыта: в выборе модели — в «Другие модели». Нажмите, чтобы показывать в списке' : 'Показывается в выборе модели. Нажмите, чтобы убрать в «Другие модели»'}
        onClick={(e) => { e.preventDefault(); setModelHidden(env, p.name, m.id, !hidden.has(m.id)); }}
      >
        <Icon name={hidden.has(m.id) ? 'eyeOff' : 'eye'} size={14} />
      </button>
      {manual && (
        <button type="button" className="icon-btn sm" aria-label={`Убрать ${m.id}`} data-tip="Убрать из списка" disabled={busy !== ''} onClick={(e) => { e.preventDefault(); void save({ models: models.filter((x) => x.id !== m.id) }); }}>
          <Icon name="x" size={12} />
        </button>
      )}
    </label>
  );

  return (
    <div className="acct">
      <div className="acct-head">
        <button type="button" className="acct-toggle" aria-expanded={open} onClick={onToggle} data-tip={open ? 'Свернуть' : 'Развернуть: модели, усилие, ключ'}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
          <b>{profileLabel(p)}</b>
        </button>
        {p.auth?.loggedIn && (p.auth.email || p.auth.plan)
          ? <span className="dim acct-desc">{[p.auth.email, p.auth.plan].filter(Boolean).join(' · ')}</span>
          : p.description && <span className="dim acct-desc">{p.description}</span>}
        {p.auth?.loggedIn === false && (
          <button className="acct-login" onClick={() => onLogin(p)} data-tip="Войти в подписку Claude прямо в браузере на сервере">не вошёл · Войти</button>
        )}
        <span className="spacer" />
        {!open && <span className="dim acct-sum">{summary}</span>}
        <span className="acct-src" data-tip={p.modelsFrom === 'claude-code' ? 'Провайдер не отдал список (или ключа нет — подписка) — взят список самого Claude Code' : undefined}>{source}</span>
        {open && !manual && (
          <button className="btn sm" disabled={busy !== ''} onClick={() => void run('refresh', () => client.profileModels(p.name, true))} data-tip="Спросить список у провайдера (/v1/models); не ответит — у Claude Code">
            <Icon name="refresh" size={12} /> {busy === 'refresh' ? 'Обновляю…' : 'Обновить'}
          </button>
        )}
      </div>
      {open && <>
      {!manual && p.modelsAt !== undefined && (
        <div className="dim acct-note">обновлено {new Date(p.modelsAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
      )}

      <div className="acct-models" role="radiogroup" aria-label={`Модель по умолчанию · ${profileLabel(p)}`}>
        {custom.map((c) => (
          <label key={c.id} className={`acct-model ${p.model === c.id ? 'on' : ''}`}>
            <input type="radio" name={`def-${p.name}`} checked={p.model === c.id} disabled={busy !== ''} onChange={() => void save({ model: c.id })} />
            <span className="acct-mname">{customLabel(c)}{c.label ? <span className="dim mono"> {c.base}</span> : null}</span>
            <span className="acct-tag" data-tip={`Своя модель: ${c.base}${c.ctx > 200_000 ? ' с 1M' : ''}, Claude Code сжимает переписку, дойдя до ${ctxLabel(c.ctx)} токенов`}>своя</span>
            {p.model === c.id && <span className="acct-def">по умолчанию</span>}
            <button
              type="button"
              className="icon-btn sm"
              aria-label={`Убрать ${customLabel(c)}`}
              data-tip="Убрать свою модель"
              disabled={busy !== ''}
              onClick={(e) => { e.preventDefault(); void save({ custom: custom.filter((x) => x.id !== c.id), ...(p.model === c.id ? { model: null } : {}) }); }}
            >
              <Icon name="x" size={12} />
            </button>
          </label>
        ))}
        {models.length === 0 && (
          <div className="dim acct-empty">{manual ? 'Список пуст — добавьте модель ниже.' : 'Список ещё не получен — нажмите «Обновить».'}</div>
        )}
        {shownModels.map(modelRow)}
        {hiddenList.length > 0 && (
          <button type="button" className="acct-more" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)} data-tip="Модели, убранные глазом в «Другие модели»">
            <Icon name={showHidden ? 'chevronDown' : 'chevronRight'} size={14} /> Скрытые <span className="dim">{hiddenList.length}</span>
          </button>
        )}
        {showHidden && hiddenList.map(modelRow)}
        <form
          className="field-inline acct-add acct-custom-add"
          onSubmit={(e) => { e.preventDefault(); if (nextCustom) { void save({ custom: nextCustom }); setCBase(''); setCK(''); setCLabel(''); } }}
        >
          <span className="dim acct-add-lbl" data-tip="Та же модель с другим окном контекста: Claude Code сжимает переписку, дойдя до него. Больше 200K — запуск с 1M">Своя модель</span>
          <input className="mono" list={`cm-${env}-${p.name}`} placeholder="модель" value={cBase} onChange={(e) => setCBase(e.target.value)} aria-label="Базовая модель" />
          <datalist id={`cm-${env}-${p.name}`}>{[...new Set(models.map((m) => baseModelId(m.id)))].map((id) => <option key={id} value={id} />)}</datalist>
          <input className="mono acct-ctx" type="number" min={100} max={1000} step={50} placeholder="окно" value={cK} onChange={(e) => setCK(e.target.value)} aria-label="Окно контекста, тысяч токенов" />
          <span className="dim">K</span>
          <input placeholder="название — необязательно" value={cLabel} onChange={(e) => setCLabel(e.target.value)} aria-label="Название своей модели" />
          <button className="btn sm" type="submit" disabled={!nextCustom || busy !== ''} data-tip="Окно 100–1000K. Появится в выборе модели этого аккаунта">Добавить</button>
        </form>
        {manual && (
          <form className="field-inline acct-add" onSubmit={(e) => { e.preventDefault(); if (next) { void save({ models: next }); setDraft(''); } }}>
            <input className="mono" placeholder="идентификатор, например glm-5.3-air" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button className="btn sm" type="submit" disabled={!next || busy !== ''}>Добавить</button>
          </form>
        )}
      </div>

      <div className="acct-row">
        <span>Усилие по умолчанию</span>
        {anyEffort
          ? (
            <select value={p.defaultEffort ?? ''} disabled={busy !== ''} onChange={(e) => void save({ defaultEffort: e.target.value === '' ? null : e.target.value as EffortLevel })}>
              <option value="">решает модель</option>
              {EFFORT_ORDER.map((l) => <option key={l} value={l}>{EFFORT_LABEL[l]}</option>)}
            </select>
          )
          : <span className="dim">{manual ? 'шлюз не принимает усилие — в поле ввода переключателя нет' : 'у моделей аккаунта усилия нет'}</span>}
      </div>
      {p.keyEditable && <KeyRow p={p} client={client} />}
      <label className="acct-row acct-check">
        <input type="checkbox" checked={p.ultracode !== false} disabled={busy !== ''} onChange={(e) => void save({ ultracode: e.target.checked })} />
        <span>ultracode — агент раздаёт работу субагентам{p.ultracode === false ? ' · выключен: кнопки в поле ввода нет' : ''}</span>
      </label>
      <label className="acct-row acct-check">
        <input type="checkbox" checked={p.delegate === true} disabled={busy !== ''} onChange={(e) => void save({ delegate: e.target.checked })} />
        <span>делегирование — агент может передавать задачи воркерам-сессиям других аккаунтов (тратится квота выбранного аккаунта){p.delegate === true ? '' : ' · выключено'}</span>
      </label>
      <label className="acct-row acct-check">
        <input type="checkbox" checked={p.nativeAgents !== false} disabled={busy !== ''} onChange={(e) => void save({ nativeAgents: e.target.checked })} />
        <span>нативные субагенты (Task) — быстрые помощники в той же сессии; у шлюзов по умолчанию выключены (моделей Anthropic нет), кросс-аккаунтные воркеры — через делегирование</span>
      </label>
      <div className="acct-foot">
        {manual
          ? <button className="link-btn" disabled={busy !== ''} onClick={() => void save({ modelsSource: 'auto' })}>брать список у провайдера</button>
          : <button className="link-btn" disabled={busy !== ''} onClick={() => void save({ modelsSource: 'manual', models })}>задать список вручную</button>}
        {busy === 'save' && <span className="dim">сохраняю…</span>}
      </div>
      </>}
      {err && <div className="err-text acct-err" role="alert">{err}</div>}
    </div>
  );
}

const OPEN_KEY = 'perimeter:acct-open';

/** Какие карточки аккаунтов развёрнуты (по среде и аккаунту) — переживает перезапуск. */
function loadOpen(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as unknown;
    return typeof v === 'object' && v !== null ? v as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

export function AccountsSettings({ clients, envs, initialEnv }: { clients: ClientSet; envs: EnvId[]; initialEnv: EnvId }) {
  const [env, setEnv] = useState<EnvId>(envs.includes(initialEnv) ? initialEnv : envs[0]!);
  const client = clients.get(env);
  // окно «Добавить аккаунт» / «Войти» (эталон 003-accounts-add)
  const [dlg, setDlg] = useState<null | { login?: ProfileInfo }>(null);
  // карточки свёрнуты, если аккаунтов больше одного; что развернул — помним
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(loadOpen);
  const byDefault = client.profiles.length <= 1;
  const isOpen = (name: string) => openMap[`${env}:${name}`] ?? byDefault;
  const toggle = (name: string) => setOpenMap((m) => {
    const k = `${env}:${name}`;
    const n = { ...m, [k]: !(m[k] ?? byDefault) };
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(n)); } catch { /* хранилище недоступно — живёт до перезапуска */ }
    return n;
  });
  return (
    <div className="field accounts">
      <div className="acct-top">
        <span>Аккаунты — модели, усилие, ultracode (токены живут в среде и сюда не попадают)</span>
        <span className="spacer" />
        <button className="btn sm primary" disabled={client.status !== 'live'} onClick={() => setDlg({})} data-tip="Подписка Claude (вход на странице Anthropic) или ключ API">
          <Icon name="plus" size={12} /> Добавить аккаунт
        </button>
      </div>
      {envs.length > 1 && (
        <div className="seg env-seg" role="tablist" aria-label="Среда">
          {envs.map((e) => (
            <button key={e} type="button" role="tab" aria-selected={env === e} className={env === e ? 'on' : ''} onClick={() => setEnv(e)}>{envLabel(e)}</button>
          ))}
        </div>
      )}
      {client.status !== 'live' && <div className="warn-text acct-note">Нет связи со средой «{envLabel(env)}» — показано последнее известное.</div>}
      {client.profiles.length === 0 && client.status === 'live' && <div className="dim acct-note">Аккаунтов нет — добавьте подписку Claude (токеном) или ключ API: кнопка «Добавить аккаунт».</div>}
      {client.profiles.map((p) => (
        <AccountCard key={`${env}:${p.name}`} p={p} client={client} env={env} onLogin={(x) => setDlg({ login: x })} open={isOpen(p.name)} onToggle={() => toggle(p.name)} />
      ))}
      {dlg && (
        <AddAccountDialog client={client} env={env} {...(clients.has('local') ? { local: clients.get('local') } : {})}
          {...(dlg.login ? { loginProfile: dlg.login } : {})} onClose={() => setDlg(null)} />
      )}
    </div>
  );
}
