// Версия supervisor'а — отдельный файл, чтобы не тянуть цикл импортов из index.
// В сборке для сервера (scripts/build-server.mjs, АДР 004) esbuild подставляет __PERIMETER_BUILD__ =
// «<версия пакета>-<хэш сборки>» — её же установщик приложения сверяет с папкой ~/.perimeter/server/<версия>.
// Из исходников (tsx) — просто версия пакета.
declare const __PERIMETER_BUILD__: string | undefined;

export const SUPERVISOR_VERSION: string = typeof __PERIMETER_BUILD__ === 'string' ? __PERIMETER_BUILD__ : '0.1.0';
