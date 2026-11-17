// Добавление MCP-сервера: «Каталог» (официальный реестр MCP — поиск и форма из записи), «Из документации»
// (вставить JSON или команду `claude mcp add`), «Вручную». Всё сводится к конфигу Claude Code и cmd:mcp.add;
// секреты (заголовки, переменные) только уходят на сервер. Ключ аккаунта-шлюза (z.ai) подставляет сам сервер.
import { useEffect, useRef, useState } from 'react';
import { CmdError, envLabel, type McpCatalogEntry, type McpConfig, type McpField, type McpServer, type ProfileInfo, type SupervisorClient } from '../supervisor';
import {
  ACCOUNT_KEY, NAME_RE, draftToConfig, draftWarnings, emptyDraft, fillTemplate, freeName, parseMcpPaste, previewTemplate,
  accountKeyFits, secretish, withAccountKeyMark, type KV, type McpDraft,
} from '../lib/mcpInstall';
import { Icon } from './Icon';

type Added = (servers: McpServer[], name: string, oauth: boolean) => void;
/** add — как ставить (общий список: всем аккаунтам); нет — cmd:mcp.add аккаунту profile */
type AddFn = (name: string, config: McpConfig) => Promise<McpServer[]>;
interface Ctx { client: SupervisorClient; profile: ProfileInfo; taken: Set<string>; onAdded: Added; servers: McpServer[]; add?: AddFn }

/** Тот же адрес/команда уже подключены — под каким именем. */
function sameAs(servers: McpServer[], cfg: McpConfig | string): string | undefined {
  if (typeof cfg === 'string') return undefined;
  const target = cfg.type === 'stdio' ? [cfg.command, ...(cfg.args ?? [])].join(' ') : cfg.url;
  return servers.find((s) => s.target.replace(/\/$/, '') === target.replace(/\/$/, ''))?.name;
}

function errText(e: unknown): string {
  return e instanceof CmdError || e instanceof Error ? e.message : String(e);
}

/** Подсказка ключа аккаунта («…UDPw»), если его можно отдать этому серверу (аккаунт на шлюзе с ключом, домен шлюза). */
const accountKeyFor = (p: ProfileInfo, target: { type: McpDraft['type']; url?: string }) =>
  p.keyEditable === true && p.keyHint && accountKeyFits(p.gatewayHost, target) ? p.keyHint : undefined;

const KIND: Record<McpCatalogEntry['variants'][number]['kind'], string> = { remote: 'удалённый', npm: 'npm', pypi: 'PyPI', oci: 'Docker' };

function nameError(name: string, taken: Set<string>): string {
  return !name ? 'нужно имя' : !NAME_RE.test(name) ? 'латиница, цифры, «-» и «_»' : taken.has(name) ? 'такой сервер уже есть' : '';
}

/** Поставить по очереди; ошибки — по имени. */
async function addAll(client: SupervisorClient, profile: string, list: { name: string; config: McpConfig }[], add?: AddFn): Promise<{ servers: McpServer[] | null; errors: Record<string, string> }> {
  let servers: McpServer[] | null = null;
  const errors: Record<string, string> = {};
  for (const x of list) {
    try { servers = add ? await add(x.name, x.config) : await client.mcpAdd(profile, x.name, x.config); } catch (e) { errors[x.name] = errText(e); }
  }
  return { servers, errors };
}

const needsAuth = (servers: McpServer[], names: string[]) => names.find((n) => servers.find((s) => s.name === n)?.status === 'needs-auth');

// ─── Поле значения: секрет с глазом и кнопкой «ключ аккаунта» ───────────────

function ValueInput({ value, onChange, secret, label, placeholder, accountKey, keyName }: {
  value: string; onChange: (v: string) => void; secret: boolean; label: string; placeholder?: string;
  /** подсказка ключа аккаунта («…UDPw») — показать кнопку */
  accountKey?: string; keyName: string;
}) {
  const [show, setShow] = useState(false);
  const usesKey = value.includes(ACCOUNT_KEY);
  return (
    <div className="mcp-val">
      <input type={secret && !show && !usesKey ? 'password' : 'text'} className="mono" autoComplete="off" spellCheck={false} value={value}
        onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} />
      {secret && !usesKey && <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? 'Скрыть' : 'Показать'}><Icon name={show ? 'eyeOff' : 'eye'} size={14} /></button>}
      {usesKey && <span className="dim mcp-keytag" data-tip="Подставит сервер; в приложение ключ не приходит"><Icon name="lock" size={12} /> ключ аккаунта{accountKey ? ` ${accountKey}` : ''}</span>}
      {accountKey && !usesKey && (
        <button type="button" className="btn sm ghost" onClick={() => onChange(withAccountKeyMark(keyName, value))} data-tip={`Сервер подставит ключ этого аккаунта (${accountKey}) — только серверам домена его шлюза`}>
          <Icon name="lock" size={12} /> Ключ аккаунта
        </button>
      )}
    </div>
  );
}

// ─── Каталог ────────────────────────────────────────────────────────────────

function CatalogRow({ e, onPick }: { e: McpCatalogEntry; onPick: () => void }) {
  const kinds = [...new Set(e.variants.map((v) => v.kind))];
  return (
    <button type="button" className="mcp-cat-row" onClick={onPick}>
      <div className="mcp-cat-head">
        <b>{e.title}</b>
        <span className="dim mcp-pub">{e.publisher}</span>
        {e.deprecated && <span className="mcp-badge warn">устарел</span>}
        <span className="spacer" />
        {kinds.map((k) => <span key={k} className={`mcp-badge ${k === 'remote' ? 'remote' : ''}`}>{KIND[k]}</span>)}
        <Icon name="chevronRight" size={14} className="dim" />
      </div>
      {e.description && <div className="mcp-cat-desc">{e.description}</div>}
    </button>
  );
}

function FieldRow({ f, value, onChange, accountKey }: { f: McpField; value: string; onChange: (v: string) => void; accountKey?: string }) {
  return (
    <label className="aa-field">
      <span>{f.label}{f.required ? '' : <span className="dim"> · необязательно</span>}</span>
      {f.choices?.length
        ? <select value={value || f.default || ''} onChange={(e) => onChange(e.target.value)} aria-label={f.label}>{!f.required && <option value="">—</option>}{f.choices.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        : <ValueInput value={value} onChange={onChange} secret={f.secret} label={f.label} keyName={f.key} {...(f.default ? { placeholder: f.default } : {})} {...(f.secret && accountKey ? { accountKey } : {})} />}
      {f.description && <span className="dim aa-hint">{f.description}</span>}
    </label>
  );
}

function CatalogInstall({ client, profile, taken, onAdded, servers, add, entry, onBack }: Ctx & { entry: McpCatalogEntry; onBack: () => void }) {
  const first = entry.variants.find((v) => !v.missing) ?? entry.variants[0]!;
  const [vid, setVid] = useState(first.id);
  const v = entry.variants.find((x) => x.id === vid) ?? first;
  const [name, setName] = useState(() => freeName(entry.suggestedName, taken));
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const cfg = fillTemplate(v.template, v.fields, values);
  const nameErr = nameError(name, taken);
  const key = v.kind === 'remote' ? accountKeyFor(profile, { type: v.template.type, ...(typeof cfg !== 'string' && cfg.type !== 'stdio' ? { url: cfg.url } : { url: v.template.url ?? '' }) }) : undefined;

  const install = async () => {
    if (typeof cfg === 'string' || nameErr || v.missing) return;
    setBusy(true);
    setErr('');
    const r = await addAll(client, profile.name, [{ name, config: cfg }], add);
    setBusy(false);
    if (r.errors[name] || !r.servers) { setErr(r.errors[name] ?? 'не добавился'); return; }
    onAdded(r.servers, name, !!needsAuth(r.servers, [name]));
  };

  return (
    <form className="aa-key" onSubmit={(e) => { e.preventDefault(); void install(); }}>
      <div className="mcp-cat-title">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="К результатам поиска"><Icon name="arrowLeft" size={16} /></button>
        <div className="mcp-main">
          <div><b>{entry.title}</b> {entry.version && <span className="dim">v{entry.version}</span>} {entry.deprecated && <span className="mcp-badge warn">устарел</span>}</div>
          <div className="dim aa-hint">
            {entry.publisher} · <span className="mono">{entry.id}</span>
            {entry.repo && <> · <a href={entry.repo} target="_blank" rel="noreferrer">исходники <Icon name="externalLink" size={12} /></a></>}
            {entry.website && <> · <a href={entry.website} target="_blank" rel="noreferrer">сайт <Icon name="externalLink" size={12} /></a></>}
          </div>
          {entry.description && <div className="aa-hint">{entry.description}</div>}
        </div>
      </div>
      {entry.variants.length > 1 && (
        <div className="aa-field">
          <span>Как подключить</span>
          <div className="aa-chips mcp-variants" role="radiogroup" aria-label="Способ подключения">
            {entry.variants.map((x) => (
              <button key={x.id} type="button" role="radio" aria-checked={x.id === v.id} disabled={!!x.missing} className={`aa-chip ${x.id === v.id ? 'on' : ''}`}
                onClick={() => { setVid(x.id); setValues({}); setErr(''); }} {...(x.missing ? { 'data-tip': x.missing } : {})}>{x.label}</button>
            ))}
          </div>
          {entry.variants.some((x) => x.missing) && <span className="dim aa-hint">{entry.variants.filter((x) => x.missing).map((x) => `${KIND[x.kind]}: ${x.missing}`).join(' · ')}</span>}
        </div>
      )}
      <label className="aa-field">
        <span>Имя</span>
        <input className="mono" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} aria-label="Имя MCP-сервера" />
        {nameErr && <span className="err-text aa-hint">{nameErr}</span>}
      </label>
      {v.fields.map((f) => <FieldRow key={`${v.id}:${f.key}`} f={f} value={values[f.key] ?? ''} onChange={(x) => setValues({ ...values, [f.key]: x })} {...(key ? { accountKey: key } : {})} />)}
      <div className="mcp-preview">
        <span className="dim">{v.kind === 'remote' ? 'Адрес' : 'Запуск на сервере'}</span>
        <code className="mono">{previewTemplate(v.template, v.fields, values)}</code>
        {sameAs(servers, cfg) && <span className="warn-text">Такой сервер уже подключён — «{sameAs(servers, cfg)}»</span>}
      </div>
      {v.kind !== 'remote' && (
        <div className="aa-banner warn">
          Пакет скачается из {KIND[v.kind]} и будет запускаться на «{envLabel(client.environment)}» при каждой сессии аккаунта — с правами пользователя
          supervisor'а. Ставьте от авторов, которым доверяете.
        </div>
      )}
      <div className="aa-status" role="status">
        {busy ? <><Icon name="loader" size={14} className="spin" /><span>Добавляем и проверяем подключение (до минуты)…</span></>
          : typeof cfg === 'string' ? <span className="dim">{cfg}</span>
            : <span className="dim">После добавления Claude Code проверит подключение; если сервер попросит вход — откроется его страница</span>}
      </div>
      {err && <div className="err-text">{err}</div>}
      <div className="modal-actions">
        <button className="btn primary" type="submit" disabled={busy || typeof cfg === 'string' || !!nameErr || !!v.missing}>{busy ? 'Добавляю…' : 'Добавить'}</button>
      </div>
    </form>
  );
}

function CatalogPane(ctx: Ctx) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ query: string; entries: McpCatalogEntry[]; skipped: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<McpCatalogEntry | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    const my = ++seq.current;
    if (query.length < 2) { setRes(null); setErr(''); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(() => {
      ctx.client.mcpCatalogSearch(query).then(
        (r) => { if (seq.current === my) { setRes({ query, ...r }); setErr(''); } },
        (e) => { if (seq.current === my) setErr(errText(e)); },
      ).finally(() => { if (seq.current === my) setLoading(false); });
    }, 400);
    return () => clearTimeout(t);
  }, [q]);

  if (sel) return <CatalogInstall {...ctx} entry={sel} onBack={() => setSel(null)} />;
  return (
    <div className="mcp-cat">
      <label className="mcp-search">
        <Icon name="search" size={14} className="dim" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти сервер: notion, github, postgres, figma…" aria-label="Поиск в каталоге MCP" spellCheck={false} />
        {loading && <Icon name="loader" size={14} className="spin dim" />}
      </label>
      {!res && !err && (
        <div className="dim aa-hint">
          Официальный каталог MCP (registry.modelcontextprotocol.io) — его ведут авторы протокола. Записи публикуют сами авторы
          серверов, каталог проверяет только, что имя принадлежит автору (его домен или аккаунт GitHub), поэтому рядом с названием — кто опубликовал.
        </div>
      )}
      {err && <div className="err-text">{err}</div>}
      {res && res.entries.length === 0 && !loading && (
        <div className="dim acct-note">
          По «{res.query}» ничего не нашлось{res.skipped ? ` (ещё ${res.skipped} — в форматах, которые отсюда не ставятся)` : ''}. Попробуйте другое слово
          или вкладку «Из документации».
        </div>
      )}
      {res && res.entries.length > 0 && (
        <div className={`mcp-cat-list ${loading ? 'stale' : ''}`}>
          {res.entries.map((e) => <CatalogRow key={e.id} e={e} onPick={() => setSel(e)} />)}
        </div>
      )}
      {res && res.skipped > 0 && res.entries.length > 0 && <div className="dim aa-hint">Ещё {res.skipped} — в форматах, которые отсюда не ставятся (mcpb, NuGet).</div>}
    </div>
  );
}

// ─── Черновик: форма сервера (вручную и после вставки) ──────────────────────

function KvRows({ rows, onChange, kind, accountKey }: { rows: KV[]; onChange: (r: KV[]) => void; kind: 'header' | 'env'; accountKey?: string }) {
  const set = (i: number, patch: Partial<KV>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="mcp-kv">
      {rows.map((r, i) => (
        <div key={i} className="mcp-kv-row">
          <input className="mono mcp-kv-name" value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder={kind === 'header' ? 'Authorization' : 'API_KEY'} aria-label={kind === 'header' ? 'Заголовок' : 'Переменная'} spellCheck={false} />
          <ValueInput value={r.value} onChange={(v) => set(i, { value: v })} secret={secretish(r.name)} label="Значение" keyName={r.name} placeholder={kind === 'header' ? 'Bearer …' : 'значение'} {...(accountKey ? { accountKey } : {})} />
          <button type="button" className="icon-btn" onClick={() => onChange(rows.filter((_, k) => k !== i))} aria-label="Убрать"><Icon name="x" size={14} /></button>
        </div>
      ))}
      <button type="button" className="btn sm ghost mcp-kv-add" onClick={() => onChange([...rows, { name: '', value: '' }])}>
        <Icon name="plus" size={12} /> {kind === 'header' ? 'Заголовок' : 'Переменная'}
      </button>
    </div>
  );
}

function DraftEditor({ d, onChange, taken, profile, compact }: { d: McpDraft; onChange: (d: McpDraft) => void; taken: Set<string>; profile: ProfileInfo; compact?: boolean }) {
  const nameErr = d.name ? nameError(d.name, taken) : '';
  const key = accountKeyFor(profile, d);
  const warn = draftWarnings(d);
  const set = (patch: Partial<McpDraft>) => onChange({ ...d, ...patch });
  return (
    <div className={`mcp-draft ${compact ? 'compact' : ''}`}>
      <div className="aa-row2">
        <label className="aa-field">
          <span>Имя</span>
          <input className="mono" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={64} aria-label="Имя MCP-сервера" placeholder="notion" />
          {nameErr && <span className="err-text aa-hint">{nameErr}</span>}
        </label>
        <div className="aa-field">
          <span>Тип</span>
          <div className="seg mcp-type" role="radiogroup" aria-label="Тип подключения">
            {(['http', 'sse', 'stdio'] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={d.type === t} className={d.type === t ? 'on' : ''} onClick={() => set({ type: t })}>
                {t === 'stdio' ? 'Команда' : t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        {d.type !== 'stdio'
          ? (
            <label className="aa-field grow">
              <span>Адрес</span>
              <input className="mono" value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://…/mcp" aria-label="Адрес MCP-сервера" spellCheck={false} />
            </label>
          )
          : (
            <label className="aa-field grow">
              <span>Команда</span>
              <input className="mono" value={d.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" aria-label="Команда" spellCheck={false} />
            </label>
          )}
      </div>
      {d.type === 'stdio' && (
        <label className="aa-field">
          <span>Аргументы</span>
          <input className="mono" value={d.args} onChange={(e) => set({ args: e.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem /home/yan/projects" aria-label="Аргументы" spellCheck={false} />
        </label>
      )}
      <div className="aa-field">
        <span>{d.type === 'stdio' ? 'Переменные окружения' : 'Заголовки'}<span className="dim"> · значения уходят только на сервер</span></span>
        {d.type === 'stdio'
          ? <KvRows rows={d.env} onChange={(env) => set({ env })} kind="env" {...(key ? { accountKey: key } : {})} />
          : <KvRows rows={d.headers} onChange={(headers) => set({ headers })} kind="header" {...(key ? { accountKey: key } : {})} />}
      </div>
      {warn.map((w) => <div key={w} className="warn-text aa-hint mcp-warn"><Icon name="alert" size={12} /><span>{w}</span></div>)}
      {d.type === 'stdio' && !compact && <span className="dim aa-hint">Команда запускается на сервере от пользователя supervisor'а при каждой сессии аккаунта.</span>}
    </div>
  );
}

function ManualPane({ client, profile, taken, onAdded, add: addFn }: Ctx) {
  const [d, setD] = useState<McpDraft>(emptyDraft('http'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const cfg = draftToConfig(d);
  const nameErr = nameError(d.name, taken);
  const add = async () => {
    if (typeof cfg === 'string' || nameErr) return;
    setBusy(true);
    setErr('');
    const r = await addAll(client, profile.name, [{ name: d.name, config: cfg }], addFn);
    setBusy(false);
    if (r.errors[d.name] || !r.servers) { setErr(r.errors[d.name] ?? 'не добавился'); return; }
    onAdded(r.servers, d.name, !!needsAuth(r.servers, [d.name]));
  };
  const touched = !!(d.name || d.url || d.command);
  return (
    <form className="aa-key" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <DraftEditor d={d} onChange={setD} taken={taken} profile={profile} />
      <div className="aa-status" role="status">
        {busy ? <><Icon name="loader" size={14} className="spin" /><span>Добавляем и проверяем подключение (до минуты)…</span></>
          : touched && typeof cfg === 'string' ? <span className="warn-text">{cfg}</span>
            : <span className="dim">Если сервер попросит вход через свою страницу — кнопка «Войти» появится в списке</span>}
      </div>
      {err && <div className="err-text">{err}</div>}
      <div className="modal-actions">
        <button className="btn primary" type="submit" disabled={busy || typeof cfg === 'string' || !!nameErr}>{busy ? 'Добавляю…' : 'Добавить'}</button>
      </div>
    </form>
  );
}

const PASTE_HINT = `Например:
{ "mcpServers": { "web-search-prime": { "type": "http", "url": "https://api.z.ai/api/mcp/web_search_prime/mcp", "headers": { "Authorization": "Bearer your_api_key" } } } }

claude mcp add --transport http notion https://mcp.notion.com/mcp

npx -y @upstash/context7-mcp`;

function PastePane({ client, profile, taken, onAdded, add: addFn }: Ctx) {
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<McpDraft[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [perr, setPerr] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const parse = (t: string) => {
    setText(t);
    setErrors({});
    const r = parseMcpPaste(t);
    const used = new Set(taken);
    // повтор имён среди вставленных и уже установленных — сразу свободные
    setDrafts(r.servers.map((d) => { const name = freeName(d.name, used); used.add(name); return { ...d, name }; }));
    setNotes(r.notes);
    setPerr(r.error ?? '');
  };

  const names = drafts.map((d) => d.name);
  const configs = drafts.map((d) => draftToConfig(d));
  const bad = drafts.findIndex((d, i) => typeof configs[i] === 'string' || nameError(d.name, taken) || names.indexOf(d.name) !== i);
  const add = async () => {
    if (bad >= 0 || !drafts.length) return;
    setBusy(true);
    const r = await addAll(client, profile.name, drafts.map((d, i) => ({ name: d.name, config: configs[i] as McpConfig })), addFn);
    setBusy(false);
    setErrors(r.errors);
    const ok = drafts.filter((d) => !r.errors[d.name]).map((d) => d.name);
    if (Object.keys(r.errors).length === 0 && r.servers) { onAdded(r.servers, ok[0]!, !!needsAuth(r.servers, ok)); return; }
    // часть встала — оставить только неудавшиеся
    setDrafts(drafts.filter((d) => r.errors[d.name]));
  };

  return (
    <form className="aa-key" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <label className="aa-field">
        <span>JSON или команда из документации сервера</span>
        <textarea className="mono aa-area mcp-paste" rows={drafts.length ? 4 : 8} value={text} onChange={(e) => parse(e.target.value)} placeholder={PASTE_HINT} spellCheck={false} aria-label="Вставка конфигурации MCP" />
        <span className="dim aa-hint">Понимаю {'{"mcpServers": …}'} (Claude Desktop, Cursor), {'{"servers": …}'} (VS Code), «claude mcp add …», адрес https://… и строку запуска npx/uvx/docker. Заглушки вроде your_api_key замените ниже.</span>
      </label>
      {perr && text.trim() && <div className="warn-text">{perr}</div>}
      {notes.map((n) => <div key={n} className="dim aa-hint">· {n}</div>)}
      {drafts.map((d, i) => (
        <div key={i} className="mcp-draft-card">
          <DraftEditor d={d} onChange={(x) => setDrafts(drafts.map((y, k) => (k === i ? x : y)))} taken={taken} profile={profile} compact />
          {typeof configs[i] === 'string' && <div className="warn-text aa-hint">{configs[i] as string}</div>}
          {names.indexOf(d.name) !== i && <div className="err-text aa-hint">имя повторяется во вставке</div>}
          {errors[d.name] && <div className="err-text aa-hint">{errors[d.name]}</div>}
        </div>
      ))}
      <div className="aa-status" role="status">
        {busy && <><Icon name="loader" size={14} className="spin" /><span>Добавляем и проверяем подключение (до минуты)…</span></>}
      </div>
      <div className="modal-actions">
        <button className="btn primary" type="submit" disabled={busy || !drafts.length || bad >= 0}>
          {busy ? 'Добавляю…' : drafts.length > 1 ? `Добавить все (${drafts.length})` : 'Добавить'}
        </button>
      </div>
    </form>
  );
}

// ─── Вкладки ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'catalog', label: 'Каталог' },
  { id: 'paste', label: 'Из документации' },
  { id: 'manual', label: 'Вручную' },
] as const;

export function AddMcp(ctx: Ctx) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('catalog');
  return (
    <div className="mcp-add">
      <div className="seg env-seg mcp-tabs" role="tablist" aria-label="Откуда сервер">
        {TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      {/* вкладки не размонтируются — поиск и вставка не теряются при переключении */}
      <div hidden={tab !== 'catalog'}><CatalogPane {...ctx} /></div>
      <div hidden={tab !== 'paste'}><PastePane {...ctx} /></div>
      <div hidden={tab !== 'manual'}><ManualPane {...ctx} /></div>
    </div>
  );
}
