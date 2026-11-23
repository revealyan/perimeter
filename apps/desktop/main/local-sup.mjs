// Жизненный цикл локального supervisor'а (среда «Этот компьютер»): подготовка (докачка движка в packaged) → процесс
// на :8791 → статус строкой в окно.
//
// 23.11 (v0.2.0) статус «моргал» бесконечно: окно на КАЖДОЕ изменение статуса снова просило «запустить», все такие
// вызовы ждали одну и ту же докачку — и по её окончании каждый запускал свой процесс. Первый занимал порт, остальные
// падали (EADDRINUSE), а выход упавшего дубля обнулял ссылку на живой процесс и писал «упал» → снова «запустить»…
// Здесь: один запуск за раз (повторные ждут его же), события процесса учитываются только от текущего процесса,
// «стоп» во время подготовки отменяет запуск.

export class LocalSupervisor {
  /**
   * @param {{
   *   prepare: (onStatus: (s: string) => void) => Promise<{ args: string[]; cwd: string; env: Record<string, string> }>,
   *   spawnProc: (args: string[], cwd: string, env: Record<string, string>) => import('node:child_process').ChildProcess,
   *   killTree: (child: import('node:child_process').ChildProcess) => void,
   *   onStatus?: (s: string) => void,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.proc = null;
    this.status = 'не запущен';
    this.starting = null;
    this.wanted = false;
    this.lastErr = '';
  }

  set(s) {
    this.status = s;
    this.deps.onStatus?.(s);
  }

  /** Запустить, если не запущен; повторный вызов во время запуска — ждёт тот же запуск. */
  start() {
    this.wanted = true;
    if (this.proc) return Promise.resolve(this.status);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      let launch;
      try {
        launch = await this.deps.prepare((s) => this.set(s));
      } catch (e) {
        this.set(`движок не установился: ${String(e?.message ?? e).slice(0, 140)}`);
        return this.status;
      }
      // пока готовились, попросили остановить — не запускаем
      if (!this.wanted || this.proc) return this.status;
      this.spawn(launch);
      return this.status;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  spawn({ args, cwd, env }) {
    this.lastErr = '';
    const child = this.deps.spawnProc(args, cwd, env);
    this.proc = child;
    const current = () => this.proc === child;
    child.stdout?.on('data', (d) => { if (current() && String(d).includes('ws://')) this.set('запущен'); });
    // stderr — не обязательно ошибка (предупреждения Node); показываем только при падении
    child.stderr?.on('data', (d) => { if (current()) this.lastErr = String(d).trim().split(/\r?\n/).pop()?.slice(0, 160) ?? ''; });
    child.on('error', (err) => {
      if (!current()) return;
      this.proc = null;
      this.set(`ошибка запуска: ${String(err?.message ?? err).slice(0, 120)}`);
    });
    child.on('exit', (code) => {
      if (!current()) return; // остановленный или чужой процесс — статус текущего не трогаем
      this.proc = null;
      this.set(code === 0 || code === null ? 'остановлен' : `упал (код ${code})${this.lastErr ? `: ${this.lastErr}` : ''}`);
    });
    this.set('запускается…');
  }

  /** Остановить (и отменить идущий запуск). */
  stop() {
    this.wanted = false;
    const child = this.proc;
    if (!child) {
      if (this.starting) this.set('остановлен');
      return;
    }
    this.proc = null;
    this.deps.killTree(child);
    this.set('остановлен');
  }
}
