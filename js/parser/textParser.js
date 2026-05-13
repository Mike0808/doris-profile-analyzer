// textParser: indent-aware state machine over classified lines.
// See docs/superpowers/specs/2026-05-12-iteration-1-parser-raw-design.md §5

import { createAst, createFragment, createPipeline, createOperator } from './ast.js';
import { detect } from './detect.js';
import { unwrapJson } from './jsonParser.js';

const RE_SECTION  = /^(Summary|Execution Summary|MergedProfile|Changed Session Variables|Physical Plan)\s*:?\s*$/;
const RE_COUNTER  = /^(\s*)-\s+([^:]+?)\s*:\s*(.*)$/;
const RE_COUNTER_NOVAL = /^(\s*)-\s+([^:]+?)\s*$/;       // '- PlanInfo' (no value)

const RE_FRAGMENT        = /^\s+Fragment\s+(\d+)\s*:\s*$/;
const RE_PIPELINE_MERGED = /^\s+Pipeline\s*:\s*(\d+)\s*\(instance_num=(\d+)\)\s*:\s*$/;
const RE_PIPELINE_PERHOST = /^\s+Pipeline\s*:\s*(\d+)\s+\(host=/;
// "Execution Profile <query_id>:" begins the per-instance execution detail section.
// Doris 3.x profile format: appears after MergedProfile, before per-host Pipeline lines.
const RE_EXEC_PROFILE    = /^Execution Profile [0-9a-f-]+\s*:/;
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
  let opaque = null;
  const flushOpaque = () => {
    if (opaque) {
      ast.opaqueBlocks.push({
        kind: opaque.kind,
        startLine: opaque.startLine,
        endLine: opaque.startLine + opaque.lines.length - 1,
        text: opaque.lines.join('\n'),
      });
      opaque = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const secMatch = RE_SECTION.exec(line);
    if (secMatch) {
      const name = secMatch[1];
      flushOpaque();
      if      (name === 'Summary')                    section = 'summary';
      else if (name === 'Execution Summary')          section = 'executionSummary';
      else if (name === 'MergedProfile')              section = 'mergedProfile';
      else if (name === 'Changed Session Variables') {
        section = null;
        opaque = { kind: 'changedSessionVariables', startLine: i, lines: [line] };
        counterStack = []; lastCounterEntry = null;
        continue;
      }
      else if (name === 'Physical Plan') {
        section = null;
        opaque = { kind: 'physicalPlan', startLine: i, lines: [line] };
        counterStack = []; lastCounterEntry = null;
        continue;
      }
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
      // "Execution Profile <id>:" marks the start of per-instance execution details.
      // Everything from here to EOF is opaque (contains per-host Pipeline / PipelineTask entries).
      if (RE_EXEC_PROFILE.test(line) || RE_PIPELINE_PERHOST.test(line)) {
        flushOpaque();
        opaque = { kind: 'perHostPipelines', startLine: i, lines: [line] };
        section = null;          // stop structured parsing
        opStack = [];
        continue;
      }

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

      const om2 = RE_COUNTER.exec(line);
      const om2No = !om2 ? RE_COUNTER_NOVAL.exec(line) : null;
      const opCounter = om2 || om2No;
      if (opCounter && opStack.length) {
        const indent = opCounter[1].length;
        const key = opCounter[2].trim();
        const value = om2 ? om2[3] : '';
        const top = opStack[opStack.length - 1];
        // Operator counters always indent more than the operator header.
        if (indent <= top.indent) {
          // Looks like a stray counter at a shallower level — record a warning.
          ast.warnings.push({ line: i, message: `Stray counter "${key}" at indent ${indent} <= operator indent ${top.indent}` });
          continue;
        }
        // Maintain a per-operator path stack for nested counters.
        if (!top.counterStack) top.counterStack = [];
        while (top.counterStack.length && top.counterStack[top.counterStack.length - 1].indent >= indent) {
          top.counterStack.pop();
        }
        const path = top.counterStack.map(e => e.name).concat([key]).join('.');
        top.node.attrs.set(path, value);
        top.counterStack.push({ indent, name: key });
        top.node.endLine = i;
        continue;
      }

      // Other MergedProfile content handled in later tasks.
    }

    // Fall-through: if an opaque block is active, append; otherwise silently drop.
    if (opaque) {
      opaque.lines.push(line);
    }
  }

  flushOpaque();
  return ast;
}

export function runPipeline(input) {
  const format = detect(input);
  let text = input;
  if (format === 'json') {
    const u = unwrapJson(input);
    if (!u.ok) return { ok: false, ast: null, error: u.reason };
    text = u.text;
  }
  const ast = textParser(text);
  ast.format = format;
  ast.sourceText = text;
  return { ok: true, ast, error: null };
}
