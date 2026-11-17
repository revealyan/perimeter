// Шапка сессии (BD2): проект / имя, бейдж статуса; справа — мини-иконки панелей и «Перенести → …» (пока неактивно).
// Выбор «аккаунт · модель» и режима переехал в поле ввода (SessionPickers) — как в Claude Code.
import type { SessionView, SupervisorClient } from '../supervisor';
import { envLabel } from '../supervisor';
import type { PanelTab } from '../lib/panelLayout';
import { STATE_LABEL } from './labels';
import { Icon, type IconName } from './Icon';
import { ProjectTag } from './ui';

// режимы и их подписи нужны и вне поля ввода (создание сессии, сводка, строка статуса)
export { MODES, modeLabel } from './SessionPickers';

/** Мини-иконки панелей: подписи и клавиши — одни на шапку, панель и меню. */
export const PANEL_META: Record<PanelTab, { icon: IconName; label: string; key?: string }> = {
  changes: { icon: 'diff', label: 'Изменения', key: 'Ctrl Shift D' },
  terminal: { icon: 'terminal', label: 'Терминал', key: 'Ctrl `' },
  files: { icon: 'folder', label: 'Файлы', key: 'Ctrl Shift E' },
  browser: { icon: 'globe', label: 'Браузер', key: 'Ctrl Shift B' },
  ports: { icon: 'plug2', label: 'Порты' },
  tasks: { icon: 'listChecks', label: 'Задачи', key: 'Ctrl Shift T' },
  context: { icon: 'gauge', label: 'Контекст' },
};
const HEADER_TABS: PanelTab[] = ['changes', 'terminal', 'files', 'browser', 'ports', 'tasks'];

export function SessionHeader({ session, client, projectName, panelOpen, panelTab, hasChanges, onTab, onTogglePanel }: {
  session: SessionView;
  client: SupervisorClient;
  projectName?: string | undefined;
  panelOpen: boolean;
  panelTab: PanelTab;
  hasChanges: boolean;
  onTab: (t: PanelTab) => void;
  onTogglePanel: () => void;
}) {

  return (
    <header className="topbar">
      <div className="topbar-title">
        <span className="topbar-project"><ProjectTag name={projectName} /></span>
        <span className="topbar-slash">/</span>
        <span className="topbar-name" title={session.name}>{session.name}</span>
        <span className={`badge st-${session.state}`} data-tip={STATE_LABEL[session.state] ?? session.state}><span className="badge-dot" /><span className="badge-text">{STATE_LABEL[session.state] ?? session.state}</span></span>
      </div>
      <div className="topbar-controls">
        <div className="icon-group" role="toolbar" aria-label="Панели">
          {HEADER_TABS.map((t) => {
            const m = PANEL_META[t];
            const on = panelOpen && panelTab === t;
            return (
              <button key={t} className={`icon-btn ${on ? 'on' : ''}`} aria-pressed={on} aria-label={m.label} data-tip={m.label} {...(m.key ? { 'data-key': m.key } : {})} onClick={() => onTab(t)}>
                <Icon name={m.icon} />
                {t === 'changes' && hasChanges && <span className="icon-dot" />}
              </button>
            );
          })}
          <span className="icon-sep" />
          <button className={`icon-btn panel-toggle ${panelOpen ? 'on' : ''}`} aria-pressed={panelOpen} aria-label="Панель" data-tip={panelOpen ? 'Скрыть панель' : 'Показать панель'} data-key="Ctrl \" onClick={onTogglePanel}>
            <Icon name="panelRight" />
          </button>
        </div>
        <button className="hbtn transfer is-disabled" aria-disabled="true" data-tip="Перенос сессии в другое подключение — следующий шаг (нужен export/import на supervisor)">
          <Icon name="arrowLeftRight" /><span className="hbtn-label">Перенести</span>
        </button>
      </div>
    </header>
  );
}
