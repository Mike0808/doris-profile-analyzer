// textParser: indent-aware state machine over classified lines.
// See docs/superpowers/specs/2026-05-12-iteration-1-parser-raw-design.md §5

import { createAst } from './ast.js';

const RE_SECTION  = /^(Summary|Execution Summary|MergedProfile|Changed Session Variables|Physical Plan)\s*:?\s*$/;
const RE_COUNTER  = /^(\s*)-\s+([^:]+?)\s*:\s*(.*)$/;
const RE_COUNTER_NOVAL = /^(\s*)-\s+([^:]+?)\s*$/;       // '- PlanInfo' (no value)

export function textParser(input) {
  const ast = createAst();
  ast.sourceText = input;
  const lines = input.split(/\r?\n/);

  let section = null;               // 'summary' | 'executionSummary' | null
  // Stack of {indent, name} for currently-open counters. Used to build dotted paths.
  let counterStack = [];
  let lastCounterEntry = null;      // {key, mapRef} — used for multi-line continuation

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const secMatch = RE_SECTION.exec(line);
    if (secMatch) {
      const name = secMatch[1];
      if (name === 'Summary')                section = 'summary';
      else if (name === 'Execution Summary') section = 'executionSummary';
      else                                    section = null;
      counterStack = [];
      lastCounterEntry = null;
      continue;
    }

    if (section === 'summary' || section === 'executionSummary') {
      const targetMap = section === 'summary' ? ast.summary : ast.executionSummary;

      const cm = RE_COUNTER.exec(line);
      const cmNo = !cm ? RE_COUNTER_NOVAL.exec(line) : null;
      const counterMatch = cm || cmNo;

      if (counterMatch) {
        const indent = counterMatch[1].length;
        const key = counterMatch[2].trim();
        const value = cm ? cm[3] : '';
        // Pop stack while top has indent >= current.
        while (counterStack.length && counterStack[counterStack.length - 1].indent >= indent) {
          counterStack.pop();
        }
        const path = counterStack.map(e => e.name).concat([key]).join('.');
        targetMap.set(path, value);
        counterStack.push({ indent, name: key });
        lastCounterEntry = { key: path, mapRef: targetMap };
        continue;
      }

      // Multi-line continuation: append to lastCounterEntry's value.
      // (Only inside Summary / Execution Summary.)
      if (lastCounterEntry && line.length > 0) {
        const prev = lastCounterEntry.mapRef.get(lastCounterEntry.key);
        lastCounterEntry.mapRef.set(lastCounterEntry.key, prev + '\n' + line);
        continue;
      }

      // Blank line: do nothing. Don't clear lastCounterEntry yet —
      // some profiles have blank lines inside Sql Statement.
      if (line.trim() === '') continue;
    }

    // Outside Summary/Execution Summary, or unrecognised: ignore for now.
    // Later tasks (6–10) handle the rest.
  }

  return ast;
}
