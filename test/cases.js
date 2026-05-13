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
