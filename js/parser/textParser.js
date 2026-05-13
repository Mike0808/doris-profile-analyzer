// textParser: indent-aware state machine over classified lines.
// See docs/superpowers/specs/2026-05-12-iteration-1-parser-raw-design.md §5

import {
  createAst, createFragment, createPipeline, createOperator,
  createPerHostFragment, createPerHostPipeline, createPipelineTask, createFragmentLevel,
} from './ast.js';
import { detect } from './detect.js';
import { unwrapJson } from './jsonParser.js';

const RE_SECTION  = /^(Summary|Execution Summary|MergedProfile|Changed Session Variables|Physical Plan)\s*:?\s*$/;
const RE_COUNTER  = /^(\s*)-\s+([^:]+?)\s*:\s*(.*)$/;
const RE_COUNTER_NOVAL = /^(\s*)-\s+([^:]+?)\s*$/;       // '- PlanInfo' (no value)

const RE_FRAGMENT        = /^\s+Fragment\s+(\d+)\s*:\s*$/;
const RE_PIPELINE_MERGED = /^\s+Pipeline\s*:\s*(\d+)\s*\(instance_num=(\d+)\)\s*:\s*$/;
const RE_OPERATOR        = /^(\s*)([A-Z_]+_OPERATOR)\b.*?\(id=(-?\d+)[^\n]*\)\s*:\s*$/;
// NOTE: table name includes nested parens: "lineitem(lineitem)" → use .*? instead of [^)]* so
// the regex can skip the inner ")" and land on the outer "):(ExecTime:".
// e.g. OLAP_SCAN_OPERATOR (id=0. nereids_id=209. table name = lineitem(lineitem)):(ExecTime: …)
// Doris 3.x: https://doris.apache.org/docs/3.x/query-acceleration/tuning/profiling-tools/
const RE_OPERATOR_PERHOST = /^(\s*)([A-Z_]+_OPERATOR)\b.*?\(id=(-?\d+).*?\):\(ExecTime:\s+([^)]+)\)/;
const RE_NAMED_BLOCK_PERHOST = /^(\s*)(VScanner|SegmentIterator|IndexFilter)\s*:?\s*$/;

// perHost section regexes
// Doris 3.x: https://doris.apache.org/docs/3.x/query-acceleration/tuning/profiling-tools/
const RE_EXEC_PROFILE_OPEN     = /^Execution Profile [0-9a-f-]+\s*:/;
const RE_PERHOST_FRAGMENTS     = /^\s+Fragments:\s*$/;
const RE_PERHOST_FRAGMENT      = /^\s+Fragment\s+(\d+)\s*:\s*$/;
const RE_FRAGMENT_LEVEL        = /^\s+Fragment Level Profile:\s+\(host=([^)]+(?:\)[^)]*)?)\):\(ExecTime:\s+([^)]+)\)/;
const RE_PIPELINE_PERHOST_FULL = /^\s+Pipeline\s*:\s*(\d+)\s+\(host=([^)]+(?:\)[^)]*)?)\):\s*$/;
const RE_PIPELINE_TASK         = /^\s+PipelineTask\s+\(index=(\d+)\):\(ExecTime:\s+([^)]+)\)/;

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
  let perHostState = null;
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

    // perHost section opens on 'Execution Profile <id>:' header.
    if (RE_EXEC_PROFILE_OPEN.test(line)) {
      flushOpaque();
      section = 'perHost';
      counterStack = [];
      lastCounterEntry = null;
      opStack = [];
      perHostState = {
        currentFragment: null,
        currentFragmentLevel: null,
        currentPipeline: null,
        currentTask: null,
        taskCounterStack: [],
        fragmentLevelCounterStack: [],
      };
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
      // Implicit opener: per-host Pipeline appearing inside MergedProfile without
      // a preceding 'Execution Profile' header. Open perHost section lazily.
      if (RE_PIPELINE_PERHOST_FULL.test(line)) {
        flushOpaque();
        section = 'perHost';
        opStack = [];
        perHostState = {
          currentFragment: null,
          currentFragmentLevel: null,
          currentPipeline: null,
          currentTask: null,
          taskCounterStack: [],
          fragmentLevelCounterStack: [],
        };
        ast.warnings.push({ line: i, message: 'per-host pipeline without preceding "Execution Profile" header — opened section implicitly' });
        // Implicit opener has no Fragment context — create a synthetic Fragment 0.
        perHostState.currentFragment = createPerHostFragment({ id: 0, startLine: i });
        ast.perHost.fragments.push(perHostState.currentFragment);
        const pp = RE_PIPELINE_PERHOST_FULL.exec(line);
        const pipeline = createPerHostPipeline({ id: parseInt(pp[1], 10), host: pp[2], startLine: i });
        perHostState.currentFragment.pipelines.push(pipeline);
        perHostState.currentPipeline = pipeline;
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

    if (section === 'perHost') {
      // Fragment container line — no-op, just a label.
      if (RE_PERHOST_FRAGMENTS.test(line)) continue;

      const fm = RE_PERHOST_FRAGMENT.exec(line);
      if (fm) {
        perHostState.currentFragment = createPerHostFragment({ id: parseInt(fm[1], 10), startLine: i });
        ast.perHost.fragments.push(perHostState.currentFragment);
        perHostState.currentFragmentLevel = null;
        perHostState.currentPipeline = null;
        perHostState.currentTask = null;
        opStack = [];
        perHostState.taskCounterStack = [];
        perHostState.fragmentLevelCounterStack = [];
        continue;
      }

      const fl = RE_FRAGMENT_LEVEL.exec(line);
      if (fl && perHostState.currentFragment) {
        const fragmentLevel = createFragmentLevel({ host: fl[1], execTime: fl[2], startLine: i });
        perHostState.currentFragment.fragmentLevel = fragmentLevel;
        perHostState.currentFragmentLevel = fragmentLevel;
        perHostState.currentPipeline = null;
        perHostState.currentTask = null;
        opStack = [];
        perHostState.fragmentLevelCounterStack = [];
        perHostState.taskCounterStack = [];
        continue;
      }

      const pp = RE_PIPELINE_PERHOST_FULL.exec(line);
      if (pp && perHostState.currentFragment) {
        const pipeline = createPerHostPipeline({ id: parseInt(pp[1], 10), host: pp[2], startLine: i });
        perHostState.currentFragment.pipelines.push(pipeline);
        perHostState.currentPipeline = pipeline;
        perHostState.currentFragmentLevel = null;
        perHostState.currentTask = null;
        opStack = [];
        perHostState.taskCounterStack = [];
        perHostState.fragmentLevelCounterStack = [];
        continue;
      }

      const pt = RE_PIPELINE_TASK.exec(line);
      if (pt && perHostState.currentPipeline) {
        const task = createPipelineTask({ index: parseInt(pt[1], 10), execTime: pt[2], startLine: i });
        perHostState.currentPipeline.tasks.push(task);
        perHostState.currentTask = task;
        opStack = [];
        perHostState.taskCounterStack = [];
        continue;
      }

      const om = RE_OPERATOR_PERHOST.exec(line);
      if (om && perHostState.currentTask) {
        const indent = om[1].length;
        const op = createOperator({
          name: om[2],
          rawHeader: line.trim(),
          id: parseInt(om[3], 10),
          startLine: i,
        });
        op.attrs.set('ExecTime', om[4]);
        while (opStack.length && opStack[opStack.length - 1].indent >= indent) {
          opStack.pop();
        }
        if (opStack.length === 0) {
          if (perHostState.currentTask.operators === null) {
            perHostState.currentTask.operators = op;
          } else {
            ast.warnings.push({
              line: i,
              message: `PipelineTask ${perHostState.currentTask.index} already has a root operator; ignoring ${op.name}`,
            });
          }
        } else {
          opStack[opStack.length - 1].node.children.push(op);
        }
        opStack.push({ indent, node: op, namedBlockStack: [], counterStack: [] });
        continue;
      }

      // Task 7: named blocks (VScanner / SegmentIterator / IndexFilter) —
      // Doris 3.x: https://doris.apache.org/docs/3.x/query-acceleration/tuning/profiling-tools/
      const nb = RE_NAMED_BLOCK_PERHOST.exec(line);
      if (nb && opStack.length > 0) {
        const indent = nb[1].length;
        const name = nb[2];
        const top = opStack[opStack.length - 1];
        if (indent <= top.indent) {
          ast.warnings.push({ line: i, message: `Named block "${name}" at indent ${indent} <= operator indent ${top.indent}` });
          continue;
        }
        // Pop named blocks deeper than or equal to current indent.
        while (top.namedBlockStack.length && top.namedBlockStack[top.namedBlockStack.length - 1].indent >= indent) {
          top.namedBlockStack.pop();
        }
        top.namedBlockStack.push({ indent, name });
        // Named blocks reset the operator-level counter stack (a new block opens fresh nesting).
        top.counterStack = [];
        continue;
      }

      // Task 6: counter routing — operator > task > fragmentLevel priority.
      // Doris 3.x: https://doris.apache.org/docs/3.x/query-acceleration/tuning/profiling-tools/
      const cm = RE_COUNTER.exec(line);
      const cmNo = !cm ? RE_COUNTER_NOVAL.exec(line) : null;
      const counterMatch = cm || cmNo;
      if (counterMatch) {
        const indent = counterMatch[1].length;
        const key = counterMatch[2].trim();
        const value = cm ? cm[3] : '';

        // Priority 1: top of opStack (operator).
        if (opStack.length > 0) {
          const top = opStack[opStack.length - 1];
          if (indent <= top.indent) {
            ast.warnings.push({ line: i, message: `Stray counter "${key}" at indent ${indent} <= operator indent ${top.indent}` });
            continue;
          }
          while (top.counterStack.length && top.counterStack[top.counterStack.length - 1].indent >= indent) {
            top.counterStack.pop();
          }
          const path = [
            ...top.namedBlockStack.map(b => b.name),
            ...top.counterStack.map(c => c.name),
            key,
          ].join('.');
          top.node.attrs.set(path, value);
          top.counterStack.push({ indent, name: key });
          top.node.endLine = i;
          continue;
        }

        // Priority 2: current PipelineTask.
        if (perHostState.currentTask) {
          while (perHostState.taskCounterStack.length && perHostState.taskCounterStack[perHostState.taskCounterStack.length - 1].indent >= indent) {
            perHostState.taskCounterStack.pop();
          }
          const path = perHostState.taskCounterStack.map(c => c.name).concat([key]).join('.');
          perHostState.currentTask.attrs.set(path, value);
          perHostState.taskCounterStack.push({ indent, name: key });
          perHostState.currentTask.endLine = i;
          continue;
        }

        // Priority 3: current FragmentLevel.
        if (perHostState.currentFragmentLevel) {
          while (perHostState.fragmentLevelCounterStack.length && perHostState.fragmentLevelCounterStack[perHostState.fragmentLevelCounterStack.length - 1].indent >= indent) {
            perHostState.fragmentLevelCounterStack.pop();
          }
          const path = perHostState.fragmentLevelCounterStack.map(c => c.name).concat([key]).join('.');
          perHostState.currentFragmentLevel.attrs.set(path, value);
          perHostState.fragmentLevelCounterStack.push({ indent, name: key });
          perHostState.currentFragmentLevel.endLine = i;
          continue;
        }

        // Priority 4: drop with warning.
        ast.warnings.push({ line: i, message: `Stray counter "${key}" in perHost section with no active operator/task/fragmentLevel` });
        continue;
      }
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
