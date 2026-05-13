import { el } from '../util/dom.js';

export function renderRaw(container, ast) {
  const text = ast.sourceText || '';
  const lines = text.split(/\r?\n/);
  const gutter = el('div', { class: 'gutter' });
  const body   = el('div', { class: 'body' });
  for (let i = 0; i < lines.length; i++) {
    gutter.appendChild(document.createTextNode(String(i + 1) + '\n'));
    const span = el('span', { class: 'line' }, lines[i] === '' ? ' ' : lines[i]);
    body.appendChild(span);
  }
  const view = el('div', { class: 'raw-view' }, [gutter, body]);
  container.appendChild(view);
}
