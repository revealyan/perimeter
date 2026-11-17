// Рендер маркдауна ответов агента: блоки из lib/markdown, подсветка кода highlight.js.
import { useState, type ReactNode } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import yaml from 'highlight.js/lib/languages/yaml';
import markdownLang from 'highlight.js/lib/languages/markdown';
import { inlineTokens, parseMarkdown, safeHref, type MdBlock } from '../lib/markdown';

for (const [name, lang] of Object.entries({
  bash, typescript, javascript, json, python, xml, css, csharp, go, rust, yaml, markdown: markdownLang,
})) {
  hljs.registerLanguage(name, lang);
}
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs'], { languageName: 'javascript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['cs'], { languageName: 'csharp' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

const CODE_PREVIEW_LINES = 24;

/** HTML подсветки (highlight.js экранирует исходник); null — язык не знаем или подсветка упала. */
export function highlightCode(code: string, lang: string | undefined): string | null {
  if (!lang || !hljs.getLanguage(lang)) return null;
  try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { return null; }
}

export function CodeBlock({ code, lang, collapsible = false }: { code: string; lang?: string; collapsible?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [all, setAll] = useState(false);
  const lines = code.split('\n');
  const long = collapsible && lines.length > CODE_PREVIEW_LINES;
  const shown = long && !all ? lines.slice(0, CODE_PREVIEW_LINES).join('\n') : code;
  const highlighted = highlightCode(shown, lang);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || 'текст'}</span>
        <button className="code-copy" onClick={copy}>{copied ? 'скопировано' : 'копировать'}</button>
      </div>
      {/* highlight.js экранирует исходник — вставка его HTML безопасна */}
      {highlighted !== null
        ? <pre dangerouslySetInnerHTML={{ __html: highlighted }} />
        : <pre>{shown}</pre>}
      {long && <button className="link-btn code-more" onClick={() => setAll(!all)}>{all ? 'свернуть' : `ещё ${lines.length - CODE_PREVIEW_LINES} строк`}</button>}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  inlineTokens(text).forEach((tok, k) => {
    switch (tok.t) {
      case 'text': out.push(tok.v); break;
      case 'code': out.push(<code key={k} className="inline-code">{tok.v}</code>); break;
      case 'b': out.push(<strong key={k}>{tok.v}</strong>); break;
      case 'i': out.push(<em key={k}>{tok.v}</em>); break;
      case 's': out.push(<s key={k}>{tok.v}</s>); break;
      case 'a': {
        const href = safeHref(tok.href);
        out.push(href ? <a key={k} href={href} target="_blank" rel="noreferrer">{tok.v}</a> : <span key={k}>{tok.v}</span>);
        break;
      }
    }
  });
  return <>{out}</>;
}

function Block({ b }: { b: MdBlock }) {
  switch (b.t) {
    case 'p': return <p>{b.text.split('\n').map((l, i, arr) => <span key={i}><Inline text={l} />{i < arr.length - 1 && <br />}</span>)}</p>;
    case 'h': {
      const Tag = (`h${Math.min(b.level + 2, 6)}`) as 'h3';
      return <Tag className={`md-h md-h${b.level}`}><Inline text={b.text} /></Tag>;
    }
    case 'ul': return <ul>{b.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</ul>;
    case 'ol': return <ol start={b.start}>{b.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</ol>;
    case 'quote': return <blockquote><Markdown text={b.text} /></blockquote>;
    case 'code': return <CodeBlock code={b.text} {...(b.lang ? { lang: b.lang } : {})} />;
    case 'hr': return <hr />;
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{b.head.map((c, i) => <th key={i}><Inline text={c} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}><Inline text={c} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  return <div className="md">{parseMarkdown(text).map((b, i) => <Block key={i} b={b} />)}</div>;
}
