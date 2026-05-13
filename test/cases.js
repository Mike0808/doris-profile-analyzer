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
