// Generic AST factories for Doris profile parsing.
// See docs/superpowers/specs/2026-05-12-iteration-1-parser-raw-design.md §4

export function createAst() {
  return {
    format: 'text',
    sourceText: '',
    summary: new Map(),
    executionSummary: new Map(),
    mergedProfile: { fragments: [] },
    opaqueBlocks: [],
    warnings: [],
  };
}

export function createFragment({ id, startLine }) {
  return { id, startLine, endLine: startLine, pipelines: [] };
}

export function createPipeline({ id, instanceNum, startLine }) {
  return { id, instanceNum, startLine, endLine: startLine, operators: null };
}

export function createOperator({ name, rawHeader, id, startLine }) {
  return {
    name,
    rawHeader,
    id: id ?? null,
    meta: new Map(),
    attrs: new Map(),
    startLine,
    endLine: startLine,
    children: [],
  };
}
