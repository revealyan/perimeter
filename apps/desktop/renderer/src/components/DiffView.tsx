// Диф правки: «Построчно» / «Рядом» + тумблер «Мутации» (подсветка изменённых слов внутри строки).
// Режим общий на всё приложение и запоминается (localStorage), меняется из шапки любого дифа.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Patch } from '../lib/toolFormat';
import { splitRows, withMutations, type MutLine, type Seg } from '../lib/diffModes';

type Layout = 'unified' | 'split';
interface Prefs { layout: Layout; words: boolean }

const EVENT = 'perimeter:diff-prefs';
function readPrefs(): Prefs {
  return {
    layout: localStorage.getItem('perimeter:diff-layout') === 'split' ? 'split' : 'unified',
    words: localStorage.getItem('perimeter:diff-words') !== 'off',
  };
}
function usePrefs(): [Prefs, (p: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  useEffect(() => {
    const h = () => setPrefs(readPrefs());
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
  const update = (p: Partial<Prefs>) => {
    if (p.layout) localStorage.setItem('perimeter:diff-layout', p.layout);
    if (p.words !== undefined) localStorage.setItem('perimeter:diff-words', p.words ? 'on' : 'off');
    window.dispatchEvent(new Event(EVENT));
  };
  return [prefs, update];
}

function Text({ line, words }: { line: MutLine; words: boolean }) {
  if (!words || !line.segs) return <span className="diff-text">{line.text || ' '}</span>;
  const kind = line.sign === '+' ? 'add' : 'del';
  return (
    <span className="diff-text">
      {line.segs.map((s: Seg, i) => (s.changed ? <mark key={i} className={`diff-word ${kind}`}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </span>
  );
}

function Cell({ line, side, words }: { line: MutLine | undefined; side: 'left' | 'right'; words: boolean }) {
  if (!line) return <div className="diff-cell empty"><span className="diff-no" /><span className="diff-text"> </span></div>;
  const cls = line.sign === '+' ? 'add' : line.sign === '-' ? 'del' : '';
  const no = side === 'left' ? line.oldNo : line.newNo;
  return (
    <div className={`diff-cell ${cls}`}>
      <span className="diff-no">{no ?? ''}</span>
      <Text line={line} words={words} />
    </div>
  );
}

/**
 * head — заголовок слева в шапке дифа (файл, счётчики); allowSplit=false — «Рядом» не влезет
 * (узкая лента при открытой панели): показываем построчно, кнопка неактивна.
 */
export function DiffView({ patch, head, allowSplit = true, className }: { patch: Patch; head?: ReactNode; allowSplit?: boolean; className?: string }) {
  const [prefs, setPrefs] = usePrefs();
  const hunks = useMemo(() => withMutations(patch.hunks), [patch]);
  const isNewFile = patch.removed === 0 && hunks.every((h) => h.lines.every((l) => l.sign === '+'));
  const splitOff = isNewFile || !allowSplit;
  const split = prefs.layout === 'split' && !splitOff;

  return (
    <div className={`diff ${className ?? ''}`}>
      <div className="diff-toolbar">
        {head && <div className="diff-head">{head}</div>}
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Вид дифа">
          <button className={!split ? 'on' : ''} aria-pressed={!split} onClick={() => setPrefs({ layout: 'unified' })}>Построчно</button>
          <button
            className={`${split ? 'on' : ''} ${splitOff ? 'is-disabled' : ''}`}
            aria-pressed={split}
            aria-disabled={splitOff}
            onClick={() => { if (!splitOff) setPrefs({ layout: 'split' }); }}
            data-tip={isNewFile ? 'Новый файл — сравнивать не с чем' : !allowSplit ? 'Тесно — откройте диф в панели «Изменения»' : 'Было | стало'}
          >Рядом</button>
        </div>
        <button
          className={`chip-toggle ${prefs.words ? 'on' : ''}`}
          aria-pressed={prefs.words}
          data-tip="Подсвечивать изменённые слова внутри строки"
          onClick={() => setPrefs({ words: !prefs.words })}
        >Мутации</button>
      </div>
      {hunks.map((h, hi) => (
        <div key={hi} className="diff-hunk">
          {hunks.length > 1 && <div className="diff-hunk-head">@@ −{h.oldStart} +{h.newStart} @@</div>}
          {split
            ? splitRows(h).map((r, i) => (
                <div key={i} className="diff-split-row">
                  <Cell line={r.left} side="left" words={prefs.words} />
                  <Cell line={r.right} side="right" words={prefs.words} />
                </div>
              ))
            : h.lines.map((l, i) => (
                <div key={i} className={`diff-line ${l.sign === '+' ? 'add' : l.sign === '-' ? 'del' : ''}`}>
                  <span className="diff-no">{l.sign === '+' ? '' : l.oldNo ?? ''}</span>
                  <span className="diff-no">{l.sign === '-' ? '' : l.newNo ?? ''}</span>
                  <span className="diff-sign">{l.sign === ' ' ? '' : l.sign === '-' ? '−' : '+'}</span>
                  <Text line={l} words={prefs.words} />
                </div>
              ))}
        </div>
      ))}
    </div>
  );
}
