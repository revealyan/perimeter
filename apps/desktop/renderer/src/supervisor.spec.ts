// Хранилище клиента против фейкового WebSocket: реконнект, hello, команды с ответом, лента.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeWS.all.push(this); }
  send(d: string) { this.sent.push(JSON.parse(d) as Record<string, unknown>); }
  close() { this.readyState = 3; this.onclose?.(); }
  // ── помощники теста ──
  open() { this.readyState = 1; this.onopen?.(); }
  recv(f: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify({ v: 1, ts: Date.now(), ...f }) }); }
  last(type: string) { return [...this.sent].reverse().find((f) => f['type'] === type); }
}

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
});
vi.stubGlobal('WebSocket', FakeWS);
// rAF, который никогда не срабатывает (перекрытое окно) — флаш обязан прийти по таймеру
vi.stubGlobal('requestAnimationFrame', () => 0);

const { SupervisorClient, computeSyncSuggestions } = await import('./supervisor');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const GHOST = '99999999-9999-4999-8999-999999999999';

const hello = (sessions: Array<Record<string, unknown>>) => ({ type: 'event:hello', seq: 0, server: { version: 't', uptimeMs: 1 }, sessions });
const ack = (id: unknown, data?: unknown) => ({ id, ok: true, ...(data !== undefined ? { data } : {}) });

function connected() {
  const c = new SupervisorClient();
  c.connect();
  const ws = FakeWS.all.at(-1)!;
  ws.open();
  return { c, ws };
}

beforeEach(() => { FakeWS.all = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('SupervisorClient', () => {
  it('перерисовка доходит, даже когда rAF не срабатывает (окно перекрыто)', () => {
    const { c } = connected();
    const fn = vi.fn();
    c.subscribe(fn);
    c.showError('x');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('event:session.created — воркер появляется в сторе без hello (имя и родитель на месте)', () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: S1, name: 'главная', state: 'working' }]));
    ws.recv({ type: 'event:session.created', seq: 0, session: { id: S2, name: 'сабагент · главная', state: 'creating', profile: 'zai', parentSessionId: S1, agentOf: 'delegate_to_agent' } });
    const v = c.sessions.get(S2);
    expect(v).toBeDefined();
    expect(v!.name).toBe('сабагент · главная'); // не обрубок id
    expect(v!.parentSessionId).toBe(S1);
    expect(v!.profile).toBe('zai');
    // повторный hello не затирает вложенность
    ws.recv(hello([{ id: S1, name: 'главная', state: 'idle' }, { id: S2, name: 'сабагент · главная', state: 'idle', profile: 'zai', parentSessionId: S1 }]));
    expect(c.sessions.get(S2)!.parentSessionId).toBe(S1);
  });

  it('hello убирает сессии, которых больше нет на сервере (призраки после рестарта)', () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: GHOST, name: 'старая', state: 'idle' }]));
    expect(c.sessions.has(GHOST)).toBe(true);
    ws.recv(hello([{ id: S1, name: 'новая', state: 'idle' }]));
    expect([...c.sessions.keys()]).toEqual([S1]);
    expect(c.activeId).toBe(S1);
  });

  it('hello не запрашивает ресинк повторно, пока идёт первый; ошибка транскрипта не даёт тоста', async () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: S1, name: 'a', state: 'idle' }]));
    const get = ws.last('cmd:transcript.get')!;
    ws.recv({ id: get['id'], ok: false, code: 'TRANSCRIPT_NOT_FOUND', message: '/x.jsonl' });
    await vi.runAllTimersAsync();
    expect(c.lastError).toBe('');
    expect(c.sessions.get(S1)!.resyncing).toBe(false);
  });

  it('история грузится только у открытой сессии; остальные — при открытии и один раз', async () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: S1, name: 'a', state: 'idle' }, { id: S2, name: 'b', state: 'idle' }]));
    const gets = () => ws.sent.filter((f) => f['type'] === 'cmd:transcript.get');
    // через медленный туннель все истории разом забивают канал — тянем только выбранную
    const first = c.activeId!;
    expect(gets().map((f) => f['sessionId'])).toEqual([first]);
    ws.recv(ack(gets()[0]!['id'], { items: [{ kind: 'user', data: { text: 'привет' } }], lastSeq: 3 }));
    await vi.runAllTimersAsync();
    const other = first === S1 ? S2 : S1;
    c.select(other);
    expect(gets().map((f) => f['sessionId'])).toEqual([first, other]);
    ws.recv(ack(gets()[1]!['id'], { items: [], lastSeq: null }));
    await vi.runAllTimersAsync();
    // вернулись к уже загруженным — повторно не тянем
    c.select(S1);
    c.select(S2);
    expect(gets()).toHaveLength(2);
    expect(c.sessions.get(S1)!.historyLoaded && c.sessions.get(S2)!.historyLoaded).toBe(true);
  });

  it('newSession шлёт модель и режим, после ack выбирает новую сессию с введённым именем', async () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: S1, name: 'a', state: 'idle' }]));
    const p = c.newSession({ name: 'тест диалога', profile: 'zai', model: 'glm-4.6', permissionMode: 'plan' });
    const cmd = ws.last('cmd:session.new')!;
    expect(cmd).toMatchObject({ name: 'тест диалога', profile: 'zai', model: 'glm-4.6', permissionMode: 'plan' });
    // событие состояния новой сессии приходит раньше ack — имя не должно стать «22222222»
    ws.recv({ type: 'event:session.state', sessionId: S2, seq: 0, state: 'initializing' });
    ws.recv(ack(cmd['id'], { sessionId: S2 }));
    expect(await p).toBe(S2);
    expect(c.activeId).toBe(S2);
    expect(c.sessions.get(S2)!.name).toBe('тест диалога');
    // у новой сессии историю не тянем: ответ ресинка затёр бы первое сообщение
    expect(ws.sent.filter((f) => f['type'] === 'cmd:transcript.get' && f['sessionId'] === S2)).toHaveLength(0);
    c.sendText(S2, 'первое сообщение');
    expect(c.sessions.get(S2)!.items.map((i) => i.kind)).toEqual(['user']);
  });

  it('ошибка команды → тост, который гаснет сам', async () => {
    const { c, ws } = connected();
    const p = c.newSession({ name: 'x' });
    ws.recv({ id: ws.last('cmd:session.new')!['id'], ok: false, code: 'UNKNOWN_PROFILE', message: 'нет профиля' });
    expect(await p).toBeNull();
    expect(c.lastError).toContain('нет профиля');
    vi.advanceTimersByTime(9000);
    expect(c.lastError).toBe('');
  });

  it('команда без связи не висит вечно', async () => {
    const c = new SupervisorClient();
    await expect(c.request({ type: 'cmd:session.list' })).rejects.toThrow('нет связи');
  });

  it('turn.result и смена состояния гасят «призрак» печати', () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: S1, name: 'a', state: 'working' }]));
    ws.recv({ type: 'event:stream.delta', sessionId: S1, seq: 1, kind: 'text', delta: 'недопеч' });
    expect(c.sessions.get(S1)!.printing).toBe('недопеч');
    ws.recv({ type: 'event:turn.result', sessionId: S1, seq: 2, subtype: 'error_during_execution' });
    expect(c.sessions.get(S1)!.printing).toBeNull();
  });

  it('повторно присланный запрос разрешения (старый seq) принимается один раз', () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: S1, name: 'a', state: 'waiting_permission' }]));
    ws.recv({ type: 'event:message.assistant', sessionId: S1, seq: 5, messageId: 'm', block: { type: 'text', text: 'hi' } });
    const req = { type: 'event:permission.request', sessionId: S1, seq: 3, requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } };
    ws.recv(req);
    ws.recv(req);
    expect(c.sessions.get(S1)!.permissions.map((p) => p.requestId)).toEqual(['r1']);
    // и это не считается регрессом seq (лента не сбрасывается)
    expect(c.sessions.get(S1)!.items.length).toBe(1);
  });

  it('«Всегда» — правило в формате SDK PermissionUpdate[]', () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: S1, name: 'a', state: 'waiting_permission' }]));
    c.alwaysAllowTool(S1, 'r1', 'Bash');
    expect(ws.last('cmd:permission.respond')).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
    });
  });

  it('ответ на несколько вопросов уходит одним кадром со всеми ответами', () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: S1, name: 'a', state: 'waiting_permission' }]));
    const questions = [
      { question: 'Где диф?', header: 'Диф', options: [{ label: 'Карточка' }] },
      { question: 'Тосты?', header: 'Тосты', options: [{ label: 'Ход' }, { label: 'Ошибка' }], multiSelect: true },
    ];
    c.answerQuestions(S1, { requestId: 'q1', toolName: 'AskUserQuestion', input: { questions }, questions, at: 0 }, { 'Где диф?': 'Карточка', 'Тосты?': 'Ход, Ошибка' });
    expect(ws.last('cmd:permission.respond')).toMatchObject({
      requestId: 'q1', behavior: 'allow',
      updatedInput: { questions, answers: { 'Где диф?': 'Карточка', 'Тосты?': 'Ход, Ошибка' } },
    });
  });

  it('close(): старый сокет не запускает реконнект и не портит статус', () => {
    const { c, ws } = connected();
    c.close();
    ws.onclose?.();
    vi.advanceTimersByTime(20_000);
    expect(FakeWS.all.length).toBe(1);
  });

  it('обрыв → reconnecting → новый сокет с lastSeq', () => {
    const { c, ws } = connected();
    ws.recv(hello([{ id: S1, name: 'a', state: 'idle' }]));
    ws.recv({ type: 'event:message.assistant', sessionId: S1, seq: 7, messageId: 'm', block: { type: 'text', text: 'x' } });
    ws.close();
    expect(c.status).toBe('reconnecting');
    vi.advanceTimersByTime(2000);
    const ws2 = FakeWS.all.at(-1)!;
    expect(ws2).not.toBe(ws);
    ws2.open();
    expect(ws2.last('cmd:hello')).toMatchObject({ lastSeq: { [S1]: 7 } });
    expect(c.status).toBe('live');
  });

  it('битый JSON от сервера не роняет клиент', () => {
    const { ws } = connected();
    expect(() => ws.onmessage?.({ data: '{oops' })).not.toThrow();
  });

  describe('панели: терминал, файлы, порты', () => {
    it('поток терминала идёт по termId мимо ленты и seq сессии', () => {
      const { c, ws } = connected();
      ws.recv(hello([{ id: S1, name: 'a', state: 'idle' }]));
      ws.recv({ type: 'event:message.assistant', sessionId: S1, seq: 4, messageId: 'm', block: { type: 'text', text: 'x' } });
      const got: unknown[] = [];
      const other: unknown[] = [];
      const un = c.onTerm('t1', (e) => got.push(e));
      c.onTerm('t2', (e) => other.push(e));
      ws.recv({ type: 'event:term.output', seq: 0, termId: 't1', data: 'привет\r\n' });
      ws.recv({ type: 'event:term.exit', seq: 0, termId: 't1', code: 0 });
      expect(got).toEqual([{ type: 'output', data: 'привет\r\n' }, { type: 'exit', code: 0 }]);
      expect(other).toEqual([]);
      // лента и счётчик seq сессии не тронуты; регресса seq нет
      expect(c.sessions.get(S1)!.items.length).toBe(1);
      expect(c.sessions.size).toBe(1);
      ws.recv({ type: 'event:message.assistant', sessionId: S1, seq: 5, messageId: 'm2', block: { type: 'text', text: 'y' } });
      expect(c.sessions.get(S1)!.items.length).toBe(2);
      un();
      ws.recv({ type: 'event:term.output', seq: 0, termId: 't1', data: 'после отписки' });
      expect(got).toHaveLength(2);
    });

    it('вывод до подписки не теряется (ответ на open ещё не разобран)', async () => {
      const { c, ws } = connected();
      ws.recv({ type: 'event:term.output', seq: 0, termId: 't9', data: 'ранний' });
      const got: unknown[] = [];
      c.onTerm('t9', (e) => got.push(e));
      await Promise.resolve();
      expect(got).toEqual([{ type: 'output', data: 'ранний' }]);
    });

    it('обёртки шлют кадры с sessionId и разбирают ack', async () => {
      const { c, ws } = connected();
      const list = c.fsList(S1, 'apps');
      const f = ws.last('cmd:fs.list')!;
      expect(f).toMatchObject({ sessionId: S1, path: 'apps' });
      ws.recv(ack(f['id'], { root: '/opt/x', path: 'apps', entries: [{ name: 'desktop', kind: 'dir' }] }));
      expect((await list).entries.map((e) => e.name)).toEqual(['desktop']);

      const open = c.termOpen(S1, 2000, 0);
      const o = ws.last('cmd:term.open')!;
      expect(o).toMatchObject({ sessionId: S1, cols: 1000, rows: 1 });
      ws.recv(ack(o['id'], { termId: 't1', mode: 'pipe', shell: 'bash', cwd: '/opt/x' }));
      expect(await open).toMatchObject({ termId: 't1', mode: 'pipe' });

      const input = c.termInput(S1, 't1', 'x'.repeat(20_000));
      const parts = ws.sent.filter((s) => s['type'] === 'cmd:term.input');
      expect(parts.map((p) => String(p['data']).length)).toEqual([16_384]); // второй кусок — после ack первого
      ws.recv(ack(parts[0]!['id']));
      await vi.advanceTimersByTimeAsync(0);
      const parts2 = ws.sent.filter((s) => s['type'] === 'cmd:term.input');
      expect(parts2.map((p) => String(p['data']).length)).toEqual([16_384, 3_616]);
      ws.recv(ack(parts2[1]!['id']));
      await input;
    });

    it('пустой ack старого сервера → понятная ошибка «не поддерживает»', async () => {
      const { c, ws } = connected();
      const p = c.gitStatus(S1);
      ws.recv(ack(ws.last('cmd:git.status')!['id']));
      await expect(p).rejects.toMatchObject({ code: 'UNSUPPORTED' });
      await expect(p).rejects.toThrow('сервер не поддерживает git-статус');
    });

    it('сервер, не знающий команду (молчит), — таймаут 8 с, а не 15', async () => {
      const { c } = connected();
      const p = c.netPorts();
      const done = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(8_100);
      await done;
    });

    it('onConnect срабатывает на каждое (пере)подключение', () => {
      const c = new SupervisorClient();
      const fn = vi.fn();
      c.onConnect(fn);
      c.connect();
      const ws = FakeWS.all.at(-1)!;
      ws.open();
      expect(fn).toHaveBeenCalledTimes(1);
      ws.close();
      vi.advanceTimersByTime(2000);
      FakeWS.all.at(-1)!.open();
      expect(fn).toHaveBeenCalledTimes(2);
      c.close();
    });
  });

  describe('среды и синк проектов', () => {
    const P = (name: string, path: string) => ({ id: `${name}-id`, name, path });

    it('две среды сразу: по клиенту на среду, свои адреса, сессии не смешиваются', () => {
      // адрес подключения приходит из списка подключений (App зовёт setUrl); здесь — явно в конструкторе
      const vps = new SupervisorClient('vps');
      const local = new SupervisorClient('local', 'ws://127.0.0.1:8796');
      vps.ensureConnected();
      local.ensureConnected();
      const [wv, wl] = FakeWS.all.slice(-2);
      expect(wv!.url).toBe('ws://127.0.0.1:8790');
      expect(wl!.url).toBe('ws://127.0.0.1:8796');
      wv!.open(); wl!.open();
      wv!.recv(hello([{ id: S1, name: 'vps-сессия', state: 'idle' }]));
      wl!.recv(hello([{ id: S2, name: 'локальная', state: 'idle' }]));
      expect([...vps.sessions.keys()]).toEqual([S1]);
      expect([...local.sessions.keys()]).toEqual([S2]);
      // повторный ensureConnected не плодит второй сокет
      const n = FakeWS.all.length;
      vps.ensureConnected();
      expect(FakeWS.all.length).toBe(n);
      // выключили среду — закрыт и больше не переподключается
      local.close();
      expect(local.running).toBe(false);
      expect(local.status).toBe('closed');
      vi.advanceTimersByTime(20_000);
      expect(FakeWS.all.length).toBe(n);
      vps.close();
    });

    it('проекты другой среды пришли позже — предложения синка пересчитываются', () => {
      const vps = new SupervisorClient('vps');
      const local = new SupervisorClient('local');
      vps.onProjectsChanged = () => local.recomputeSync();
      local.onProjectsChanged = () => vps.recomputeSync();
      local.connect(); const wl = FakeWS.all.at(-1)!; wl.open();
      wl.recv({ ...hello([]), projects: [P('perimeter', 'C:\\devs\\perimeter')] });
      expect(local.syncSuggestions).toEqual([]);
      vps.connect(); const wv = FakeWS.all.at(-1)!; wv.open();
      wv.recv({ ...hello([]), projects: [P('perimeter', '/opt/perimeter'), P('конвейер', '/opt/pipeline')] });
      expect(local.syncSuggestions.map((x) => x.name)).toEqual(['конвейер']);
      vps.close(); local.close();
      delete store['perimeter:projects:vps']; delete store['perimeter:projects:local'];
    });

    it('после hello проекты другой среды НЕ создаются с чужим путём — только предложения по имени', () => {
      store['perimeter:projects:vps'] = JSON.stringify([P('perimeter', '/opt/perimeter'), P('конвейер', '/opt/pipeline')]);
      store['perimeter:env'] = 'local';
      const c = new SupervisorClient();
      c.connect();
      const ws = FakeWS.all.at(-1)!;
      ws.open();
      ws.recv({ ...hello([]), projects: [P('perimeter', 'C:\devs\perimeter')] });
      expect(ws.last('cmd:project.new')).toBeUndefined();
      expect(c.syncSuggestions.map((x) => [x.name, x.otherPath, x.otherEnv])).toEqual([['конвейер', '/opt/pipeline', 'vps']]);
      // снимок текущей среды сохранён для обратного направления
      expect(JSON.parse(store['perimeter:projects:local']!)).toHaveLength(1);
      // «не предлагать» — больше не предлагается
      c.dismissSync('конвейер');
      expect(c.syncSuggestions).toEqual([]);
      delete store['perimeter:projects:vps']; delete store['perimeter:projects:local']; delete store['perimeter:sync-dismissed:local'];
      store['perimeter:env'] = 'vps';
    });

    it('привязка: проект создаётся здесь с тем же именем, дефолтами и СВОИМ путём', async () => {
      const { c, ws } = connected();
      ws.recv(hello([]));
      const p = c.linkProject({ name: 'конвейер', otherPath: '/opt/pipeline', otherEnv: 'vps', profile: 'zai' }, 'C:\devs\pipeline');
      const cmd = ws.last('cmd:project.new')!;
      expect(cmd).toMatchObject({ name: 'конвейер', path: 'C:\devs\pipeline', profile: 'zai' });
      ws.recv(ack(cmd['id'], { project: P('конвейер', 'C:\devs\pipeline') }));
      expect(await p).toBe(true);
    });

    it('сопоставление по имени без учёта регистра и пробелов', () => {
      expect(computeSyncSuggestions([P('Perimeter ', 'x')], [P('perimeter', '/opt/perimeter')], 'vps')).toEqual([]);
    });
  });
});
