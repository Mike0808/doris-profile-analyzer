---
description: Guided workflow for adding parser + render support for a new Doris operator type
---

Adding support for a new operator follows a strict sequence. Do not skip steps.

## Step 1 — Inventory

Identify all samples in `samples/` that contain the target operator type
(e.g., `HASH_JOIN_OPERATOR`). Use grep. List the files and the variety of
configurations the operator appears in (different join types, with/without
runtime filters, with/without spill, etc.).

If the operator does NOT appear in any sample, STOP. Tell the user which
TPC-H/TPC-DS query is expected to produce this operator, ask them to
generate that profile and add it to `samples/`. Do not write a parser for
an operator you cannot test.

## Step 2 — Verify against docs

Run `/check-docs` against your list of metrics for this operator. Confirm
field names and their meaning against the official Doris 3.x documentation.

## Step 3 — Parser

Create `js/parser/operators/<operatorName>.js` (camelCase, e.g.
`hashJoin.js`). The module exports a single function:

```js
export function parseHashJoin(operatorBlock) {
  // operatorBlock is the lines of text for this operator from textParser.js
  // Returns a normalized object matching the AST shape in js/parser/ast.js
  return {
    type: 'HASH_JOIN_OPERATOR',
    id: ...,
    execTime: ...,
    waitForDependencyTime: ...,
    peakMemoryUsage: ...,
    specific: {
      // operator-specific fields here
    },
  };
}
```

Run the parser against ALL sample files. Fix until zero exceptions and the
output is sensible (no `NaN`, no `undefined` where a value is expected).

## Step 4 — Render

Add the operator to the relevant tab(s):
- All operators: appear in **Plan Tree** with their basic metrics.
- `OLAP_SCAN_OPERATOR`: also a row in **Scan Summary**.
- `HASH_JOIN_OPERATOR`: also a row in **Join Summary**.
- Others: Plan Tree only, for now.

## Step 5 — Regression check

Open the app in a browser. Load each sample file in turn. Verify:
- No console errors.
- The new operator appears with sensible values.
- Other operators that were working before still work.

## Step 6 — Doc the operator

Append a one-paragraph section to `docs/operators.md` (create the file if
absent) describing what this operator does in Doris, which queries
typically produce it, and which metrics matter for performance debugging.

Arguments: $ARGUMENTS (the operator type name, e.g. `HASH_JOIN_OPERATOR`)
