# Recon: всё, что можно извлечь из Claude Code CLI (v2.1.229)

Цель: свой десктоп-UI, который управляет Claude Code на VPS; сессия переживает обрывы (tmux/daemon), фичи — как в Claude Code Desktop. Пометки: **[лок.]** — проверено на живом CLI 2.1.229, **[доки]** — из официальной документации code.claude.com (2026-11), **[комьюнити]** — неофициальные наблюдения.

---

## 1. Карта поверхностей интеграции

| # | Канал | Что даёт | Живучесть при обрыве UI |
|---|-------|----------|--------------------------|
| 1 | `claude -p --output-format stream-json` (headless) | полный поток событий: init, ассистент, tool-вызовы, result с деньгами | процесс на VPS живёт пока жив родитель; обёртка в tmux/systemd решает |
| 2 | `--input-format stream-json` (двунаправленный) | долгоживущий процесс: пользовательские сообщения, control-кадры (interrupt, разрешения) | да, если процесс в tmux/под демоном |
| 3 | Встроенный daemon + `--bg` / `claude agents` | фоновые сессии под супервизором, реестр, PTY-сокеты, авто-respawn, `claude attach/stop/respawn/logs` | да — штатный механизм, ровно под нашу задачу |
| 4 | `--remote-control [name]` | управление интерактивной сессией извне (флаг есть в 2.1.229; вложения пишет в `uploads/<session>/`) | да |
| 5 | `claude mcp serve` | Claude Code как MCP-сервер (stdio) — есть в бинаре [лок.], но **удалён из доков** — не фундамент | да |
| 6 | Hooks (в т.ч. **type: http**) | шина событий наружу: PreToolUse, PostToolUse, PermissionRequest, Stop, … + `transcript_path` в stdin | события летят на вебхук независимо от UI |
| 7 | Файлы на диске (`~/.claude/**`) | транскрипты, состояние фоновых работ, история, статистика, чекпоинты | да, это и есть персистентность |
| 8 | Agent SDK (`@anthropic-ai/claude-agent-sdk`) | CLI как библиотека: query(), canUseTool, hooks, resume, listSessions, sessionStore | да, в своём демоне |

---

## 2. Stream-JSON: формат событий [лок.]

Запуск: `claude -p "<промпт>" --output-format stream-json --verbose [--include-partial-messages] [--include-hook-events]`

### 2.1 `system/init` — первое событие, паспорт окружения
Поля (реальный ключевой состав, 2.1.229): `session_id`, `tools[]` (полный список встроенных инструментов), `mcp_servers[]` ({name, status}), `model`, `permissionMode`, `slash_commands[]`, `terminal_slash_commands[]`, `agents[]` (доступные субагенты), `skills[]`, `plugins[]` ({name, path, source, version}), `memory_paths`, `apiKeySource`, `output_style`, `capabilities`, `claude_code_version`, `cwd`, `fast_mode_state`, `analytics_disabled`, `uuid`.

### 2.2 Прочие `system/*` подтипы (замечены в реальном прогоне)
- `system/api_retry` — {attempt, error, error_status, max_retries, retry_delay_ms}
- `system/thinking_tokens` — {estimated_tokens, estimated_tokens_delta} — счётчик расхода на размышления, потоково
- `system/notification` — {key, priority, text} — уведомления (в т.ч. ожидание ввода)

### 2.3 `assistant` — сообщения модели
Ключи: `message` (Anthropic-сообщение: content[] с text/thinking/tool_use, model, usage, stop_reason), `parent_tool_use_id` (для субагентских сообщений; с `--forward-subagent-text` их текст летит отдельными сообщениями), `session_id`, `timestamp`, `uuid`.

### 2.4 `user` — результаты инструментов
User-событие с tool_result; в транскрипте дополнительно `toolUseResult`, `sourceToolAssistantUUID`, `promptId`.

### 2.5 `result` — итог хода (всегда последняя строка потока) [лок. + доки]
`subtype` (success | error_max_turns | ошибки исполнения — в `result`), `result` (текст), `total_cost_usd` (на `--resume/--continue` — сумма всей беседы, клиентская оценка), `usage` {input_tokens, output_tokens (только верхний цикл, субагенты — в model_usage!), cache_creation/read_input_tokens}, `model_usage` (по моделям, для учёта всего дерева), `structured_output` (только при валидном `--json-schema` — проверять наличие поля!), `num_turns`, `duration_ms`, `duration_api_ms`, `time_to_request_ms`, `ttft_ms`, `ttft_stream_ms` [лок.], `permission_denials`, `stop_reason`, `terminal_reason`, `api_error_status`, `errors[]`, `is_error`, `session_id`, `deferred_tool_use`. Рецепт интроспекции: `claude -p --resume <id> --output-format json "<промпт>" | jq -r '.result'`.

### 2.6 `--include-partial-messages` → `stream_event` [лок.]
Родные SSE-события Anthropic: `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop` — посимвольный стриминг для живого UI.

### 2.7 Двунаправленный режим: `claude -p --input-format stream-json --output-format stream-json --verbose` [доки]

Долгоживущий процесс, кадры = NDJSON на stdin/stdout. Это и есть «серверный движок» для нашего UI.

**Кадры пользователя (вход):**
```json
{"type":"user","session_id":"","message":{"role":"user","content":"текст"},"parent_tool_use_id":null}
```
Картинки — массивом блоков: `content:[{type:"text",...},{type:"image","source":{type:"base64","media_type":"image/png","data":"…"}}]`. Сообщения **станавливаются в очередь и обрабатываются последовательно**, можно докидывать прямо во время хода (steering). С `--max-turns` сообщение, стоявшее в очереди на лимите, стартует новый ход со своим лимитом. `--replay-user-messages` — подтверждение приёма (эхо кадра в stdout).

**Слеш-команды** — строкой в промпте: `/model sonnet`, `/effort high`, `/config thinking=false`, `/output-style concise`; скиллы/кастомные команды раскрываются. Терминальные (`/login`, `/plugin`, `/resume`) — недоступны.

**Контрольный канал (мультиплексируется с поток сообщений):**
- Кадр: `{type:"control_request", request_id, request}`; ответы — обёртка control-response. Точные пер-субтиповые схемы — в поставляемых типах SDK (`sdk.d.ts` у TS, `types.py` у Python); доки публикуют конверт и типы ответов.
- Разрешения приходят в хост как `control_request` с `request.subtype: "can_use_tool"` (полные кадры, включая ределивери после `reinitialize()`); ответ: `{behavior:"allow", updatedInput?, updatedPermissions?}` или `{behavior:"deny", message, interrupt?}`. `AskUserQuestion` тоже приходит сюда (вопрос/опции/мультиселект) — готовый механизм карточек-вопросов в UI.
- **Interrupt**: SDK `interrupt()` (только streaming-режим); при capability `interrupt_receipt_v1` возвращает `{still_queued:[uuid], cancelled?:[uuid]}`.
- **Методы Query-интерфейса поверх контрольного канала** (готовый API для UI!): `rewindFiles(userMessageId,{dryRun})`, `setPermissionMode(mode)`, `setModel(model?)`, `setMaxThinkingTokens(n)`, `applyFlagSettings` (вкл. effortLevel), `updateSettings(source, settings)`, `initializationResult()` (→ commands, agents, output_styles, models, account, claude_code_version), `reinitialize()`, `supportedCommands()`, `supportedModels()`, `supportedAgents()`, `mcpServerStatus()`, `getContextUsage({detail})`, `readFile(path,{maxBytes,encoding})`, `reloadPlugins()`, `reloadSkills()`, `reloadOutputStyles()`, `seedReadState()`, `accountInfo()`, `reconnectMcpServer()`, `toggleMcpServer()`, `setMcpServers()`, `setMcpPermissionModeOverride()`, `readMcpResource()`, `streamInput()`, `stopTask(taskId)`, `backgroundTasks(toolUseId?)`, `close()`.
- `capabilities[]` в init — feature-detect (например `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`); неизвестные значения игнорировать.

**Разрешения в headless:**
- `--permission-prompt-tool mcp__<server>__<tool>` — MCP-инструмент решает; Claude ждёт коннекта его сервера до MCP_TIMEOUT (30 c). Инструменты «требующие юзера» так одобрять нельзя (allow→deny).
- `--permission-prompts host|none` (v2.1.259+): `none` = никто не отвечает, всё требующее одобрения — deny (кроме разрешений от PermissionRequest-хука); AskUserQuestion удаляется.
- Отказы видны как `system`-сообщения `permission_denied` + список `permission_denials` в result. С v2.1.302 `-p` без режима стартует в Manual — без одобрения всё deny.
- Порядок оценки: hooks → deny-правила → ask-правила → режим → allow-правила → canUseTool (в dontAsk canUseTool пропускается).

**Поток при `--include-partial-messages`** (документированный порядок): message_start → content_block_start(text) → deltas → **полный AssistantMessage** → content_block_stop → content_block_start(tool_use) → input_json_delta-чанки → AssistantMessage(tool_use) → … → message_delta → message_stop → выполнение инструмента → ход → result. При обрыве/интеррапте `message_stop` всё равно приходит (v2.1.290+); незакрытый tool_use-блок считать неполным. Партиалы субагентов не форвардятся (только main-сессия).

### 2.8 Полезные флаги ввода/вывода (из `claude --help`, 2.1.229) [лок.]
`--include-hook-events` (все хук-события в потоке), `--forward-subagent-text`, `--replay-user-messages`, `--json-schema` (структурированный вывод), `--max-budget-usd`, `--no-session-persistence`, `--prompt-suggestions` (предсказание следующего промпта после хода), `--fallback-model`, `--effort`, `--bare`, `--safe-mode`.

---

## 3. Встроенный daemon, фоновые сессии, resume [лок. + доки]

**Это уже готовая инфраструктура «сессия живёт без терминала».**

### 3.1 Daemon и реестр [лок.]
- `~/.claude/daemon.status.json` / `~/.claude/daemon/roster.json` — супервизор воркеров. На каждого воркера: `pid`, `sessionId`, `rendezvousSock` + `ptySock` (именованные каналы/сокеты), ключи `rvAuth`/`ptyAuth`, `dispatch` (mode resume, fork, flagArgs, env, seed {intent, name}, cols/rows), `respawnFlags` — по ним воркер пересоздаётся, `decModes` (состояние PTY).
- `~/.claude/daemon/control.key`, `pipe.key` — ключи авторизации к каналам демона; `attach-journal/` — журнал подключений (surface: `fleet`, attachMs, msgsLoaded — лента восстанавливается из транскрипта за ~100 мс).
- **[доки]** Управление демоном: `claude daemon status|logs|run|stop`; журнал `~/.claude/daemon.log`.
- `claude --bg` — стартовать сессию как фонового агента; `claude agents` — интерактивный просмотр (fleet); **`claude agents --json`** — машиночитаемый реестр [лок.]: id/pid, cwd, kind: interactive|background, startedAt, sessionId, name, state: idle|blocked|working. `--all` добавляет завершённые.
- **[доки]** Фоновые команды: `claude attach <id>` (подключиться к живой фоновой сессии; при `--resume <id>` запущенной фоновой — тоже аттачит), `claude stop <id>`, `claude respawn <id>`, `claude logs <id>`, `claude rm <id>` (убирает из agent view, транскрипт остаётся — можно resume).
- `~/.claude/sessions/<pid>.json` [лок.] — пер-процессная запись: {pid, sessionId, cwd, startedAt, version, peerProtocol, kind, entrypoint, name, nameSource, status, updatedAt} + `<pid>.<hash>.key` (ключи пиринга). [доки] — файлы для детекта конкурентного доступа/краша, удаляются при выходе.
- `~/.claude/jobs/<short-id>/state.json` + `timeline.jsonl` [лок.] — состояние фоновой работы: `state` (working/blocked/…), `needs` (текст вопроса, на котором сессия стоит — готовый триггер для UI!), `tokens`, `inFlight` {tasks, queued, kinds}, `output`, `respawnFlags`, `intent`; таймлайн переходов состояний.

### 3.2 Resume и имена [доки]
- `--resume, -r` без аргумента — интерактивный пикер (Ctrl+A все проекты, Ctrl+W воркфлои, Ctrl+B фильтр по git-ветке, Space превью, Ctrl+R rename). С аргументом: имя сессии (точное совпадение — сразу открывает), session-id (поиск по текущему проекту → git worktrees → всем проектам машины), **абсолютный путь к .jsonl-транскрипту**. До v2.1.223 поиск id был только в текущем проекте.
- `--continue, -c` — последняя сессия в каталоге (обычно пропускает `-p`/SDK/loop-сессии; `claude -p --continue` — включает). Открывает и завершённые фоновые (v2.1.257+), работающие — отказ.
- `--fork-session` — при resume/continue создать новый session-id (оригинал нетронут). `/branch [name]` — форк внутри процесса; `/fork` — копия в новую фоновую сессию; `/cd` — **перенос** сессии в другой каталог.
- `--name, -n <имя>` / `/rename` — имя сессии (до 200 символов), resume по имени.
- Три вида названий [доки]: кастомное имя; дефолт `<каталог>-<2 символа>` (НЕ является resume-хэндлом); сгенерированный AI-заголовок (краткое резюме первого промпта, пишет фоновая задача на быстрой модели; claude -p их не получает) — заголовок ЯВЛЯЕТСЯ resume-хэндлом. [лок.] в транскрипте это тип `ai-title`.
- Листинга-команды нет: пикер, `claude agents --json`, либо SDK `listSessions()` → {sessionId, mtime}.
- Удаление: `claude purge [path]` (--dry-run, -y, -i, --all; ранее `claude project purge`) — сносит транскрипты+память, tasks/, debug/, file-history/, строки history.jsonl, запись в ~/.claude.json.
- Таблица восстановления permission-mode при resume — в sessions.md#permission-mode-on-resume.

### 3.3 Remote Control / cloud / каналы [доки + лок.]
- **Remote Control** — управление локальной сессией с claude.ai/code и мобильного приложения. Серверный режим: `claude remote-control` (флаги: `--name`, `--spawn same-dir|worktree|session`, `--capacity <N>` (32), `--create-session-in-dir`, `--permission-mode`, `-c`, `--session-id`); интерактивно: `claude --remote-control` / `/remote-control`. Транспорт: **только исходящие HTTPS к Anthropic API, polling, inbound портов нет**; транскрипты при подключении хранятся на серверах Anthropic. ⚠️ **Протокол закрытый**: клиенты — только приложения Anthropic; обязательна авторизация подпиской claude.ai (API-ключи/`setup-token`/`ANTHROPIC_BASE_URL`≠anthropic запрещены; Bedrock/Vertex нельзя). → Для своего UI этот канал не переиспользовать, но вложения RC пишет в `~/.claude/uploads/<session>/` [доки], а флаги `--remote-control[-session-name-prefix]` есть в CLI [лок.].
- **Cloud-сессии**: `--cloud <description|session_id|url>`; `claude -p --cloud <session-id> "…"` — постановка сообщения в облачную сессию; `--teleport` стягивает облачную сессию в терминал; `claude self-hosted-runner` регистрирует свою машину хостом облачных сессий; `--environment ccpool_…`.
- **Channels** (`--channels plugin:<name>@<marketplace>`, research preview) — пуш событий из внешних серверов (Telegram/Discord/свой) в живую сессию.
- `--tmux` (с `--worktree`) — CLI сам создаёт tmux-сессию для воркфлои-ветки.

---

## 4. Файлы на диске — что можно читать своим UI [лок. + доки]

База: `CLAUDE_CONFIG_DIR` (по умолчанию `~/.claude`); имя каталога проекта = путь с не-буквенно-цифровыми символами → `-`; >200 символов → обрезка + хэш; `CLAUDE_CODE_PROJECT_DIR_NAME` задаёт вручную (v2.1.234+). Чистка: `cleanupPeriodDays` (по умолчанию 30, min 1).

| Путь | Содержимое | Чистится |
|------|-----------|----------|
| `~/.claude/projects/<слаг>/<uuid>.jsonl` | транскрипт сессии (§5) | да |
| `~/.claude/projects/<слаг>/<uuid>/subagents/` | транскрипты субагентов (тот же формат + `agentId`) | да |
| `<session>/tool-results/`, `<session>/mcp-tasks/` | переполненные большие выводы инструментов, полноразмерные MCP-картинки | да |
| `<session>.orphaned-<ts>-<suffix>.jsonl`, `.superseded-<ts>` | отложенные копии (в пикере не показываются) | да |
| `~/.claude/file-history/<uuid>/` | чекпоинты файлов (rewind/restore), ~100 последних | да |
| `~/.claude/plans/` | файлы плана Plan Mode | да |
| `~/.claude/tasks/<uuid>/N.json` | состояние задач TaskCreate/… ({id, subject, description, activeForm, status, blocks, blockedBy}); удаление = потеря активных списков | да |
| `~/.claude/debug/<session>.txt` | отладочные логи сессии | да |
| `~/.claude/uploads/<session>/` | вложения Remote Control | да |
| `~/.claude/paste-cache/`, `image-cache/` (legacy; теперь `%TEMP%\claude\<project>\<session>\`) | вставленные картинки | да |
| `~/.claude/session-env/` | env-метаданные сессии | да |
| `~/.claude/usage-data/` | отчёты /insights (report.html) | да |
| `~/.claude/history.jsonl` | история вводов {display, pastedContents, timestamp, project, sessionId}; питает стрелку вверх/Ctrl+R | НЕТ |
| `~/.claude/stats-cache.json` | агрегированные токены/стоимость для /usage; дневная активность {messageCount, sessionCount, toolCallCount} | НЕТ |
| `~/.claude/remote-settings.json` | кэш серверных настроек | при logout |
| `~/.claude.json` | глобальное состояние: mcpServers, oauthAccount, projects{} (trust, allowedTools, lastCost, lastSessionMetrics, lastTotal*Tokens…), фича-флаги. Склонна к порче при частых записях → `backups/` (5 копий) | НЕТ |
| `~/.claude/settings.json`, `.claude/settings{,.local}.json` | env, hooks, statusLine, model, permissions, enabledPlugins | НЕТ |
| `~/.claude/sessions/<pid>.json` | реестр живых процессов | при выходе |
| `~/.claude/jobs/`, `daemon/`, `daemon.log` | фоновые работы и демон | НЕТ |
| `~/.claude/agent-memory/<name>/` | память агентов (agent teams) | НЕТ |
| Scratchpad `%TEMP%\claude\<project>\<session>\scratchpad\` | рабочие артефакты (нужен claude.ai login + Anthropic API) | по ретеншену |
| Авторские конфиги: `CLAUDE.md`, `.claude/rules/*.md`, `.claude/skills/*/SKILL.md`, `.claude/commands/*.md`, `.claude/agents/*.md`, `.claude/output-styles/*.md`, `.claude/workflows/*.js`, `.mcp.json`, `.claude/keybindings…`, `~/.claude/themes/*.json`, `~/.claude/plugins/` | всё, что можно редактировать/показывать в UI | НЕТ |

## 5. Формат транскрипта `.jsonl` [лок. + доки + комьюнити]

⚠️ [доки] Официальная позиция: «формат записей внутренний и меняется между версиями» — парсить только с запиненной версией CLI. Стабильные интерфейсы — CLI-флаги, hooks/statusline stdin (`transcript_path`), SDK.

`type` [лок.]: `user`, `assistant`, `ai-title`, `attachment`, `file-history-snapshot` ({isSnapshotUpdate, messageId, snapshot}), `last-prompt`, `mode`, `permission-mode`; [комьюнити] ещё `summary`, `custom-title`, `agent-name`, `system` ({subtype, level, durationMs}).

Общие поля [лок.]: `uuid`, `parentUuid` (связный список/дерево; ветки субагентов начинаются с parentUuid: null), `sessionId`, `cwd`, `version`, `gitBranch`, `timestamp`, `isSidechain`, `userType`, `entrypoint`, `slug`, `effort`.

- `user`: message (строка или content[] с tool_result {tool_use_id, is_error}), `toolUseResult` ({stdout, stderr, exitCode} для Bash), `sourceToolAssistantUUID`, `promptId`.
- `assistant`: message.content[] (text/thinking/tool_use {id, name, input}), model, usage {input_tokens, output_tokens, cache_read/creation_input_tokens}, stop_reason; `requestId`. **Один API-ход пишет несколько assistant-строк с одинаковым usage — дедуп по `message.id`** [комьюнити].
- Субагентские файлы: + `agentId`, `sourceToolAssistantUUID`.

**Вывод для UI:** транскрипт самодостаточен для реконструкции ленты (дерево, ветки субагентов, расходы, чекпоинты, режимы, AI-заголовок) — рендер ленты после переподключения строится из него (так делает и сам fleet-attach: msgsLoaded = msgsInJsonl). ⚠️ Формат — внутренний, меняется между версиями: пиновать версию CLI и проверять на апдейтах (главный источник дрейфа у всех чужих обёрток, §15).

## 6. Хуки — полная шина событий [доки + лок.]

**33 события**: `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`.

**Типы хук-обработчиков**: `command` (exec/sh-форма, `shell: bash|powershell`, `async`, `asyncRewake` — фон и продлёт при exit 2), **`http`** (`url`, `headers` с `$VAR`, `allowedEnvVars` — то, что уже использует хаб :8787), **`mcp_tool`** (вызов MCP-инструмента с подстановкой `${tool_input.field}`), `prompt` и `agent` (промпт/агент как реакция). Общие: `if` (правило вида `Bash(git *)`), `timeout` (дефолты 600/30/60 c по типу), `statusMessage`, `once`. Матчеры — точное имя/список/regex; `*` = все; у части событий матчеров нет (UserPromptSubmit, Stop, TaskCreated…).

**Stdin/POST-тело (общее)**: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `hook_event_name`, `effort.level`, `agent_id/agent_type` + специфичные (`tool_name/tool_input/tool_use_id`, `prompt`, `stop_hook_active`, `source` у SessionStart/Compact, `reason` у SessionEnd…).

**Управляющие ответы (stdout-JSON / HTTP-ответ)**:
- универсальные: `continue:false` (остановить Клода), `stopReason`, `systemMessage`, `terminalSequence` (OSC);
- `decision:"block"` + `reason` — для UserPromptSubmit/PostToolUse/Stop/PreCompact/PreModelSwitch/Elicitation/TaskCreated…;
- `hookSpecificOutput`: PreToolUse → `permissionDecision: allow|deny|ask|defer` + `updatedInput` (подмена аргументов!) + `additionalContext`; **PermissionRequest → `{decision:{behavior:"allow"|"deny", updatedInput}}`**; PermissionDenied → `retry:true`; Stop/SubagentStop → block + `additionalContext`; Elicitation* → `action: accept|decline|cancel`; MessageDisplay → `displayContent`; SessionStart → `sessionTitle`, `initialUserMessage`, `watchPaths`, `reloadSkills`;
- exit-код 2 = блокирующий (не для всех событий); лимит additionalContext 10k символов; стоп-хуки — максимум 8 подряд (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).

**Для UI это исходящая шина**: http-хуки на каждый шаг (PreToolUse/PostToolUse/PermissionRequest/FileChanged/Stop…) — хаб получает всё в реальном времени; а `--include-hook-events` дублирует hook_started/progress/response прямо в stream-json. Входящее направление — stream-json кадры или Channels.

**Инжект окружения в хуки/баш**: `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_EFFORT`, `CLAUDE_ENV_FILE`, `CLAUDE_PID`, и главное — **`CLAUDE_CODE_MESSAGING_SOCKET` + `CLAUDE_CODE_MESSAGING_TOKEN`** (инбокс-сокет кросс-сессионного обмена сообщениями).

## 7. Чекпоинты / rewind [доки]

- `~/.claude/file-history/<session>/` — снапшоты **перед** каждым ходом; хранятся ~100 последних чекпоинтов.
- Триггеры: `/rewind` (алиасы `/checkpoint`, `/undo`), Esc Esc на пустом промпте. Меню: Restore code and conversation / conversation / code; Summarize from/up to here.
- Не отслеживаются: изменения только через Bash (если файл не редактился Claude), правки субагентов (кроме foreground fork-скиллов), внешние правки.
- **Программный доступ — через Agent SDK**: метод Query-интерфейса `rewindFiles(userMessageId, {dryRun})` [доки] — откат файлов к чекпоинту конкретного сообщения (есть dryRun — получить список изменений без применения). Прямого CLI-флага нет. (В SDK отдельно `enableFileCheckpointing` — свои бэкапы на диск, не связаны с SessionStore.)

## 8. Statusline stdin — полный список полей [доки + лок.]

`.session_id`, `.session_name`, `.prompt_id`, `.transcript_path`, `.version`, `.cwd`, `.workspace.{current_dir, project_dir, added_dirs[], git_worktree, repo.{host,owner,name}}`, `.model.{id, display_name}`, `.output_style.name`, `.cost.{total_cost_usd, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed}`, `.context_window.{total_input_tokens, total_output_tokens, context_window_size, used_percentage, remaining_percentage, current_usage.{input,output,cache_creation,cache_read}}`, `.exceeds_200k_tokens`, `.prompt_cache.{warm, caching_observed, ttl, expires_at, requests, misses, hit_ratio, cache_write_tokens, …}`, `.rate_limits.{five_hour|seven_day|spend_limit}.{used_percentage, resets_at, used_usd, limit_usd}`, `.fast_mode`, `.effort.level`, `.thinking.enabled`, `.vim.mode`, `.agent.name`, `.pr.{number,url,review_state,kind}`, `.worktree.{…}`.

**Санкционированный способ поллинга живого состояния**: statusLine command + `refreshInterval` (300 мс дебаунс; перезапуск на каждое сообщение/компакт/смену режима; ин-флайт запуск отменяется новым). `padding`, `hideVimModeIndicator`.

**`subagentStatusLine`** (та же схема) — на входе базовые поля + `columns` + `tasks[]`: {id, name, type, agentType, status, description, label, startTime, model, effort, contextWindowSize, tokenCount, tokenSamples, cwd}; на выходе — по JSON-строке `{"id","content"}` на задачу. **Готовая лента фоновых задач субагентов для UI.**

Триггер `session_state_changed`-событий в stream-json: env `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`.

## 9. Контекст/расходы: слеш-команды и счётчики [доки + лок.]

- `/context [all]` — визуализация контекстного окна; `/status` — вкладка настроек с Session kind (interactive / background job · attached|unattended); `/usage` (алиасы `/cost`, `/stats`) — Total cost/durations/lines + Usage by model + prompt cache + лимиты плана + разбивка по skills/subagents/plugins/MCP; `/insights` пишет `usage-data/report.html`.
- `/tasks` (алиас `/bashes`) — фон. работы/субагенты. `/todos` больше нет — задачи через Task-инструменты (TaskCreate/TaskGet/TaskUpdate/TaskList; `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` у юзера уже включён).
- OpenTelemetry-метрики (токены/стоимость, correlation по prompt.id) — для мониторинга VPS.
- `claude auth status` → {authMethod, configDirectory}.

## 10. Прочие CLI-команды (2.1.229) [лок.]

`claude agents` (фоновые), `attach`/`stop`/`respawn`/`logs`/`rm`, `daemon status|logs|run|stop`, `auth`, `doctor`, `gateway` (enterprise auth/telemetry, --config YAML), `import` (импорт конфига из другого агента), `install <target>`, `mcp` (add/add-json/get/list/login/logout/remove/serve…), `plugin`, `project purge`, `setup-token` (долгоживущий токен), `ultrareview`, `update`.

Режимы разрешений (choices 2.1.229): `acceptEdits`, `auto`, `bypassPermissions`, `manual` (алиас default), `dontAsk`, `plan` — см. §13.

Скрытые/новые слеш-команды из init [лок.]: `rename`, `recap`, `goal`, `insights`, `usage`, `context`, `effort`, `fast`, `autocompact`, `compact`, `agents`, `team-onboarding`, `__remote-workflow`, `workflow-launch-exec`, `reload-skills`, `heapdump`. Из доков ещё: `/plan`, `/btw`, `/branch`, `/fork`, `/cd`, `/schedule` (алиас `/routines`), `/teleport`, `/sandbox`, `/voice`, `/loop` (алиас `/proactive`), `/diff`, `/verify`, `/code-review` (уровни low…ultra, --fix), `/deep-research`, `/import codex|gemini|cursor`, `/list-agents` (`/peers`), `/workflows`, `/tui`. Терминальные команды в `-p` недоступны; принимающие аргументы (`/model sonnet`, `/config key=value`, `/mcp`) — работают.

`/export [filename]` [доки] — экспорт текущей беседы **только plain text** (в файл или буфер); для структурных данных доки отправляют к stream-json/SDK.

**`claude mcp serve`** [лок.] — команда в бинаре 2.1.229 есть (запускает Claude Code как stdio-MCP-сервер со встроенными инструментами), но из текущих официальных доков она **исчезла** — считать недокументированной и не строить на ней фундамент; основные поверхности — stream-json (§2.7) и SDK (§11).

Прочее из доков: `session_state_changed`-события в stream-json через env `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`; `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (сколько `-p` ждёт фоновые работы при выходе, дефолт 10 мин); SIGTERM → exit 143 и `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` продолжит оборванный ход при resume; лимит stdin 10 МБ.

## 11. Agent SDK (`@anthropic-ai/claude-agent-sdk` / `claude-agent-sdk`) [доки]

SDK — библиотека, **запускающая тот же бинарь CLI субпроцессом и говорящая с ним по stdio тем же stream-json** (§2). 1 сессия = 1 субпроцесс; N сессий = N субпроцессов. Для не-TS/Python языков доки сами советуют: `claude -p --output-format stream-json` субпроцессом — тот же проводной протокол.

**`query({prompt, options})`** — prompt может быть строкой ИЛИ AsyncIterable кадров (стриминговый вход — картинки, очередь, интеррапты, мультитёрн). Ключевые options: `resume`, `resumeSessionAt` (откат к UUID сообщения!), `forkSession`, `continue`, `allowedTools`/`disallowedTools`, `canUseTool`, `hooks`, `permissionMode` (default|acceptEdits|plan|bypassPermissions|dontAsk|auto), `permissionPrompts`, `includePartialMessages`, `maxTurns`, `model`, `cwd`, `mcpServers`, `strictMcpConfig`, `settingSources: []` (отключить все настройки!), `systemPrompt` ({type:'preset', append, excludeDynamicSections}), `additionalDirectories`, `env`, `plugins`, `agents`, `tools`, `sessionStore`. Python: + `forward_subagent_text`, `permission_prompt_tool_name`, `extra_args`, `max_budget_usd`, `load_timeout_ms`.

**События**: SDKSystemMessage (init), SDKAssistantMessage, SDKUserMessage, SDKPartialAssistantMessage (stream_event), SDKResultMessage, compact_boundary, hook-сообщения (hook_started/progress/response), status, mirror_error.

**Паттерн хостинга (hosting.md) — прямо наш кейс VPS:** long-running — на каждую активную сессию долгоживущий query+субпроцесс, HTTP/WebSocket-эндпоинт наружу, новые ходы через `streamInput()`; `startup()`/`prewarm()` прогревают субпроцессы. Бюджет: ~1 GiB RAM / 5 GiB disk / 1 CPU на агента — размер пула = (RAM−overhead)/потолок. Мультитенантность: `settingSources: []`, per-tenant `CLAUDE_CONFIG_DIR` + `cwd`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Ограничения: нет общего таймаута сессии (maxTurns), рост памяти долгих сессий (рециклить субпроцессы). ⚠️ «Anthropic не разрешает сторонним разработчикам предлагать claude.ai login/лимиты» — для своего UI авторизация API-ключом (у нас z.ai-шлюз — ок). Рантаймы: Node 18.14+/Python 3.10+.

**Сессионные хелперы**: `listSessions()` → {sessionId, mtime}, `getSessionInfo()`, `renameSession()`, `tagSession()`, `getSessionMessages()`, `listSubagents()`, `getSubagentMessages()`, `deleteSession()`, `forkSession()`, кастомный `sessionStore` (+ `listSessionSummaries`). TS: `persistSession: false`.

**Альтернативный стек для «не хочется SDK»**:RawMessage flooding по §2.7 в любом языке — контрольные кадры те же, схемы брать из `sdk.d.ts`/`types.py` в поставке SDK.

---

## 12. Claude Code Desktop — чеклист фич для реплики [доки]

Десктоп = три вкладки (Chat / Cowork / **Code**). Вкладка Code — **кастомный чат-UI (Electron), НЕ встроенный терминал**; терминал — лишь одна из панелей. Делит конфиг с CLI (`~/.claude.json`, settings, hooks, skills, .mcp.json).

### 12.1 Оболочка и сессии
- Сайдбар сессий: `+ New`/Cmd+N, группировка/сортировка (по папке, статусу), rename кликом по заголовку, Ctrl+Tab переключение, Archive/Unarchive (~30 дней ретеншен, авто-архив после мержа PR).
- **Split view** (Alt+клик — две сессии рядом), New window (Cmd+клик).
- Панель деталей сессии (правый рельс): окружение (+ переключатель **Remote Control**), изменения, running tasks, контекст.
- `/resume` в десктопе — сессии, стартованные из CLI; `/desktop` в терминале — перенести CLI-сессию в приложение; `claude --desktop [--resume <id>]`.

### 12.2 Строка запуска сессии и промпт-бокс
- Ряд под промпт-боксом: **Environment selector → папка проекта → ворктогл → режим разрешений → модель + Effort**; рядом usage-ring.
- Промпт-бокс: Stop (interrupt); ввод на ходу = steering-сообщение в очередь; **+** → файлы/картинки/PDF/скиллы/коннекторы/плагины/папки/слеш-команды; **@-mention** файлов с автодополнением; ghost-text подсказки следующего промпта (Tab — принять).

### 12.3 Разрешения и аппрувы
- Селектор режимов: **Manual** (спрашивать всё, диф-аппрув), **Accept edits**, **Plan**, **Auto** (фоновый классификатор проверяет shell/сеть; дефолт с авг. 2026), **Bypass** (гейтится настройкой; rm всё равно запрещён). `dontAsk` — только CLI.
- Карточка внешнего сайта (Browser): Allow once / Always allow / Deny по домену, отзыв в настройках.

### 12.4 Диф-ревью
- Карточка **Changes** со счётчиком строк за ход (`+12 -1`) → диф-вью пофайлово.
- **Инлайн-комментарии на строки** (hover → + → комментарий, батч-отправка) → Клод читает и выдаёт новый диф.
- `/code-review` → карточка ревью пофайлово с **Walk through in diff** (шаг по замечаниям, «Fix this one») и **Apply fixes** — фоновый субагент. `/ultrareview` — облачная мультиагентная проверка.

### 12.5 Чекпоинты (см. §6)
- Автоснапшот перед каждым ходом, 100 последних, переживают resume. Rewind-меню: Restore code+conversation / conversation / code; Summarize from/up to here.

### 12.6 Панели воркспейса
- Панели: **чат, диф, браузер, терминал (Ctrl+`), файловый редактор, план, задачи, субагенты** (+ iOS Simulator на macOS); перенос заголовком, ресайз, pop-out в окно, минимизация.
- Файловый редактор: клик по пути; автосейв; конфликт-оверрайд; «Attach as context»; Open in VS Code/Cursor/Zed.
- Режимы просмотра ленты (Ctrl+O): Normal / Thinking / Verbose.
- **Браузер-панель**: автозапуск дев-серверов по `.claude/launch.json` (runtimeExecutable, port, autoPort, url, autoVerify), автопроверка изменений (скриншоты, DOM, клики), карточки дев-серверов start/stop.

### 12.7 Git
- **Worktree-изоляция** на сессию (тогл; хранятся в `<project>/.claude/worktrees/`; `.worktreeinclude` для gitignored).
- PR-мониторинг в карточке Changes со статусом CI; **Auto-fix** (чинит падающие проверки), **Merge when ready** (auto-merge); нужен `gh`; авто-архив после мержа/закрытия.

### 12.8 Контекст/расходы
- Карточка **Context** с % окна и разбивкой по категориям; `/context`, `/compact`, авто-саммаризация при заполнении, idle-compaction.
- Usage-ring → лимиты плана; `/usage` с разбивкой по skill/subagent/plugin/MCP.
- Карточка лимита с чекбоксом **Auto-continue when limits reset**.

### 12.9 Расширяемость
- **Каталог коннекторов (MCP)** с графической установкой и OAuth; менеджер **плагинов** (enable/disable/uninstall); скиллы через `/`.
- Хуков в десктопе нет — они в общих settings и работают автоматически.

### 12.10 Окружения — ядро нашей задачи
- Типы: **Local / Cloud / SSH / WSL**. До 8 сохранённых окружений из недавних папок.
- Редактор окружения: переменные (шифрованно), несколько папок, worktree-папка.
- **SSH-сессии**: диалог (Name/Host/Port/key); десктоп **сам ставит Claude Code на удалёнку в `~/.claude/remote/`**; читает `~/.ssh/config` (HostName, User, IdentityFile, ProxyJump/ProxyCommand); **задача продолжает работать при отключении десктопа через фоновый хелпер на удалённой машине**; при переподключении «Restarting Claude Code on <host>…»; git/gh настраиваются на удалёнке.
- **Cloud-сессии**: живут на инфраструктуре Anthropic, переживают закрытие приложения; мониторинг с claude.ai/code и телефона; «Open in → Cloud» переносит локальную сессию.

### 12.11 Параллельные агенты и фон
- Панель **Background tasks** (субагенты, фоновые команды, workflows) с просмотром вывода и stop.
- **Side chat** (Cmd+;/`/btw`): читает контекст сессии, ничего не пишет, не сохраняется.
- **Кросс-сессионный обмен**: Клод видит до 20 недавних сессий, шлёт сообщения карточками (в очередь, если цель занята); `@имя-сессии`.
- **Suggested task cards**: «рядом есть работа» → Start (отдельная сессия) / Do it here / Options.

### 12.12 Remote Control (мультидевайс)
- Переключатель на сессию (`/remote-control`); настройка автоподключения (`remoteControlAtStartup`/`disableRemoteControl`); подключённые сессии видны на claude.ai/code и в мобильных приложениях; `claude remote-control` публикует машину как device card.

### 12.13 Планировщик
- Страница **Scheduled**: Name/описание/инструкции с per-task режимом разрешений и моделью, папка, триггеры (Hourly/Daily/Weekdays/Weekly/Manual/cron), worktree-опция; Run now, History (каждый запуск → его сессия), «Always allowed» панель инструментов; catch-up пропущенных; «Keep computer awake».

### 12.14 Прочее
- Computer use (View only / Click only / Full control), Quick Entry (глобальный хоткей + скриншот-регион), диктовка, уведомления ОС/пуш, автообновление (встроенный движок Code обновляется отдельно от CLI), восстановление сессий, MDM-развёртывание.
- Только в CLI (не в десктопе): headless/SDK, agent teams, dontAsk, per-session allowedTools. Только в десктопе: коннекторы/плагины UI, вложения картинок, панели, Dispatch, планировщик UI, computer-use UI.

---

## 13. Разрешения — полная модель [доки]

- Режимы: `default` (в UI — **Manual**; `manual` — алиас), `acceptEdits` (авто-accept правок + mkdir/touch/rm/rmdir/mv/cp/sed), `plan` (чтение + классификатор; правки заблокированы до аппрува плана; варианты аппрува «Yes, and use auto mode» / «Yes, manually approve» / «No»), `auto` (классификатор вместо юзера; дефолт терминала с v2.1.283), `dontAsk` (всё требующее аппрува — deny; canUseTool пропускается), `bypassPermissions` (только с флага/настройки; `--allow-dangerously-skip-permissions` добавляет в цикл). Порядок оценки: hooks → deny → ask → режим → allow → canUseTool.
- Выбор: Shift+Tab цикл default→acceptEdits→plan(+auto/bypass), `--permission-mode`, `permissions.defaultMode` (auto/bypass из проектных файлов игнорируются).
- Структура `permissions` в settings: `allow[]/ask[]/deny[]` (первое совпадение; deny не перебивается), `defaultMode`, `additionalDirectories`, `disableBypassPermissionsMode`, `disableAutoMode`, `block{Reads,Writes}OutsideWorkingDirectories`, `allowManagedPermissionRulesOnly`.
- Синтаксис правил: `Bash(npm run build)` точное, `Bash(npm run *)` префикс, составные (`&&`, `|`…) — каждый член должен быть разрешён; врапперы (timeout/nice/nohup…) срезаются; read-only набор (ls/cat/grep/git-чтение) не спрашивает; `Read/Edit(гитигнор-паттерны)`, `WebFetch(domain:example.com)`, `mcp__server__tool`, `mcp__server__*`, `Agent(Explore)`, параметрические deny/ask: `Agent(model:opus)`, `Bash(run_in_background:true)`.
- Клиентские флаги: `--allowedTools`, `--disallowedTools` (bare имя убирает инструмент из контекста), `--tools` (ограничить встроенный набор), `--permission-prompt-tool`, `--permission-prompts host|none`, `--add-dir`.
- Хук `PreToolUse` с `permissionDecision` (§6) решает до правил; exit-2 блок перебивает allow.

## 14. Settings, env, precedence [доки]

- **Приоритет**: managed (MDM/claude.ai-консоль) → `--settings` (файл или inline JSON, ≤2 МиБ, на сессию) → `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`. `CLAUDE_CONFIG_DIR` переносит базу. Списки (permissions.allow и т.п.) **мерджатся** между файлами, а не перезаписываются; security-ключи — принимается более строгий. Хот-релоад: правки `permissions`/`hooks`/`apiKeyHelper` применяются к живой сессии + событие `ConfigChange`; `model`/`effortLevel` читаются один раз (менять через `/model`).
- Ключи (выборка): `apiKeyHelper`, `cleanupPeriodDays`, `env`, `attribution` (замена includeCoAuthoredBy), `model`, `effortLevel`, `modelSettings` (per-model effort/autoCompactWindow), `fallbackModel`, `availableModels`/`deniedModels`, `outputStyle`, `statusLine`, `subagentStatusLine`, `hooks`, `disableAllHooks`, `permissions.*`, `autoMode`, `teammateMode`, `skillOverrides`, `channelsEnabled`+`allowedChannelPlugins`, `autoMemoryEnabled`, `idleCompaction`, `remoteControlAtStartup`, `crossSessionInbound` (accept|hold|refuse), `disableRemoteControl`, `modelPricing`, `promptCacheTtl`, `spinnerTips*`, `respectGitignore`.
- **Env (полная таблица env-vars.md; набор для VPS)**: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL` (+`_NAME/_DESCRIPTION`), `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_AUTO_MODE_MODEL`; лимиты: `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `MAX_THINKING_TOKENS`, `CLAUDE_CODE_MAX_TURNS`, `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT`/`MAX_MCP_OUTPUT_TOKENS`, `BASH_DEFAULT/MAX_TIMEOUT_MS`/`BASH_MAX_OUTPUT_LENGTH`, `API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`; сеть: `HTTPS_PROXY`/`NO_PROXY`, клиентские серт; телеметрия off: `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (⚠️ заодно отключает Remote Control/скилл-синк — у юзера включён); инжектнутые (читать в скриптах): `CLAUDE_CODE_SESSION_ID`, `CLAUDE_EFFORT`, `CLAUDE_ENV_FILE`, `CLAUDE_CODE_MESSAGING_SOCKET/_TOKEN`, `CLAUDE_JOB_DIR`, `CLAUDE_CODE_REMOTE_SESSION_ID`.
- **MCP-клиент**: `claude mcp add/add-json/list/get/remove/login/logout/reset-project-choices`; скоупы local (запись в ~/.claude.json) > project (.mcp.json, версионируется, требует одобрения) > user; приоритет одинаковых имён local>project>user>plugin>коннекторы; `.mcp.json` поддерживает `${VAR}`/`${VAR:-default}` (кроме чужих кред — Anthropic-токены не экспандятся наружу), `timeout`, `alwaysLoad`; `/mcp [reconnect|enable|disable]`.

---

## 15. Как устроены чужие UI (только как справочник) [обзор исходников]

| Проект | Транспорт к claude | Переживание обрыва | Аппрувы | Грабли |
|---|---|---|---|---|
| **Happy** (slopus/happy) | Два пути: локально — интерактивный `cla` subпроцесс + хвост JSONL-транскрипта (дедуп по uuid, реконструкция субагентов по parent_tool_use_id); удалённо — Agent SDK query-stream | claude под локальным демоном; релей — исходящие соединения с обеих сторон + E2E-шифрование, store-and-forward зашифрованных блобов | SDK canUseTool; песочница ⇒ принудительный bypassPermissions | Два инжест-пути, дедуп на resume/fork, дрейф форматов — пришлось reimplement`ить то, что потом появилось как `--forward-subagent-text` |
| **CloudCLI** (siteboon/claudecodeui, экс claude-code-ui) | Node-сервер: чат через SDK-раннер; шелл — node-pty ↔ xterm.js по WS | reconnect-команда подменяет WS под **живой** процесс; PTY-сессии возобновляются `claude --resume <id>` | `claude-permission-response {requestId, allow, updatedInput}` по WS (= canUseTool наружу) | SIGKILL нод-сервера на Ubuntu, дрейф заголовков (CLI добавил /rename — обёртка не заметила), просят REST/SSE рядом с WS |
| **opcode** (winfunc/opcode) | Tauri/Rust: spawn `claude --output-format stream-json --verbose [--resume]` | resume по `--resume`, список из `~/.claude/projects/`, свои чекпоинты | по сути sidestep — exposes `--dangerously-skip-permissions` | одноходовые процессы, парсинг связан со схемой stream-json, todos читает из файла (костыль) |
| **Crystal** (stravu/crystal) | Electron + SDK-инстансы в node-pty (по одному на git worktree), рендер XTerm.js | SQLite + worktrees, история сессий | «Waiting»-статус + ввод через PTY | Electron; парсинг claude внутри generic-абстракции |
| **claude-squad** (smtg-ai) | чистый tmux: send-keys / capture-pane | tmux-сервер владеет сессиями — переживает всё | attach и ответ руками; флаг autoyes | никакой структуры: нет JSON, диффов, тудушек; таймауты на новых версиях CLI |
| **VS Code ext** (официальный) | свой приватный CLI-бинарь фоновым процессом + graphical panel | общая `~/.claude` история; single-owner guard | нативные IDE-диалоги, per-change accept/reject | удалённый доступ = только remote-control (loopback MCP на той же машине) |
| **PTY-паттерн для VPS** (mikecodeur) | Next.js → node-pty → claude → хвост JSONL → SSE в браузер | tmux переживает SSH-обрывы | ввод в PTY (неструктурированно) | сырое скрейпинг-рвётся; делали ради подписочного биллинга (TTY-детект клиентский) |

**Синтез — что ломается и почему:**
1. **Скрейпинг PTY/tmux без потока** — живёт вечно, но семантически слепой (нет структурных аппрувов/диффов/тудушек, картинки не отрисовать). Только как субстрат + JSONL-хвост как семантический канал.
2. **`-p --output-format stream-json` на каждый ход** (opcode) — просто, но одноходово: аппрувы требуют `--permission-prompt-tool`, иначе все скатываются в `--dangerously-skip-permissions`. ⚠️ Биллинг-сплит июня 2026 (headless = отдельный пул кредитов на подписке) — **нам не важно**: у нас z.ai-шлюз по API-токену.
3. **Двунаправленный stream-json** (наш §2.7) — почти никем не используется, а именно он даёт долгоживущий управляемый процесс без SDK-зависимости.
4. **Agent SDK** (Happy-remote, CloudCLI, Crystal) — canUseTool/permission-modes/resume из коробки; цена — Node на хосте и локстеп версий SDK↔CLI.
5. **Читатели файлов** (~/.claude/projects/*.jsonl, todos) — универсальный фолбэк и главный источник дрейфа (формат не гарантирован).
6. **Топология релея**: Happy — исходящие с обеих сторон + E2E + store-and-forward (эталон для «телефон/лаптоп через плохие сети»); CloudCLI — сервер рядом с claude, браузер переподключается к живым процессам. Наша SSH-топология устойчивее обоих: туннель + supervisor на VPS.

---

## 16. Рекомендуемая архитектура (синтез)

### 16.1 Сервер (VPS)

```
systemd → supervisor (свой демон; Node/TS c Agent SDK ИЛИ любой язык по raw §2.7)
             │  по сессии: долгоживущий claude
             │    claude -p --input-format stream-json --output-format stream-json
             │           --verbose --include-partial-messages --include-hook-events
             │           --forward-subagent-text --replay-user-messages
             │           [--permission-prompt-tool mcp__hub__approve]
             ├── реестр сессий: свой + `claude agents --json` + транскрипты на диске
             ├── хвост транскрипта .jsonl = восстановление ленты при (re)connect
             ├── statusline-контракт / getContextUsage = живое состояние контекста
             └── WSS/HTTP наружу — только через SSH-туннель (никаких публичных портов)
tmux (опц.) — запасной ручной доступ к тем же сессиям (`claude attach`, отладка)
```

- **Переживание обрывов**: supervisor — systemd-юнит; claude — его ребёнок. Умер supervisor — сессия восстанавливается `--resume <id>` (транскрипт на диске). Умер UI — ничего не умерло: supervisor копит события (store-and-forward, как у Happy), UI при подключении догоняет по транскрипту + живому потоку.
- **Аппрувы — решать структурно с первого дня** (главный урок §15): canUseTool через SDK / контрольный канал §2.7 / `--permission-prompt-tool` на свой MCP-сервер / PermissionRequest-http-хук (у юзера уже работает /permission на хабе :8787). AskUserQuestion приходит тем же каналом — готовые карточки-вопросы.
- **Управление**: методы Query-интерфейса (§2.7) покрывают добрую половину фич Desktop: setPermissionMode, setModel, setMaxThinkingTokens, getContextUsage, rewindFiles (чекпоинты!), readFile, supportedCommands/Models/Agents, mcpServerStatus, backgroundTasks, stopTask, interrupt.
- **Аутентификация**: на VPS `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` + токен в settings env (как сейчас локально). Биллинг-сплит подписки не касается.
- **Мультитенантность/изоляция** (если несколько машин): per-machine `CLAUDE_CONFIG_DIR`, `settingSources: []` при необходимости.

### 16.2 Клиент (свой десктоп)

- Транспорт: SSH-порт-форвардинг до WSS supervisor'а (или Tailscale). UI = Electron/Tauri, лента — не терминал, а рендер событий (как у Desktop, §12).
- Маппинг фич Desktop → источники данных:
  - лента сообщений/инструментов → stream-json (assistant/user/stream_event; субагенты по parent_tool_use_id + --forward-subagent-text);
  - карточки разрешений/вопросов → canUseTool/AskUserQuestion/PermissionRequest;
  - дифы правок → input Edit/Write tool_use (старый vs новый текст) + `git diff`; чекпоинты → rewindFiles(dryRun);
  - задачи → события TaskCreate/TaskUpdate + `~/.claude/tasks/<sid>/*.json`; лента субагентов → subagentStatusLine-контракт (tasks[]);
  - контекст-ринг → getContextUsage / поля context_window+prompt_cache статуслайна;
  - деньги → result.total_cost_usd / model_usage + stats-cache.json;
  - сессии → `claude agents --json` + listSessions + ai-title из транскрипта; resume/fork/branch → флаги;
  - настройки/хуки/MCP/скиллы → редактор settings.json/.mcp.json/.claude/* (hot-reload + ConfigChange-хук подтверждает применение).
- **Что не получить из CLI** (проектировать костыли): рендер картинок из tool_result (все страдают — отдавать файлом/путём), интерналы чекпоинт-формата (использовать rewindFiles), закрытый Remote Control (свой канал вместо него), приватный формат daemon-сокетов (не завязываться на них).

### 16.3 Поэтапный план (минимум → Desktop-parity)

1. **P0 — ядро**: supervisor с одной сессией (двунаправленный stream-json), WSS через SSH-туннель, лента + ввод + interrupt + permission-карточки + result-метрики.
2. **P1**: реестр сессий/несколько сессий, resume/fork, субагенты, партиалы (печатающий текст), steering-очередь, расходы.
3. **P2**: диф-вью + аппрув правок, чекпоинты/rewind, задачи, контекст-ринг, режимы разрешений (Manual/Plan/Auto), план-режим.
4. **P3**: контрольные методы (setModel/effort), MCP-статусы, скиллы/команды-пикер, статистика/insights, фоновые работы, worktree-изоляция, архив сессий.

---

## Источники

Официальные: code.claude.com/docs — headless, cli-reference, sessions, claude-directory, checkpointing, statusline, hooks(+guide), hooks reference, permission-modes, permissions, settings(+reference), env-vars, commands, skills, mcp, channels(+reference), costs, remote-control, desktop(+quickstart/linux/scheduled-tasks), agent-sdk (overview, typescript, python, streaming-*, user-input, permissions, hosting, sessions, session-storage, todo-tracking), vs-code, errors, changelog. Обзор чужих UI: исходники slopus/happy, siteboon/claudecodeui, winfunc/opcode, stravu/crystal, smtg-ai/claude-squad (через zread), blog.mikecodeur.com (PTY-паттерн). Локальная верификация: claude 2.1.229 (Windows), `~/.claude/**`.
