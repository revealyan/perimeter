// Выбор «аккаунт · модель», усилия, ultracode и режима разрешений для сессии. Живут в поле ввода (как в Claude Code),
// меню открываются вверх. Чего у аккаунта нет (усилие у GLM, ultracode у шлюза) — того и не показываем.
import { useEffect, useState } from 'react';
import type { SessionView, SupervisorClient } from '../supervisor';
import { profileLabel } from '../supervisor';
import { onComposerAction } from '../composeBus';
import { EFFORT_LABEL, baseModelId, effectiveEffort, effortRange, effortsFor, findModel, isLong, modelChoices, ultracodeAllowed, type EffortLevel, type ModelChoice } from '../lib/modelsModel';
import { hiddenModels, splitVisible } from '../lib/modelVisibility';
import { Icon } from './Icon';
import { usePopover } from './ui';

export const MODES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'default', label: 'Спрашивать', hint: 'каждое действие — с разрешения' },
  { id: 'acceptEdits', label: 'Правки без спроса', hint: 'файлы правит сам, команды — с разрешения' },
  { id: 'plan', label: 'План', hint: 'только читает и предлагает план' },
  { id: 'auto', label: 'Авто', hint: 'классификатор решает сам; на шлюзах (z.ai) может отказывать в действиях — тогда «Правки без спроса»' },
  { id: 'bypassPermissions', label: 'Без ограничений', hint: 'никаких вопросов вообще — опасно: rm -rf и push пройдут молча' },
];

export function modeLabel(id: string | undefined): string {
  return MODES.find((m) => m.id === id)?.label ?? id ?? '—';
}

function isBusy(s: SessionView): boolean {
  return s.state === 'working' || s.state === 'waiting_permission' || s.state === 'waiting_input';
}

function profileOf(session: SessionView, client: SupervisorClient) {
  return client.profiles.find((p) => p.name === (session.profile ?? ''));
}

/**
 * Переключатели работают и в черновике новой сессии (сессии ещё нет): тогда вместо команды supervisor'у
 * зовётся onPick/onToggle, а «сессия» — просто текущий выбор черновика.
 */
export function ModelPicker({ session, client, onPick }: { session: SessionView; client: SupervisorClient; onPick?: (profile: string, model: string) => void }) {
  const pop = usePopover();
  // «сменить модель» из карточки ошибки хода — открыть этот выбор
  useEffect(() => onComposerAction((a) => { if (a === 'open-model') { setFlipped(new Set()); pop.setOpen(true); } }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [customModel, setCustomModel] = useState('');
  const [otherOpen, setOtherOpen] = useState<Set<string>>(() => new Set());
  // группы аккаунтов: развёрнут аккаунт сессии, остальные свёрнуты до заголовка; здесь — какие пользователь переключил
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const single = client.profiles.length <= 1;
  const currentProfile = session.profile ?? '';
  const currentProfileInfo = profileOf(session, client);
  // сессия может знать модель с [1m] (как её запустили) — в списке аккаунта она без суффикса
  const currentModel = baseModelId(session.model ?? '');

  const pick = (profile: string, model: string) => {
    pop.setOpen(false);
    if (onPick) { onPick(profile, model); return; }
    if (profile !== currentProfile && isBusy(session)) {
      client.showError('Аккаунт меняется только между ходами — дождитесь конца хода или нажмите «Стоп»');
      return;
    }
    if (profile === currentProfile && model === currentModel) return;
    void client.setSessionSettings(session.id, {
      ...(profile !== currentProfile ? { profile } : {}),
      ...(model !== currentModel ? { model } : {}),
    });
  };
  const curLabel = `${findModel(currentProfileInfo, currentModel)?.label ?? (currentModel || 'модель по умолчанию')}${currentModel && isLong(currentProfileInfo, currentModel) ? ' · 1M' : ''}`;
  const text = `${currentProfileInfo ? `${profileLabel(currentProfileInfo)} · ` : ''}${curLabel}`;

  return (
    <div className="picker up" ref={pop.ref}>
      <button className="hbtn" onClick={() => { if (!pop.open) setFlipped(new Set()); pop.setOpen(!pop.open); }} aria-haspopup="menu" aria-expanded={pop.open} data-tip={`Аккаунт и модель: ${text}`}>
        <Icon name="bot" /><span className="hbtn-label">{text}</span><Icon name="chevronDown" size={14} className="hbtn-chev" />
      </button>
      {pop.open && (
        <div className="menu picker-menu" role="menu">
          {client.profiles.map((p) => {
            const { shown, other } = splitVisible(modelChoices(p), hiddenModels(client.environment, p.name), p.name === currentProfile ? currentModel : undefined);
            const item = (m: ModelChoice) => {
              const cur = p.name === currentProfile && m.id === currentModel;
              return (
                <button key={m.id} role="menuitemradio" aria-checked={cur} className="menu-2line" onClick={() => pick(p.name, m.id)}>
                  <span>
                    <b>{m.label ?? m.id}{isLong(p, m.id) && !/\[1m\]$/i.test(m.id) ? <span className="dim"> · 1M</span> : null}</b>
                    {m.description
                      ? <span className="menu-hint">{m.description}</span>
                      : <span className="menu-hint mono">{m.label ? m.id : ''}{m.efforts !== undefined && p.models ? `${m.label ? ' · ' : ''}${effortRange(m.efforts)}` : ''}</span>}
                  </span>
                  {cur && <Icon name="check" size={14} />}
                </button>
              );
            };
            const open = otherOpen.has(p.name);
            const groupOpen = single || (p.name === currentProfile) !== flipped.has(p.name);
            const title = (
              <>
                {profileLabel(p)}{p.auth?.loggedIn === false
                  ? <span className="warn-text"> · не вошёл — Настройки → Аккаунты → «Войти»</span>
                  : p.description ? <span className="dim"> · {p.description}</span> : null}
              </>
            );
            return (
              <div key={p.name} className="menu-group">
                {single
                  ? <div className="menu-title">{title}</div>
                  : (
                    <button
                      className="menu-gtoggle"
                      aria-expanded={groupOpen}
                      onClick={() => setFlipped((s) => { const n = new Set(s); if (n.has(p.name)) n.delete(p.name); else n.add(p.name); return n; })}
                    >
                      <Icon name={groupOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                      <span className="menu-gtitle">{title}</span>
                      {!groupOpen && <span className="dim">{shown.length + other.length}</span>}
                    </button>
                  )}
                {groupOpen && shown.map(item)}
                {groupOpen && other.length > 0 && (
                  <button
                    className="menu-more"
                    aria-expanded={open}
                    onClick={() => setOtherOpen((s) => { const n = new Set(s); if (n.has(p.name)) n.delete(p.name); else n.add(p.name); return n; })}
                    data-tip="Модели, скрытые в настройках подключения"
                  >
                    <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} /> Другие модели <span className="dim">{other.length}</span>
                  </button>
                )}
                {groupOpen && open && <div className="menu-sub">{other.map(item)}</div>}
              </div>
            );
          })}
          <div className="menu-group">
            <div className="menu-title">Своя модель</div>
            <form className="picker-custom" onSubmit={(e) => { e.preventDefault(); if (customModel.trim()) pick(currentProfile, customModel.trim()); }}>
              <input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="имя или glm-5.3@400k" data-tip="Любая модель по имени; с @400k — с окном контекста 400K" />
              <button className="btn sm" type="submit" disabled={!customModel.trim()}>ОК</button>
            </form>
          </div>
          <div className="menu-note">Модели аккаунтов — в настройках (Ctrl+,)</div>
        </div>
      )}
    </div>
  );
}

/** Усилие: только если у модели сессии оно настраивается. Меняется на лету — со следующего сообщения. */
export function EffortPicker({ session, client, onPick }: { session: SessionView; client: SupervisorClient; onPick?: (e: EffortLevel | null) => void }) {
  const pop = usePopover();
  const profile = profileOf(session, client);
  const levels = effortsFor(profile, session.model);
  if (levels.length === 0) return null;
  const eff = effectiveEffort(session.effort, profile, levels);
  const pick = (e: EffortLevel | null) => {
    pop.setOpen(false);
    if ((e ?? undefined) === session.effort) return;
    if (onPick) { onPick(e); return; }
    void client.setSessionSettings(session.id, { effort: e });
  };
  const text = eff ? EFFORT_LABEL[eff] : 'по умолчанию';
  return (
    <div className="picker up" ref={pop.ref}>
      <button className="hbtn" onClick={() => pop.setOpen(!pop.open)} aria-haspopup="menu" aria-expanded={pop.open} data-tip={`Усилие: ${text}`}>
        <Icon name="gauge" /><span className="hbtn-label">усилие: {text}</span><Icon name="chevronDown" size={14} className="hbtn-chev" />
      </button>
      {pop.open && (
        <div className="menu picker-menu effort-menu" role="menu">
          <div className="menu-title">Усилие{session.model ? <span className="dim"> · {session.model}</span> : null}</div>
          <button role="menuitemradio" aria-checked={session.effort === undefined} className="menu-2line" onClick={() => pick(null)}>
            <span><b>По умолчанию</b><span className="menu-hint">{profile?.defaultEffort && levels.includes(profile.defaultEffort) ? `как в аккаунте — ${EFFORT_LABEL[profile.defaultEffort]}` : 'решает модель'}</span></span>
            {session.effort === undefined && <Icon name="check" size={14} />}
          </button>
          {levels.map((l) => (
            <button key={l} role="menuitemradio" aria-checked={session.effort === l} onClick={() => pick(l)}>
              <span>{EFFORT_LABEL[l]}</span>{session.effort === l && <Icon name="check" size={14} />}
            </button>
          ))}
          <div className="menu-note">Чем выше, тем дольше думает и дороже ход. Меняется на лету, со следующего сообщения.</div>
        </div>
      )}
    </div>
  );
}

/** ultracode: агент раздаёт работу субагентам. Кнопки нет, если аккаунту он запрещён (например, GLM). */
export function UltracodeToggle({ session, client, onToggle }: { session: SessionView; client: SupervisorClient; onToggle?: (on: boolean) => void }) {
  const profile = profileOf(session, client);
  if (!ultracodeAllowed(profile)) return null;
  const on = session.ultracode === true;
  return (
    <button
      className={`hbtn ultracode ${on ? 'on' : ''}`}
      aria-pressed={on}
      data-tip={on ? 'ultracode включён: агент раздаёт работу субагентам — дольше и дороже. Нажмите, чтобы выключить' : 'ultracode: агент раздаёт работу субагентам (для больших задач)'}
      onClick={() => (onToggle ? onToggle(!on) : void client.setSessionSettings(session.id, { ultracode: !on }))}
    >
      <Icon name="sparkles" /><span className="hbtn-label">ultracode</span>
    </button>
  );
}

export function ModePicker({ session, client, onPick }: { session: SessionView; client: SupervisorClient; onPick?: (mode: string) => void }) {
  const pop = usePopover();
  const cur = MODES.find((m) => m.id === session.permissionMode);
  return (
    <div className="picker up" ref={pop.ref}>
      <button className="hbtn" onClick={() => pop.setOpen(!pop.open)} aria-haspopup="menu" aria-expanded={pop.open} data-tip={`Режим: ${modeLabel(session.permissionMode)} — ${cur?.hint ?? ''}`}>
        <Icon name="pencil" /><span className="hbtn-label">{session.permissionMode ? modeLabel(session.permissionMode) : 'Режим'}</span><Icon name="chevronDown" size={14} className="hbtn-chev" />
      </button>
      {pop.open && (
        <div className="menu picker-menu" role="menu">
          {MODES.map((m) => {
            const on = (session.permissionMode ?? 'acceptEdits') === m.id;
            return (
              <button key={m.id} role="menuitemradio" aria-checked={on} className="menu-2line" onClick={() => { pop.setOpen(false); if (on) return; if (onPick) onPick(m.id); else void client.setSessionSettings(session.id, { permissionMode: m.id }); }}>
                <span><b>{m.label}</b><span className="menu-hint">{m.hint}</span></span>
                {on && <Icon name="check" size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
