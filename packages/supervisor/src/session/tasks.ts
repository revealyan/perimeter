// Список задач, как в Claude Code Desktop: инструменты TaskCreate/TaskUpdate/TaskList/TaskGet.
// В режиме SDK Claude Code включает их только старым моделям (claude-*-4-x и раньше), явное перечисление
// в allowedTools — любой модели (проверено подставным шлюзом 23.11).
export const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'] as const;
