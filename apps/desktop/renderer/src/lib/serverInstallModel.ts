// Блок «Supervisor на сервере» (настройки подключения, АДР 004): что написать и какие кнопки показать по статусу
// установщика из main (perimeter-server.sh status). Обновление — только по кнопке (решение владельца 2026-11-13).

/** Статус от main (apps/desktop/main/server-install.mjs → parseStatus + planOf). */
export interface ServerStatus {
  ok: boolean;
  message?: string;
  appVersion?: string;
  /** install — нет установки (или служба из исходников), update — другая версия, ok — та же и отвечает, restart — та же, но не отвечает */
  plan?: 'install' | 'update' | 'ok' | 'restart';
  installing?: boolean;
  /** system — вход под root, системная служба с User=; user — служба systemd самого ssh-пользователя */
  mode?: 'system' | 'user';
  sshUser?: string;
  serviceUser?: string;
  systemd?: boolean;
  /** юнит службы perimeter есть */
  unit?: boolean;
  /** юнит — установщика (запускает ~/.perimeter/server/current/start.sh) */
  managed?: boolean;
  active?: string;
  current?: string;
  previous?: string;
  /** версия, что сейчас отвечает на порту supervisor'а; пусто — никто */
  running?: string;
  /** сессий в работе (ход, карточка разрешения, вопрос) — перезапуск их прервёт */
  busy?: number;
  linger?: string;
  /** недостающие системные пакеты полного функционала (git/xvfb/gcc/make/python3) */
  packagesMissing?: string[];
  /** apt — можно поставить кнопкой; none — только команды для рук */
  pkgManager?: 'apt' | 'none';
}

/** Зачем нужен каждый системный пакет (строка предложения в блоке). */
export const PKG_WHY: Record<string, string> = {
  git: 'панель «Файлы» и клон проектов',
  xvfb: 'браузер на сервере без проверок Cloudflare',
  gcc: 'сборка node-pty — терминал с настоящим pty',
  make: 'сборка node-pty — терминал с настоящим pty',
  python3: 'сборка node-pty — терминал с настоящим pty',
};

/** Строка «не хватает» для блока: пакеты с пояснением или готовая команда для рук. */
export function packagesLine(st: ServerStatus): string | null {
  const miss = st.packagesMissing ?? [];
  if (miss.length === 0) return null;
  const why = miss.map((p) => `${p} (${PKG_WHY[p] ?? 'полный функционал'})`).join(', ');
  if (st.pkgManager === 'none') return `Не хватает: ${why}. Пакетный менеджер не apt — поставьте руками.`;
  return `Не хватает: ${why}.`;
}

export interface ServerView {
  tone: 'ok' | 'warn' | 'err' | 'dim';
  /** главная строка */
  text: string;
  /** пояснения ниже */
  notes: string[];
  /** главная кнопка: что сделает установка */
  primary?: string;
  /** кнопка отката (на previous) */
  rollback?: string;
  /** нужно имя пользователя службы (вход под root) */
  askUser: boolean;
}

export const BUSY_WARNING = (n: number): string =>
  `Идут ходы в ${n} ${n === 1 ? 'сессии' : 'сессиях'} — перезапуск службы их прервёт.`;

export function describeServer(st: ServerStatus): ServerView {
  if (!st.ok) return { tone: 'err', text: st.message ?? 'сервер не ответил', notes: [], askUser: false };
  const notes: string[] = [];
  const askUser = st.mode === 'system';
  if (st.systemd === false) {
    return { tone: 'err', text: 'На сервере нет systemd — установщик не может поставить службу.', notes, askUser: false };
  }
  const app = st.appVersion ?? '?';
  const rollback = st.managed && st.previous ? `Откатить на ${st.previous}` : undefined;
  if (st.mode === 'user' && st.managed && st.linger !== undefined && st.linger !== 'yes') {
    notes.push(`linger выключен — служба остановится после выхода из ssh. Один раз под root: loginctl enable-linger ${st.serviceUser ?? st.sshUser ?? ''}`.trim());
  }
  if ((st.busy ?? 0) > 0) notes.push(BUSY_WARNING(st.busy ?? 0));
  const view = (tone: ServerView['tone'], text: string, primary?: string): ServerView => ({
    tone, text, notes, askUser, ...(primary ? { primary } : {}), ...(rollback ? { rollback } : {}),
  });
  switch (st.plan) {
    case 'ok':
      return view('ok', `Стоит ${st.current} — та же версия, что у приложения.`);
    case 'restart':
      return view('warn', `Стоит ${st.current}, но supervisor не отвечает (служба: ${st.active || '?'}).`, 'Переустановить');
    case 'update':
      return view('warn', `На сервере ${st.current}${st.running && st.running !== st.current ? ` (отвечает ${st.running})` : ''}, у приложения ${app}.`, `Обновить до ${app}`);
    default:
      if (st.unit && !st.managed) {
        notes.unshift('Служба perimeter сейчас запущена не установщиком (из исходников). Установка переведёт её на сборку приложения; прежний юнит сохранится рядом (.before-installer).');
        return view('warn', `Служба работает${st.running ? ` (${st.running})` : ''}, но не из установщика.`, `Установить ${app}`);
      }
      return view('dim', 'Supervisor на сервере не установлен.', `Установить ${app}`);
  }
}
