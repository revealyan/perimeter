// Вкладка «Файлы» (BD2, P2): поиск «Найти файл · Ctrl P», «Все / Изменённые N», ленивое дерево
// с git-метками и точками на папках, просмотр файла с номерами строк, подсветкой и отметками правок сессии,
// «@ Упомянуть в сообщении» и «Открыть в VS Code».
import { encodingLabel } from '../lib/panelData';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import type { SessionView, SupervisorClient } from '../supervisor';
import { isRemote } from '../supervisor';
import { connections } from '../connections';
import { filesModel, READ_MAX_BYTES, type FilesModel } from '../files';
import {
  baseName, crumbs, dirTone, fmtSize, markFor, matchFiles, mentionOf, parentOf, samePath, toAbs, vscodeUrl,
  type GitIndex, type GitMark, type RemoteHost,
} from '../lib/fileTree';
import type { FileChange } from '../lib/feedModel';
import { sessionLineMarks } from '../lib/lineMarks';
import { plainLines, splitHighlighted } from '../lib/hlLines';
import { langOf } from '../lib/toolFormat';
import { countOf } from '../lib/ru';
import { highlightCode } from './Markdown';
import { Icon } from './Icon';

/** Подсветка тяжёлая — большие файлы показываем без неё. */
const HL_MAX_CHARS = 300_000;
/** Сколько строк рисуем сразу; дальше — по кнопке. */
const LINES_FIRST = 3000;
const SPLIT_KEY = 'perimeter:files-split';

// ─── хост VPS для «Открыть в VS Code» ───────────────────────────────────────

let tunnelInfo: Promise<RemoteHost | null> | null = null;
/** Хост подключения: из списка подключений (у каждого VPS свой), иначе — старый tunnelInfo первого VPS. */
function useRemoteHost(env: string): RemoteHost | null {
  const [host, setHost] = useState<RemoteHost | null>(null);
  const c = connections.get(env);
  const own: RemoteHost | null = c?.kind === 'vps' && c.host ? { host: c.host, ...(c.user ? { user: c.user } : {}), ...(c.port ? { port: c.port } : {}) } : null;
  const ownKey = own ? `${own.user ?? ''}@${own.host}:${own.port ?? ''}` : '';
  useEffect(() => {
    if (ownKey || env !== 'vps') return;
    const ipc = window.perimeterIPC;
    if (!ipc?.tunnelInfo) return;
    tunnelInfo ??= ipc.tunnelInfo().catch(() => null);
    let live = true;
    void tunnelInfo.then((h) => { if (live) setHost(h); });
    return () => { live = false; };
  }, [env, ownKey]);
  return own ?? host;
}

/** vscode:// — через main (shell.openExternal); в браузере-стенде — обычной ссылкой. */
function openExternal(url: string): void {
  const ipc = window.perimeterIPC;
  if (ipc?.openExternal) { void ipc.openExternal(url); return; }
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noreferrer';
  a.click();
}

function useModel(m: FilesModel): void {
  const [, setTick] = useState(0);
  useEffect(() => m.subscribe(() => setTick((t) => t + 1)), [m]);
}

// ─── вкладка ────────────────────────────────────────────────────────────────

export function FilesTab({ session, client, changes, onMention }: {
  session: SessionView;
  client: SupervisorClient;
  /** правки сессии по файлам (из ленты) — для отметок и автообновления */
  changes: FileChange[];
  onMention: (text: string) => void;
}) {
  const model = filesModel(client, session.id);
  useModel(model);
  const env = client.environment;
  const remote = useRemoteHost(env);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [split, setSplit] = useState(() => {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(v) && v >= 0.15 && v <= 0.85 ? v : 0.42;
  });

  useEffect(() => { model.start(); }, [model]);
  useEffect(() => { setQuery(''); }, [session.id]);

  // выбранный файл (из поиска, после перезапуска) — в видимую часть дерева, когда его строка появится
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!model.selected || scrolledTo.current === model.selected) return;
    const row = listRef.current?.querySelector('.ft-file.on, .ft-path.on');
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      scrolledTo.current = model.selected;
    }
  });

  // автообновление: после хода и после каждой применённой правки агента; после реконнекта
  const editCount = changes.reduce((n, c) => n + c.itemIds.length, 0);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => void model.refresh(), 400);
    return () => clearTimeout(t);
  }, [editCount, session.lastResult, client.status === 'live']);

  // Ctrl+P — к поиску (пока вкладка открыта)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyP') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, []);

  const root = model.root;
  const abs = (rel: string) => (root ? toAbs(root, rel) : rel);
  const urlFor = (rel: string) => (root ? vscodeUrl(env, abs(rel), remote) : null);
  const vsTip = isRemote(env)
    ? (remote ? `Открыть в VS Code через Remote SSH (${remote.user ? `${remote.user}@` : ''}${remote.host})` : 'Нужен хост VPS: в приложении — из настроек подключения; в браузере-стенде недоступно')
    : 'Открыть файл в VS Code на этом компьютере';
  const mention = (rel: string) => onMention(mentionOf(rel));

  const idx = model.git.idx;
  /** git.status: ветки нет и файлов нет — папка не в репозитории */
  const notRepo = model.git.status === 'ok' && model.git.data?.branch === null && (model.git.data?.files.length ?? 0) === 0;
  const changedCount = idx ? idx.paths.length : 0;
  const results = useMemo(() => (query.trim() ? matchFiles(query, model.knownFiles()) : []), [query, model.version]);
  useEffect(() => { setHi(0); }, [query]);

  const pick = (rel: string) => {
    if (rel.endsWith('/')) {
      // неотслеживаемая папка целиком — раскрываем в дереве
      const dir = rel.slice(0, -1);
      model.setMode('all');
      if (!model.expanded.has(dir)) model.toggle(dir);
      for (let p = parentOf(dir); p; p = parentOf(p)) if (!model.expanded.has(p)) model.toggle(p);
      return;
    }
    model.select(rel);
  };

  const onSearchKey = (e: RKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setQuery(''); return; }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[hi];
      if (r) { pick(r); setQuery(''); }
    }
  };

  // перетаскивание разделителя дерево / просмотр
  const startSplit = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = bodyRef.current?.getBoundingClientRect();
    if (!box) return;
    document.body.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    let last = split;
    const move = (ev: PointerEvent) => {
      last = Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height));
      setSplit(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging');
      document.body.style.cursor = '';
      localStorage.setItem(SPLIT_KEY, String(last));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const rootState = model.dirs.get('');
  const rootName = root ? baseName(root) : 'папка сессии';

  let list: ReactNode;
  if (query.trim()) {
    list = (
      <div className="ft-results" role="listbox" aria-label="Найденные файлы">
        {results.length === 0 && <div className="ft-note">Ничего не нашлось среди загруженного.</div>}
        {results.map((p, i) => (
          <PathRow key={p} path={p} mark={idx ? markFor(p.replace(/\/$/, ''), idx) : null} on={i === hi} selected={p === model.selected}
            onClick={() => { pick(p); setQuery(''); }} onHover={() => setHi(i)} />
        ))}
        <div className="ft-note">Ищем среди раскрытых папок и изменённых файлов. Раскройте папку — найдётся и в ней.</div>
      </div>
    );
  } else if (rootState?.status === 'error' && rootState.entries.length === 0) {
    list = (
      <div className="panel-empty">
        <Icon name="alert" size={20} />
        <div>Не удалось открыть папку сессии</div>
        <div className="dim">{rootState.error}</div>
        <button className="btn sm" onClick={() => model.start()}><Icon name="refresh" size={14} /> Повторить</button>
      </div>
    );
  } else if (model.mode === 'changed') {
    list = (
      <div className="ft-results" role="listbox" aria-label="Изменённые файлы">
        {model.git.status === 'error' && <div className="ft-note err-text">{model.git.error}</div>}
        {notRepo && <div className="ft-note">Папка сессии не в git-репозитории — изменённые файлы не отслеживаются.</div>}
        {model.git.status === 'ok' && !notRepo && changedCount === 0 && <div className="ft-note">Изменений нет — рабочая копия чистая.</div>}
        {idx?.paths.map((p) => (
          <PathRow key={p} path={p} mark={markFor(p.replace(/\/$/, ''), idx)} on={false} selected={p === model.selected} onClick={() => pick(p)} />
        ))}
      </div>
    );
  } else {
    list = (
      <div className="ft-tree" role="tree" aria-label="Файлы сессии">
        <div className="ft-row ft-root" role="treeitem" aria-expanded title={root ?? undefined}>
          <Icon name="chevronDown" size={14} className="ft-chev" />
          <Icon name="folderOpen" size={14} className="ft-ico" />
          <span className="ft-name"><b>{rootName}</b> {root && <span className="dim mono">{root}</span>}</span>
          {model.git.data?.branch && <span className="ft-branch dim" data-tip="Ветка git"><Icon name="gitBranch" size={12} />{model.git.data.branch}</span>}
        </div>
        <DirRows model={model} path="" depth={1} idx={idx} onMention={mention} urlFor={urlFor} vsTip={vsTip} />
      </div>
    );
  }

  const gitOk = model.git.status === 'ok' && !notRepo;
  const changedTip = model.git.status === 'error'
    ? `git: ${model.git.error ?? 'ошибка'}`
    : model.git.status === 'loading' ? 'git-статус загружается…' : notRepo ? 'Папка сессии не в git-репозитории' : 'Изменённые и новые файлы по git';

  return (
    <div className="files-tab">
      <div className="files-bar">
        <label className="files-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Найти файл"
            aria-label="Найти файл"
            spellCheck={false}
          />
          {!query && <kbd>Ctrl P</kbd>}
          {query && <button className="icon-btn sm" aria-label="Очистить" onClick={() => setQuery('')}><Icon name="x" size={14} /></button>}
        </label>
        <div className="seg" role="group" aria-label="Какие файлы показать">
          <button className={model.mode === 'all' ? 'on' : ''} aria-pressed={model.mode === 'all'} onClick={() => model.setMode('all')}>Все</button>
          <button
            className={`${model.mode === 'changed' ? 'on' : ''} ${!gitOk ? 'is-off' : ''}`}
            aria-pressed={model.mode === 'changed'}
            onClick={() => model.setMode('changed')}
            data-tip={changedTip}
          >Изменённые{gitOk && <span className="seg-n">{changedCount}</span>}</button>
        </div>
        <button className="icon-btn" onClick={() => void model.refresh()} aria-label="Обновить" data-tip="Обновить дерево, git и файл"><Icon name="refresh" size={14} /></button>
      </div>
      <div className="files-body" ref={bodyRef} style={model.selected ? { gridTemplateRows: `${Math.round(split * 1000) / 10}% 6px minmax(0, 1fr)` } : undefined}>
        <div className="files-list" ref={listRef}>{list}</div>
        {model.selected && (
          <>
            <div className="files-divider" onPointerDown={startSplit} onDoubleClick={() => { setSplit(0.42); localStorage.setItem(SPLIT_KEY, '0.42'); }} data-tip="Потяните, чтобы изменить высоту" role="separator" aria-orientation="horizontal" />
            <FileView
              model={model}
              session={session}
              changes={changes}
              abs={abs}
              mark={idx && model.selected ? markFor(model.selected, idx) : null}
              vsUrl={urlFor(model.selected)}
              vsTip={vsTip}
              env={env}
              onMention={() => model.selected && mention(model.selected)}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ─── дерево ─────────────────────────────────────────────────────────────────

function DirRows({ model, path, depth, idx, onMention, urlFor, vsTip }: {
  model: FilesModel;
  path: string;
  depth: number;
  idx: GitIndex | undefined;
  onMention: (rel: string) => void;
  urlFor: (rel: string) => string | null;
  vsTip: string;
}) {
  const st = model.dirs.get(path);
  const pad = { paddingLeft: 8 + depth * 16 };
  if (!st) return null;
  if (st.status === 'loading' && st.entries.length === 0) return <div className="ft-row ft-dim" style={pad}>загрузка…</div>;
  if (st.status === 'error' && st.entries.length === 0) {
    return (
      <div className="ft-row ft-err" style={pad}>
        <span className="err-text">{st.error}</span>
        <button className="link-btn" onClick={() => void model.loadDir(path)}>повторить</button>
      </div>
    );
  }
  if (st.entries.length === 0) return <div className="ft-row ft-dim" style={pad}>пусто</div>;
  return (
    <>
      {st.entries.map((e) => {
        const rel = path ? `${path}/${e.name}` : e.name;
        if (e.kind === 'dir') {
          const open = model.expanded.has(rel);
          const tone = idx ? dirTone(rel, idx) : null;
          return (
            <div key={rel} role="none">
              <div className="ft-row" role="treeitem" aria-expanded={open} tabIndex={0} style={{ paddingLeft: 8 + depth * 16 }}
                onClick={() => model.toggle(rel)}
                onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); model.toggle(rel); } }}>
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="ft-chev" />
                <Icon name={open ? 'folderOpen' : 'folder'} size={14} className="ft-ico" />
                <span className="ft-name">{e.name}</span>
                {tone && <span className={`ft-dot tone-${tone}`} aria-label="внутри есть изменения" />}
              </div>
              {open && <DirRows model={model} path={rel} depth={depth + 1} idx={idx} onMention={onMention} urlFor={urlFor} vsTip={vsTip} />}
            </div>
          );
        }
        const mark = idx ? markFor(rel, idx) : null;
        const sel = model.selected === rel;
        const url = urlFor(rel);
        return (
          <div key={rel} className={`ft-row ft-file ${sel ? 'on' : ''}`} role="treeitem" aria-selected={sel} tabIndex={0}
            style={{ paddingLeft: 8 + depth * 16 + 18 }}
            onClick={() => model.select(rel)}
            onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); model.select(rel); } }}
            title={e.kind === 'link' ? `${rel} (ссылка)` : rel}>
            <Icon name={langOf(e.name) ? 'fileCode' : 'file'} size={14} className="ft-ico" />
            <span className="ft-name">{e.name}</span>
            <span className="ft-actions" onClick={(ev) => ev.stopPropagation()}>
              <button className="ft-act" onClick={() => onMention(rel)} data-tip="Упомянуть в сообщении (@путь)"><Icon name="atSign" size={12} />упомянуть</button>
              <button className={`ft-act ${url ? '' : 'is-disabled'}`} aria-disabled={!url} onClick={() => url && openExternal(url)} data-tip={vsTip}><Icon name="externalLink" size={12} />открыть</button>
            </span>
            {mark && <GitBadge mark={mark} />}
          </div>
        );
      })}
      {st.more ? <div className="ft-row ft-dim" style={pad}>ещё {st.more} — папка большая, показано начало</div> : null}
    </>
  );
}

function GitBadge({ mark }: { mark: GitMark }) {
  return <span className={`ft-mark tone-${mark.tone}`} data-tip={mark.label}>{mark.code}</span>;
}

/** Строка плоского списка (поиск, «Изменённые»): имя + папка, git-метка справа. */
function PathRow({ path, mark, on, selected, onClick, onHover }: {
  path: string; mark: GitMark | null; on: boolean; selected: boolean; onClick: () => void; onHover?: () => void;
}) {
  const dirOnly = path.endsWith('/');
  const clean = path.replace(/\/$/, '');
  const dir = parentOf(clean);
  return (
    <button role="option" aria-selected={selected} className={`ft-row ft-path ${on ? 'hi' : ''} ${selected ? 'on' : ''}`} onClick={onClick} onMouseEnter={onHover} title={path}>
      <Icon name={dirOnly ? 'folder' : langOf(clean) ? 'fileCode' : 'file'} size={14} className="ft-ico" />
      <span className="ft-name">{baseName(clean)}{dirOnly ? '/' : ''}</span>
      {dir && <span className="ft-dir dim mono">{dir}</span>}
      <span className="spacer" />
      {mark && <GitBadge mark={mark} />}
    </button>
  );
}

// ─── просмотр файла ─────────────────────────────────────────────────────────

function FileView({ model, session, changes, abs, mark, vsUrl, vsTip, env, onMention }: {
  model: FilesModel;
  session: SessionView;
  changes: FileChange[];
  abs: (rel: string) => string;
  mark: GitMark | null;
  vsUrl: string | null;
  vsTip: string;
  env: string;
  onMention: () => void;
}) {
  const rel = model.selected!;
  const f = model.file?.path === rel ? model.file : null;
  const data = f?.data;
  const absPath = abs(rel);
  const change = changes.find((c) => samePath(c.path, absPath));
  const [all, setAll] = useState(false);
  useEffect(() => { setAll(false); }, [rel]);

  const text = data && !data.binary ? data.content.replace(/\r\n/g, '\n') : '';
  const lines = useMemo(() => {
    if (!data || data.binary) return [];
    const html = text.length <= HL_MAX_CHARS ? highlightCode(text, langOf(rel)) : null;
    const out = html !== null ? splitHighlighted(html) : plainLines(text);
    if (out.length > 1 && out[out.length - 1] === '') out.pop(); // перенос в конце файла — не строка
    return out;
  }, [text, data?.binary, rel]);
  const editIds = change?.itemIds.join(',') ?? '';
  const marks = useMemo(
    () => sessionLineMarks(session.items, (p) => samePath(p, absPath), text),
    [text, absPath, editIds],
  );
  const shown = all ? lines : lines.slice(0, LINES_FIRST);

  let body: ReactNode;
  if (!f || (f.status === 'loading' && !data)) {
    body = <div className="fv-state"><div className="skeleton-line w70" /><div className="skeleton-line w40" /><div className="skeleton-line w85" /></div>;
  } else if (f.status === 'error' && !data) {
    body = (
      <div className="panel-empty">
        <Icon name="alert" size={20} />
        <div>Не удалось прочитать файл</div>
        <div className="dim">{f.error}</div>
        <button className="btn sm" onClick={() => void model.loadFile(rel)}><Icon name="refresh" size={14} /> Повторить</button>
      </div>
    );
  } else if (data?.binary) {
    body = (
      <div className="panel-empty">
        <Icon name="binary" size={20} />
        <div>Бинарный файл, {fmtSize(data.size)}</div>
        <div className="dim">Просмотр не поддерживается — откройте в редакторе.</div>
      </div>
    );
  } else {
    body = (
      <div className="fv-code">
        {data?.truncated && (
          <div className="fv-note">Файл большой — показано начало: {fmtSize(Math.min(READ_MAX_BYTES, data.content.length))} из {fmtSize(data.size)}.</div>
        )}
        {encodingLabel(data?.encoding) && <div className="fv-note">Кодировка: {encodingLabel(data?.encoding)}</div>}
        {lines.length === 0 || (lines.length === 1 && lines[0] === '')
          ? <div className="fv-note">Пустой файл.</div>
          : (
            <div className="fv-lines" role="presentation">
              {marks.delAfter.has(0) && <div className="fv-line"><span className="fv-no" /><span className="fv-gut del-before" /><span className="fv-text" /></div>}
              {shown.map((html, i) => {
                const n = i + 1;
                const m = marks.lines.get(n);
                return (
                  <div key={i} className="fv-line">
                    <span className="fv-no">{n}</span>
                    <span className={`fv-gut ${m ?? ''} ${marks.delAfter.has(n) ? 'del-after' : ''}`} {...(m ? { 'data-tip': m === 'add' ? 'добавлено в этой сессии' : 'изменено в этой сессии' } : {})} />
                    <span className="fv-text" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                  </div>
                );
              })}
            </div>
          )}
        {lines.length > shown.length && (
          <button className="link-btn fv-more" onClick={() => setAll(true)}>показать ещё {countOf(lines.length - shown.length, ['строку', 'строки', 'строк'])}</button>
        )}
      </div>
    );
  }

  return (
    <div className="fv" aria-label={`Файл ${rel}`}>
      <div className="fv-head">
        <span className="fv-crumbs" title={absPath}>
          {crumbs(rel).map((c, i, arr) => (
            <span key={i}>{i > 0 && <span className="fv-sep">›</span>}{i === arr.length - 1 ? <b>{c}</b> : c}</span>
          ))}
        </span>
        <span className="spacer" />
        {f?.status === 'loading' && data && <Icon name="loader" size={12} className="spin dim" />}
        {mark && <GitBadge mark={mark} />}
        {change && <span className="mono fv-stat" data-tip="Правки агента в этой сессии"><span className="add">+{change.added}</span> <span className="del">−{change.removed}</span></span>}
        <button className="icon-btn sm" onClick={() => model.select(null)} aria-label="Закрыть просмотр" data-tip="Закрыть просмотр"><Icon name="x" size={14} /></button>
      </div>
      <div className="fv-actions">
        <button className="btn sm" onClick={onMention} data-tip="Вставить @путь в строку ввода"><Icon name="atSign" size={14} /> Упомянуть в сообщении</button>
        <button className={`btn sm ${vsUrl ? '' : 'is-disabled'}`} aria-disabled={!vsUrl} onClick={() => vsUrl && openExternal(vsUrl)} data-tip={vsTip}>
          <Icon name="externalLink" size={14} /> Открыть в VS Code{isRemote(env) && <span className="dim"> (Remote SSH)</span>}
        </button>
      </div>
      <div className="fv-body">{body}</div>
    </div>
  );
}
