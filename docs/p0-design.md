# P0-срез perimeter: протокол, состояния, репо

Основа: `research/claude-cli-recon.md` (поверхности CLI), АДР 001–003, эталон Фигмы `001-p0-three-pane`.
Решения: supervisor Node/TS + Agent SDK (АДР 002) · WSS JSON-кадры (АДР 003) · аппрувы canUseTool · Electron · монорепо · лейаут B.

## 1. Контур

```
Electron-клиент (Windows/macOS)
   │  wss://127.0.0.1:8790  (SSH-туннель: ssh -N -L 8790:127.0.0.1:8790 vps)
   ▼
supervisor (VPS, systemd: Restart=always)
   │  по сессии: Agent SDK query() со streamInput → субпроцесс claude
   │  (двунаправленный stream-json, --include-partial-messages,
   │   --include-hook-events, --forward-subagent-text, --replay-user-messages)
   ▼
~/.claude/projects/<slug>/<uuid>.jsonl  — транскрипты = ресинк после обрыва
```

Публичных портов нет; слушает только 127.0.0.1 на VPS.

## 2. Репо (монорепо npm workspaces)

```
perimeter/
├─ package.json            # workspaces: packages/*, apps/*
├─ packages/
│  ├─ protocol/            # ЕДИНСТВЕННОЕ место схемы кадров: типы + версии
│  │  └─ src/frames.ts     #   (шишка v, все типы event:*/cmd:*, zod-валидация)
│  └─ supervisor/
│     ├─ src/index.ts      # вход: поднятие WSS + загрузка реестра сессий
│     ├─ src/wss.ts        # сокет, hello/resume, ринг-буфер seq, ack/err
│     ├─ src/session/
│     │  ├─ manager.ts     # реестр сессий, spawn/stop/respawn
│     │  ├─ engine.ts      # обёртка Agent SDK: query/streamInput/canUseTool/interrupt
│     │  ├─ state.ts       # машина состояний (§4)
│     │  └─ resume.ts      # --resume по транскрипту, ресинк ленты
│     └─ systemd/perimeter.service
├─ apps/
│  └─ desktop/             # Electron: main/ (сокет, реконнект) + renderer/ (эталон 001)
├─ docs/                   # decisions.md, adr/, p0-design.md
└─ research/claude-cli-recon.md
```

## 3. Протокол WSS (v1)

Шапка кадра: `{v:1, id?, type, sessionId?, seq?, ts}`. `seq` — монотонный, на сессию, только у событий. Команды подтверждаются `ack {id, ok:true, data?}` / `err {id, code, message}`.

**UI → supervisor**
| Кадр | Нагрузка |
|---|---|
| `cmd:hello` | `{lastSeq: {<sessionId>: n}}` |
| `cmd:session.list` | — |
| `cmd:session.new` | `{name?, cwd?, model?, permissionMode?}` |
| `cmd:session.open` | `{sessionId}` (подписка на события сессии) |
| `cmd:message.send` | `{sessionId, text, images?: [base64]}` |
| `cmd:permission.respond` | `{requestId, behavior: allow\|deny, updatedInput?}` |
| `cmd:interrupt` | `{sessionId}` |
| `cmd:transcript.get` | `{sessionId, afterUuid?}` (ресинк глубже ринг-буфера) |
| `cmd:session.stop` | `{sessionId}` |

**supervisor → UI**
| Кадр | Нагрузка |
|---|---|
| `event:hello` | `{server: {version, uptime}, sessions: [{id, name, state, needs?, model, permissionMode}]}` |
| `event:session.state` | `{state, needs?}` — машина §4 |
| `event:session.init` | паспорт из system/init (tools, mcp_servers, model…) |
| `event:message.assistant` | блок text/thinking/tool_use (готовый AssistantMessage) |
| `event:stream.delta` | партиал: `{kind: text\|thinking\|input_json, delta}` |
| `event:message.user` | tool_result + toolUseResult |
| `event:permission.request` | `{requestId, toolName, input, questions?}` (canUseTool/AskUserQuestion) |
| `event:permission.result` | чем кончилось (в т.ч. таймаут) |
| `event:turn.result` | `result`: `$`, usage, modelUsage, ходы, длительности |
| `event:subagent.*` | старт/текст/стоп субагента (parent_tool_use_id) |
| `event:error` | код+текст |

**Догон после обрыва**: `cmd:hello {lastSeq}` → ретрансль пропущенного из ринг-буфера (2000 кадров/сессия); дыра глубже буфера → supervisor сам шлёт `event:error {code:'RESYNC_NEEDED'}`, UI тянет `cmd:transcript.get`.

## 4. Машина состояний сессии (supervisor `state.ts`)

```
            spawn                    system/init
 creating ─────────▶ initializing ─────────────▶ idle ◀────────────────┐
                      │ spawn упал                 │  message.send      │ turn.result
                      ▼                            ▼                    │
                    dead ◀──── kill -9 ──  working ──── canUseTool ──▶ waiting_permission
                      │  resume              │  ▲    ◀── respond ────┘   │ таймаут карточки
                      └── respawn (--resume) │  └── interrupt ─▶ interrupted ──▶ idle
                                            │       AskUserQuestion
                                            └────▶ waiting_input (needs = вопрос)
```

- `needs` — текст вопроса/запроса (аналог поля `needs` из `~/.claude/jobs/state.json`): то, что показывается в сайдбаре и на карточке.
- `dead` ≠ потеряно: транскрипт на диске → `respawn` через `--resume <session-id>`; лента восстанавливается, seq продолжает.
- Состояние соединения UI отдельно: `connecting → live → reconnecting → resync` (не смешивается с состоянием сессии).

## 5. Инварианты (каждый — тест)

1. `seq` монотонный без дыр на сессию (unit + интеграционный с мок-SKD).
2. `kill -9 supervisor` → systemd-рестарт → сессии поднимаются `--resume`, лента байт-в-байт (e2e).
3. Обрыв WSS на 30 с → `cmd:hello {lastSeq}` → лента идентична ленте без обрыва (e2e).
4. Разрешение, отвеченное во время обрыва (pending-очередь supervisor'а), доставляется после реконнекта.
5. Кадры на границе пакета protocol валидируются схемой; неизвестный `type` игнорируется (совместимость версий).
6. Supervisor слушает только 127.0.0.1 (тест: попытка коннекта с внешнего адреса).

## 6. Задачи среза P0

| # | Задача | Выход |
|---|---|---|
| T1 | Скелет монорепо + пакет protocol (типы кадров, версии, валидация) | `npm test` зелёный на схеме |
| T2 | supervisor: SessionManager + engine (SDK query/streamInput), события → кадры | одна сессия гоняется headless-скриптом |
| T3 | WSS-сервер: hello/resume, ринг-буфер, ack/err | инварианты 1, 5 |
| T4 | canUseTool → permission.request/respond, таймауты, pending-очередь | инвариант 4 |
| T5 | desktop: Electron + эталон 001 (сайдбар/лента/ввод/Stop/карточки) | ручной прогон против VPS |
| T6 | Деплой: systemd-юнит, ssh-туннель-скрипт, README | инварианты 2, 3, 6 |
| T7 | Двухдневный живой прогон + kill-тесты | журнал наблюдений, правки |

Открыто на дальнейших срезах: фреймворк renderer (решить на старте T5), терминал-панель (P2), показ фоновых работ (P1–P2), диф-вью и чекпоинты (P2, rewindFiles), мобайл-деградация панелей.
