#!/bin/sh
# Запуск supervisor'а этой версии: служба perimeter → ~/.perimeter/server/current/start.sh (АДР 004).
# Свой Node версии — по ссылке node/ рядом (её делает perimeter-server.sh). В PATH он идёт последним:
# системные node/npx (MCP-серверы через npx) остаются главными, свой — запасной, если системного нет.
here=$(cd "$(dirname "$0")" && pwd -P)
PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}:$here/node/bin"
export PATH
exec "$here/node/bin/node" "$here/supervisor.mjs"
