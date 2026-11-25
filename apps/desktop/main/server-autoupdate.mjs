// Supervisor на серверах — за приложением (владелец 2026-11-25: «как-то обновление организовать»): приложение
// обновилось → при подключении к серверу, где стоит прошлая версия, обновляем её сами, когда нет идущих ходов
// (идут — ждём и пробуем снова). Только там, где supervisor поставлен установщиком: первую установку делает человек.
// Только в packaged-приложении: в разработке сборка — из рабочих исходников, их правят параллельные сессии.

const RETRY_BUSY_MS = 2 * 60_000;
const MAX_BUSY_RETRIES = 30; // ~час ожидания конца ходов

export class ServerAutoUpdate {
  /**
   * @param {{ installer: { status: (c: object) => Promise<any>, install: (c: object, onLine?: (l: string) => void) => Promise<any> },
   *           config: (id: string) => object, enabled: () => boolean, packaged: boolean,
   *           onEvent: (e: { connId: string, state: 'waiting' | 'updating' | 'done' | 'failed', message?: string, version?: string }) => void,
   *           onLine?: (connId: string, line: string) => void, setTimer?: typeof setTimeout, settleMs?: number }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.up = new Set();
    /** connId@версия приложения — уже обновляли (или решили не трогать) в этом запуске */
    this.handled = new Set();
    this.running = new Set();
  }

  /** Список подключений из ConnectionManager: поднялось — проверить (с паузой, пусть туннель устоится). */
  onConnections(list) {
    for (const c of list) {
      const isUp = c.enabled && c.status === 'подключён';
      if (isUp && !this.up.has(c.id)) (this.deps.setTimer ?? setTimeout)(() => void this.check(c.id), this.deps.settleMs ?? 5000);
      if (isUp) this.up.add(c.id); else this.up.delete(c.id);
    }
  }

  async check(id, attempt = 0) {
    if (!this.deps.packaged || !this.deps.enabled() || this.running.has(id) || !this.up.has(id)) return;
    let conn;
    try { conn = this.deps.config(id); } catch { return; }
    this.running.add(id);
    try {
      const st = await this.deps.installer.status(conn);
      if (!st?.ok || !st.managed || st.plan !== 'update') return;
      const key = `${id}@${st.appVersion}`;
      if (this.handled.has(key)) return;
      if ((st.busy ?? 0) > 0) {
        if (attempt === 0) this.deps.onEvent({ connId: id, state: 'waiting', version: st.appVersion, message: 'в сессиях идут ходы — обновлю supervisor, когда закончатся' });
        if (attempt < MAX_BUSY_RETRIES) (this.deps.setTimer ?? setTimeout)(() => void this.check(id, attempt + 1), RETRY_BUSY_MS);
        return;
      }
      this.handled.add(key);
      this.deps.onEvent({ connId: id, state: 'updating', version: st.appVersion });
      const r = await this.deps.installer.install(conn, (line) => this.deps.onLine?.(id, line));
      this.deps.onEvent({ connId: id, state: r?.ok ? 'done' : 'failed', version: st.appVersion, message: String(r?.message ?? '') });
    } catch (e) {
      this.deps.onEvent({ connId: id, state: 'failed', message: String(e?.message ?? e) });
    } finally {
      this.running.delete(id);
    }
  }
}
