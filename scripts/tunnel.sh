#!/usr/bin/env bash
# SSH-туннель до supervisor на VPS (клиент ходит на ws://127.0.0.1:8790).
# Использование: ./scripts/tunnel.sh user@vps-host [порт]
# Автопереподключение через автосш, если есть; иначе обычный ssh с ServerAliveInterval.

set -euo pipefail

HOST="${1:?использование: tunnel.sh user@host [порт]}"
PORT="${2:-8790}"

if command -v autossh >/dev/null 2>&1; then
  echo "туннель (autossh): локальный 127.0.0.1:${PORT} → ${HOST}:127.0.0.1:${PORT}"
  exec autossh -M 0 -N \
    -o "ServerAliveInterval=15" -o "ServerAliveCountMax=4" \
    -o "ExitOnForwardFailure=yes" \
    -L "127.0.0.1:${PORT}:127.0.0.1:${PORT}" "$HOST"
else
  echo "туннель (ssh): локальный 127.0.0.1:${PORT} → ${HOST}:127.0.0.1:${PORT}"
  echo "для автопереподключения поставьте autossh"
  exec ssh -N \
    -o "ServerAliveInterval=15" -o "ServerAliveCountMax=4" \
    -L "127.0.0.1:${PORT}:127.0.0.1:${PORT}" "$HOST"
fi
