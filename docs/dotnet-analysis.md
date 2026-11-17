# .NET/AOT: честный разбор «переписать всё?»

**Вердикт: нет, не переписывать.** Подробный отчёт — см. ниже.

## Почему нет (одной таблицей)

| Компонент | LOC | Вердикт | Причина |
|---|---|---|---|
| Supervisor (Node+TS) | ~1500 | **Stay TS** | I/O-bound, CPU ~0.1%. Kestrel не даст измеримого выигрыша. SDK только Node/TS — форк = ручная гонка за ~100 релизов/год Anthropic |
| Desktop shell (Electron main) | тонкий | **Stay** | Проблем не создаёт. Avalonia сэкономила бы ~100 МБ, но переписывание рендера = 3–6 недель |
| Renderer (React) | 1617 | **Stay, чинить данные** | Тормозил не Electron, а per-frame re-render (N1 — уже исправлено rAF-коалесценцией) |
| Protocol (zod) | 422 | **Stay TS** | STJ source-gen дал бы 2–5x на микробенчмарке, но на реальном объёме = мс/мин |
| Tunnel (ssh2) | — | **Stay** | SSH.NET эквивалентен, throughput network-bound |

## Native AOT (ответ на вопрос владельца)

| Метрика | .NET JIT | .NET AOT | Node 22 + tsx |
|---|---|---|---|
| Резидентная память | ~60–100 МБ | **~40–70 МБ** | ~150 МБ |
| Холодный старт | ~450 мс | **~50 мс** | ~2 с (tsx) |
| CPU steady-state (I/O) | ~0% | ~0% | ~0% |

**Выигрыш AOT: −50–110 МБ и −400 мс старта.** На машине с Electron-клиентом (~200 МБ), N тёплых claude-процессов (по ~250 МБ каждый) и supervisor (~150 МБ) — **округление в большую сторону**, не аргумент.

**Ловушки AOT:** весь JSON — через `JsonSerializerContext` source-gen; SSH.NET AOT-safe с апреля 2024; бинарь 10–50 МБ self-contained. Наша zod-схема (422 строк) стала бы STJ source-gen портом с двойной поддержкой навсегда.

## SDK — решающий фактор

`@anthropic-ai/claude-agent-sdk` — официальная библиотека, только TS и Python. Включает:
- стриминговый вход (`AsyncIterable<SDKUserMessage>`) — ядро engine.ts
- `canUseTool` с `updatedInput` + `updatedPermissions` — карточки разрешений
- `interrupt()`, `setModel()`, `setPermissionMode()`, `getContextUsage()`, `rewindFiles()`
- `resume`, `forkSession`, `prewarm/SpareProcess`
- ~100 релизов/год синхронизации с Claude Code v2.1.x

Коммьюнити .NET-порты: 1 звезда (print-mode only, без streaming) и 34 звезды (preview, no NuGet, tracks Python SDK v0.2.82). Оба непригодны.

## Что делать вместо (уже сделано)

1. **N1 (сделано):** rAF-коалесценция ререндера — рецепт Ink/Claude Code. 500 событий/сек → ≤60 ререндеров/сек.
2. **N2 (сделано):** `prewarm()/SpareProcess` — родная фича SDK, убирает 1–3 сек холодного старта. Это и есть «оптимизация производительности», которая стоит усилий.
3. **N6 (сделано):** benchmark 19K событий/сек подтверждает — сеть и supervisor не являются узким местом.

## Если когда-нибудь .NET понадобится

Единственный защищаемый кусок — **desktop shell на Avalonia** (один процесс, AOT-able, −100 МБ). Но только вместе с переписыванием рендера (3–6 недель), и это ничего не даёт текущей проблеме (которая уже решена).

## Источники

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) — только TS/Python
- [TS SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) — частота breaking changes
- [TechEmpower R22](https://www.techempower.com/benchmarks/#hw=ph&test=composite&section=data-r22) — aspcore top tier, но на 10k-connection HTTP, не на 1-2 client WS
- [Node spawn perf](https://blog.val.town/node-spawn-performance) — ~25 мс/spawn, нейтрализуется prewarm
- [Native AOT memory](https://blog.stackademic.com/mastering-net-native-aot-how-i-reduced-startup-time-and-memory-usage-in-production-apis-2bef4fcb5c08) — 120→55 МБ
- [MAUI Linux](https://github.com/dotnet/maui/discussions/31649) — нет Linux, team не примет
- [Avalonia vs Electron](https://avaloniaui.net/electron-compare) — 80–120 МБ vs 150–374 МБ
