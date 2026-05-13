import { el } from '../util/dom.js';

function indentOf(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line[i] === undefined ? -1 : i;   // -1 marks empty lines (treat as "no indent")
}

function precomputeFolds(lines) {
  // For each line, find the index of the last line in its fold block.
  // A fold block ends at the first subsequent non-empty line whose indent is ≤ the line's indent.
  // Empty lines are transparent (treated as belonging to the current block).
  const foldEnd = new Array(lines.length).fill(-1);
  for (let i = 0; i < lines.length; i++) {
    const ind = indentOf(lines[i]);
    if (ind < 0) continue;
    let j = i + 1;
    let last = i;
    while (j < lines.length) {
      const indJ = indentOf(lines[j]);
      if (indJ < 0) { last = j; j++; continue; }
      if (indJ <= ind) break;
      last = j;
      j++;
    }
    foldEnd[i] = last > i ? last : -1;     // -1 = leaf
  }
  return foldEnd;
}

export function renderRaw(container, ast) {
  const text = ast.sourceText || '';
  const lines = text.split(/\r?\n/);
  const foldEnd = precomputeFolds(lines);

  const gutter = el('div', { class: 'gutter' });
  const body   = el('div', { class: 'body' });
  const lineSpans = new Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    // Gutter row: line number + fold triangle (if any).
    const gutterRow = el('div', { class: 'gutter-row' });
    const num = el('span', { class: 'line-num' }, String(i + 1).padStart(5, ' '));
    const fold = el('span', { class: foldEnd[i] >= 0 ? 'fold' : 'fold leaf' }, foldEnd[i] >= 0 ? '▾' : ' ');
    gutterRow.appendChild(num);
    gutterRow.appendChild(document.createTextNode(' '));
    gutterRow.appendChild(fold);
    gutterRow.appendChild(document.createTextNode('\n'));
    gutter.appendChild(gutterRow);

    const span = el('span', { class: 'line' }, lines[i] === '' ? ' ' : lines[i]);
    body.appendChild(span);
    lineSpans[i] = span;

    if (foldEnd[i] >= 0) {
      const startIdx = i;
      const endIdx = foldEnd[i];
      let collapsed = false;
      fold.addEventListener('click', () => {
        collapsed = !collapsed;
        fold.textContent = collapsed ? '▸' : '▾';
        fold.classList.toggle('collapsed', collapsed);
        for (let k = startIdx + 1; k <= endIdx; k++) {
          lineSpans[k].classList.toggle('hidden', collapsed);
        }
      });
    }
  }

  const view = el('div', { class: 'raw-view' }, [gutter, body]);
  container.appendChild(view);
}
