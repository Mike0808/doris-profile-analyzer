import { suite, test, assertEqual, assertTrue, assertContains } from './runner.js';
import { createAst, createOperator, createPipeline, createFragment, createPerHostFragment, createPerHostPipeline, createPipelineTask, createFragmentLevel } from '../js/parser/ast.js';
import {
  parseDuration, parseBytes, parseRowCount,
  parseAvgMaxMin, parseSumAvgMaxMin, parseSumAvgMaxMinRows,
  parseScalarTime, parseArray,
  formatNs, formatBytes, formatRows, formatPct,
} from '../js/util/format.js';

suite('Runner smoke', () => {
  test('assertEqual on equal values passes', () => {
    assertEqual(1 + 1, 2);
  });
  test('assertTrue on truthy passes', () => {
    assertTrue([].length === 0);
  });
});

suite('AST factories', () => {
  test('createAst returns the documented shape', () => {
    const ast = createAst();
    assertEqual(ast.format, 'text');
    assertEqual(ast.sourceText, '');
    assertTrue(ast.summary instanceof Map);
    assertTrue(ast.executionSummary instanceof Map);
    assertEqual(ast.mergedProfile.fragments, []);
    assertEqual(ast.perHost.fragments, []);
    assertEqual(ast.opaqueBlocks, []);
    assertEqual(ast.warnings, []);
  });

  test('createOperator captures header fields', () => {
    const op = createOperator({
      name: 'EXCHANGE_OPERATOR',
      rawHeader: 'EXCHANGE_OPERATOR (id=5):',
      id: 5,
      startLine: 12,
    });
    assertEqual(op.name, 'EXCHANGE_OPERATOR');
    assertEqual(op.id, 5);
    assertEqual(op.startLine, 12);
    assertEqual(op.endLine, 12);
    assertTrue(op.meta instanceof Map);
    assertTrue(op.attrs instanceof Map);
    assertEqual(op.children, []);
  });

  test('createFragment / createPipeline default fields', () => {
    const f = createFragment({ id: 0, startLine: 100 });
    assertEqual(f.id, 0);
    assertEqual(f.pipelines, []);
    const p = createPipeline({ id: 0, instanceNum: 24, startLine: 101 });
    assertEqual(p.id, 0);
    assertEqual(p.instanceNum, 24);
    assertEqual(p.operators, null);
  });
});

import { detect } from '../js/parser/detect.js';

suite('detect', () => {
  test('JSON object → "json"', () => {
    assertEqual(detect('{"msg":"success","data":{"profile":"…"}}'), 'json');
  });
  test('Leading whitespace then { → "json"', () => {
    assertEqual(detect('   \n  {"msg":"success"}'), 'json');
  });
  test('UTF-8 BOM then { → "json"', () => {
    assertEqual(detect('﻿{"msg":"success"}'), 'json');
  });
  test('"Summary:" → "text"', () => {
    assertEqual(detect('Summary:\n   - Profile ID: abc'), 'text');
  });
  test('Empty string → "text" (defensive)', () => {
    assertEqual(detect(''), 'text');
  });
});

import { unwrapJson } from '../js/parser/jsonParser.js';

suite('jsonParser.unwrapJson', () => {
  test('Valid wrapper returns inner profile text', () => {
    const payload = JSON.stringify({
      msg: 'success',
      code: 0,
      data: { profile: 'Summary:\n   - Profile ID: abc\n' },
    });
    const r = unwrapJson(payload);
    assertEqual(r.ok, true);
    assertEqual(r.text, 'Summary:\n   - Profile ID: abc\n');
  });
  test('Escaped newlines and quotes are honored', () => {
    const inner = 'Summary:\n   - Sql Statement: SELECT "a"\n';
    const payload = JSON.stringify({ data: { profile: inner } });
    const r = unwrapJson(payload);
    assertEqual(r.ok, true);
    assertEqual(r.text, inner);
  });
  test('Missing data.profile returns ok=false with reason', () => {
    const r = unwrapJson('{"msg":"success","data":{}}');
    assertEqual(r.ok, false);
    assertContains(r.reason, 'data.profile');
  });
  test('Invalid JSON returns ok=false', () => {
    const r = unwrapJson('{not json');
    assertEqual(r.ok, false);
    assertContains(r.reason, 'JSON');
  });
});

import { textParser } from '../js/parser/textParser.js';

const SUMMARY_FIXTURE = `Summary:
   - Profile ID: abc-123
   - Task Type: QUERY
   - Total: 105ms
   - Sql Statement: SELECT * FROM lineitem
WHERE l_shipdate < '1998-12-01'
LIMIT 10
   - Distributed Plan: N/A
Execution Summary:
   - Plan Time: 9ms
     - Nereids Analysis Time: 4ms
     - Nereids Rewrite Time: 1ms
       - Nereids Fold Const By BE Time: 0ms
   - Schedule Time: 7ms
`;

suite('textParser — Summary + Execution Summary', () => {
  test('Top-level Summary keys', () => {
    const ast = textParser(SUMMARY_FIXTURE);
    assertEqual(ast.summary.get('Profile ID'), 'abc-123');
    assertEqual(ast.summary.get('Task Type'), 'QUERY');
    assertEqual(ast.summary.get('Total'), '105ms');
    assertEqual(ast.summary.get('Distributed Plan'), 'N/A');
  });

  test('Multi-line Sql Statement preserves continuation lines', () => {
    const ast = textParser(SUMMARY_FIXTURE);
    const sql = ast.summary.get('Sql Statement');
    assertContains(sql, "SELECT * FROM lineitem");
    assertContains(sql, "WHERE l_shipdate < '1998-12-01'");
    assertContains(sql, "LIMIT 10");
  });

  test('Execution Summary nested counters use dotted paths', () => {
    const ast = textParser(SUMMARY_FIXTURE);
    assertEqual(ast.executionSummary.get('Plan Time'), '9ms');
    assertEqual(ast.executionSummary.get('Plan Time.Nereids Analysis Time'), '4ms');
    assertEqual(ast.executionSummary.get('Plan Time.Nereids Rewrite Time'), '1ms');
    assertEqual(
      ast.executionSummary.get('Plan Time.Nereids Rewrite Time.Nereids Fold Const By BE Time'),
      '0ms',
    );
    assertEqual(ast.executionSummary.get('Schedule Time'), '7ms');
  });

  test('Parser does not throw on empty input', () => {
    const ast = textParser('');
    assertEqual(ast.summary.size, 0);
    assertEqual(ast.executionSummary.size, 0);
  });
});

const MERGED_SKELETON_FIXTURE = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
       Fragment 1:
         Pipeline : 0(instance_num=24):
         Pipeline : 1(instance_num=24):
`;

suite('textParser — MergedProfile skeleton', () => {
  test('Two fragments parsed', () => {
    const ast = textParser(MERGED_SKELETON_FIXTURE);
    assertEqual(ast.mergedProfile.fragments.length, 2);
    assertEqual(ast.mergedProfile.fragments[0].id, 0);
    assertEqual(ast.mergedProfile.fragments[1].id, 1);
  });
  test('Pipelines parsed with instance_num', () => {
    const ast = textParser(MERGED_SKELETON_FIXTURE);
    const f0 = ast.mergedProfile.fragments[0];
    const f1 = ast.mergedProfile.fragments[1];
    assertEqual(f0.pipelines.length, 1);
    assertEqual(f0.pipelines[0].id, 0);
    assertEqual(f0.pipelines[0].instanceNum, 1);
    assertEqual(f1.pipelines.length, 2);
    assertEqual(f1.pipelines[1].id, 1);
    assertEqual(f1.pipelines[1].instanceNum, 24);
  });
  test('All pipelines have operators=null at this stage', () => {
    const ast = textParser(MERGED_SKELETON_FIXTURE);
    for (const f of ast.mergedProfile.fragments) {
      for (const p of f.pipelines) {
        assertEqual(p.operators, null);
      }
    }
  });
});

const OP_TREE_FIXTURE = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           RESULT_SINK_OPERATOR (id=0):
             EXCHANGE_OPERATOR (id=5):
               OLAP_SCAN_OPERATOR (id=0. nereids_id=273. table name = lineitem(lineitem)):
`;

suite('textParser — operator stack', () => {
  test('Operator tree has chain shape', () => {
    const ast = textParser(OP_TREE_FIXTURE);
    const root = ast.mergedProfile.fragments[0].pipelines[0].operators;
    assertTrue(root !== null);
    assertEqual(root.name, 'RESULT_SINK_OPERATOR');
    assertEqual(root.id, 0);
    assertEqual(root.children.length, 1);
    const child = root.children[0];
    assertEqual(child.name, 'EXCHANGE_OPERATOR');
    assertEqual(child.id, 5);
    assertEqual(child.children.length, 1);
    const leaf = child.children[0];
    assertEqual(leaf.name, 'OLAP_SCAN_OPERATOR');
    assertEqual(leaf.id, 0);
  });
  test('Operator rawHeader is preserved verbatim', () => {
    const ast = textParser(OP_TREE_FIXTURE);
    const leaf = ast.mergedProfile.fragments[0].pipelines[0].operators.children[0].children[0];
    assertEqual(leaf.rawHeader, 'OLAP_SCAN_OPERATOR (id=0. nereids_id=273. table name = lineitem(lineitem)):');
  });
});

const OP_COUNTERS_FIXTURE = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           RESULT_SINK_OPERATOR (id=0):
              - CloseTime: avg 20.731us, max 20.731us, min 20.731us
              - ExecTime: avg 529.994us, max 529.994us, min 529.994us
              - InputRows: sum 4, avg 4, max 4, min 4
             EXCHANGE_OPERATOR (id=5):
                - PlanInfo
                   - offset: 0
                - BlocksProduced: sum 5, avg 5, max 5, min 5
                - ExecTime: avg 682.642us, max 682.642us, min 682.642us
`;

suite('textParser — operator counters', () => {
  test('Top-level counters land in attrs', () => {
    const ast = textParser(OP_COUNTERS_FIXTURE);
    const root = ast.mergedProfile.fragments[0].pipelines[0].operators;
    assertEqual(root.attrs.get('CloseTime'), 'avg 20.731us, max 20.731us, min 20.731us');
    assertEqual(root.attrs.get('ExecTime'), 'avg 529.994us, max 529.994us, min 529.994us');
    assertEqual(root.attrs.get('InputRows'), 'sum 4, avg 4, max 4, min 4');
  });
  test('Sub-counters use dotted keys; parent with no value has empty string', () => {
    const ast = textParser(OP_COUNTERS_FIXTURE);
    const child = ast.mergedProfile.fragments[0].pipelines[0].operators.children[0];
    assertEqual(child.attrs.get('PlanInfo'), '');
    assertEqual(child.attrs.get('PlanInfo.offset'), '0');
    assertEqual(child.attrs.get('BlocksProduced'), 'sum 5, avg 5, max 5, min 5');
    assertEqual(child.attrs.get('ExecTime'), 'avg 682.642us, max 682.642us, min 682.642us');
  });
  test('Counters do not bleed across siblings', () => {
    const ast = textParser(OP_COUNTERS_FIXTURE);
    const root = ast.mergedProfile.fragments[0].pipelines[0].operators;
    const child = root.children[0];
    assertTrue(!root.attrs.has('BlocksProduced'));
    assertTrue(!child.attrs.has('CloseTime'));
  });
});

const OPAQUE_FIXTURE = `Summary:
   - Profile ID: x

Changed Session Variables:
VarName | CurrentValue | DefaultValue
enable_profile | true | false


Physical Plan
PhysicalResultSink[245] ( outputExprs=[COUNT(*)#16] )
     +--PhysicalHashAggregate[230]@2

MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           RESULT_SINK_OPERATOR (id=0):
              - ExecTime: avg 1us, max 1us, min 1us
      Pipeline :0  (host=TNetworkAddress(hostname:10.29.81.155, port:9050)):
        PipelineTask (index=0):(ExecTime: 1.900ms)
          RESULT_SINK_OPERATOR (id=0):(ExecTime: 529.994us)
              - ExecTime: avg 529.994us, max 529.994us, min 529.994us
`;

function findBlock(ast, kind) {
  return ast.opaqueBlocks.find(b => b.kind === kind) || null;
}

suite('textParser — opaqueBlocks', () => {
  test('Changed Session Variables captured', () => {
    const ast = textParser(OPAQUE_FIXTURE);
    const b = findBlock(ast, 'changedSessionVariables');
    assertTrue(b !== null);
    assertContains(b.text, 'enable_profile');
  });
  test('Physical Plan captured', () => {
    const ast = textParser(OPAQUE_FIXTURE);
    const b = findBlock(ast, 'physicalPlan');
    assertTrue(b !== null);
    assertContains(b.text, 'PhysicalResultSink');
    assertContains(b.text, 'PhysicalHashAggregate');
  });
  test('Per-host pipeline parsed into ast.perHost (implicit opener)', () => {
    // Implicit opener: pipeline inside MergedProfile without "Execution Profile" header.
    // Now parsed structurally into ast.perHost instead of an opaque block.
    const ast = textParser(OPAQUE_FIXTURE);
    assertTrue(ast.perHost.fragments.length >= 1);
    const p = ast.perHost.fragments[0].pipelines[0];
    assertTrue(p !== undefined);
    assertContains(p.host, 'TNetworkAddress');
  });
  test('MergedProfile structure still parsed alongside perHost', () => {
    const ast = textParser(OPAQUE_FIXTURE);
    assertEqual(ast.mergedProfile.fragments.length, 1);
    const root = ast.mergedProfile.fragments[0].pipelines[0].operators;
    assertEqual(root.attrs.get('ExecTime'), 'avg 1us, max 1us, min 1us');
  });
});

// "Execution Profile <id>:" section appeared after MergedProfile content.
// Now parsed structurally into ast.perHost (Fragment/FragmentLevel/Pipeline/PipelineTask).
const EXEC_PROFILE_FIXTURE = `Summary:
   - Profile ID: abc
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           RESULT_SINK_OPERATOR (id=0):
              - ExecTime: avg 1us, max 1us, min 1us

Execution Profile abc123-def456:
  Fragments:
    Fragment 0:
      Fragment Level Profile:  (host=TNetworkAddress(hostname:10.0.0.1, port:9050)):(ExecTime: 1ms)
         - BuildPipelinesTime: 34us
         - BuildTasksTime: 235us
      Pipeline :0  (host=TNetworkAddress(hostname:10.0.0.1, port:9050)):
        PipelineTask (index=0):(ExecTime: 679us)
           - TaskState: Finished
`;

suite('textParser — Execution Profile structured', () => {
  test('Execution Profile section parsed into ast.perHost (not opaque)', () => {
    const ast = textParser(EXEC_PROFILE_FIXTURE);
    assertEqual(ast.perHost.fragments.length, 1);
    assertEqual(ast.perHost.fragments[0].id, 0);
    const fl = ast.perHost.fragments[0].fragmentLevel;
    assertTrue(fl !== null);
    assertContains(fl.host, '10.0.0.1');
    assertEqual(fl.execTime, '1ms');
  });
  test('Only 1 merged fragment (Execution Profile "Fragment 0" is NOT a MergedProfile fragment)', () => {
    const ast = textParser(EXEC_PROFILE_FIXTURE);
    assertEqual(ast.mergedProfile.fragments.length, 1);
  });
  test('No stray-counter warnings generated by Execution Profile content', () => {
    const ast = textParser(EXEC_PROFILE_FIXTURE);
    assertEqual(ast.warnings.length, 0);
  });
  test('MergedProfile operators still parsed correctly alongside Execution Profile', () => {
    const ast = textParser(EXEC_PROFILE_FIXTURE);
    const root = ast.mergedProfile.fragments[0].pipelines[0].operators;
    assertEqual(root.name, 'RESULT_SINK_OPERATOR');
    assertEqual(root.attrs.get('ExecTime'), 'avg 1us, max 1us, min 1us');
  });
  test('PipelineTask parsed in perHost section', () => {
    const ast = textParser(EXEC_PROFILE_FIXTURE);
    const tasks = ast.perHost.fragments[0].pipelines[0].tasks;
    assertEqual(tasks.length, 1);
    assertEqual(tasks[0].index, 0);
    assertEqual(tasks[0].execTime, '679us');
  });
});

import { runPipeline } from '../js/parser/textParser.js';

suite('runPipeline', () => {
  test('Plain text input yields format=text', () => {
    const r = runPipeline('Summary:\n   - Profile ID: abc\n');
    assertEqual(r.ok, true);
    assertEqual(r.ast.format, 'text');
    assertEqual(r.ast.summary.get('Profile ID'), 'abc');
    assertEqual(r.ast.sourceText, 'Summary:\n   - Profile ID: abc\n');
  });
  test('JSON wrapper unwrapped, format=json', () => {
    const inner = 'Summary:\n   - Profile ID: xyz\n';
    const wrapped = JSON.stringify({ data: { profile: inner } });
    const r = runPipeline(wrapped);
    assertEqual(r.ok, true);
    assertEqual(r.ast.format, 'json');
    assertEqual(r.ast.summary.get('Profile ID'), 'xyz');
    assertEqual(r.ast.sourceText, inner);
  });
  test('Malformed JSON returns ok=false with error message', () => {
    const r = runPipeline('{not json');
    assertEqual(r.ok, false);
    assertContains(r.error, 'JSON');
  });
});

// ── Real-sample integration tests ─────────────────────────────────────────────
// These tests use fetch() to load actual TPC-H profiles and assert the same
// invariants that the Node diagnostic harness (test/run-node.mjs) validates.
// See spec §9 for the canonical assertion list.

const SAMPLE_PATHS = [
  '../samples/tpch/count_lineitem.txt',
  '../samples/tpch/count_lineitem.json',
  '../samples/tpch/tpch_q1.txt',
  '../samples/tpch/tpch_q1.json',
  '../samples/tpch/tpch_q3.txt',
  '../samples/tpch/tpch_q3.json',
];

function countOperators(ast) {
  let n = 0;
  function walk(node) {
    if (!node) return;
    n++;
    for (const c of node.children) walk(c);
  }
  for (const f of ast.mergedProfile.fragments) {
    for (const p of f.pipelines) walk(p.operators);
  }
  return n;
}

function allOperatorsHaveStartEndLine(ast) {
  let ok = true;
  function walk(node) {
    if (!node) return;
    if (typeof node.startLine !== 'number' || typeof node.endLine !== 'number') ok = false;
    for (const c of node.children) walk(c);
  }
  for (const f of ast.mergedProfile.fragments) {
    for (const p of f.pipelines) walk(p.operators);
  }
  return ok;
}

suite('Real samples', () => {
  for (const path of SAMPLE_PATHS) {
    test(`${path} — no throw`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertEqual(r.ok, true, `runPipeline error: ${r.error}`);
    });
    test(`${path} — has summary`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(r.ast.summary.size > 0);
    });
    test(`${path} — has executionSummary`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(r.ast.executionSummary.size > 0);
    });
    test(`${path} — has >=1 fragment`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(r.ast.mergedProfile.fragments.length >= 1);
    });
    test(`${path} — has >=1 operator`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(countOperators(r.ast) >= 1);
    });
    test(`${path} — operators have start/end line`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(allOperatorsHaveStartEndLine(r.ast));
    });
    test(`${path} — sourceText nonempty`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(r.ast.sourceText.length > 0);
    });
    test(`${path} — warnings count reasonable (<50)`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(r.ast.warnings.length < 50, `Got ${r.ast.warnings.length} warnings`);
    });
  }
});

// ── JSON ↔ text equivalence tests ─────────────────────────────────────────────
// For each query pair (txt, json), assert that parsing both forms produces
// identical summary, executionSummary, and operator count. This verifies that
// the JSON unwrap and text parser are compatible.

const PAIRS = [
  ['../samples/tpch/count_lineitem.txt', '../samples/tpch/count_lineitem.json'],
  ['../samples/tpch/tpch_q1.txt',        '../samples/tpch/tpch_q1.json'],
  ['../samples/tpch/tpch_q3.txt',        '../samples/tpch/tpch_q3.json'],
];

function mapToObject(m) {
  const o = {};
  for (const [k, v] of m) o[k] = v;
  return o;
}

suite('JSON ↔ text equivalence', () => {
  for (const [txtPath, jsonPath] of PAIRS) {
    test(`${txtPath} ≡ ${jsonPath} — summary keys match`, async () => {
      const t = runPipeline(await (await fetch(txtPath)).text());
      const j = runPipeline(await (await fetch(jsonPath)).text());
      assertEqual(mapToObject(t.ast.summary), mapToObject(j.ast.summary));
    });
    test(`${txtPath} ≡ ${jsonPath} — executionSummary keys match`, async () => {
      const t = runPipeline(await (await fetch(txtPath)).text());
      const j = runPipeline(await (await fetch(jsonPath)).text());
      assertEqual(mapToObject(t.ast.executionSummary), mapToObject(j.ast.executionSummary));
    });
    test(`${txtPath} ≡ ${jsonPath} — operator counts match`, async () => {
      const t = runPipeline(await (await fetch(txtPath)).text());
      const j = runPipeline(await (await fetch(jsonPath)).text());
      assertEqual(countOperators(t.ast), countOperators(j.ast));
    });
  }
});

// ── util/format — parsers ─────────────────────────────────────────────────────

suite('util/format — parsers', () => {
  // parseDuration
  test('parseDuration: ns', () => {
    assertEqual(parseDuration('0ns'), 0);
    assertEqual(parseDuration('915ns'), 915);
  });
  test('parseDuration: us', () => {
    assertEqual(parseDuration('87.130us'), 87130);
    assertEqual(parseDuration('1us'), 1000);
  });
  test('parseDuration: ms — trailing zero is decimal', () => {
    assertEqual(parseDuration('1.578ms'), 1578000);
    assertEqual(parseDuration('1.40ms'), 1400000);
    assertEqual(parseDuration('105ms'), 105000000);
  });
  test('parseDuration: s and min', () => {
    assertEqual(parseDuration('2.5s'), 2500000000);
    assertEqual(parseDuration('1min'), 60000000000);
  });
  test('parseDuration: unparseable → null', () => {
    assertEqual(parseDuration('xyz'), null);
    assertEqual(parseDuration(''), null);
    assertEqual(parseDuration(null), null);
  });

  // parseBytes
  test('parseBytes: trailing-space zero', () => {
    assertEqual(parseBytes('0.00 '), 0);
    assertEqual(parseBytes('0.00'), 0);
  });
  test('parseBytes: B/KB/MB/GB', () => {
    assertEqual(parseBytes('64.00 B'), 64);
    assertEqual(parseBytes('192.00 KB'), 196608);
    assertEqual(parseBytes('4.75 MB'), 4980736);
    assertEqual(parseBytes('2.25 KB'), 2304);
  });
  test('parseBytes: unparseable → null', () => {
    assertEqual(parseBytes('xyz'), null);
  });

  // parseRowCount
  test('parseRowCount: integer in parens preferred', () => {
    assertEqual(parseRowCount('6.001215M (6001215)'), 6001215);
    assertEqual(parseRowCount('250.05K (250050)'), 250050);
  });
  test('parseRowCount: bare number', () => {
    assertEqual(parseRowCount('251384'), 251384);
    assertEqual(parseRowCount('0'), 0);
  });
  test('parseRowCount: bare M/K suffix without parens', () => {
    assertEqual(parseRowCount('6.001215M'), 6001215);
    assertEqual(parseRowCount('250.05K'), 250050);
  });
  test('parseRowCount: unparseable → null', () => {
    assertEqual(parseRowCount('xyz'), null);
  });

  // parseAvgMaxMin
  test('parseAvgMaxMin: standard format', () => {
    assertEqual(
      parseAvgMaxMin('avg 1.578ms, max 2.252ms, min 931.799us'),
      { avg_ns: 1578000, max_ns: 2252000, min_ns: 931799 }
    );
  });
  test('parseAvgMaxMin: zero ns', () => {
    assertEqual(
      parseAvgMaxMin('avg 0ns, max 0ns, min 0ns'),
      { avg_ns: 0, max_ns: 0, min_ns: 0 }
    );
  });
  test('parseAvgMaxMin: malformed → null', () => {
    assertEqual(parseAvgMaxMin('only avg here'), null);
  });

  // parseSumAvgMaxMin
  // Note: avg 181.33 KB = Math.round(181.33 * 1024) = 185682 bytes
  test('parseSumAvgMaxMin: bytes', () => {
    assertEqual(
      parseSumAvgMaxMin('sum 4.25 MB, avg 181.33 KB, max 256.00 KB, min 64.00 KB'),
      { sum: 4456448, avg: 185682, max: 262144, min: 65536 }
    );
  });

  // parseSumAvgMaxMinRows
  test('parseSumAvgMaxMinRows: rows', () => {
    assertEqual(
      parseSumAvgMaxMinRows('sum 6.001215M (6001215), avg 250.05K (250050), max 252.575K (252575), min 247.901K (247901)'),
      { sum: 6001215, avg: 250050, max: 252575, min: 247901 }
    );
  });

  // parseScalarTime
  test('parseScalarTime: alias for parseDuration', () => {
    assertEqual(parseScalarTime('1.614ms'), 1614000);
  });

  // parseArray
  test('parseArray: trailing comma+space tolerated', () => {
    assertEqual(
      parseArray('[163.063us, 64.045us, 112.836us, 17.614us, ]', parseScalarTime),
      [163063, 64045, 112836, 17614]
    );
  });
  test('parseArray: empty array', () => {
    assertEqual(parseArray('[]', parseScalarTime), []);
    assertEqual(parseArray('[ ]', parseScalarTime), []);
  });
  test('parseArray: row counts', () => {
    assertEqual(
      parseArray('[63.01K, 63.03K, 62.98K, 62.36K, ]', parseRowCount),
      [63010, 63030, 62980, 62360]
    );
  });
});

// ── util/format — formatters ──────────────────────────────────────────────────

suite('util/format — formatters', () => {
  test('formatNs: ns/us/ms/s ranges', () => {
    assertEqual(formatNs(0), '0ns');
    assertEqual(formatNs(915), '915ns');
    assertEqual(formatNs(87130), '87.1us');
    assertEqual(formatNs(1578000), '1.58ms');
    assertEqual(formatNs(2_500_000_000), '2.5s');
    assertEqual(formatNs(60_000_000_000), '60.0s');
  });
  test('formatNs: null/undefined → "—"', () => {
    assertEqual(formatNs(null), '—');
    assertEqual(formatNs(undefined), '—');
  });
  test('formatBytes: B/KB/MB/GB', () => {
    assertEqual(formatBytes(0), '0 B');
    assertEqual(formatBytes(64), '64 B');
    assertEqual(formatBytes(196608), '192.0 KB');
    assertEqual(formatBytes(4980736), '4.75 MB');
  });
  test('formatBytes: null → "—"', () => {
    assertEqual(formatBytes(null), '—');
  });
  // Note: 250050/1000 = 250.05 → toFixed(1) = '250.1K' (math rounding)
  test('formatRows: K/M', () => {
    assertEqual(formatRows(0), '0');
    assertEqual(formatRows(999), '999');
    assertEqual(formatRows(250050), '250.1K');
    assertEqual(formatRows(6001215), '6.0M');
  });
  test('formatRows: null → "—"', () => {
    assertEqual(formatRows(null), '—');
  });
  test('formatPct: one decimal', () => {
    assertEqual(formatPct(0), '0.0%');
    assertEqual(formatPct(92.345), '92.3%');
    assertEqual(formatPct(100), '100.0%');
  });
  test('formatPct: null → "—"', () => {
    assertEqual(formatPct(null), '—');
  });
});

// ── AST factories — perHost ───────────────────────────────────────────────────

suite('AST factories — perHost', () => {
  test('createPerHostFragment defaults', () => {
    const f = createPerHostFragment({ id: 0, startLine: 100 });
    assertEqual(f.id, 0);
    assertEqual(f.startLine, 100);
    assertEqual(f.endLine, 100);
    assertEqual(f.pipelines, []);
    assertEqual(f.fragmentLevel, null);
  });
  test('createFragmentLevel defaults', () => {
    const fl = createFragmentLevel({ host: '10.0.0.1:9050', execTime: '6.954ms', startLine: 101 });
    assertEqual(fl.host, '10.0.0.1:9050');
    assertEqual(fl.execTime, '6.954ms');
    assertTrue(fl.attrs instanceof Map);
    assertEqual(fl.startLine, 101);
  });
  test('createPerHostPipeline defaults', () => {
    const p = createPerHostPipeline({ id: 0, host: '10.0.0.1:9050', startLine: 110 });
    assertEqual(p.id, 0);
    assertEqual(p.host, '10.0.0.1:9050');
    assertEqual(p.tasks, []);
  });
  test('createPipelineTask defaults', () => {
    const t = createPipelineTask({ index: 0, execTime: '679.83us', startLine: 120 });
    assertEqual(t.index, 0);
    assertEqual(t.execTime, '679.83us');
    assertTrue(t.attrs instanceof Map);
    assertEqual(t.operators, null);
  });
});

// ── textParser — perHost skeleton (Task 4) ────────────────────────────────────

const PERHOST_SKELETON_FIXTURE = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
Execution Profile abc-123:
  Fragments:
    Fragment 0:
      Fragment Level Profile:  (host=TNetworkAddress(hostname:10.0.0.1, port:9050)):(ExecTime: 6.954ms)
      Pipeline :0  (host=TNetworkAddress(hostname:10.0.0.1, port:9050)):
        PipelineTask (index=0):(ExecTime: 679.83us)
        PipelineTask (index=1):(ExecTime: 711.21us)
    Fragment 1:
      Fragment Level Profile:  (host=TNetworkAddress(hostname:10.0.0.2, port:9050)):(ExecTime: 7.143ms)
      Pipeline :0  (host=TNetworkAddress(hostname:10.0.0.2, port:9050)):
        PipelineTask (index=0):(ExecTime: 598.241us)
`;

suite('textParser — perHost skeleton', () => {
  test('perHost has two fragments', () => {
    const ast = textParser(PERHOST_SKELETON_FIXTURE);
    assertEqual(ast.perHost.fragments.length, 2);
    assertEqual(ast.perHost.fragments[0].id, 0);
    assertEqual(ast.perHost.fragments[1].id, 1);
  });
  test('fragmentLevel header parsed (host + execTime)', () => {
    const ast = textParser(PERHOST_SKELETON_FIXTURE);
    const fl = ast.perHost.fragments[0].fragmentLevel;
    assertTrue(fl !== null);
    assertContains(fl.host, '10.0.0.1');
    assertEqual(fl.execTime, '6.954ms');
  });
  test('pipelines parsed with host', () => {
    const ast = textParser(PERHOST_SKELETON_FIXTURE);
    const p = ast.perHost.fragments[0].pipelines[0];
    assertEqual(p.id, 0);
    assertContains(p.host, '10.0.0.1');
  });
  test('pipeline tasks parsed with index and execTime', () => {
    const ast = textParser(PERHOST_SKELETON_FIXTURE);
    const tasks = ast.perHost.fragments[0].pipelines[0].tasks;
    assertEqual(tasks.length, 2);
    assertEqual(tasks[0].index, 0);
    assertEqual(tasks[0].execTime, '679.83us');
    assertEqual(tasks[1].index, 1);
    assertEqual(tasks[1].execTime, '711.21us');
  });
  test('Tasks have operators=null until Task 5 lands operator parsing', () => {
    const ast = textParser(PERHOST_SKELETON_FIXTURE);
    for (const f of ast.perHost.fragments) {
      for (const p of f.pipelines) {
        for (const t of p.tasks) {
          assertEqual(t.operators, null);
        }
      }
    }
  });
  test('mergedProfile still parsed', () => {
    const ast = textParser(PERHOST_SKELETON_FIXTURE);
    assertEqual(ast.mergedProfile.fragments.length, 1);
  });
});

// ── textParser — perHost operators (Task 5) ───────────────────────────────────

const PERHOST_OP_FIXTURE = `Summary:
   - Profile ID: x
Execution Profile abc-123:
  Fragments:
    Fragment 0:
      Pipeline :0  (host=TNetworkAddress(hostname:10.0.0.1, port:9050)):
        PipelineTask (index=0):(ExecTime: 679.83us)
          RESULT_SINK_OPERATOR (id=0):(ExecTime: 114.905us)
            EXCHANGE_OPERATOR (id=4):(ExecTime: 98.403us)
        PipelineTask (index=1):(ExecTime: 200us)
          DATA_STREAM_SINK_OPERATOR (id=4,dst_id=4):(ExecTime: 50us)
            OLAP_SCAN_OPERATOR (id=0):(ExecTime: 30us)
`;

suite('textParser — perHost operators', () => {
  test('Two PipelineTasks have their own operator trees', () => {
    const ast = textParser(PERHOST_OP_FIXTURE);
    const tasks = ast.perHost.fragments[0].pipelines[0].tasks;
    assertEqual(tasks.length, 2);
    assertTrue(tasks[0].operators !== null);
    assertTrue(tasks[1].operators !== null);
    assertEqual(tasks[0].operators.name, 'RESULT_SINK_OPERATOR');
    assertEqual(tasks[1].operators.name, 'DATA_STREAM_SINK_OPERATOR');
  });
  test('Operator tree depth correct', () => {
    const ast = textParser(PERHOST_OP_FIXTURE);
    const root0 = ast.perHost.fragments[0].pipelines[0].tasks[0].operators;
    assertEqual(root0.children.length, 1);
    assertEqual(root0.children[0].name, 'EXCHANGE_OPERATOR');
    const root1 = ast.perHost.fragments[0].pipelines[0].tasks[1].operators;
    assertEqual(root1.children[0].name, 'OLAP_SCAN_OPERATOR');
  });
  test('Inline ExecTime captured in attrs', () => {
    const ast = textParser(PERHOST_OP_FIXTURE);
    const root = ast.perHost.fragments[0].pipelines[0].tasks[0].operators;
    assertEqual(root.attrs.get('ExecTime'), '114.905us');
    assertEqual(root.children[0].attrs.get('ExecTime'), '98.403us');
  });
  test('OLAP_SCAN with same id as merged is fine (no cross-pollution)', () => {
    const ast = textParser(PERHOST_OP_FIXTURE);
    const leaf = ast.perHost.fragments[0].pipelines[0].tasks[1].operators.children[0];
    assertEqual(leaf.id, 0);
    assertEqual(leaf.name, 'OLAP_SCAN_OPERATOR');
  });
});

// ── textParser — perHost counter routing (Task 6) ─────────────────────────────

const PERHOST_COUNTERS_FIXTURE = `Summary:
   - Profile ID: x
Execution Profile abc-123:
  Fragments:
    Fragment 0:
      Fragment Level Profile:  (host=TNetworkAddress(hostname:10.0.0.1, port:9050)):(ExecTime: 6.954ms)
         - BuildPipelinesTime: 34.585us
         - BuildTasksTime: 235.213us
      Pipeline :0  (host=TNetworkAddress(hostname:10.0.0.1, port:9050)):
        PipelineTask (index=0):(ExecTime: 679.83us)
           - TaskState: Finished
           - ExecuteTime: 403.353us
             - CloseTime: 16.919us
             - GetBlockTime: 7.906us
           - NumScheduleTimes: 3
          RESULT_SINK_OPERATOR (id=0):(ExecTime: 114.905us)
             - AppendBatchTime: 24.193us
               - CopyBufferTime: 0ns
             - BytesSent: 8.00 B
`;

suite('textParser — perHost counter routing', () => {
  test('FragmentLevel counters land in fragmentLevel.attrs', () => {
    const ast = textParser(PERHOST_COUNTERS_FIXTURE);
    const fl = ast.perHost.fragments[0].fragmentLevel;
    assertEqual(fl.attrs.get('BuildPipelinesTime'), '34.585us');
    assertEqual(fl.attrs.get('BuildTasksTime'), '235.213us');
  });
  test('PipelineTask counters land in task.attrs with dotted-path nesting', () => {
    const ast = textParser(PERHOST_COUNTERS_FIXTURE);
    const task = ast.perHost.fragments[0].pipelines[0].tasks[0];
    assertEqual(task.attrs.get('TaskState'), 'Finished');
    assertEqual(task.attrs.get('ExecuteTime'), '403.353us');
    assertEqual(task.attrs.get('ExecuteTime.CloseTime'), '16.919us');
    assertEqual(task.attrs.get('ExecuteTime.GetBlockTime'), '7.906us');
    assertEqual(task.attrs.get('NumScheduleTimes'), '3');
  });
  test('Operator counters land in op.attrs with dotted-path nesting', () => {
    const ast = textParser(PERHOST_COUNTERS_FIXTURE);
    const op = ast.perHost.fragments[0].pipelines[0].tasks[0].operators;
    assertEqual(op.attrs.get('AppendBatchTime'), '24.193us');
    assertEqual(op.attrs.get('AppendBatchTime.CopyBufferTime'), '0ns');
    assertEqual(op.attrs.get('BytesSent'), '8.00 B');
  });
  test('Operator counters do not leak into task.attrs', () => {
    const ast = textParser(PERHOST_COUNTERS_FIXTURE);
    const task = ast.perHost.fragments[0].pipelines[0].tasks[0];
    assertTrue(!task.attrs.has('AppendBatchTime'));
    assertTrue(!task.attrs.has('BytesSent'));
  });
});

// ── textParser — perHost operator with nested parens in header (Task 9) ──────
// Regression test for OLAP_SCAN with table name = X(X) producing nested
// parentheses in the operator header:
//   OLAP_SCAN_OPERATOR (id=0. nereids_id=209. table name = lineitem(lineitem)):(ExecTime: 1.614ms)
// Old RE_OPERATOR_PERHOST used [^)]*\) which stopped at the inner ")" of
// "(lineitem)" and then failed to match ":(ExecTime:" — so the scan was silently
// skipped.  The fix is .*?\) so backtracking can skip the inner ")" and land on
// the outer one.

const PERHOST_NESTED_PAREN_FIXTURE = `Summary:
   - Profile ID: x
Execution Profile abc-123:
  Fragments:
    Fragment 0:
      Pipeline :0  (host=TNetworkAddress(hostname:10.0.0.1, port:9050)):
        PipelineTask (index=0):(ExecTime: 2ms)
          AGGREGATION_OPERATOR (id=3 , nereids_id=230):(ExecTime: 25.837us)
            OLAP_SCAN_OPERATOR (id=0. nereids_id=209. table name = lineitem(lineitem)):(ExecTime: 1.614ms)
               - RowsReturned: 6001215
`;

suite('textParser — perHost nested-paren operator header', () => {
  test('OLAP_SCAN with table name = X(X) is parsed, not skipped', () => {
    const ast = textParser(PERHOST_NESTED_PAREN_FIXTURE);
    const task = ast.perHost.fragments[0].pipelines[0].tasks[0];
    assertTrue(task.operators !== null);
    const agg = task.operators;
    assertEqual(agg.name, 'AGGREGATION_OPERATOR');
    assertEqual(agg.children.length, 1);
    assertEqual(agg.children[0].name, 'OLAP_SCAN_OPERATOR');
  });
  test('OLAP_SCAN inline ExecTime captured despite nested parens', () => {
    const ast = textParser(PERHOST_NESTED_PAREN_FIXTURE);
    const scan = ast.perHost.fragments[0].pipelines[0].tasks[0].operators.children[0];
    assertEqual(scan.attrs.get('ExecTime'), '1.614ms');
  });
  test('OLAP_SCAN counters below nested-paren header are attributed correctly', () => {
    const ast = textParser(PERHOST_NESTED_PAREN_FIXTURE);
    const scan = ast.perHost.fragments[0].pipelines[0].tasks[0].operators.children[0];
    assertEqual(scan.attrs.get('RowsReturned'), '6001215');
  });
  test('No spurious warnings generated by nested-paren header', () => {
    const ast = textParser(PERHOST_NESTED_PAREN_FIXTURE);
    assertEqual(ast.warnings.length, 0);
  });
});

// ── textParser — perHost named blocks (Task 7) ────────────────────────────────

const PERHOST_NAMED_BLOCK_FIXTURE = `Summary:
   - Profile ID: x
Execution Profile abc-123:
  Fragments:
    Fragment 0:
      Pipeline :0  (host=TNetworkAddress(hostname:10.0.0.1, port:9050)):
        PipelineTask (index=0):(ExecTime: 1ms)
          OLAP_SCAN_OPERATOR (id=0):(ExecTime: 1.614ms)
             - RuntimeFilters: :
             - PushDownAggregate: COUNT
            VScanner:
               - ReadColumns: [l_shipdate]
               - PerScannerRunningTime: [163.063us, 64.045us, 112.836us, 17.614us, ]
              SegmentIterator:
                 - RowsBloomFilterFiltered: 0
                 - RowsZoneMapRuntimePredicateFiltered: 5
              IndexFilter:
`;

suite('textParser — perHost named blocks', () => {
  test('Counter outside any named block has flat key', () => {
    const ast = textParser(PERHOST_NAMED_BLOCK_FIXTURE);
    const op = ast.perHost.fragments[0].pipelines[0].tasks[0].operators;
    // RuntimeFilters value depends on whether the source preserved trailing whitespace.
    // Both ':' and ': ' are valid — assert it starts with ':'.
    assertContains(op.attrs.get('RuntimeFilters') ?? '', ':');
    assertEqual(op.attrs.get('PushDownAggregate'), 'COUNT');
  });
  test('Counter inside VScanner has VScanner.* prefix', () => {
    const ast = textParser(PERHOST_NAMED_BLOCK_FIXTURE);
    const op = ast.perHost.fragments[0].pipelines[0].tasks[0].operators;
    assertEqual(op.attrs.get('VScanner.ReadColumns'), '[l_shipdate]');
    assertEqual(op.attrs.get('VScanner.PerScannerRunningTime'), '[163.063us, 64.045us, 112.836us, 17.614us, ]');
  });
  test('Counter inside VScanner.SegmentIterator has nested prefix', () => {
    const ast = textParser(PERHOST_NAMED_BLOCK_FIXTURE);
    const op = ast.perHost.fragments[0].pipelines[0].tasks[0].operators;
    assertEqual(op.attrs.get('VScanner.SegmentIterator.RowsBloomFilterFiltered'), '0');
    assertEqual(op.attrs.get('VScanner.SegmentIterator.RowsZoneMapRuntimePredicateFiltered'), '5');
  });
  test('IndexFilter as bare block is accepted (empty body)', () => {
    const ast = textParser(PERHOST_NAMED_BLOCK_FIXTURE);
    const op = ast.perHost.fragments[0].pipelines[0].tasks[0].operators;
    assertTrue(op !== null);
  });
});

// ── Real samples — perHost (Task 9) ──────────────────────────────────────────
// These tests walk ast.perHost to verify that the per-host parser produces a
// meaningful tree for every real TPC-H sample file.
// SAMPLE_PATHS is reused from the 'Real samples' suite above — do NOT redeclare.

function countPerHostOperators(ast) {
  let n = 0;
  function walk(node) { if (!node) return; n++; for (const c of node.children) walk(c); }
  for (const f of ast.perHost.fragments) {
    for (const p of f.pipelines) {
      for (const t of p.tasks) walk(t.operators);
    }
  }
  return n;
}

function countPerHostScans(ast) {
  let n = 0;
  function walk(node) {
    if (!node) return;
    if (node.name === 'OLAP_SCAN_OPERATOR') n++;
    for (const c of node.children) walk(c);
  }
  for (const f of ast.perHost.fragments) {
    for (const p of f.pipelines) {
      for (const t of p.tasks) walk(t.operators);
    }
  }
  return n;
}

suite('Real samples — perHost', () => {
  for (const path of SAMPLE_PATHS) {
    test(`${path} — has ≥1 perHost fragment`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(r.ast.perHost.fragments.length >= 1);
    });
    test(`${path} — has ≥1 PipelineTask`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      let taskCount = 0;
      for (const f of r.ast.perHost.fragments) {
        for (const p of f.pipelines) taskCount += p.tasks.length;
      }
      assertTrue(taskCount >= 1, `Got ${taskCount} tasks`);
    });
    test(`${path} — has ≥1 perHost operator`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(countPerHostOperators(r.ast) >= 1);
    });
    test(`${path} — has ≥1 perHost OLAP_SCAN`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(countPerHostScans(r.ast) >= 1, `Got ${countPerHostScans(r.ast)} OLAP_SCAN ops`);
    });
    test(`${path} — warnings still <50`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      assertTrue(r.ast.warnings.length < 50, `Got ${r.ast.warnings.length} warnings`);
    });
  }
});

// ── typeOlapScan — merged-side accessor (Task 11) ────────────────────────────

import { typeOlapScan } from '../js/parser/operators/olapScan.js';

function makeMergedScanNode() {
  const node = {
    name: 'OLAP_SCAN_OPERATOR',
    rawHeader: 'OLAP_SCAN_OPERATOR (id=0. nereids_id=209. table name = lineitem(lineitem)):',
    id: 0,
    meta: new Map(),
    attrs: new Map(),
    startLine: 0, endLine: 0, children: [],
  };
  node.attrs.set('PlanInfo', '');
  node.attrs.set('PlanInfo.TABLE', 'tpch.lineitem(lineitem), PREAGGREGATION: ON');
  node.attrs.set('PlanInfo.partitions', '1/1 (lineitem)');
  node.attrs.set('PlanInfo.tablets', '96/96, tabletList=1,2,3 ...');
  node.attrs.set('PlanInfo.cardinality', '6001215, avgRowSize=157.78, numNodes=3');
  node.attrs.set('PlanInfo.pushAggOp', 'COUNT');
  node.attrs.set('ExecTime', 'avg 1.578ms, max 2.252ms, min 931.799us');
  node.attrs.set('RowsProduced', 'sum 6.001215M (6001215), avg 250.05K (250050), max 252.575K (252575), min 247.901K (247901)');
  node.attrs.set('BlocksProduced', 'sum 96, avg 4, max 4, min 4');
  node.attrs.set('MemoryUsagePeak', 'sum 4.75 MB, avg 202.67 KB, max 256.00 KB, min 128.00 KB');
  node.attrs.set('WaitForDependency[OLAP_SCAN_OPERATOR_DEPENDENCY]Time', 'avg 521.603us, max 1.152ms, min 83.117us');
  return node;
}

suite('typeOlapScan', () => {
  test('extracts table name (without alias parens)', () => {
    const t = typeOlapScan(makeMergedScanNode());
    assertEqual(t.table, 'lineitem');
  });
  test('extracts cardinality as integer', () => {
    const t = typeOlapScan(makeMergedScanNode());
    assertEqual(t.cardinality, 6001215);
  });
  test('extracts pushAggOp and partitions/tablets raw', () => {
    const t = typeOlapScan(makeMergedScanNode());
    assertEqual(t.pushAggOp, 'COUNT');
    assertEqual(t.partitions, '1/1 (lineitem)');
    assertEqual(t.tablets, '96/96, tabletList=1,2,3 ...');
  });
  test('parses ExecTime avg/max/min triple', () => {
    const t = typeOlapScan(makeMergedScanNode());
    assertEqual(t.execTime, { avg_ns: 1578000, max_ns: 2252000, min_ns: 931799 });
  });
  test('parses RowsProduced sum/avg/max/min', () => {
    const t = typeOlapScan(makeMergedScanNode());
    assertEqual(t.rowsProduced, { sum: 6001215, avg: 250050, max: 252575, min: 247901 });
  });
  test('parses MemoryUsagePeak in bytes', () => {
    const t = typeOlapScan(makeMergedScanNode());
    assertEqual(t.memoryPeak.max, 262144);
  });
  test('null for missing counters', () => {
    const node = makeMergedScanNode();
    node.attrs.delete('WaitForDependency[OLAP_SCAN_OPERATOR_DEPENDENCY]Time');
    const t = typeOlapScan(node);
    assertEqual(t.waitForDependency, null);
  });
});

// ── typeOlapScanInstance — per-host accessor (Task 12) ───────────────────────

import { typeOlapScanInstance } from '../js/parser/operators/olapScan.js';

function makePerHostScanNode() {
  const node = {
    name: 'OLAP_SCAN_OPERATOR',
    rawHeader: 'OLAP_SCAN_OPERATOR (id=0. nereids_id=209. table name = lineitem(lineitem)):(ExecTime: 1.614ms)',
    id: 0,
    meta: new Map(),
    attrs: new Map(),
    startLine: 0, endLine: 0, children: [],
  };
  node.attrs.set('ExecTime', '1.614ms');
  node.attrs.set('RowsRead', '251.384K (251384)');
  node.attrs.set('RowsProduced', '251.384K (251384)');
  node.attrs.set('BlocksProduced', '4');
  node.attrs.set('NumScanners', '4');
  node.attrs.set('TabletNum', '4');
  node.attrs.set('MemoryUsagePeak', '192.00 KB');
  node.attrs.set('ScannerWorkerWaitTime', '936.181us');
  node.attrs.set('WaitForDependency[OLAP_SCAN_OPERATOR_DEPENDENCY]Time', '1.40ms');
  node.attrs.set('WaitForRuntimeFilter', '0ns');
  node.attrs.set('PushDownAggregate', 'COUNT');
  node.attrs.set('PushDownPredicates', '[]');
  node.attrs.set('RuntimeFilters', ': ');
  node.attrs.set('VScanner.ReadColumns', '[l_shipdate]');
  node.attrs.set('VScanner.PerScannerRunningTime', '[163.063us, 64.045us, 112.836us, 17.614us, ]');
  node.attrs.set('VScanner.PerScannerRowsRead', '[63.01K, 63.03K, 62.98K, 62.36K, ]');
  node.attrs.set('VScanner.PerScannerWaitTime', '[92.433us, 94.184us, 90.672us, 658.892us, ]');
  node.attrs.set('VScanner.SegmentIterator.RowsBloomFilterFiltered', '0');
  node.attrs.set('VScanner.SegmentIterator.RowsZoneMapRuntimePredicateFiltered', '5');
  node.attrs.set('VScanner.SegmentIterator.RowsShortCircuitPredFiltered', '3');
  return node;
}

suite('typeOlapScanInstance', () => {
  test('scalar counters typed', () => {
    const t = typeOlapScanInstance(makePerHostScanNode());
    assertEqual(t.execTime_ns, 1614000);
    assertEqual(t.rowsRead, 251384);
    assertEqual(t.rowsProduced, 251384);
    assertEqual(t.numScanners, 4);
    assertEqual(t.tabletNum, 4);
    assertEqual(t.memoryUsagePeak, 196608);
  });
  test('per-scanner arrays typed', () => {
    const t = typeOlapScanInstance(makePerHostScanNode());
    assertEqual(t.perScannerRunningTime_ns, [163063, 64045, 112836, 17614]);
    assertEqual(t.perScannerRowsRead, [63010, 63030, 62980, 62360]);
    assertEqual(t.perScannerWaitTime_ns, [92433, 94184, 90672, 658892]);
  });
  test('filter counters typed', () => {
    const t = typeOlapScanInstance(makePerHostScanNode());
    assertEqual(t.rowsBloomFilterFiltered, 0);
    assertEqual(t.rowsZoneMapRuntimePredicateFiltered, 5);
    assertEqual(t.rowsShortCircuitPredFiltered, 3);
  });
  test('null for missing counters', () => {
    const node = makePerHostScanNode();
    node.attrs.delete('VScanner.SegmentIterator.RowsBloomFilterFiltered');
    const t = typeOlapScanInstance(node);
    assertEqual(t.rowsBloomFilterFiltered, null);
  });
});

// ── collectScans — real-sample aggregation (Task 13) ─────────────────────────

import { collectScans } from '../js/parser/operators/olapScan.js';

suite('collectScans — real samples', () => {
  test('count_lineitem has 1 scan row', async () => {
    const raw = await (await fetch('../samples/tpch/count_lineitem.txt')).text();
    const r = runPipeline(raw);
    const rows = collectScans(r.ast);
    assertEqual(rows.length, 1);
    assertEqual(rows[0].table, 'lineitem');
  });
  test('tpch_q3 has 3 scan rows (lineitem, orders, customer)', async () => {
    const raw = await (await fetch('../samples/tpch/tpch_q3.txt')).text();
    const r = runPipeline(raw);
    const rows = collectScans(r.ast);
    assertEqual(rows.length, 3);
    const tables = rows.map(x => x.table).sort();
    assertEqual(tables, ['customer', 'lineitem', 'orders']);
  });
  test('scan row has instances aggregated', async () => {
    const raw = await (await fetch('../samples/tpch/count_lineitem.txt')).text();
    const r = runPipeline(raw);
    const rows = collectScans(r.ast);
    assertTrue(rows[0].instances.length >= 8, `Got ${rows[0].instances.length} instances`);
    assertTrue(rows[0].rowsReadSum > 0);
  });
  test('skewMergedRatio computed for customer in tpch_q3', async () => {
    const raw = await (await fetch('../samples/tpch/tpch_q3.txt')).text();
    const r = runPipeline(raw);
    const rows = collectScans(r.ast);
    const customer = rows.find(x => x.table === 'customer');
    // customer: ExecTime max=3.910ms, min=340.421us → ratio ≈ 11.5
    assertTrue(customer.skewMergedRatio > 5, `Got skew ratio ${customer.skewMergedRatio}`);
  });
});

// ── JSON ↔ text equivalence — perHost (Task 10) ───────────────────────────────
// PAIRS is defined in the earlier 'JSON ↔ text equivalence' suite above.
// countPerHostOperators is defined in the 'Real samples — perHost' suite above.

suite('JSON ↔ text equivalence — perHost', () => {
  for (const [txtPath, jsonPath] of PAIRS) {
    test(`${txtPath} ≡ ${jsonPath} — perHost fragment count`, async () => {
      const t = runPipeline(await (await fetch(txtPath)).text());
      const j = runPipeline(await (await fetch(jsonPath)).text());
      assertEqual(t.ast.perHost.fragments.length, j.ast.perHost.fragments.length);
    });
    test(`${txtPath} ≡ ${jsonPath} — perHost pipeline counts per fragment`, async () => {
      const t = runPipeline(await (await fetch(txtPath)).text());
      const j = runPipeline(await (await fetch(jsonPath)).text());
      const tPipes = t.ast.perHost.fragments.map(f => f.pipelines.length);
      const jPipes = j.ast.perHost.fragments.map(f => f.pipelines.length);
      assertEqual(tPipes, jPipes);
    });
    test(`${txtPath} ≡ ${jsonPath} — perHost operator counts`, async () => {
      const t = runPipeline(await (await fetch(txtPath)).text());
      const j = runPipeline(await (await fetch(jsonPath)).text());
      assertEqual(countPerHostOperators(t.ast), countPerHostOperators(j.ast));
    });
  }
});

import { renderScanSummary } from '../js/render/scanSummary.js';

suite('renderScanSummary — smoke', () => {
  test('Empty AST renders empty state', () => {
    const container = document.createElement('div');
    const fakeAst = { mergedProfile: { fragments: [] }, perHost: { fragments: [] } };
    renderScanSummary(container, fakeAst);
    assertContains(container.innerHTML, 'No OLAP scan operators');
  });
});

// ── typeHashJoin / typeHashJoinSink — unit tests ──────────────────────────────

import { typeHashJoin, typeHashJoinSink, typeHashJoinInstance, typeHashJoinSinkInstance, collectJoins } from '../js/parser/operators/hashJoin.js';

function makeMergedHashJoinNode() {
  const node = {
    name: 'HASH_JOIN_OPERATOR',
    rawHeader: 'HASH_JOIN_OPERATOR (id=5 , nereids_id=960):',
    id: 5,
    meta: new Map(), attrs: new Map(),
    startLine: 0, endLine: 0, children: [],
  };
  node.attrs.set('PlanInfo', '');
  node.attrs.set('PlanInfo.join op', 'INNER JOIN(COLOCATE[])[]');
  node.attrs.set('PlanInfo.equal join conjunct', '(l_orderkey = o_orderkey)');
  node.attrs.set('PlanInfo.runtime filters', 'RF002[min_max] <- o_orderkey(218740/262144/1048576)');
  node.attrs.set('ExecTime', 'avg 497.335us, max 2.24ms, min 289.156us');
  node.attrs.set('ProjectionTime', 'avg 200.366us, max 1.100ms, min 84.153us');
  node.attrs.set('InitTime', 'avg 17.993us, max 36.914us, min 10.140us');
  node.attrs.set('WaitForDependency[HASH_JOIN_OPERATOR_DEPENDENCY]Time', 'avg 0ns, max 0ns, min 0ns');
  node.attrs.set('ProbeRows', 'sum 30.519K (30519), avg 1.271K (1271), max 1.394K (1394), min 1.114K (1114)');
  node.attrs.set('RowsProduced', 'sum 30.519K (30519), avg 1.271K (1271), max 1.394K (1394), min 1.114K (1114)');
  node.attrs.set('BlocksProduced', 'sum 96, avg 4, max 4, min 4');
  node.attrs.set('MemoryUsagePeak', 'sum 288.00 KB, avg 12.00 KB, max 12.00 KB, min 12.00 KB');
  return node;
}

function makeMergedHashJoinSinkNode() {
  const node = {
    name: 'HASH_JOIN_SINK_OPERATOR',
    rawHeader: 'HASH_JOIN_SINK_OPERATOR (id=5 , nereids_id=960):',
    id: 5,
    meta: new Map(), attrs: new Map(),
    startLine: 0, endLine: 0, children: [],
  };
  node.attrs.set('ExecTime', 'avg 365.883us, max 545.179us, min 199.384us');
  node.attrs.set('InitTime', 'avg 25.535us, max 81.292us, min 10.558us');
  node.attrs.set('InputRows', 'sum 147.126K (147126), avg 6.13K (6130), max 6.198K (6198), min 6.032K (6032)');
  node.attrs.set('MemoryUsagePeak', 'sum 4.31 MB, avg 183.95 KB, max 184.22 KB, min 183.57 KB');
  node.attrs.set('MemoryUsageHashTable', 'sum 1.31 MB, avg 55.95 KB, max 56.22 KB, min 55.57 KB');
  node.attrs.set('MemoryUsageBuildBlocks', 'sum 3.00 MB, avg 128.00 KB, max 128.00 KB, min 128.00 KB');
  node.attrs.set('WaitForDependency[HASH_JOIN_SINK_OPERATOR_DEPENDENCY]Time', 'avg 0ns, max 0ns, min 0ns');
  return node;
}

suite('typeHashJoin (merged probe)', () => {
  test('parses joinType + COLOCATE distribution from PlanInfo.join op', () => {
    const t = typeHashJoin(makeMergedHashJoinNode());
    assertEqual(t.joinType, 'INNER JOIN');
    assertEqual(t.distribution, 'COLOCATE');
  });
  test('parses BROADCAST distribution', () => {
    const node = makeMergedHashJoinNode();
    node.attrs.set('PlanInfo.join op', 'LEFT SEMI JOIN(BROADCAST)[]');
    const t = typeHashJoin(node);
    assertEqual(t.joinType, 'LEFT SEMI JOIN');
    assertEqual(t.distribution, 'BROADCAST');
  });
  test('extracts equal join conjunct and runtime filters', () => {
    const t = typeHashJoin(makeMergedHashJoinNode());
    assertEqual(t.equalJoinConjunct, '(l_orderkey = o_orderkey)');
    assertContains(t.runtimeFilters, 'RF002');
  });
  test('parses time avg/max/min and row sum/avg/max/min', () => {
    const t = typeHashJoin(makeMergedHashJoinNode());
    assertEqual(t.execTime.max_ns, 2240000);
    assertEqual(t.probeRows.sum, 30519);
    assertEqual(t.rowsProduced.max, 1394);
  });
  test('null for missing counters', () => {
    const node = makeMergedHashJoinNode();
    node.attrs.delete('PlanInfo.runtime filters');
    const t = typeHashJoin(node);
    assertEqual(t.runtimeFilters, null);
  });
});

suite('typeHashJoinSink (merged build)', () => {
  test('parses InputRows + hash table memory', () => {
    const t = typeHashJoinSink(makeMergedHashJoinSinkNode());
    assertEqual(t.inputRows.sum, 147126);
    assertEqual(t.memoryUsageHashTable.sum, 1373635);  // 1.31 MB
  });
  test('parses ExecTime', () => {
    const t = typeHashJoinSink(makeMergedHashJoinSinkNode());
    assertEqual(t.execTime.max_ns, 545179);
  });
});

function makePerHostHashJoinNode() {
  const node = {
    name: 'HASH_JOIN_OPERATOR',
    rawHeader: 'HASH_JOIN_OPERATOR (id=5 , nereids_id=960):(ExecTime: 433.995us)',
    id: 5,
    meta: new Map(), attrs: new Map(),
    startLine: 0, endLine: 0, children: [],
  };
  node.attrs.set('ExecTime', '433.995us');
  node.attrs.set('InitTime', '23.960us');
  node.attrs.set('InitProbeSideTime', '27.274us');
  node.attrs.set('ProbeExprCallTime', '1.634us');
  node.attrs.set('ProbeWhenSearchHashTableTime', '67.340us');
  node.attrs.set('ProbeRows', '1.225K (1225)');
  node.attrs.set('RowsProduced', '1.225K (1225)');
  node.attrs.set('MemoryUsagePeak', '12.00 KB');
  node.attrs.set('WaitForDependency[HASH_JOIN_OPERATOR_DEPENDENCY]Time', '0ns');
  return node;
}

function makePerHostHashJoinSinkNode() {
  const node = {
    name: 'HASH_JOIN_SINK_OPERATOR',
    rawHeader: 'HASH_JOIN_SINK_OPERATOR (id=5 , nereids_id=960):(ExecTime: 320.232us)',
    id: 5,
    meta: new Map(), attrs: new Map(),
    startLine: 0, endLine: 0, children: [],
  };
  node.attrs.set('JoinType', 'INNER_JOIN');
  node.attrs.set('BroadcastJoin', '0');
  node.attrs.set('BuildShareHashTable', '1');
  node.attrs.set('ShareHashTableEnabled', '1');
  node.attrs.set('ExecTime', '320.232us');
  node.attrs.set('BuildHashTableTime', '144.275us');
  node.attrs.set('BuildTableInsertTime', '99.411us');
  node.attrs.set('BuildRuntimeFilterTime', '167.408us');
  node.attrs.set('BuildExprCallTime', '1.307us');
  node.attrs.set('InputRows', '6.164K (6164)');
  node.attrs.set('MemoryUsageHashTable', '56.09 KB');
  node.attrs.set('MemoryUsagePeak', '184.09 KB');
  return node;
}

suite('typeHashJoinInstance / typeHashJoinSinkInstance', () => {
  test('probe instance: scalar times + rows + memory', () => {
    const t = typeHashJoinInstance(makePerHostHashJoinNode());
    assertEqual(t.execTime_ns, 433995);
    assertEqual(t.probeWhenSearchHashTableTime_ns, 67340);
    assertEqual(t.probeRows, 1225);
    assertEqual(t.memoryUsagePeak, 12288);
  });
  test('sink instance: build metadata + build-phase times', () => {
    const t = typeHashJoinSinkInstance(makePerHostHashJoinSinkNode());
    assertEqual(t.joinType, 'INNER_JOIN');
    assertEqual(t.broadcastJoin, '0');
    assertEqual(t.buildHashTableTime_ns, 144275);
    assertEqual(t.buildRuntimeFilterTime_ns, 167408);
    assertEqual(t.inputRows, 6164);
    assertEqual(t.memoryUsageHashTable, 57436); // 56.09 KB
  });
});

// ── collectJoins — real-sample integration ────────────────────────────────────

suite('collectJoins — real samples', () => {
  test('count_lineitem has 0 hash joins', async () => {
    const raw = await (await fetch('../samples/tpch/count_lineitem.txt')).text();
    const r = runPipeline(raw);
    assertEqual(collectJoins(r.ast).length, 0);
  });
  test('tpch_q1 has 0 hash joins', async () => {
    const raw = await (await fetch('../samples/tpch/tpch_q1.txt')).text();
    const r = runPipeline(raw);
    assertEqual(collectJoins(r.ast).length, 0);
  });
  test('tpch_q3 has 2 hash joins (COLOCATE l⋈o + BROADCAST o⋈c)', async () => {
    const raw = await (await fetch('../samples/tpch/tpch_q3.txt')).text();
    const r = runPipeline(raw);
    const rows = collectJoins(r.ast);
    assertEqual(rows.length, 2);
    const distribs = rows.map(x => x.distribution).sort();
    assertEqual(distribs, ['BROADCAST', 'COLOCATE']);
  });
  test('tpch_q3 join rows have paired probe + sink with 24 instances each', async () => {
    const raw = await (await fetch('../samples/tpch/tpch_q3.txt')).text();
    const r = runPipeline(raw);
    const rows = collectJoins(r.ast);
    for (const row of rows) {
      assertEqual(row.joinType, 'INNER JOIN');
      assertTrue(row.probeInstances.length === 24, `probeInstances=${row.probeInstances.length}`);
      assertTrue(row.sinkInstances.length === 24, `sinkInstances=${row.sinkInstances.length}`);
      assertTrue(row.buildHashTableTimeMax_ns !== null);
      assertTrue(row.hashTableMemSum !== null);
    }
  });
  test('tpch_q3 JSON ≡ text: same row count and distributions', async () => {
    const t = runPipeline(await (await fetch('../samples/tpch/tpch_q3.txt')).text());
    const j = runPipeline(await (await fetch('../samples/tpch/tpch_q3.json')).text());
    const tRows = collectJoins(t.ast);
    const jRows = collectJoins(j.ast);
    assertEqual(tRows.length, jRows.length);
    assertEqual(tRows.map(x => x.distribution).sort(), jRows.map(x => x.distribution).sort());
  });
});

import { renderJoinSummary } from '../js/render/joinSummary.js';

suite('renderJoinSummary — smoke', () => {
  test('Empty AST renders empty state', () => {
    const container = document.createElement('div');
    const fakeAst = { mergedProfile: { fragments: [] }, perHost: { fragments: [] } };
    renderJoinSummary(container, fakeAst);
    assertContains(container.innerHTML, 'No hash join operators');
  });
});

// ── planTree — Task 1: extractDstId ──────────────────────────────────────────

import { extractDstId } from '../js/parser/planTree.js';

suite('planTree — extractDstId', () => {
  test('EXCHANGE_OPERATOR (id=4):', () => {
    assertEqual(extractDstId('EXCHANGE_OPERATOR (id=4):'), 4);
  });
  test('EXCHANGE_OPERATOR (id=4) variants tolerate spaces and trailing colons', () => {
    assertEqual(extractDstId('EXCHANGE_OPERATOR (id=4 , nereids_id=900):'), 4);
  });
  test('DATA_STREAM_SINK_OPERATOR (id=4,dst_id=4):', () => {
    assertEqual(extractDstId('DATA_STREAM_SINK_OPERATOR (id=4,dst_id=4):'), 4);
  });
  test('DATA_STREAM_SINK with whitespace around dst_id', () => {
    assertEqual(extractDstId('DATA_STREAM_SINK_OPERATOR (id=4, dst_id = 7):'), 7);
  });
  test('Header without dst_id falls back to id= even with commas before id', () => {
    assertEqual(extractDstId('SOME_OP (id = 12, foo=3):'), 12);
  });
  test('No id at all returns null', () => {
    assertEqual(extractDstId('SOME_OPERATOR (no ids here):'), null);
  });
});

// ── planTree — Task 2: shortName + extractExecTimeMaxNs ──────────────────────

import { shortName, extractExecTimeMaxNs } from '../js/parser/planTree.js';

suite('planTree — shortName', () => {
  test('OLAP_SCAN_OPERATOR → OLAP_SCAN', () => {
    assertEqual(shortName('OLAP_SCAN_OPERATOR'), 'OLAP_SCAN');
  });
  test('HASH_JOIN_OPERATOR → HASH_JOIN', () => {
    assertEqual(shortName('HASH_JOIN_OPERATOR'), 'HASH_JOIN');
  });
  test('HASH_JOIN_SINK_OPERATOR → HASH_JOIN_SINK', () => {
    assertEqual(shortName('HASH_JOIN_SINK_OPERATOR'), 'HASH_JOIN_SINK');
  });
  test('AGGREGATION_OPERATOR → AGG', () => {
    assertEqual(shortName('AGGREGATION_OPERATOR'), 'AGG');
  });
  test('STREAMING_AGGREGATION_OPERATOR → STREAM_AGG', () => {
    assertEqual(shortName('STREAMING_AGGREGATION_OPERATOR'), 'STREAM_AGG');
  });
  test('AGGREGATION_SINK_OPERATOR → AGG_SINK', () => {
    assertEqual(shortName('AGGREGATION_SINK_OPERATOR'), 'AGG_SINK');
  });
  test('EXCHANGE_OPERATOR → EXCH', () => {
    assertEqual(shortName('EXCHANGE_OPERATOR'), 'EXCH');
  });
  test('DATA_STREAM_SINK_OPERATOR → STREAM_SINK', () => {
    assertEqual(shortName('DATA_STREAM_SINK_OPERATOR'), 'STREAM_SINK');
  });
  test('RESULT_SINK_OPERATOR → RESULT_SINK', () => {
    assertEqual(shortName('RESULT_SINK_OPERATOR'), 'RESULT_SINK');
  });
  test('LOCAL_EXCHANGE_OPERATOR → LOCAL_EXCH', () => {
    assertEqual(shortName('LOCAL_EXCHANGE_OPERATOR'), 'LOCAL_EXCH');
  });
  test('Unknown operator strips _OPERATOR', () => {
    assertEqual(shortName('FOO_BAR_OPERATOR'), 'FOO_BAR');
  });
});

suite('planTree — extractExecTimeMaxNs', () => {
  test('From merged-side ExecTime value', () => {
    const attrs = new Map([['ExecTime', 'avg 497.335us, max 2.24ms, min 289.156us']]);
    assertEqual(extractExecTimeMaxNs(attrs), 2240000);
  });
  test('Returns null when ExecTime missing', () => {
    assertEqual(extractExecTimeMaxNs(new Map()), null);
  });
  test('Returns null when ExecTime unparseable', () => {
    const attrs = new Map([['ExecTime', 'some garbage']]);
    assertEqual(extractExecTimeMaxNs(attrs), null);
  });
});

// ── planTree — Task 3: buildPlanTree single fragment ─────────────────────────

import { buildPlanTree } from '../js/parser/planTree.js';

const SINGLE_FRAGMENT_FIXTURE = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           RESULT_SINK_OPERATOR (id=0):
              - ExecTime: avg 1ms, max 1ms, min 1ms
             EXCHANGE_OPERATOR (id=5):
                - ExecTime: avg 2ms, max 2ms, min 2ms
               OLAP_SCAN_OPERATOR (id=0. nereids_id=209. table name = lineitem(lineitem)):
                  - ExecTime: avg 3ms, max 3ms, min 3ms
`;

suite('buildPlanTree — single fragment', () => {
  test('Three operators → three nodes, root at index 0', () => {
    const ast = textParser(SINGLE_FRAGMENT_FIXTURE);
    const plan = buildPlanTree(ast);
    assertEqual(plan.nodes.length, 3);
    assertEqual(plan.nodes[0].name, 'RESULT_SINK_OPERATOR');
    assertEqual(plan.nodes[0].parentIdx, null);
  });
  test('parent/child indexes form the operator chain', () => {
    const ast = textParser(SINGLE_FRAGMENT_FIXTURE);
    const plan = buildPlanTree(ast);
    const [sink, exch, scan] = plan.nodes;
    assertEqual(sink.childrenIdx, [exch.idx]);
    assertEqual(exch.parentIdx, sink.idx);
    assertEqual(exch.childrenIdx, [scan.idx]);
    assertEqual(scan.parentIdx, exch.idx);
    assertEqual(scan.childrenIdx, []);
  });
  test('Every node has fragmentId, opId, shortName, attrsRef', () => {
    const ast = textParser(SINGLE_FRAGMENT_FIXTURE);
    const plan = buildPlanTree(ast);
    for (const n of plan.nodes) {
      assertEqual(n.fragmentId, 0);
      assertTrue(typeof n.opId === 'number');
      assertTrue(typeof n.shortName === 'string' && n.shortName.length > 0);
      assertTrue(n.attrsRef instanceof Map);
    }
  });
  test('rootIdx points at the RESULT_SINK_OPERATOR', () => {
    const ast = textParser(SINGLE_FRAGMENT_FIXTURE);
    const plan = buildPlanTree(ast);
    assertEqual(plan.rootIdx, 0);
    assertEqual(plan.nodes[plan.rootIdx].name, 'RESULT_SINK_OPERATOR');
  });
});

// ── planTree — Task 4: fragmentMaxExecTime ────────────────────────────────────

const MULTI_OP_FRAGMENT_FIXTURE = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           RESULT_SINK_OPERATOR (id=0):
              - ExecTime: avg 1ms, max 1ms, min 1ms
             EXCHANGE_OPERATOR (id=5):
                - ExecTime: avg 5ms, max 5ms, min 5ms
       Fragment 1:
         Pipeline : 0(instance_num=24):
           OLAP_SCAN_OPERATOR (id=10):
              - ExecTime: avg 22ms, max 30ms, min 18ms
         Pipeline : 1(instance_num=24):
           OLAP_SCAN_OPERATOR (id=11):
              - ExecTime: avg 8ms, max 10ms, min 6ms
`;

suite('buildPlanTree — fragmentMaxExecTime', () => {
  test('Fragment 0 max is the EXCHANGE (5ms)', () => {
    const ast = textParser(MULTI_OP_FRAGMENT_FIXTURE);
    const plan = buildPlanTree(ast);
    assertEqual(plan.fragmentMaxExecTime[0], 5_000_000);
  });
  test('Fragment 1 max is the first OLAP_SCAN (30ms)', () => {
    const ast = textParser(MULTI_OP_FRAGMENT_FIXTURE);
    const plan = buildPlanTree(ast);
    assertEqual(plan.fragmentMaxExecTime[1], 30_000_000);
  });
  test('fragmentMaxExecTime entry is null when no operator has parseable ExecTime', () => {
    const fx = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           RESULT_SINK_OPERATOR (id=0):
              - SomethingElse: 1
`;
    const ast = textParser(fx);
    const plan = buildPlanTree(ast);
    assertEqual(plan.fragmentMaxExecTime[0], null);
  });
});

// ── planTree — Task 5: cross-fragment stitching ───────────────────────────────

const TWO_FRAGMENT_STITCH_FIXTURE = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           RESULT_SINK_OPERATOR (id=0):
              - ExecTime: avg 1ms, max 1ms, min 1ms
             EXCHANGE_OPERATOR (id=4):
                - ExecTime: avg 2ms, max 2ms, min 2ms
       Fragment 1:
         Pipeline : 0(instance_num=24):
           DATA_STREAM_SINK_OPERATOR (id=4,dst_id=4):
              - ExecTime: avg 3ms, max 3ms, min 3ms
             OLAP_SCAN_OPERATOR (id=10):
                - ExecTime: avg 4ms, max 4ms, min 4ms
`;

suite('buildPlanTree — cross-fragment stitching', () => {
  test('EXCHANGE id=4 is linked to DATA_STREAM_SINK dst_id=4', () => {
    const ast = textParser(TWO_FRAGMENT_STITCH_FIXTURE);
    const plan = buildPlanTree(ast);
    const exch = plan.nodes.find(n => n.name === 'EXCHANGE_OPERATOR');
    const sink = plan.nodes.find(n => n.name === 'DATA_STREAM_SINK_OPERATOR');
    assertTrue(exch !== undefined);
    assertTrue(sink !== undefined);
    assertEqual(exch.crossFragmentLink.kind, 'exchange');
    assertEqual(exch.crossFragmentLink.dstId, 4);
    assertEqual(exch.crossFragmentLink.peerIdx, sink.idx);
  });
  test('No warnings on a clean stitch', () => {
    const ast = textParser(TWO_FRAGMENT_STITCH_FIXTURE);
    const plan = buildPlanTree(ast);
    assertEqual(plan.warnings, []);
  });
  test('LOCAL_EXCHANGE_OPERATOR is not stitched', () => {
    const fx = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           LOCAL_EXCHANGE_OPERATOR (PASSTHROUGH) (id=-8):
              - ExecTime: avg 1ms, max 1ms, min 1ms
`;
    const ast = textParser(fx);
    const plan = buildPlanTree(ast);
    const lx = plan.nodes.find(n => n.name === 'LOCAL_EXCHANGE_OPERATOR');
    assertTrue(lx !== undefined);
    assertEqual(lx.crossFragmentLink, null);
  });
});

// ── planTree — Task 6: rootIdx + warnings ────────────────────────────────────

suite('buildPlanTree — rootIdx + warnings', () => {
  test('rootIdx points at the RESULT_SINK across fragments', () => {
    const ast = textParser(TWO_FRAGMENT_STITCH_FIXTURE);
    const plan = buildPlanTree(ast);
    assertEqual(plan.nodes[plan.rootIdx].name, 'RESULT_SINK_OPERATOR');
  });
  test('rootIdx falls back to fragmentRoots[0] when no RESULT_SINK', () => {
    const fx = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           OLAP_SCAN_OPERATOR (id=0):
              - ExecTime: avg 1ms, max 1ms, min 1ms
`;
    const ast = textParser(fx);
    const plan = buildPlanTree(ast);
    assertEqual(plan.rootIdx, 0);
    assertEqual(plan.nodes[plan.rootIdx].name, 'OLAP_SCAN_OPERATOR');
  });
  test('Unmatched EXCHANGE produces a warning + peerIdx null', () => {
    const fx = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           EXCHANGE_OPERATOR (id=99):
              - ExecTime: avg 1ms, max 1ms, min 1ms
`;
    const ast = textParser(fx);
    const plan = buildPlanTree(ast);
    const exch = plan.nodes.find(n => n.name === 'EXCHANGE_OPERATOR');
    assertEqual(exch.crossFragmentLink.peerIdx, null);
    assertEqual(plan.warnings.length, 1);
    assertContains(plan.warnings[0].message, 'Unmatched EXCHANGE');
  });
  test('Duplicate DATA_STREAM_SINK dst_id produces a warning', () => {
    const fx = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           DATA_STREAM_SINK_OPERATOR (id=4,dst_id=7):
              - ExecTime: avg 1ms, max 1ms, min 1ms
       Fragment 1:
         Pipeline : 0(instance_num=24):
           DATA_STREAM_SINK_OPERATOR (id=5,dst_id=7):
              - ExecTime: avg 2ms, max 2ms, min 2ms
`;
    const ast = textParser(fx);
    const plan = buildPlanTree(ast);
    assertEqual(plan.warnings.length, 1);
    assertContains(plan.warnings[0].message, 'Duplicate');
  });
  test('EXCHANGE_OPERATOR with no parseable id emits a warning', () => {
    // Craft a node manually since textParser would reject this header anyway.
    const ast = {
      mergedProfile: {
        fragments: [{
          id: 0,
          pipelines: [{
            id: 0,
            operators: {
              name: 'EXCHANGE_OPERATOR',
              rawHeader: 'EXCHANGE_OPERATOR (broken header):',
              id: 5,
              attrs: new Map(),
              children: [],
            },
          }],
        }],
      },
      perHost: { fragments: [] },
    };
    const plan = buildPlanTree(ast);
    assertTrue(plan.warnings.length >= 1);
    assertContains(plan.warnings[0].message, 'no parseable id');
  });
});

// ── planTree — Task 7: real-sample integration ────────────────────────────────
// SAMPLE_PATHS and PAIRS are defined in earlier suites above — do NOT redeclare.
// runPipeline is already imported above.

suite('buildPlanTree — real samples', () => {
  for (const path of SAMPLE_PATHS) {
    test(`${path} — buildPlanTree no exception, rootIdx set`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      const plan = buildPlanTree(r.ast);
      assertTrue(plan.nodes.length > 0, `Got ${plan.nodes.length} nodes`);
      assertTrue(plan.rootIdx !== null);
    });
    test(`${path} — every EXCHANGE has dstId set`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      const plan = buildPlanTree(r.ast);
      const exchanges = plan.nodes.filter(n => n.name === 'EXCHANGE_OPERATOR');
      for (const e of exchanges) {
        assertTrue(e.crossFragmentLink !== null);
        assertTrue(typeof e.crossFragmentLink.dstId === 'number');
      }
    });
  }
  test('tpch_q3.txt — 3 fragments, rootIdx is RESULT_SINK in fragment 0', async () => {
    const raw = await (await fetch('../samples/tpch/tpch_q3.txt')).text();
    const r = runPipeline(raw);
    const plan = buildPlanTree(r.ast);
    assertEqual(plan.fragmentRoots.length, 3);
    assertEqual(plan.nodes[plan.rootIdx].name, 'RESULT_SINK_OPERATOR');
    assertEqual(plan.nodes[plan.rootIdx].fragmentId, 0);
  });
});

suite('buildPlanTree — JSON ≡ text equivalence', () => {
  for (const [txtPath, jsonPath] of PAIRS) {
    test(`${txtPath} ≡ ${jsonPath} — same node count`, async () => {
      const t = runPipeline(await (await fetch(txtPath)).text());
      const j = runPipeline(await (await fetch(jsonPath)).text());
      assertEqual(buildPlanTree(t.ast).nodes.length, buildPlanTree(j.ast).nodes.length);
    });
    test(`${txtPath} ≡ ${jsonPath} — same root fragment+opId`, async () => {
      const t = runPipeline(await (await fetch(txtPath)).text());
      const j = runPipeline(await (await fetch(jsonPath)).text());
      const tp = buildPlanTree(t.ast);
      const jp = buildPlanTree(j.ast);
      assertEqual(
        { f: tp.nodes[tp.rootIdx].fragmentId, op: tp.nodes[tp.rootIdx].opId },
        { f: jp.nodes[jp.rootIdx].fragmentId, op: jp.nodes[jp.rootIdx].opId },
      );
    });
  }
});

// ── layout — Task 8: computeDepths ───────────────────────────────────────────

import { computeDepths } from '../js/render/planTree.js';

suite('layout — computeDepths', () => {
  test('Single-chain 3 nodes → depths [0, 1, 2]', () => {
    const ast = textParser(SINGLE_FRAGMENT_FIXTURE);
    const plan = buildPlanTree(ast);
    const depths = computeDepths(plan);
    assertEqual(depths, [0, 1, 2]);
  });
  test('Stitched 2 fragments → peer depth = exchange depth + 1', () => {
    const ast = textParser(TWO_FRAGMENT_STITCH_FIXTURE);
    const plan = buildPlanTree(ast);
    const depths = computeDepths(plan);
    // nodes order: F0 RESULT_SINK(0), F0 EXCH(1), F1 STREAM_SINK(2), F1 OLAP_SCAN(3)
    assertEqual(depths[0], 0);   // RESULT_SINK
    assertEqual(depths[1], 1);   // EXCHANGE
    assertEqual(depths[2], 2);   // peer SINK, one level below EXCH
    assertEqual(depths[3], 3);   // OLAP_SCAN under SINK
  });
});

// ── layout — Task 9: computeSubtreeWidths ────────────────────────────────────

import { computeSubtreeWidths, NODE_W, H_GAP } from '../js/render/planTree.js';

suite('layout — computeSubtreeWidths', () => {
  test('Single leaf width = NODE_W', () => {
    const fx = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           OLAP_SCAN_OPERATOR (id=0):
              - ExecTime: avg 1ms, max 1ms, min 1ms
`;
    const ast = textParser(fx);
    const plan = buildPlanTree(ast);
    const w = computeSubtreeWidths(plan);
    assertEqual(w[0], NODE_W);
  });
  test('Two-leaf siblings → root width = 2*NODE_W + H_GAP', () => {
    const fx = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           HASH_JOIN_OPERATOR (id=0):
              - ExecTime: avg 1ms, max 1ms, min 1ms
             OLAP_SCAN_OPERATOR (id=1):
                - ExecTime: avg 1ms, max 1ms, min 1ms
             OLAP_SCAN_OPERATOR (id=2):
                - ExecTime: avg 1ms, max 1ms, min 1ms
`;
    const ast = textParser(fx);
    const plan = buildPlanTree(ast);
    const w = computeSubtreeWidths(plan);
    assertEqual(w[0], 2 * NODE_W + H_GAP);   // HASH_JOIN root
    assertEqual(w[1], NODE_W);
    assertEqual(w[2], NODE_W);
  });
});

// ── layout — Task 10: layoutPlan ─────────────────────────────────────────────

import { layoutPlan, NODE_H, V_GAP } from '../js/render/planTree.js';

suite('layout — layoutPlan', () => {
  test('Single-chain → x identical, y descending by (NODE_H + V_GAP)', () => {
    const ast = textParser(SINGLE_FRAGMENT_FIXTURE);
    const plan = buildPlanTree(ast);
    const pos = layoutPlan(plan);
    assertEqual(pos[0].x, pos[1].x);
    assertEqual(pos[1].x, pos[2].x);
    assertEqual(pos[1].y - pos[0].y, NODE_H + V_GAP);
    assertEqual(pos[2].y - pos[1].y, NODE_H + V_GAP);
  });
  test('Two-leaf siblings → leaves evenly flank root', () => {
    const fx = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           HASH_JOIN_OPERATOR (id=0):
              - ExecTime: avg 1ms, max 1ms, min 1ms
             OLAP_SCAN_OPERATOR (id=1):
                - ExecTime: avg 1ms, max 1ms, min 1ms
             OLAP_SCAN_OPERATOR (id=2):
                - ExecTime: avg 1ms, max 1ms, min 1ms
`;
    const ast = textParser(fx);
    const plan = buildPlanTree(ast);
    const pos = layoutPlan(plan);
    assertEqual(pos[2].x - pos[1].x, NODE_W + H_GAP);
    assertEqual(pos[0].x, (pos[1].x + pos[2].x) / 2);
    assertEqual(pos[1].y, pos[2].y);
  });
  test('Stitched 2 fragments → peer y = exchange.y + (NODE_H + V_GAP)', () => {
    const ast = textParser(TWO_FRAGMENT_STITCH_FIXTURE);
    const plan = buildPlanTree(ast);
    const pos = layoutPlan(plan);
    const exch = plan.nodes.find(n => n.name === 'EXCHANGE_OPERATOR');
    const sink = plan.nodes.find(n => n.name === 'DATA_STREAM_SINK_OPERATOR');
    assertEqual(pos[sink.idx].y - pos[exch.idx].y, NODE_H + V_GAP);
  });
});

// ── layout — multi-pipeline fragments (Phase 2 fix) ──────────────────────────

const MULTI_PIPELINE_FIXTURE = `Summary:
   - Profile ID: x
MergedProfile
     Fragments:
       Fragment 0:
         Pipeline : 0(instance_num=1):
           RESULT_SINK_OPERATOR (id=0):
              - ExecTime: avg 1ms, max 1ms, min 1ms
         Pipeline : 1(instance_num=1):
           AGGREGATION_OPERATOR (id=10):
              - ExecTime: avg 2ms, max 2ms, min 2ms
         Pipeline : 2(instance_num=1):
           SORT_OPERATOR (id=11):
              - ExecTime: avg 3ms, max 3ms, min 3ms
`;

suite('layout — multi-pipeline fragments', () => {
  test('pipelineRoots records every parentIdx=null node', () => {
    const ast = textParser(MULTI_PIPELINE_FIXTURE);
    const plan = buildPlanTree(ast);
    assertEqual(plan.pipelineRoots.length, 3);
  });
  test('layoutPlan places all pipeline roots (all have distinct x)', () => {
    const ast = textParser(MULTI_PIPELINE_FIXTURE);
    const plan = buildPlanTree(ast);
    const pos = layoutPlan(plan);
    const rootIdxs = plan.pipelineRoots.map(r => r.idx);
    const xs = rootIdxs.map(i => pos[i].x);
    const xSet = new Set(xs);
    assertTrue(xSet.size === 3, `Expected 3 unique x values; got ${xSet.size}: ${xs}`);
  });
  test('computeDepths assigns a depth to every node', () => {
    const ast = textParser(MULTI_PIPELINE_FIXTURE);
    const plan = buildPlanTree(ast);
    const depths = computeDepths(plan);
    for (let i = 0; i < depths.length; i++) {
      assertTrue(depths[i] !== null, `Node ${i} has null depth`);
    }
  });
});

suite('layout — real samples reach every node', () => {
  for (const path of SAMPLE_PATHS) {
    test(`${path} — every node has a depth assigned`, async () => {
      const raw = await (await fetch(path)).text();
      const r = runPipeline(raw);
      const plan = buildPlanTree(r.ast);
      const depths = computeDepths(plan);
      const orphans = depths.filter(d => d === null).length;
      assertEqual(orphans, 0);
    });
  }
});
