import { suite, test, assertEqual, assertTrue, assertContains } from './runner.js';
import { createAst, createOperator, createPipeline, createFragment } from '../js/parser/ast.js';

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
