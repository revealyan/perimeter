// Запрос разрешения и вопросы агента в терминальной манере (BD2): промпт с клавишами Y / N / A.
// Команда в промпте показывается всегда целиком — человек должен видеть, что разрешает.
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { PermissionCard, SessionView, SupervisorClient } from '../supervisor';
import { editPatch, shortPath, toolHead } from '../lib/toolFormat';
import { askTitle } from '../lib/sessionGroups';
import { lineSummary, moreLines } from '../lib/multiline';
import { countOf } from '../lib/ru';
import { DiffView } from './DiffView';
import { FullText } from './ui';

/** «ждёт 2 мин» — обновляется сама. */
export function useAge(at: number): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? 'только что' : `${Math.floor(s / 60)} мин`;
}

/** ← → — по кнопкам промпта (Enter/пробел нажимают кнопку в фокусе сами). */
function arrowNav(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([aria-disabled="true"])')];
  const i = btns.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length]?.focus();
}

export function AskPrompt({ card, sid, client, compact }: { card: PermissionCard; sid: string; client: SupervisorClient; compact?: boolean }) {
  const age = useAge(card.at);
  if (card.questions?.length) return <QuestionsPrompt card={card} sid={sid} client={client} age={age} />;
  const head = toolHead(card.toolName, card.input);
  // правка файла: что именно поменяется — до разрешения
  const patch = editPatch(card.toolName, card.input, undefined);
  return (
    <div className="block prompt" role="group" aria-label="запрос разрешения">
      <div className="prompt-head">
        <span className="dot dot-amber" />
        <b>{askTitle(card.toolName)}</b>
        <span className="mono dim">{card.toolName}</span>
        <span className="spacer" />
        <span className="warn-text">ждёт {age}</span>
      </div>
      {patch
        ? <DiffView patch={patch} allowSplit={!compact} head={<span className="mono">{shortPath(patch.path, 3)} <span className="add">+{patch.added}</span> <span className="del">−{patch.removed}</span></span>} />
        : head.target !== '' && <FullText text={head.target} {...(card.toolName === 'Bash' ? { prefix: '$' } : {})} className="prompt-cmd" />}
      {head.note && <div className="prompt-note">{head.note}</div>}
      <div className="prompt-actions" onKeyDown={arrowNav}>
        <button className="btn primary" onClick={() => client.respondPermission(sid, card.requestId, 'allow')} data-tip="Разрешить" data-key="Y">
          <span className="kbd-tag">[Y]</span> Разрешить
        </button>
        <button className="btn ghost" onClick={() => client.respondPermission(sid, card.requestId, 'deny')} data-tip="Отклонить" data-key="N">
          <span className="kbd-tag err">[N]</span> Отклонить
        </button>
        <button className="btn ghost" onClick={() => client.alwaysAllowTool(sid, card.requestId, card.toolName)} data-tip={`Разрешить и не спрашивать ${card.toolName} до конца этой сессии (в новые сессии правило не переезжает)`} data-key="A">
          <span className="kbd-tag">[A]</span> Дальше не спрашивать ({card.toolName})
        </button>
        <span className="spacer" />
        <span className="key-hints" data-tip="Y / N / A работают, когда курсор не в поле ввода">
          <kbd>←</kbd><kbd>→</kbd> выбор <kbd>Enter</kbd> подтвердить
        </span>
      </div>
    </div>
  );
}

function QuestionsPrompt({ card, sid, client, age }: { card: PermissionCard; sid: string; client: SupervisorClient; age: string }) {
  const questions = card.questions ?? [];
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((p) => {
      const cur = p[qi] ?? [];
      const next = multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
      return { ...p, [qi]: next };
    });
  };
  const answerOf = (qi: number): string => {
    const o = (other[qi] ?? '').trim();
    return [...(picked[qi] ?? []), ...(o ? [o] : [])].join(', ');
  };
  const ready = questions.every((_, qi) => answerOf(qi) !== '');
  const submit = () => {
    if (!ready) return;
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => { answers[q.question] = answerOf(qi); });
    client.answerQuestions(sid, card, answers);
  };
  // один вопрос с одиночным выбором — отвечаем сразу кликом
  const instant = questions.length === 1 && !questions[0]!.multiSelect;

  return (
    <div className="block prompt question" role="group" aria-label="вопрос агента">
      <div className="prompt-head">
        <span className="dot dot-amber" />
        <b>{questions.length > 1 ? `Агент спрашивает · ${countOf(questions.length, ['вопрос', 'вопроса', 'вопросов'])}` : 'Агент спрашивает'}</b>
        <span className="spacer" />
        <span className="warn-text">ждёт {age}</span>
      </div>
      {questions.map((q, qi) => (
        <fieldset key={qi} className="q-block">
          <legend><span className="q-chip">{q.header}</span> {q.question}{q.multiSelect && <span className="dim"> · можно несколько</span>}</legend>
          <div className="q-options" onKeyDown={arrowNav}>
            {q.options.map((o, oi) => {
              const on = (picked[qi] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  className={`q-option ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => {
                    if (instant) client.answerQuestions(sid, card, { [q.question]: o.label });
                    else toggle(qi, o.label, q.multiSelect === true);
                  }}
                >
                  <span className="q-mark mono" aria-hidden>{q.multiSelect ? (on ? '[x]' : '[ ]') : `[${oi + 1}]`}</span>
                  <span className="q-label">{o.label}</span>
                  {o.description && <span className="q-desc">{o.description}</span>}
                </button>
              );
            })}
            <input
              className="q-other"
              placeholder="свой вариант…"
              value={other[qi] ?? ''}
              onChange={(e) => setOther((p) => ({ ...p, [qi]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !(other[qi] ?? '').trim()) return;
                if (instant) client.answerQuestions(sid, card, { [q.question]: (other[qi] ?? '').trim() });
                else if (ready) submit();
              }}
            />
          </div>
        </fieldset>
      ))}
      <div className="prompt-actions">
        {!instant && <button className="btn primary" disabled={!ready} onClick={submit}>Ответить</button>}
        <button className="btn ghost" onClick={() => client.respondPermission(sid, card.requestId, 'deny')}>Не отвечать</button>
      </div>
    </div>
  );
}

/** Плашка внизу «на весь экран»: ждущее не теряется, пока лента скрыта. */
export function PendingBar({ session, client, onOpenFeed }: { session: SessionView; client: SupervisorClient; onOpenFeed: () => void }) {
  const card = session.permissions[0];
  if (!card) return null;
  const isQ = (card.questions?.length ?? 0) > 0;
  const target = lineSummary(toolHead(card.toolName, card.input).target);
  return (
    <div className="pending-bar" role="status">
      <span className="dot dot-amber" />
      <b>{session.name}</b>
      <span className="warn-text">{isQ ? 'ждёт ответа на вопрос' : 'ждёт разрешения'}</span>
      {!isQ && target.first && <span className="pending-cmd mono">{target.first}{target.extra > 0 && <span className="dim"> {moreLines(target.extra)}</span>}</span>}
      {isQ && <span className="pending-cmd">«{card.questions![0]!.question}»</span>}
      <span className="spacer" />
      {!isQ && (
        <>
          <button className="btn primary sm" onClick={() => client.respondPermission(session.id, card.requestId, 'allow')} data-tip="Команда целиком — в ленте" data-key="Y"><span className="kbd-tag">[Y]</span> Разрешить</button>
          <button className="btn ghost sm" onClick={() => client.respondPermission(session.id, card.requestId, 'deny')} data-key="N" data-tip="Отклонить"><span className="kbd-tag err">[N]</span></button>
        </>
      )}
      <button className="btn ghost sm" onClick={onOpenFeed} data-key="Esc" data-tip="Свернуть панель и открыть ленту">Открыть ленту</button>
    </div>
  );
}
