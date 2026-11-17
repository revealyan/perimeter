#!/bin/sh
# Установщик supervisor'а perimeter на сервере (АДР 004). Его кладёт и запускает приложение по ssh:
#   sh perimeter-server.sh status   [пользователь] [порт]          — что стоит (строки ключ=значение)
#   sh perimeter-server.sh install  <папка сборки> <пользователь> <порт> — поставить версию из папки, переключить службу
#   sh perimeter-server.sh rollback [пользователь] [порт]          — вернуть прошлую версию (previous)
# Под root — системная служба perimeter с User=<пользователь> (нет такого — создаётся; пусто — берётся из юнита);
# не под root — служба systemd самого пользователя (переживает выход из ssh только с linger). Root службой не бывает.
# Раскладка у пользователя службы, ~/.perimeter/server/:
#   <версия>/  supervisor.mjs, start.sh, node → ../runtime/node-v<N>-linux-<arch>, node_modules (Claude Code, node-pty)
#   runtime/   свой Node с nodejs.org (sha256 сверяется с закреплённым в сборке)
#   current → <версия>, previous → <версия> (откат)
# Вывод — строки по-русски для окна приложения; «ОШИБКА: …» — причина отказа (код выхода не 0).
set -eu

UNIT=perimeter
BUSY_STATES='creating initializing working waiting_permission waiting_input'

log() { printf '%s\n' "$*"; }
fail() { printf 'ОШИБКА: %s\n' "$*"; exit 1; }

# MODE (system|user), SVC, SVC_HOME, BASE, UNIT_FILE — по аргументу и тому, кто запустил скрипт
setup() {
  if [ "$(id -u)" = 0 ]; then
    MODE=system
    UNIT_FILE=/etc/systemd/system/$UNIT.service
    SVC=${1:-}
    if [ -z "$SVC" ] && [ -f "$UNIT_FILE" ]; then SVC=$(sed -n 's/^User=//p' "$UNIT_FILE" | head -n 1); fi
  else
    MODE=user
    SVC=$(id -un)
    if [ -n "${1:-}" ] && [ "$1" != "$SVC" ]; then
      fail "вход не под root: служба работает только под $SVC, а не под $1"
    fi
    UNIT_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT.service
    # в ssh-команде без сеанса systemd переменной может не быть
    if [ -z "${XDG_RUNTIME_DIR:-}" ]; then XDG_RUNTIME_DIR=/run/user/$(id -u); export XDG_RUNTIME_DIR; fi
  fi
  SVC_HOME=
  if [ -n "$SVC" ]; then SVC_HOME=$(getent passwd "$SVC" | cut -d: -f6 || true); fi
  BASE=
  if [ -n "$SVC_HOME" ]; then BASE=$SVC_HOME/.perimeter/server; fi
}

sysd() {
  if [ "$MODE" = system ]; then systemctl "$@"; else systemctl --user "$@"; fi
}

# команда от имени пользователя службы (под root — через runuser, иначе как есть)
as_svc() {
  if [ "$MODE" = system ]; then
    command -v runuser >/dev/null 2>&1 || fail "нет runuser (util-linux) — не могу действовать от имени $SVC"
    runuser -u "$SVC" -- "$@"
  else
    "$@"
  fi
}

detect_arch() {
  case $(uname -m) in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) fail "архитектура $(uname -m) не поддерживается (нужна x86_64 или aarch64)" ;;
  esac
}

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else fail "нет ни curl, ни wget — не на чем скачать $1"
  fi
}

# любой Node с WebSocket (22+) для проверки: свой текущей версии, свой любой, системный
any_node() {
  for n in "$BASE/current/node/bin/node" "$BASE"/runtime/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$n" ] && [ -x "$n" ]; then printf '%s\n' "$n"; return 0; fi
  done
  return 1
}

# кто отвечает на 127.0.0.1:<порт> (cmd:hello): строка 1 — версия supervisor'а, строка 2 — сколько сессий в работе
hello() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  "$1" -e '
    const ws = new WebSocket("ws://127.0.0.1:" + process.argv[1]);
    const busyStates = process.argv[2].split(" ");
    const t = setTimeout(() => process.exit(2), 3000);
    ws.onopen = () => ws.send(JSON.stringify({ v: 1, ts: Date.now(), id: "install-check", type: "cmd:hello", lastSeq: {} }));
    ws.onmessage = (e) => {
      let f;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      if (f.type !== "event:hello") return;
      const busy = (f.sessions || []).filter((s) => busyStates.includes(s.state)).length;
      console.log(f.server.version + "\n" + busy);
      clearTimeout(t);
      ws.close();
      process.exit(0);
    };
    ws.onerror = () => process.exit(1);
  ' "$2" "$BUSY_STATES" </dev/null 2>/dev/null
}

# ждать до 30 с, пока на порту не ответит supervisor нужной версии (пусто — любой)
wait_version() {
  i=0
  while [ "$i" -lt 60 ]; do
    i=$((i + 1))
    sleep 0.5
    got=$(hello "$1" "$2" | sed -n 1p || true)
    if [ -n "$got" ]; then
      if [ -z "$3" ] || [ "$got" = "$3" ]; then return 0; fi
    fi
  done
  return 1
}

journal_tail() {
  if [ "$MODE" = system ]; then journalctl -u "$UNIT" -n 15 --no-pager -o cat </dev/null 2>/dev/null || true
  else journalctl --user -u "$UNIT" -n 15 --no-pager -o cat </dev/null 2>/dev/null || true
  fi
}

# current → $1, previous → $2 (пусто — убрать previous)
link_to() {
  ln -sfn "$1" "$BASE/current.new"
  mv -Tf "$BASE/current.new" "$BASE/current"
  if [ -n "${2:-}" ]; then
    ln -sfn "$2" "$BASE/previous.new"
    mv -Tf "$BASE/previous.new" "$BASE/previous"
  else
    rm -f "$BASE/previous"
  fi
  if [ "$MODE" = system ]; then
    chown -h "$SVC:" "$BASE/current"
    if [ -L "$BASE/previous" ]; then chown -h "$SVC:" "$BASE/previous"; fi
  fi
}

# не поднявшаяся версия (если на неё уже ничто не ссылается) — прочь: 400 МБ на диске
drop_failed() {
  if [ "$(readlink "$BASE/current" 2>/dev/null || true)" != "$1" ] && [ "$(readlink "$BASE/previous" 2>/dev/null || true)" != "$1" ]; then
    rm -rf "${BASE:?}/$1"
    log "неудачная версия $1 удалена"
  fi
}

# одна установка за раз; зависшая блокировка старше часа снимается
lock() {
  if ! mkdir "$BASE/.lock" 2>/dev/null; then
    if [ -n "$(find "$BASE/.lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
      rmdir "$BASE/.lock"
      mkdir "$BASE/.lock"
    else
      fail "на сервере уже идёт установка (если нет — удалите $BASE/.lock)"
    fi
  fi
  trap 'rmdir "$BASE/.lock" 2>/dev/null || true' EXIT
}

# юнит службы: порт и адрес — от приложения, прочие Environment= прежнего юнита переносятся
write_unit() {
  extra=
  if [ -f "$UNIT_FILE" ]; then
    extra=$(grep '^Environment=' "$UNIT_FILE" | grep -v -e '^Environment=PERIMETER_PORT=' -e '^Environment=PERIMETER_HOST=' || true)
  fi
  case $extra in
    *Environment=PATH=*) ;;
    *) extra="Environment=PATH=/usr/local/bin:/usr/bin:/bin${extra:+
$extra}" ;;
  esac
  if [ "$MODE" = system ]; then wanted=multi-user.target; else wanted=default.target; fi
  mkdir -p "$(dirname "$UNIT_FILE")"
  new=$UNIT_FILE.new
  {
    printf '%s\n' "# perimeter supervisor — ставит и обновляет приложение perimeter (АДР 004)." \
      "# Файл переписывается установщиком; свои переменные — в $UNIT.service.d/*.conf." \
      "[Unit]" "Description=perimeter supervisor (Claude Code sessions)" \
      "After=network-online.target" "Wants=network-online.target" "" "[Service]" "Type=simple"
    if [ "$MODE" = system ]; then printf '%s\n' "User=$SVC"; fi
    printf '%s\n' "WorkingDirectory=$SVC_HOME" "Environment=PERIMETER_PORT=$1" "Environment=PERIMETER_HOST=127.0.0.1" "$extra" \
      "ExecStart=$BASE/current/start.sh" "Restart=always" "RestartSec=3" "KillMode=control-group" "" \
      "[Install]" "WantedBy=$wanted"
  } >"$new"
  if [ -f "$UNIT_FILE" ] && ! grep -q '/.perimeter/server/current/start.sh' "$UNIT_FILE" && [ ! -f "$UNIT_FILE.before-installer" ]; then
    cp "$UNIT_FILE" "$UNIT_FILE.before-installer"
    log "прежний юнит службы сохранён: $UNIT_FILE.before-installer"
  fi
  if [ -f "$UNIT_FILE" ] && cmp -s "$new" "$UNIT_FILE"; then
    rm -f "$new"
  else
    mv "$new" "$UNIT_FILE"
    chmod 644 "$UNIT_FILE"
    log "юнит службы записан: $UNIT_FILE"
  fi
  sysd daemon-reload
  sysd enable "$UNIT" >/dev/null 2>&1 || true
}

check_linger() {
  l=$(loginctl show-user "$SVC" -p Linger --value 2>/dev/null || echo no)
  if [ "$l" = yes ]; then return 0; fi
  loginctl enable-linger "$SVC" >/dev/null 2>&1 || true
  l=$(loginctl show-user "$SVC" -p Linger --value 2>/dev/null || echo no)
  if [ "$l" = yes ]; then log "linger включён — служба живёт без входа по ssh"
  else log "ВНИМАНИЕ: linger выключен — служба остановится после выхода из ssh; один раз под root: loginctl enable-linger $SVC"
  fi
}

# старые версии (кроме current и previous) и неиспользуемые Node — прочь
cleanup() {
  c=$(readlink "$BASE/current" 2>/dev/null || true)
  p=$(readlink "$BASE/previous" 2>/dev/null || true)
  for d in "$BASE"/*; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    case $n in runtime | current | previous) continue ;; esac
    if [ "$n" = "$c" ] || [ "$n" = "$p" ]; then continue; fi
    rm -rf "$d"
    log "удалена старая версия $n"
  done
  keep=" $(basename "$(readlink "$BASE/$c/node" 2>/dev/null || echo -)") $(basename "$(readlink "$BASE/$p/node" 2>/dev/null || echo -)") "
  for r in "$BASE"/runtime/*; do
    [ -d "$r" ] || continue
    n=$(basename "$r")
    case $keep in *" $n "*) continue ;; esac
    rm -rf "$r"
    log "удалён неиспользуемый $n"
  done
}

cmd_status() {
  setup "${1:-}"
  log "mode=$MODE"
  log "ssh_user=$(id -un)"
  log "svc_user=$SVC"
  log "svc_home=$SVC_HOME"
  log "arch=$(uname -m)"
  if command -v systemctl >/dev/null 2>&1; then log "systemd=yes"; else log "systemd=no"; fi
  # системные пакеты полного функционала: git — панель «Файлы»/клон проектов, xvfb — браузер на сервере
  # без галочки Cloudflare, gcc/make/python3 — сборка node-pty (терминал с настоящим pty)
  missing=
  pkgcheck() { command -v "$2" >/dev/null 2>&1 || missing="$missing $1"; }
  pkgcheck git git
  pkgcheck xvfb Xvfb
  pkgcheck gcc gcc
  pkgcheck make make
  pkgcheck python3 python3
  log "packages_missing=${missing# }"
  if command -v apt-get >/dev/null 2>&1; then log "pkg_manager=apt"; else log "pkg_manager=none"; fi
  port=${2:-}
  if [ -f "$UNIT_FILE" ]; then
    log "unit=yes"
    log "unit_user=$(sed -n 's/^User=//p' "$UNIT_FILE" | head -n 1)"
    if grep -q '/.perimeter/server/current/start.sh' "$UNIT_FILE"; then log "unit_managed=yes"; else log "unit_managed=no"; fi
    if [ -z "$port" ]; then port=$(sed -n 's/^Environment=PERIMETER_PORT=//p' "$UNIT_FILE" | head -n 1); fi
  else
    log "unit=no"
  fi
  log "active=$(sysd is-active "$UNIT" 2>/dev/null </dev/null || true)"
  if [ -n "$BASE" ]; then
    log "current=$(readlink "$BASE/current" 2>/dev/null || true)"
    log "previous=$(readlink "$BASE/previous" 2>/dev/null || true)"
  fi
  if [ "$MODE" = user ]; then log "linger=$(loginctl show-user "$SVC" -p Linger --value 2>/dev/null || echo unknown)"; fi
  out=$(hello "$(any_node || true)" "${port:-8790}" || true)
  log "running=$(printf '%s\n' "$out" | sed -n 1p)"
  log "busy=$(printf '%s\n' "$out" | sed -n 2p)"
}

# под пользователем службы: Node, папка версии, npm ci (Claude Code, node-pty)
cmd_prepare() {
  stage=$1
  . "$stage/server.env"
  BASE=$HOME/.perimeter/server
  detect_arch
  case $ARCH in x64) want=$NODE_SHA256_X64 ;; arm64) want=$NODE_SHA256_ARM64 ;; esac
  rt=node-v$NODE_VERSION-linux-$ARCH
  node_dir=$BASE/runtime/$rt
  mkdir -p "$BASE/runtime"
  if [ -x "$node_dir/bin/node" ]; then
    log "Node $NODE_VERSION уже есть"
  else
    log "Node $NODE_VERSION ($ARCH): качаю с nodejs.org…"
    tmp=$BASE/runtime/.$rt.tar.gz.$$
    if ! fetch "https://nodejs.org/dist/v$NODE_VERSION/$rt.tar.gz" "$tmp"; then rm -f "$tmp"; fail "не скачался Node $NODE_VERSION"; fi
    got=$(sha256sum "$tmp" | cut -d' ' -f1)
    if [ "$got" != "$want" ]; then rm -f "$tmp"; fail "контрольная сумма Node не совпала (ждали $want, пришло $got)"; fi
    rm -rf "$node_dir.tmp"
    mkdir -p "$node_dir.tmp"
    tar -xzf "$tmp" -C "$node_dir.tmp" --strip-components=1
    rm -f "$tmp"
    mv "$node_dir.tmp" "$node_dir"
    log "Node $NODE_VERSION поставлен"
  fi
  dir=$BASE/$VERSION
  if [ -f "$dir/.ok" ]; then
    log "версия $VERSION уже разложена — беру её"
    return 0
  fi
  rm -rf "$dir.tmp"
  mkdir -p "$dir.tmp"
  for f in supervisor.mjs package.json package-lock.json manifest.json server.env perimeter-server.sh start.sh; do
    cp "$stage/$f" "$dir.tmp/$f"
  done
  chmod 755 "$dir.tmp/start.sh"
  ln -s "../runtime/$rt" "$dir.tmp/node"
  log "Claude Code и node-pty: npm ci (Claude Code ~340 МБ, качает сервер)…"
  if ! (cd "$dir.tmp" && PATH="$node_dir/bin:$PATH" "$node_dir/bin/npm" ci --omit=dev --no-audit --no-fund --loglevel=error </dev/null 2>&1); then
    fail "npm ci не прошёл"
  fi
  cc=$dir.tmp/node_modules/@anthropic-ai/claude-agent-sdk-linux-$ARCH/claude
  [ -x "$cc" ] || fail "Claude Code для linux-$ARCH не поставился (нет $cc)"
  log "Claude Code $(timeout 30 "$cc" --version </dev/null 2>/dev/null | head -n 1 || echo '?')"
  pty=$dir.tmp/node_modules/node-pty/build/Release/pty.node
  if [ ! -f "$pty" ] && [ -d "$dir.tmp/node_modules/node-pty" ] && command -v make >/dev/null 2>&1; then
    (cd "$dir.tmp" && PATH="$node_dir/bin:$PATH" "$node_dir/bin/npm" rebuild node-pty --loglevel=error </dev/null 2>&1) || true
  fi
  if [ -f "$pty" ]; then log "node-pty собран — терминал с настоящим pty"
  else log "node-pty не собрался (нужны gcc, make, python3) — терминал пойдёт запасным путём"
  fi
  printf '%s\n' "$VERSION" >"$dir.tmp/.ok"
  mv "$dir.tmp" "$dir"
  log "версия $VERSION разложена"
}

cmd_install() {
  stage=$1
  setup "$2"
  port=$3
  [ -f "$stage/server.env" ] || fail "в $stage нет сборки"
  . "$stage/server.env"
  command -v systemctl >/dev/null 2>&1 || fail "на сервере нет systemd — службу не поставить"
  if [ "$MODE" = system ]; then
    [ -n "$SVC" ] || fail "не указан пользователь службы"
    [ "$SVC" != root ] || fail "supervisor не запускается под root — укажите обычного пользователя"
    if [ -z "$SVC_HOME" ]; then
      log "пользователя $SVC нет — создаю"
      useradd -m -s /bin/bash "$SVC"
      SVC_HOME=$(getent passwd "$SVC" | cut -d: -f6)
      BASE=$SVC_HOME/.perimeter/server
    fi
    chown -R "$SVC" "$stage"
  fi
  [ -n "$SVC_HOME" ] && [ -d "$SVC_HOME" ] || fail "у пользователя $SVC нет домашней папки"
  as_svc mkdir -p "$BASE"
  lock
  log "ставлю supervisor $VERSION: пользователь $SVC, служба $([ "$MODE" = system ] && echo системная || echo пользователя), порт $port"
  as_svc sh "$stage/perimeter-server.sh" prepare "$stage"
  old_cur=$(readlink "$BASE/current" 2>/dev/null || true)
  old_prev=$(readlink "$BASE/previous" 2>/dev/null || true)
  if [ -n "$old_cur" ] && [ "$old_cur" != "$VERSION" ]; then link_to "$VERSION" "$old_cur"; else link_to "$VERSION" "$old_prev"; fi
  write_unit "$port"
  log "перезапускаю службу $UNIT…"
  sysd restart "$UNIT"
  node=$BASE/current/node/bin/node
  if wait_version "$node" "$port" "$VERSION"; then
    log "готово: supervisor $VERSION отвечает на 127.0.0.1:$port"
    if [ "$MODE" = user ]; then check_linger; fi
    cleanup
    exit 0
  fi
  log "supervisor $VERSION не ответил за 30 с — последние строки журнала:"
  journal_tail
  if [ -n "$old_cur" ] && [ "$old_cur" != "$VERSION" ] && [ -f "$BASE/$old_cur/.ok" ]; then
    link_to "$old_cur" "$old_prev"
    sysd restart "$UNIT"
    drop_failed "$VERSION"
    if wait_version "$node" "$port" "$old_cur"; then fail "новая версия не поднялась — вернул прежнюю $old_cur"; fi
    fail "новая версия не поднялась, и прежняя $old_cur не отвечает — смотрите journalctl -u $UNIT"
  fi
  if [ -f "$UNIT_FILE.before-installer" ]; then
    rm -f "$BASE/current"
    cp "$UNIT_FILE.before-installer" "$UNIT_FILE"
    sysd daemon-reload
    sysd restart "$UNIT"
    drop_failed "$VERSION"
    if wait_version "$(any_node || true)" "$port" ""; then fail "новая версия не поднялась — вернул прежний юнит службы"; fi
    fail "новая версия не поднялась; прежний юнит службы вернул, но supervisor не отвечает"
  fi
  fail "supervisor $VERSION не поднялся, откатываться не на что"
}

cmd_rollback() {
  setup "${1:-}"
  port=${2:-}
  [ -n "$BASE" ] || fail "не знаю пользователя службы"
  if [ -z "$port" ] && [ -f "$UNIT_FILE" ]; then port=$(sed -n 's/^Environment=PERIMETER_PORT=//p' "$UNIT_FILE" | head -n 1); fi
  port=${port:-8790}
  cur=$(readlink "$BASE/current" 2>/dev/null || true)
  prev=$(readlink "$BASE/previous" 2>/dev/null || true)
  if [ -z "$prev" ] || [ ! -f "$BASE/$prev/.ok" ]; then fail "прошлой версии нет — откатываться не на что"; fi
  lock
  log "откат: $cur → $prev"
  link_to "$prev" "$cur"
  sysd restart "$UNIT"
  if wait_version "$BASE/current/node/bin/node" "$port" "$prev"; then
    log "готово: supervisor $prev отвечает на 127.0.0.1:$port (прошлая теперь — $cur)"
    exit 0
  fi
  journal_tail
  link_to "$cur" "$prev"
  sysd restart "$UNIT"
  fail "прошлая версия $prev не поднялась — вернул $cur"
}

# системные пакеты (git/xvfb/gcc/make/python3): root — ставит сразу, не-root — sudo без пароля,
# иначе — команда для рук. Только apt (Debian/Ubuntu); прочее — тоже командой для рук.
cmd_packages() {
  [ $# -gt 0 ] || fail "не указаны пакеты"
  manual="apt-get install -y $*"
  command -v apt-get >/dev/null 2>&1 || fail "пакеты ставятся не через apt — выполните на сервере: $manual"
  if [ "$(id -u)" = 0 ]; then
    log "обновляю список пакетов…"
    apt-get update -qq </dev/null || true
    log "ставлю пакеты: $*"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" </dev/null || fail "apt-get install не прошёл (строки выше); руками: $manual"
    log "готово: пакеты поставлены ($*)"
  elif sudo -n true </dev/null 2>/dev/null; then
    log "ставлю пакеты через sudo: $*"
    sudo -n apt-get update -qq </dev/null || true
    DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y --no-install-recommends "$@" </dev/null || fail "sudo apt-get install не прошёл (строки выше); руками: $manual"
    log "готово: пакеты поставлены ($*)"
  else
    fail "поставить может только root: выполните на сервере и повторите — $manual"
  fi
}

cmd=${1:-}
if [ $# -gt 0 ]; then shift; fi
case $cmd in
  status) cmd_status "$@" ;;
  install) cmd_install "$@" ;;
  prepare) cmd_prepare "$@" ;;
  rollback) cmd_rollback "$@" ;;
  packages) cmd_packages "$@" ;;
  *) fail "неизвестная команда «$cmd» (status | install | rollback | packages)" ;;
esac
