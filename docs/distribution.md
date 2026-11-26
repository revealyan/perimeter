# Каналы распространения (2026-11-26)

| Канал | Установка | Предупреждения системы | Обновление |
|---|---|---|---|
| GitHub Releases, Windows | `perimeter-setup-<версия>.exe` | SmartScreen один раз при первой установке (подписи нет) | само, тихо (electron-updater) |
| GitHub Releases, macOS | `perimeter-<версия>-arm64.dmg` / `-x64.dmg` | Gatekeeper: «Конфиденциальность и безопасность → Всё равно открыть» (ad-hoc подпись) | «Скачать vX» → страница релиза |
| **npm** | `npx @revealyan/perimeter` или `npm i -g @revealyan/perimeter` | нет: npm не ставит пометок «скачано из интернета», Electron — подписанный из npm | «Обновить до vX» → npm ставит после выхода и запускает |
| **winget** | `winget install revealyan.Perimeter` | обычно нет: winget сверяет хэш и снимает пометку для своего каталога (Smart App Control может блокировать) | `winget upgrade` или само (electron-updater) |

Почему npm: подписи Apple Developer ID ($99/год) нет, оплата из РФ затруднена; Windows-подпись даже EV с 2024 не
снимает SmartScreen сразу. Аудитория — пользователи Claude Code, Node у них обычно есть.

## npm — что сделать один раз (владелец)

1. Аккаунт на https://www.npmjs.com с именем **revealyan** (scope `@revealyan` = имя пользователя или организации).
   Другое имя — поменять `PERIMETER_NPM_NAME` в CI или имя в `apps/desktop/scripts/pack-npm.mjs`.
2. Access Tokens → Generate New Token → **Granular**: Packages and scopes — Read and write, только `@revealyan/*`
   (первый раз пакета ещё нет — «All packages» на время первой публикации, потом сузить).
3. GitHub → репозиторий → Settings → Secrets and variables → Actions → New repository secret: `NPM_TOKEN` = токен.

Дальше каждый тег `v*` публикует пакет сам (задача `npm` в `release.yml`, с `--provenance`). Без секрета задача
пропускается с предупреждением, релиз не ломается.

Устройство пакета (`apps/desktop/scripts/pack-npm.mjs`): `bin/perimeter.mjs` (лаунчер: Electron из зависимостей +
`app/`, терминал сразу свободен) и `app/` (main без тестов, собранный рендерер, бандлы supervisor'а). Electron 45 качает
свой бинарь при первом запуске (~100 МБ) — установочные скрипты npm 11+ по умолчанию не запускает, нам они и не нужны.
Главный процесс понимает режим `PERIMETER_DIST=npm`: готовые сборки из `app/resources`, обновление — через npm
(`main/npm-channel.mjs`: помощник на системном Node ждёт выхода приложения, `npm i -g` или `npx -y`, запускает новую).

Проверено 26.11: `npm pack` → `npm i -g --prefix …` → `perimeter` под Xvfb — окно с собранным рендерером из пакета,
локальный supervisor на 8791 (на Linux нужен `--no-sandbox`: у песочницы Chromium из npm нет setuid-помощника;
на Windows и macOS не нужно).

## winget — что сделать один раз (владелец)

1. Форк https://github.com/microsoft/winget-pkgs в свой аккаунт GitHub.
2. Classic personal access token со scope `public_repo` → секрет репозитория `WINGET_TOKEN`.
3. Первую версию подать вручную (действие в CI умеет только обновлять уже заведённый пакет), например через komac:
   `komac new revealyan.Perimeter --version <версия> --urls https://github.com/revealyan/perimeter/releases/download/v<версия>/perimeter-setup-<версия>.exe --submit`
   (InstallerType: nullsoft, Scope: user, тихо: `/S`). После принятия пулл-реквеста модераторами Microsoft каждый
   следующий релиз подаётся сам (задача `winget` в `release.yml`).

## Homebrew — нет

Официальный `homebrew/cask` требует, чтобы приложение проходило Gatekeeper (подпись + нотаризация), Homebrew 5
объявил устаревшим `--no-quarantine`; свой tap всё равно ставит пометку карантина. Без Developer ID — не канал.
