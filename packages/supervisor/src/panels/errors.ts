// Ошибка панели с кодом протокола: wss превращает её в err-кадр с тем же code.
// Всё остальное (неожиданные исключения) уходит клиенту как INTERNAL.

export class PanelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PanelError';
  }
}

/** Перевод системной ошибки fs в PanelError (известные коды) или проброс как есть. */
export function fsError(err: unknown, what: string): never {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT': throw new PanelError('NOT_FOUND', `нет такого пути: ${what}`);
    case 'ENOTDIR': throw new PanelError('NOT_A_DIR', `не папка: ${what}`);
    case 'EISDIR': throw new PanelError('NOT_A_FILE', `это папка, а не файл: ${what}`);
    case 'EACCES':
    case 'EPERM': throw new PanelError('ACCESS_DENIED', `нет доступа: ${what}`);
    case 'ELOOP': throw new PanelError('OUTSIDE_ROOT', `петля символических ссылок: ${what}`);
    default: throw err;
  }
}
