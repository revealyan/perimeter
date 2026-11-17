# Деплой на VPS

Цель: supervisor под systemd, сессии переживают обрывы (SSH, сеть, сам supervisor), клиент подключается туннелем.

## 0. Установка и обновление из приложения (с 2026-11-13, АДР 004)

Основной путь — supervisor ставит само приложение по ssh подключения, как VS Code Remote SSH. Разделы 1–2 ниже и
«Как выкатываем сейчас» — ручной путь из исходников, нужен только если установщик недоступен.

**Где:** Настройки → подключение VPS → вкладка «Подключение» → блок «Supervisor на сервере». Там версия на сервере
и у приложения, кнопки «Установить / Обновить до …», «Откатить на …» и ход установки строками. Само приложение
ничего не ставит и не перезапускает — только по кнопке (решение владельца: в режиме разработки сборка делается из
рабочих исходников, а их правят и параллельные сессии). Идут ходы в сессиях — кнопка просит подтвердить второй раз.
Из терминала — то же самое: `npm run server:install -- <id|имя подключения> status|install [пользователь]|rollback`.

**Вход и служба** (оба режима — выбор владельца):

| ssh под | служба | пользователь supervisor'а |
|---|---|---|
| root | системная `/etc/systemd/system/perimeter.service`, `User=` | поле «Пользователь службы» (хранится в подключении, `serviceUser`); пусто — из `User=` прежнего юнита; нет такого — создаётся (`useradd -m`); root нельзя |
| не root | `~/.config/systemd/user/perimeter.service` (`systemctl --user`) | сам ssh-пользователь; чтобы служба жила без входа по ssh, нужен linger — установщик пробует `loginctl enable-linger`, не вышло — подсказывает команду для root |

**Что где на сервере** (`~/.perimeter/server/` пользователя службы):

```
<версия>/      supervisor.mjs (один файл, esbuild), start.sh, perimeter-server.sh, package.json + lock,
               node → ../runtime/node-v<N>-linux-<arch>, node_modules/ (Claude Code, node-pty — ставит npm ci)
runtime/       свой Node (nodejs.org, sha256 сверяется с packages/supervisor/server/runtime.json)
current →      версия, которую запускает служба (ExecStart=…/current/start.sh)
previous →     прошлая версия — на неё «Откатить»
```

Версия = `<версия пакета supervisor>-<8 знаков хэша сборки>`, её же supervisor отдаёт в `event:hello` (`server.version`).
Приложение шлёт только сборку (~3 МБ); Node (~50 МБ) и Claude Code (~340 МБ) сервер качает сам. Хранятся `current` и
`previous`, остальные версии и неиспользуемые Node удаляются после успешной установки.

**Как идёт установка** (`perimeter-server.sh install`): временная папка `/tmp/perimeter-install.*` → Node, если нет →
папка версии + `npm ci` по lock-файлу сборки (версии и integrity — из package-lock.json репозитория) → проверка, что
Claude Code запускается, и собран ли node-pty → `current` переключается, прежний — в `previous` → юнит переписывается
(порт — из подключения, прочие `Environment=` прежнего юнита переносятся; свои переменные — в `perimeter.service.d/*.conf`)
→ `systemctl restart perimeter` → до 30 с ждёт, что на `127.0.0.1:<порт>` ответит `cmd:hello` нужной версии. Не ответил —
**сам откатывается**: на прежнюю версию, а при первой установке — на прежний юнит (он сохраняется рядом как
`perimeter.service.before-installer`). Две установки разом не идут (`~/.perimeter/server/.lock`).

**Что нужно серверу:** systemd, `curl` или `wget`, `tar`, `sha256sum`, `runuser` (util-linux), выход к nodejs.org и
registry.npmjs.org. Для настоящего pty в терминале — `gcc`, `make`, `python3` (собирают node-pty); без них терминал
идёт запасным путём (`script`/пайпы). Системные пакеты (Chromium, Xvfb, git) установщик пока не ставит — руками
(открытая развилка).

**Сборка руками:** `npm run build:server` → `packages/supervisor/dist/server/<версия>/` (по содержимому: без правок
версия та же). `PERIMETER_SERVER_BUNDLE=<папка>` — поставить готовую сборку вместо сборки из исходников;
`PERIMETER_BUILD_TAG=<метка>` — другая версия того же кода (проверка отката).

**Логи и откат руками:** `journalctl -u perimeter -f` (служба пользователя — `journalctl --user -u perimeter`);
откат без приложения — `ln -sfn <версия> ~/.perimeter/server/current && systemctl restart perimeter`; вернуться на
исходники — `cp /etc/systemd/system/perimeter.service.before-installer /etc/systemd/system/perimeter.service`,
`systemctl daemon-reload && systemctl restart perimeter`.

## 1. Подготовка VPS (однократно, ручной путь из исходников)

```bash
# node 18.14+ (или 20/22/24 LTS)
node -v

# claude установлен и авторизован тем пользователем, под которым будет сервис
claude --version
ls ~/.claude/projects   # есть история — авторизация и конфиг на месте

# репо
sudo mkdir -p /opt/perimeter && sudo chown "$USER" /opt/perimeter
git clone <репо> /opt/perimeter && cd /opt/perimeter
npm install
npm test   # прогон инвариантов на машине
```

Переменные окружения (файл `/etc/systemd/system/perimeter.service.d/override.conf` при необходимости):

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `PERIMETER_PORT` | `8790` | локальный порт WSS |
| `PERIMETER_HOST` | `127.0.0.1` | НЕ менять на 0.0.0.0 — только туннель |
| `PERIMETER_MODEL` | `glm-5.3[1m]` | модель по умолчанию для новых сессий |
| `PERIMETER_PERMISSION_MODE` | `acceptEdits` | режим разрешений по умолчанию |
| `PERIMETER_STATE` | `~/.perimeter/state.json` | реестр сессий |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | база транскриптов (ресинк) |

## 2. systemd

```bash
# в юните User подменить на своего пользователя (или использовать шаблон %i)
sudo nano /etc/systemd/system/perimeter.service   # User=vasya
sudo systemctl daemon-reload
sudo systemctl enable --now perimeter
systemctl status perimeter
journalctl -u perimeter -f
```

Проверка: `ss -ltn | grep 8790` → слушает `127.0.0.1:8790` (инвариант 6).

## 3. Туннель со машины с UI

```bash
./scripts/tunnel.sh user@vps-host        # autossh сам переподключается
# в отдельном терминале:
npm run desktop
```

Клиент ходит на `ws://127.0.0.1:8790`; сменить адрес: `localStorage['perimeter:ws']` в консоли рендера.

## Подключения VPS (connections.json, 2026-11-11)

Клиент держит подключения как в Happy: «Этот компьютер» (локальный supervisor) есть всегда, VPS — подключаемые, их может быть несколько. Конфиг — `~/.perimeter-client/connections.json` (пишется атомарно; секретов нет — только путь к ключу):

```json
{ "version": 1, "connections": [
  { "id": "vps", "name": "VPS", "host": "198.51.100.32", "port": 22, "user": "root", "remotePort": 8790, "localPort": 8790, "enabled": true },
  { "id": "c-1a2b3c", "name": "второй", "host": "1.2.3.4", "port": 22, "user": "yan", "privateKey": "C:/Users/me/.ssh/id_ed25519", "remotePort": 8790, "localPort": 8800, "enabled": true }
] }
```

- **Миграция**: нет `connections.json`, но есть старый `tunnel.json` — при запуске создаётся подключение `id: "vps"` на том же `localPort` (8790); `tunnel.json` остаётся как был. id `vps` и порт 8790 сохраняются нарочно: на них завязаны ключи `localStorage` рендерера.
- **Новые подключения** (из UI): id `c-xxxxxx`, `localPort` — первый свободный с 8800 (8790/8791/8795/8796/5173/5174 не раздаются). Включённое подключение держит свой ssh-туннель `127.0.0.1:localPort → VPS 127.0.0.1:remotePort` с автопереподъёмом; выключенное и удалённое — гасится вместе с пробросами портов.
- **Вход по ssh**: путь `privateKey`, если задан; иначе все найденные `~/.ssh/id_ed25519`, `id_rsa`, `id_ecdsa` по очереди и ssh-agent (`SSH_AUTH_SOCK`; на Windows — агент OpenSSH `\\.\pipe\openssh-ssh-agent`, а если ключей нет — pageant). Ключи с паролем не поддерживаются — используйте агент.
- **Проверка** («Проверить» в форме): ssh-вход + открытие канала на `remotePort` VPS — так видно и «ключ не подошёл», и «supervisor не запущен».
- **Проброс портов** (как в VS Code Remote SSH): порт VPS → `127.0.0.1:<тот же порт, если свободен, иначе любой>` через ssh-коннект подключения; список пробросов виден в UI, снимается там же.

## 4. Проверка живучести (инварианты 2/3 на живой машине)

```bash
# сессия работает → убиваем supervisor безжалостно
sudo kill -9 "$(systemctl show -p MainPID --value perimeter)"
# systemd поднимет за RestartSec=3; в UI:
#   сессия уйдёт в dead → сообщение в неё = respawn через --resume
#   лента восстановится ресинком из транскрипта (RESYNC_NEEDED → transcript.get)

# обрыв туннеля: оборвать сеть/убить autossh — при возврате клиент сам
# поздоровается с lastSeq и догонит хвост
```

## Мультиакк (несколько клод-кодов)

Профили живут на VPS в `~/.perimeter/profiles.json` (права 600) — токены не ходят в UI. Каждый профиль = свой `CLAUDE_CONFIG_DIR` (креды, settings, projects) или свой env-шлюз; тяжёлое общее (plugins, skills) делится симлinkами на базовый `~/.claude`:

```
~/.perimeter/
├── profiles.json
└── accounts/acc2/.claude/     # CLAUDE_CONFIG_DIR второго аккаунта
    ├── .credentials.json      # его логин
    ├── plugins -> ~/.claude/plugins   (симлинки: делим общее)
    └── skills   -> ~/.claude/skills
```

```json
{
  "version": 1,
  "profiles": [
    { "name": "yan",  "model": "sonnet", "description": "подписка claude.ai (yan)" },
    { "name": "acc2", "model": "sonnet", "configDir": "/home/yan/.perimeter/accounts/acc2/.claude" },
    { "name": "zai",  "model": "glm-5.3[1m]",
      "env": { "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic", "ANTHROPIC_AUTH_TOKEN": "…" } }
  ]
}
```

Один раз залогинировать второй аккаунт:

```bash
sudo -u yan bash -lc 'CLAUDE_CONFIG_DIR=~/.perimeter/accounts/acc2/.claude claude'
# OAuth-ссылка появится в терминале; после логина — выйти
sudo systemctl restart perimeter   # перечитает profiles.json
```

В UI профили появятся чипами «+ yan / + acc2» под кнопкой создания сессии; у сессии в сайдбаре видно её профиль. Resume/respawn применяет профиль сессии автоматически.

### Аккаунты из UI (2026-11-12, эталон 003-accounts-add)

Настройки → подключение → «Аккаунты и модели» → **«+ Добавить аккаунт»**; у аккаунта-подписки, который не вошёл в Claude Code, в карточке — «не вошёл · Войти».

- **Подписка Claude** — вход на стороне сервера: supervisor запускает `claude auth login --claudeai` (бинарь Claude Code из Agent SDK: `@anthropic-ai/claude-agent-sdk-<платформа>-<архитектура>`, иначе `claude` из PATH; переопределить — `PERIMETER_CLAUDE_BIN`) в PTY с `CLAUDE_CONFIG_DIR` аккаунта и без ключей/шлюзов окружения. Ссылку входа открывает во вкладке браузера на сервере; собственный подписчик вкладки следит за адресом и, когда Anthropic перебрасывает на `…/oauth/code/callback?code=…&state=…`, сам передаёт код (`code#state`) в процесс входа. Запасной путь в том же окне — открыть страницу у себя и вставить код (`cmd:profile.login.code`). Вход дольше 15 минут прерывается.
- Новый аккаунт: папка `~/.perimeter/accounts/acc-<слаг>/.claude` (права 700) с симлинками общего из базовой папки (`plugins`, `skills`, `commands`, `agents`; **не** `settings.json` — там может быть шлюз). После входа в `profiles.json` добавляется `{ name: <из почты>, displayName: <почта>, configDir, description: "подписка …" }`; вход не удался или отменён — папка убирается.
- Вход аккаунтов-подписок проверяется при старте (`claude auth status --json`, по одному процессу) и уходит клиенту в `profileInfo.auth` (`loggedIn`, почта, тариф).
- **Токен подписки Claude** (шаблон «Токен подписки Claude» в форме «Ключ API»): кнопка **«Получить токен»** (с 2026-11-13): локальный supervisor («Этот компьютер») запускает `claude setup-token` во временной папке (`cmd:profile.token.start`), Claude Code открывает обычный вход Anthropic в браузере владельца (Cloudflare не мешает; не открылся — ссылка и код вручную через `cmd:profile.login.code`), токен ловится в выводе и отдаётся один раз окну, которое его запросило (`cmd:profile.token.take`; в рассылку событий не попадает), встаёт в форму и сразу проверяется на выбранном подключении. Можно и по-старому — выпустить `claude setup-token` в терминале и вставить; токен — в `env.CLAUDE_CODE_OAUTH_TOKEN` профиля, у аккаунта своя папка `~/.perimeter/accounts/tok-<слаг>/.claude` (чтобы не подхватить шлюз из базового `settings.json`). Проверка — один запрос через сам Claude Code (`claude -p`, 1 ход, временная папка; токен подписки работает только внутри Claude Code). Токен живёт около года; почты и тарифа у такого аккаунта не видно (права только на запросы).
- **Ключ API** — шаблоны: Anthropic (`ANTHROPIC_API_KEY`, модели из Claude Code), z.ai (`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, `ANTHROPIC_AUTH_TOKEN`, ручные модели GLM, без ultracode), свой адрес (Bearer, ручные модели). «Проверить» — один запрос к `/v1/messages` с `max_tokens: 1` (несколько токенов). Ключ только записывается в `profiles.json`; клиенту — «…последние 4».
- Команды: `cmd:profile.add`, `cmd:profile.check`, `cmd:profile.login.start` / `.code` / `.cancel`; событие `event:profile.login` (starting → waiting → verifying → done | failed | cancelled; `rbError` — браузера на сервере нет, окно сразу показывает код руками).
- Cloudflare перед claude.ai может показать проверку «Verify you are human»: её проходит владелец во встроенной вкладке; если не пускает — запасной путь с кодом.

### MCP-подключения из UI (2026-11-12)

Настройки → подключение → **«MCP»**: **общий список** MCP-серверов среды (с 2026-11-12): строка — сервер, под ней аккаунты-переключатели — у кого включён. Серверы хранятся у самого Claude Code — `claude mcp add-json -s user` / `remove -s user` в `CLAUDE_CONFIG_DIR` каждого аккаунта (файл `.claude.json` его папки, без папки — `~/.claude.json`), так их видит и `claude` в терминале, и вход OAuth работает у каждого аккаунта. Аккаунты с общим файлом настроек — один переключатель. Статус — из `claude mcp list` у каждого аккаунта (до минуты; у stdio-серверов запускает их команды): список сначала приходит по файлам, потом со статусами.

- Запасная копия — `~/.perimeter/mcp-shared.json` рядом с `profiles.json` (права 600, в ней секреты серверов): выключенный у всех сервер не теряется, включить у аккаунта — взять отсюда; сервера, которого ещё нет в копии, снимается с аккаунта, у кого он есть. Ключ аккаунта-шлюза в копии — меткой `{{account-key}}`: у аккаунта z.ai подставляется его собственный ключ, у остальных — ключ, с которым сервер добавили.
- «Добавить MCP-сервер» ставит сервер всем аккаунтам; «Удалить» — у всех и из копии. Выключить у аккаунта — убрать из его Claude Code (у аккаунта supervisor'а на своём компьютере это обычный Claude Code владельца — пропадёт и в терминале).
- Новый аккаунт получает все серверы, включённые хоть у одного аккаунта. Новый аккаунт z.ai — ещё и **стандартный набор z.ai** (`web-search-prime`, `web-reader`, `zread` по HTTP с `Bearer <ключ>`, `zai-mcp-server` — `npx -y @z_ai/mcp-server` с `Z_AI_MODE=ZAI`, `Z_AI_API_KEY`); у уже подключённого z.ai — кнопка «Поставить» над списком, пока набора нет.
- **Смена ключа аккаунта** («Настройки → Аккаунты», `cmd:profile.update` с `apiKey`, с 2026-11-13): старый ключ этого аккаунта везде заменяется новым — в запасной копии сразу (в «как есть»; шаблон с `{{account-key}}` не меняется), у аккаунтов — фоном, по очереди (`claude mcp remove -s user` + `add-json`; не добавился — возвращается прежний конфиг). Ищется точное совпадение старого ключа (от 8 символов) только в заголовках и переменных окружения — так набор z.ai у аккаунтов без своего ключа (например, `claude`) не остаётся со старым. Трогаются все видимые аккаунты, включая не вошедшие подписки; не трогается аккаунт, у которого тот же старый ключ — его собственный. В журнал — только имена (`[mcp] <аккаунт>: новый ключ — в MCP аккаунтов (<аккаунт>/<сервер>, …)`), ключи не пишутся. Идущие сессии других аккаунтов видят обновлённые серверы со следующего запуска.

- Окно «Добавить MCP-сервер» — три вкладки (с 2026-11-12, вместо зашитых шаблонов):
  - **Каталог** — поиск по официальному реестру MCP (`registry.modelcontextprotocol.io`, `cmd:mcp.catalog.search`; ищет supervisor — серверу нужен выход в интернет). Запись реестра разбирается в способы подключения: удалённый (HTTP/SSE) или пакет, который запускается на сервере (npm → `npx -y пакет@версия`, PyPI → `uvx пакет==версия`, Docker → `docker run -i --rm образ`); форма — из полей записи (ключи, переменные, аргументы). Способ недоступен, если на сервере нет `npx`/`uvx` или у пользователя supervisor'а нет доступа к docker (не в группе `docker`). `uvx` — из uv: в Debian пакета нет, ставится бинарём релиза с проверкой суммы (`uv-x86_64-unknown-linux-gnu.tar.gz` + `.sha256` с github.com/astral-sh/uv/releases → `install -m 0755 uv uvx /usr/local/bin/`); Python берётся системный. Группу `docker` пользователю supervisor'а не даём без нужды — это права root. mcpb и NuGet отсюда не ставятся. Порядок выдачи свой: сначала сервер самого сервиса (пространство имён реестра проверено — домен или логин GitHub), обёртки Smithery (нужен их ключ) — ниже; ответы кэшируются на 10 мин.
  - **Из документации** — вставить JSON (`{"mcpServers": …}` Claude Desktop/Cursor, `{"servers": …}` VS Code, кусок `"имя": {…}`), команды `claude mcp add …` / `add-json` (несколько подряд), адрес `https://…` или строку запуска `npx/uvx/docker`. Разбор — в приложении; заглушки вроде `your_api_key` подсвечиваются.
  - **Вручную** — HTTP/SSE (адрес + заголовки) или команда (аргументы, переменные).
- Ключ аккаунта-шлюза (z.ai): кнопка «Ключ аккаунта» ставит в значение метку `{{account-key}}`, ключ подставляет supervisor — только в заголовки/переменные и для HTTP только серверам домена шлюза (`api.z.ai` → MCP z.ai веб-поиска и чтения страниц). Так MCP z.ai подключаются вставкой команды из их документации без копирования ключа.
  - У команды (stdio) адреса нет, поэтому копия помнит шлюз, чей ключ означает метка (`keyHost` в `mcp-shared.json`, с 2026-11-13): у набора z.ai — `api.z.ai`; у «Добавить всем» — шлюз первого аккаунта-шлюза с ключом (его же предлагает окно); у сервера, снятого с аккаунта, — шлюз аккаунта, чей ключ в нём был. Другим аккаунтам ключ подставляется, только если их шлюз того же домена; ключ Anthropic API без шлюза или ключ другого шлюза в команду не уходит — им ставится ключ, с которым сервер добавили (иначе, например, пакет z.ai отправил бы в z.ai чужой ключ). Копии из файла до 2026-11-13 без `keyHost`: HTTP — шлюз из адреса, `zai-mcp-server` набора z.ai — `api.z.ai`, прочие команды — метка не раздаётся никому. Добавление команды с меткой одному аккаунту (`cmd:mcp.add`) — как раньше, ключ этого аккаунта.
- Секреты (заголовки, переменные) только уходят на сервер — клиенту приходят их имена; в тексте ошибки Claude Code значения маскируются.
- Вход OAuth (статус «нужен вход» → «Войти»): `claude mcp login <имя> --no-browser` в PTY, ссылка — во вкладке браузера на сервере; адрес возврата `http://localhost:<порт>/callback` сервера Claude Code ловит сам. Запасной путь — открыть ссылку у себя и вставить адрес из адресной строки, куда перебросило. Сессии аккаунта увидят сервер со следующего запуска.
- Команды: общий список — `cmd:mcp.shared` (check — со статусами) / `cmd:mcp.toggle` / `cmd:mcp.shared.add` / `cmd:mcp.shared.remove` / `cmd:mcp.preset`; по одному аккаунту (старые клиенты) — `cmd:mcp.list` / `cmd:mcp.add` / `cmd:mcp.remove`; ещё `cmd:mcp.login.start` / `cmd:mcp.catalog.search` (ход входа — `event:profile.login`, код/адрес — `cmd:profile.login.code`).
- Проектный уровень (`.mcp.json` проекта) из UI пока не настраивается.

### Модели, усилие и ultracode по аккаунтам (2026-11-10)

Новые поля профиля (все необязательные; правятся и из UI — «Настройки → Аккаунты», команда `cmd:profile.update`):

| Поле | Что значит | По умолчанию |
|---|---|---|
| `modelsSource` | `auto` — список у провайдера: `GET {ANTHROPIC_BASE_URL}/v1/models` с ключом аккаунта (ключ API → `x-api-key`, токен шлюза → `Bearer`, токен подписки → `Bearer` + бета `oauth-2025-04-20`); настоящие id, окно контекста (`max_input_tokens`) и усилия (`capabilities.effort`). Ключа нет (подписка через `claude auth login`) или провайдер не ответил — список самого Claude Code (`supportedModels()`). `manual` — из поля `models` (с 2026-11-12) | `auto` |
| `models` | ручной список: `[{ "id": "glm-5.3", "efforts": [] }]`; `efforts` — уровни усилия модели (`low`…`max`), пусто — усилие не настраивается | — |
| `custom` | свои модели — та же модель с другим окном контекста: `[{ "id": "glm-5.3@400k", "base": "glm-5.3", "ctx": 400000, "label": "GLM короче" }]`; окно 100 000–1 000 000. Запуск: база (с `[1m]`, если окно больше 200K) и настройка Claude Code `autoCompactWindow` = окно — Claude Code сжимает переписку, дойдя до него. Окно берётся только при старте процесса: такая сессия стартует без тёплого процесса, а смена окна у идущей сессии перезапускает её процесс между ходами (история сохраняется). id самоописывающий — `glm-5.3@400k` можно вписать и в «Своя модель» в выборе модели | — |
| `long` | модели с контекстом 1M: Claude Code запускается с `--model <id>[1m]` (у шлюзов и не у всех тарифов 1M есть — включается руками, чип «1M» у модели в настройках аккаунта); пустой список `[]` — 1M выключен у всех | не задано — из настроек Claude Code аккаунта: модели с `[1m]` в `model` settings.json и в `ANTHROPIC_*_MODEL`; шаблон z.ai — `glm-5.3`, `glm-5.3-flash` |
| `defaultEffort` | усилие новых сессий аккаунта (`low`, `medium`, `high`, `xhigh`, `max`); молча не применяется к модели, которая его не знает | нет (по умолчанию модели) |
| `ultracode` | разрешён ли ultracode; `false` — кнопки в UI нет и слово «ultracode» в сообщении не срабатывает | шлюз — `false`, иначе `true` |

```json
{ "name": "zai", "model": "glm-5.3", "env": { "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic", "ANTHROPIC_AUTH_TOKEN": "…" },
  "long": ["glm-5.3"], "ultracode": false }
```

- Список `auto` хранится отдельно, в `~/.perimeter/profiles-cache.json`: обновление списка не переписывает файл с токенами. При старте supervisor в фоне спрашивает Claude Code о моделях аккаунтов, у которых списка нет или он старше недели: по одному временному процессу `claude` на аккаунт, ~3 с, без сообщений и без расхода токенов. Обновить вручную — `cmd:profile.models` с `refresh: true` (кнопка «Обновить» в настройках).
- Ключ API аккаунта-шлюза (z.ai) задаётся из UI: Настройки → Аккаунты → «Ключ API». Это только запись: ключ попадает в `env.ANTHROPIC_AUTH_TOKEN` профиля (или в `ANTHROPIC_API_KEY`, если профиль уже на нём), клиенту возвращаются лишь последние 4 символа. Простаивающие сессии аккаунта supervisor останавливает — следующее сообщение поднимет их с новым ключом. Для z.ai нужен ключ со вкладки «Personal Coding Plan»: ключ со вкладки «Standard» даёт `429 · 1113 Insufficient balance`.
- Правка из UI пишет `profiles.json` атомарно (временный файл + переименование), права файла сохраняются, `env`, `configDir` и незнакомые поля остаются как были. Битый файл правкой не перезаписывается — ошибка `PROFILE_UPDATE_FAILED`.
- Аккаунт самого supervisor'а (сессии без профиля, их обслуживает пул тёплых процессов) виден клиенту как профиль `default` — «По умолчанию». Его настройки из UI сохраняются записью `{ "name": "default", … }` без `env`. Запись `default` со своим `env` или `configDir` — это уже отдельный аккаунт, а не supervisor.
- Определение шлюза у `default` смотрит только `ANTHROPIC_BASE_URL` в окружении сервиса; если шлюз задан в `~/.claude/settings.json`, поставьте `modelsSource`/`ultracode` у записи `default` руками или из UI.
- Усилие и ultracode меняются на лету (`cmd:session.settings` → SDK `applyFlagSettings`, ~0.1 с, без перезапуска процесса) и сохраняются в реестре сессий — переживают рестарт supervisor'а и respawn.

## Панели клиента: терминал, файлы, порты

Файлы, git-статус и список портов работают без настройки (нужны `git` и `ss` из iproute2 — на Ubuntu есть по умолчанию).
Терминал работает в трёх режимах, supervisor выбирает лучший доступный:
1. **node-pty** (настоящий PTY) — для Linux собирается из исходников:
   ```bash
   sudo apt install -y build-essential python3
   cd /opt/perimeter && npm approve-scripts node-pty && npm rebuild node-pty
   ```
   (npm 11 по умолчанию не запускает install-скрипты пакетов — без `approve-scripts` модуль не соберётся.)
2. Без node-pty — `script -qfc` из util-linux: тоже настоящий PTY, ресайз через `stty`.
3. Последний запасной — пайпы (`mode: pipe`, в клиенте пометка «упрощённый режим»).
Терминал без открытой вкладки живёт 12 ч (`PERIMETER_TERM_IDLE_MS`, 0 — не гасить); при рестарте сервиса systemd гасит их вместе с supervisor'ом (`KillMode=control-group`).
Принудительно выбрать режим: `PERIMETER_TERM_MODE=pty|pipe`.

## Удалённый браузер (ретрансляция, `cmd:rb.*`, 2026-11-11)

Браузер работает на машине supervisor'а (headless Chromium/Chrome/Edge): клиент получает поток JPEG-кадров и шлёт мышь и клавиатуру — страницы видят сеть VPS, в том числе его localhost. Процесс браузера один на supervisor, вкладки — отдельные цели CDP (Chrome DevTools Protocol); закрылась последняя вкладка — процесс гасится, его временный профиль удаляется. Порт отладки CDP — случайный, только 127.0.0.1.

| Переменная | По умолчанию | Что |
|---|---|---|
| `PERIMETER_CHROMIUM` | автопоиск | путь к браузеру. Автопоиск: Windows — Chrome, затем Edge; Linux/mac — `google-chrome`, `google-chrome-stable`, `chrome-headless-shell`, `chromium`, `chromium-browser`, `microsoft-edge` в PATH, затем `/snap/bin/chromium`, `/usr/bin/chromium*` (браузеры не из snap — первыми) |
| `PERIMETER_CHROMIUM_SCOPE` | авто | `on`/`off` — запускать через `systemd-run --user --scope` (это нужно snap-chromium). Авто: браузер из snap и есть папка `XDG_RUNTIME_DIR` |
| `PERIMETER_CHROMIUM_DISPLAY` | `auto` | `auto` — на Linux с Xvfb браузер запускается **с окном на виртуальном экране** (supervisor сам поднимает `Xvfb :99…` и гасит его вместе с браузером), иначе без окна; `xvfb` — то же явно; `headless` — всегда без окна. С окном Cloudflare и Фигма принимают браузер за обычный (без окна claude.ai держит на «Verify you are human»). Нужен пакет `xvfb` (`apt install xvfb`) |
| `PERIMETER_RB_MAX` | `3` | вкладок одновременно, сверх — `RB_LIMIT` |
| `PERIMETER_RB_IDLE_MS` | `1800000` (30 мин) | вкладка без зрителей закрывается сама; `0` — не закрывать |

- Качество JPEG по умолчанию 55, клиент может попросить 20–90 (`quality` в `cmd:rb.open`).
- Кадры идут только подписанному сокету, мимо ринг-буфера (seq 0) и без сжатия. Следующий кадр браузер шлёт после подтверждения предыдущего; пока никто не смотрит, подтверждение придерживается (браузер не рисует впустую). Если у сокета в буфере больше 2 МБ — кадр пропускается.
- Адрес без схемы → `https://` (localhost, 127.x, 10.x, 192.168.x, IP → `http://`); разрешены только `http`, `https`, `about` — `javascript:`, `data:`, `file:`, `chrome:` → `RB_BAD_URL`.
- Браузер не найден или не стартовал — `RB_UNAVAILABLE` с объяснением по-русски (snap без сессии, нет библиотеки и т. п.).

### VPS: snap-chromium (проверено 2026-11-11)

На VPS (Ubuntu 24.04, glibc 2.39) есть только `chromium` из snap (база core26). Под пользователем сервиса без пользовательской сессии systemd он не стартует («cannot run snap applications… cannot track application process»), а бинарь из snap напрямую не запустить — ему нужна glibc 2.42+. Поэтому сейчас на проде `rb.open` ответит `RB_UNAVAILABLE` с этим объяснением. Варианты — оба системная правка, только с согласия владельца:

1. **linger для пользователя сервиса** (держит его systemd-сессию без входа) и путь к ней в юните:
   ```bash
   sudo loginctl enable-linger yan
   # в [Service] юнита perimeter:
   # Environment=XDG_RUNTIME_DIR=/run/user/1000
   ```
   supervisor сам увидит snap и запустит браузер через `systemd-run --user --scope`. На проде этот путь ещё не проверен. Оговорка: такой браузер живёт в cgroup пользователя, а не сервиса — `KillMode=control-group` его не гасит; supervisor закрывает его сам при остановке (SIGTERM), но после `kill -9` supervisor'а headless-процесс может остаться до ручного `pkill -u yan chromium`.
2. **Браузер не из snap**: Google Chrome (.deb) или `chrome-headless-shell` (архив Chrome for Testing можно распаковать в домашнюю папку yan без sudo) + `PERIMETER_CHROMIUM=<путь>`. Нужны системные библиотеки Chromium (libnss3, libgbm1 и др.); если какой-то нет — ошибка `rb.open` назовёт её.

**Сделано 2026-11-11 (без sudo):** `chrome-headless-shell` 157 (Chrome for Testing) распакован в `~yan/.cache/chrome-headless-shell/157.0.8103.50/`; недостающие библиотеки (libatk, libatk-bridge, libatspi, libgbm, libasound, libXcomposite/Xdamage/Xfixes/Xrandr/Xrender/Xi) скачаны `apt-get download` и распакованы `dpkg-deb -x` в `~yan/.cache/chrome-headless-shell/libs/root` — в систему ничего не ставилось. Обёртка `~yan/.local/bin/chrome-headless-shell` выставляет `LD_LIBRARY_PATH` и запускает браузер; supervisor находит её по имени через PATH юнита. Песочнице Chromium мешал AppArmor: на Ubuntu 24.04 `kernel.apparmor_restrict_unprivileged_userns=1` (без разрешения `rb.open` отвечает `RB_UNAVAILABLE` с объяснением). **Владелец выбрал профиль AppArmor — он установлен 2026-11-11** (`/etc/apparmor.d/perimeter-chrome-headless-shell`, загружен `apparmor_parser -r`): браузер на проде открывается с песочницей, тесты с настоящим браузером на VPS проходят. Варианты для другой машины:

1. **Профиль AppArmor (песочница сохраняется, нужен sudo) — стоит на проде:**
   ```bash
   sudo tee /etc/apparmor.d/perimeter-chrome-headless-shell >/dev/null <<'EOF'
   abi <abi/4.0>,
   include <tunables/global>
   profile perimeter-chrome-headless-shell /home/yan/.cache/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
     userns,
     include if exists <local/perimeter-chrome-headless-shell>
   }
   EOF
   sudo apparmor_parser -r /etc/apparmor.d/perimeter-chrome-headless-shell
   ```
2. **Без песочницы (без sudo):** `Environment=PERIMETER_CHROMIUM_NO_SANDBOX=1` в `[Service]` юнита + `systemctl daemon-reload && systemctl restart perimeter`. Страницы, открытые в браузере на сервере, изолированы от пользователя yan слабее.

Обновление браузера: новая версия Chrome for Testing — в соседнюю папку и поправить путь в обёртке (и в профиле AppArmor, если он есть — там шаблон `*`).

Тесты на VPS (`npx vitest run`): интеграционный тест с настоящим браузером сам пропускается, если браузер из snap и `XDG_RUNTIME_DIR` нет; пропустить принудительно — `PERIMETER_SKIP_REAL_BROWSER=1`.

## Пул тёплых процессов по аккаунтам

| Переменная | По умолчанию | Что |
|---|---|---|
| `PERIMETER_POOL_SIZE` | `1` | тёплых процессов для сессий без профиля (аккаунт supervisor'а); `0` — не греть |
| `PERIMETER_POOL_PROFILES` | пусто | каким профилям из `profiles.json` держать свой тёплый процесс: `all` или список через запятую (`yan,zai`; `default` — аккаунт supervisor'а). Неизвестные имена пропускаются |
| `PERIMETER_POOL_PROFILE_SIZE` | `1` | тёплых процессов на каждый такой профиль; `0` — профили не греть |

- Окружение процесса (ключ, шлюз, папка конфига) фиксируется в момент прогрева, поэтому слот одного аккаунта другому не годится: сессия берёт слот только своего профиля, слота нет — обычный холодный старт.
- Смена ключа API аккаунта из UI (`cmd:profile.update` с ключом) гасит тёплый процесс этого аккаунта и греет новый с новым ключом.
- Каждый слот — живой процесс claude, порядка 250 МБ памяти: `all` на три аккаунта — плюс три процесса. По умолчанию (переменная не задана) поведение прежнее — греется только аккаунт supervisor'а.

## Сжатие трафика (permessage-deflate)

WSS договаривается с клиентом о сжатии permessage-deflate (браузерный WebSocket и `ws` предлагают его сами, настройки не нужны). Сообщения от 1 КБ сжимаются (zlib, уровень 6), мелкие уходят как есть; кадры удалённого браузера — без сжатия (JPEG почти не жмётся, жалко CPU). Большие ответы — ресинк ленты, `transcript.get`, `fs.read` — на проводе в разы меньше (в тесте повторяющийся текст ~300 КБ ужимается больше чем в 10 раз). SSH-туннель (`scripts/tunnel.sh`) сам не сжимает, двойного сжатия нет. Выключить можно только в коде — опция `compress: false` у `WssServer`.

## Хранилище проектов (новый проект по имени)

У каждой среды свой корень проектов: новый проект из UI — это имя, папка `<корень>/<slug>` создаётся (или клонируется из git) сама.

- Корень по умолчанию — `PERIMETER_PROJECTS_ROOT`, иначе `~/projects` пользователя сервиса (на VPS: `/home/yan/projects`). Локальному supervisor'у Electron передаёт `PERIMETER_PROJECTS_ROOT` = папка рядом с репозиторием (у владельца `C:\devs\revealyan`), если переменная не задана.
- Выбор корня из UI (`cmd:storage.set`) пишется в `projects.json` (поле `root`, рядом со списком проектов) и переживает рестарт; папки нет — создаётся.
- Клон: `git clone -- <url> <папка>` от имени пользователя сервиса, с `GIT_TERMINAL_PROMPT=0` и (если не задан свой `GIT_SSH_COMMAND`) `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new` — запросов пароля нет: приватный репозиторий клонируется, только если у пользователя сервиса есть доступ (ssh-ключ в `~/.ssh`, токен в credential helper). Таймаут клона — 10 минут.
- Папка с тем же origin (https/ssh одного репо считаются одним) подключается как есть; занятая чужим — ошибка `PROJECT_PATH`, ничего не трогаем.
- Токены в URL (`https://user:token@…`) в ответах и логах маскируются (`***@`).

## Как выкатывали руками (до установщика; прод на RackNerd, 2026-11-10)

С 2026-11-13 — установщик из приложения (раздел 0). Ниже — ручная процедура для сервера без установщика.

Факт: код лежит в `/home/yan/perimeter` **без git** (копия), сервис `perimeter` (User=yan, `npx tsx packages/supervisor/src/main.ts`), реестр сессий — `~yan/.perimeter/state.json` (не в папке кода, переживает выкатку).

1. Проверить, что сессии не работают и не ждут ответа (иначе рестарт прервёт ход): `cmd:hello` → у всех `dead`/`idle`.
2. Резервная копия: `tar czf ~yan/perimeter-backup-<ts>.tgz --exclude=perimeter/node_modules perimeter .perimeter`.
3. Локально: `tar czf perimeter-src.tgz --exclude=node_modules --exclude=apps/desktop/dist-renderer --exclude=.claude --exclude=.local-state.json perimeter` → `scp` на VPS.
4. Распаковать рядом в `~yan/perimeter-new`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` (npm 10 собирает node-pty сам — gcc/make/python3 на VPS есть), `npx vitest run` и `npx tsc --noEmit` **на VPS** (ловит Linux-специфику — так нашли поломку терминала без PTY).
5. `systemctl stop perimeter` → `mv perimeter perimeter-prev-<ts>` → `mv perimeter-new perimeter` → `systemctl start perimeter`; проверить `ss -ltnp | grep 8790` (только 127.0.0.1) и hello.
6. Откат: `systemctl stop perimeter && mv perimeter perimeter-bad && mv perimeter-prev-<ts> perimeter && systemctl start perimeter`.

Замечание: в юните строка `Environment=PERIMETER_POOL_SIZE=1` стоит после `[Install]` и игнорируется systemd (по умолчанию и так 1) — перенести в `[Service]` при следующей правке юнита.

## Известные ограничения P0

- supervisor стартует процессы claude лениво: первое сообщение запускает процесс.
- `cmd:transcript.get` читает транскрипт разом (без afterUuid-пагинации) — хватит до ~сотен сообщений.
- WSS без TLS внутри туннеля (туннель шифрует); авторизация кадров пока нет — порт только loopback.
- версия CLI пинуется версией Agent SDK в `packages/supervisor/package.json`.
