// textParser: indent-aware state machine over classified lines.
// See docs/superpowers/specs/2026-05-12-iteration-1-parser-raw-design.md §5

import { createAst, createFragment, createPipeline, createOperator } from './ast.js';

const RE_SECTION  = /^(Summary|Execution Summary|MergedProfile|Changed Session Variables|Physical Plan)\s*:?\s*$/;
const RE_COUNTER  = /^(\s*)-\s+([^:]+?)\s*:\s*(.*)$/;
const RE_COUNTER_NOVAL = /^(\s*)-\s+([^:]+?)\s*$/;       // '- PlanInfo' (no value)

const RE_FRAGMENT        = /^\s+Fragment\s+(\d+)\s*:\s*$/;
const RE_PIPELINE_MERGED = /^\s+Pipeline\s*:\s*(\d+)\s*\(instance_num=(\d+)\)\s*:\s*$/;
const RE_OPERATOR        = /^(\s*)([A-Z_]+_OPERATOR)\b.*?\(id=(-?\d+)[^\n]*\)\s*:\s*$/;

export function textParser(input) {
  const ast = createAst();
  ast.sourceText = input;
  const lines = input.split(/\r?\n/);

  let section = null;               // 'summary' | 'executionSummary' | 'mergedProfile' | null
  // Stack of {indent, name} for currently-open counters. Used to build dotted paths.
  let counterStack = [];
  let lastCounterEntry = null;      // {key, mapRef} — used for multi-line continuation
  let opStack = [];                 // [{indent, node, counterStack?}] for current pipeline

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const secMatch = RE_SECTION.exec(line);
    if (secMatch) {
      const name = secMatch[1];
      if      (name === 'Summary')           section = 'summary';
      else if (name === 'Execution Summary') section = 'executionSummary';
      else if (name === 'MergedProfile')     section = 'mergedProfile';
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

    if (section === 'mergedProfile') {
      const fm = RE_FRAGMENT.exec(line);
      if (fm) {
        ast.mergedProfile.fragments.push(
          createFragment({ id: parseInt(fm[1], 10), startLine: i })
        );
        continue;
      }
      const pm = RE_PIPELINE_MERGED.exec(line);
      if (pm) {
        const currentFragment = ast.mergedProfile.fragments[ast.mergedProfile.fragments.length - 1];
        if (currentFragment) {
          currentFragment.pipelines.push(
            createPipeline({
              id: parseInt(pm[1], 10),
              instanceNum: parseInt(pm[2], 10),
              startLine: i,
            })
          );
        }
        opStack = [];
        continue;
      }

      const om = RE_OPERATOR.exec(line);
      if (om) {
        const indent = om[1].length;
        const op = createOperator({
          name: om[2],
          rawHeader: line.trim(),
          id: parseInt(om[3], 10),
          startLine: i,
        });
        // Pop stack until top has indent < current.
        while (opStack.length && opStack[opStack.length - 1].indent >= indent) {
          opStack.pop();
        }
        if (opStack.length === 0) {
          const currentFragment = ast.mergedProfile.fragments[ast.mergedProfile.fragments.length - 1];
          const currentPipeline = currentFragment.pipelines[currentFragment.pipelines.length - 1];
          if (currentPipeline.operators === null) {
            currentPipeline.operators = op;
          } else {
            ast.warnings.push({
              line: i,
              message: `Pipeline ${currentPipeline.id} already has a root operator; ignoring ${op.name}`,
            });
          }
        } else {
          opStack[opStack.length - 1].node.children.push(op);
        }
        opStack.push({ indent, node: op });
        continue;
      }

      // Other MergedProfile content handled in later tasks.
    }

    // Outside Summary/Execution Summary/MergedProfile, or unrecognised: ignore for now.
    // Later tasks (9–10) handle the rest.
  }

  return ast;
}
