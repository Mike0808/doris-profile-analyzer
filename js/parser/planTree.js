// Builds a unified plan tree model from ast.mergedProfile.
// Cross-fragment stitching pairs EXCHANGE_OPERATOR with DATA_STREAM_SINK_OPERATOR
// by dst_id. The renderer in js/render/planTree.js consumes this model.
//
// Doris 3.x: https://doris.apache.org/docs/3.x/query-acceleration/tuning/profiling-tools/

import { parseAvgMaxMin } from '../util/format.js';

// ── Task 1: Header-parsing helpers ────────────────────────────────────────────

/**
 * Extract the routing id from a raw operator header string.
 * Prefer dst_id (DATA_STREAM_SINK) over id= (EXCHANGE + all others).
 * Returns a Number or null.
 *
 * Examples:
 *   'DATA_STREAM_SINK_OPERATOR (id=4,dst_id=4):'  → 4
 *   'DATA_STREAM_SINK_OPERATOR (id=4, dst_id = 7):' → 7
 *   'EXCHANGE_OPERATOR (id=4):'                    → 4
 *   'SOME_OPERATOR (no ids here):'                 → null
 */
export function extractDstId(rawHeader) {
  if (typeof rawHeader !== 'string') return null;
  const dst = /dst_id\s*=\s*(-?\d+)/.exec(rawHeader);
  if (dst) return Number(dst[1]);
  const id = /\(id\s*=\s*(-?\d+)/.exec(rawHeader);
  if (id) return Number(id[1]);
  return null;
}

// ── Task 2: Short-name mapping ─────────────────────────────────────────────────

const SHORT_NAME_MAP = {
  OLAP_SCAN_OPERATOR:              'OLAP_SCAN',
  HASH_JOIN_OPERATOR:              'HASH_JOIN',
  HASH_JOIN_SINK_OPERATOR:         'HASH_JOIN_SINK',
  AGGREGATION_OPERATOR:            'AGG',
  STREAMING_AGGREGATION_OPERATOR:  'STREAM_AGG',
  AGGREGATION_SINK_OPERATOR:       'AGG_SINK',
  EXCHANGE_OPERATOR:               'EXCH',
  DATA_STREAM_SINK_OPERATOR:       'STREAM_SINK',
  RESULT_SINK_OPERATOR:            'RESULT_SINK',
  SORT_OPERATOR:                   'SORT',
  SORT_SINK_OPERATOR:              'SORT_SINK',
  LOCAL_EXCHANGE_OPERATOR:         'LOCAL_EXCH',
  LOCAL_EXCHANGE_SINK_OPERATOR:    'LOCAL_EXCH_SINK',
};

export function shortName(name) {
  if (SHORT_NAME_MAP[name] !== undefined) return SHORT_NAME_MAP[name];
  return name.endsWith('_OPERATOR') ? name.slice(0, -'_OPERATOR'.length) : name;
}

/**
 * Extract the max ExecTime in nanoseconds from an operator's attrs Map.
 * Returns null if ExecTime is missing or unparseable.
 */
export function extractExecTimeMaxNs(attrs) {
  if (!attrs) return null;
  const parsed = parseAvgMaxMin(attrs.get('ExecTime'));
  return parsed ? parsed.max_ns : null;
}

// ── buildPlanTree ─────────────────────────────────────────────────────────────

/**
 * Walk an OperatorNode tree depth-first, calling visit(node) on each node
 * in pre-order (parent before children).
 */
function walkOperators(opNode, visit) {
  if (!opNode) return;
  visit(opNode);
  for (const c of opNode.children) walkOperators(c, visit);
}

/**
 * Build a flat plan-tree model from ast.mergedProfile.
 *
 * Returns:
 * {
 *   nodes: PlanNode[],          // flat array, indexed by .idx
 *   rootIdx: number | null,     // RESULT_SINK_OPERATOR, or first node in fragment 0
 *   fragmentRoots: number[],    // rootIdx per fragment (first pipeline root)
 *   fragmentMaxExecTime: (number|null)[], // max ExecTime across all ops per fragment (ns)
 *   warnings: { message: string }[],
 * }
 *
 * PlanNode shape:
 * {
 *   idx: number,
 *   fragmentId: number,
 *   opId: number,
 *   name: string,
 *   shortName: string,
 *   rawHeader: string,
 *   parentIdx: number | null,
 *   childrenIdx: number[],
 *   crossFragmentLink: null | { kind: 'exchange', dstId: number, peerIdx: number|null },
 *   execTimeMaxNs: number | null,
 *   attrsRef: Map,              // direct reference to the OperatorNode.attrs Map
 *   raw: OperatorNode,          // back-reference to the raw AST node
 * }
 */
export function buildPlanTree(ast) {
  const nodes = [];
  const fragmentRoots = [];
  const fragmentMaxExecTime = [];
  const warnings = [];

  for (const frag of ast.mergedProfile.fragments) {
    const fragId = frag.id;
    const parentStack = [];   // [{opNode, idx}]
    let fragRootIdx = null;
    let maxNs = null;

    for (const pipe of frag.pipelines) {
      walkOperators(pipe.operators, (opNode) => {
        // Walk parentStack back until the top is a direct ancestor of opNode.
        // "Direct ancestor" means opNode is in top.opNode.children.
        while (
          parentStack.length > 0 &&
          !parentStack[parentStack.length - 1].opNode.children.includes(opNode)
        ) {
          parentStack.pop();
        }

        const parentIdx = parentStack.length > 0 ? parentStack[parentStack.length - 1].idx : null;

        const idx = nodes.length;
        const node = {
          idx,
          fragmentId: fragId,
          opId: opNode.id,
          name: opNode.name,
          shortName: shortName(opNode.name),
          rawHeader: opNode.rawHeader,
          parentIdx,
          childrenIdx: [],
          crossFragmentLink: null,
          execTimeMaxNs: extractExecTimeMaxNs(opNode.attrs),
          attrsRef: opNode.attrs,
          raw: opNode,
        };

        nodes.push(node);

        if (node.execTimeMaxNs !== null && node.execTimeMaxNs !== undefined) {
          if (maxNs === null || node.execTimeMaxNs > maxNs) maxNs = node.execTimeMaxNs;
        }

        if (parentIdx !== null) {
          nodes[parentIdx].childrenIdx.push(idx);
        } else if (fragRootIdx === null) {
          // First root we encounter in this fragment becomes the fragment root.
          fragRootIdx = idx;
        }

        parentStack.push({ opNode, idx });
      });
    }

    fragmentRoots.push(fragRootIdx);
    fragmentMaxExecTime.push(maxNs);
  }

  // ── Task 5: Cross-fragment stitching ─────────────────────────────────────────
  // Map DATA_STREAM_SINK dst_id → node idx. Warn on duplicates.
  const sinkByDstId = new Map();
  for (const n of nodes) {
    if (n.name !== 'DATA_STREAM_SINK_OPERATOR') continue;
    const dstId = extractDstId(n.rawHeader);
    if (dstId === null) continue;
    if (sinkByDstId.has(dstId)) {
      warnings.push({
        message: `Duplicate DATA_STREAM_SINK dst_id=${dstId} (idx ${sinkByDstId.get(dstId)} and ${n.idx})`,
      });
      continue;
    }
    sinkByDstId.set(dstId, n.idx);
  }

  // For each EXCHANGE_OPERATOR, record a crossFragmentLink by matching dst_id.
  for (const n of nodes) {
    if (n.name !== 'EXCHANGE_OPERATOR') continue;
    const dstId = extractDstId(n.rawHeader);
    if (dstId === null) {
      warnings.push({ message: `EXCHANGE_OPERATOR at idx ${n.idx} has no parseable id` });
      continue;
    }
    const peerIdx = sinkByDstId.has(dstId) ? sinkByDstId.get(dstId) : null;
    n.crossFragmentLink = { kind: 'exchange', dstId, peerIdx };
    if (peerIdx === null) {
      warnings.push({ message: `Unmatched EXCHANGE dst=${dstId} at idx ${n.idx}` });
    }
  }

  // ── Task 6: rootIdx resolution ────────────────────────────────────────────────
  // Prefer RESULT_SINK_OPERATOR (always in fragment 0); fall back to fragment 0 root.
  let rootIdx = nodes.findIndex(n => n.name === 'RESULT_SINK_OPERATOR');
  if (rootIdx < 0) rootIdx = fragmentRoots[0] ?? null;

  return { nodes, rootIdx, fragmentRoots, fragmentMaxExecTime, warnings };
}
