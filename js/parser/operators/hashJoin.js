// Typed accessors for HASH_JOIN_OPERATOR (probe) and HASH_JOIN_SINK_OPERATOR (build).
// Doris 3.x: https://doris.apache.org/docs/3.x/query-acceleration/tuning/profiling-tools/
// Probe and sink share id+nereids_id but live in separate pipelines within the same fragment.
// Field names verified against samples/tpch/tpch_q3 (probe: lines 298+, 372+; sink: lines 338+, 444+).

import {
  parseAvgMaxMin, parseSumAvgMaxMin, parseSumAvgMaxMinRows,
  parseScalarTime, parseBytes, parseRowCount,
} from '../../util/format.js';

// "INNER JOIN(COLOCATE[])[]" → { joinType: "INNER JOIN", distribution: "COLOCATE" }
// "LEFT SEMI JOIN(BROADCAST)[]" → { joinType: "LEFT SEMI JOIN", distribution: "BROADCAST" }
function parseJoinOp(s) {
  if (typeof s !== 'string') return { joinType: null, distribution: null };
  const m = /^([A-Z ]+?JOIN)\s*\(\s*([A-Z_]+)/.exec(s.trim());
  if (!m) return { joinType: s.trim(), distribution: null };
  return { joinType: m[1].trim(), distribution: m[2] };
}

// ── Merged-side accessors ─────────────────────────────────────────────────────

export function typeHashJoin(opNode) {
  const a = opNode.attrs;
  const { joinType, distribution } = parseJoinOp(a.get('PlanInfo.join op'));
  return {
    joinType,
    distribution,
    equalJoinConjunct: a.get('PlanInfo.equal join conjunct') ?? null,
    runtimeFilters:    a.get('PlanInfo.runtime filters') ?? null,
    execTime:          parseAvgMaxMin(a.get('ExecTime')),
    projectionTime:    parseAvgMaxMin(a.get('ProjectionTime')),
    initTime:          parseAvgMaxMin(a.get('InitTime')),
    waitForDependency: parseAvgMaxMin(a.get('WaitForDependency[HASH_JOIN_OPERATOR_DEPENDENCY]Time')),
    probeRows:         parseSumAvgMaxMinRows(a.get('ProbeRows')),
    rowsProduced:      parseSumAvgMaxMinRows(a.get('RowsProduced')),
    blocksProduced:    parseSumAvgMaxMinRows(a.get('BlocksProduced')),
    memoryUsagePeak:   parseSumAvgMaxMin(a.get('MemoryUsagePeak')),
    raw: opNode,
  };
}

export function typeHashJoinSink(opNode) {
  const a = opNode.attrs;
  return {
    execTime:                  parseAvgMaxMin(a.get('ExecTime')),
    initTime:                  parseAvgMaxMin(a.get('InitTime')),
    waitForDependency:         parseAvgMaxMin(a.get('WaitForDependency[HASH_JOIN_SINK_OPERATOR_DEPENDENCY]Time')),
    inputRows:                 parseSumAvgMaxMinRows(a.get('InputRows')),
    memoryUsagePeak:           parseSumAvgMaxMin(a.get('MemoryUsagePeak')),
    memoryUsageHashTable:      parseSumAvgMaxMin(a.get('MemoryUsageHashTable')),
    memoryUsageBuildBlocks:    parseSumAvgMaxMin(a.get('MemoryUsageBuildBlocks')),
    memoryUsageBuildKeyArena:  parseSumAvgMaxMin(a.get('MemoryUsageBuildKeyArena')),
    raw: opNode,
  };
}

// ── Per-host instance accessors ───────────────────────────────────────────────

export function typeHashJoinInstance(opNode) {
  const a = opNode.attrs;
  return {
    host:                                null,
    execTime_ns:                         parseScalarTime(a.get('ExecTime')),
    initTime_ns:                         parseScalarTime(a.get('InitTime')),
    initProbeSideTime_ns:                parseScalarTime(a.get('InitProbeSideTime')),
    probeExprCallTime_ns:                parseScalarTime(a.get('ProbeExprCallTime')),
    probeWhenSearchHashTableTime_ns:     parseScalarTime(a.get('ProbeWhenSearchHashTableTime')),
    probeWhenBuildSideOutputTime_ns:     parseScalarTime(a.get('ProbeWhenBuildSideOutputTime')),
    probeWhenProbeSideOutputTime_ns:     parseScalarTime(a.get('ProbeWhenProbeSideOutputTime')),
    finishProbePhaseTime_ns:             parseScalarTime(a.get('FinishProbePhaseTime')),
    joinFilterTime_ns:                   parseScalarTime(a.get('JoinFilterTimer')),
    projectionTime_ns:                   parseScalarTime(a.get('ProjectionTime')),
    waitForDependency_ns:                parseScalarTime(a.get('WaitForDependency[HASH_JOIN_OPERATOR_DEPENDENCY]Time')),
    probeRows:                           parseRowCount(a.get('ProbeRows')),
    rowsProduced:                        parseRowCount(a.get('RowsProduced')),
    memoryUsagePeak:                     parseBytes(a.get('MemoryUsagePeak')),
    raw: opNode,
  };
}

export function typeHashJoinSinkInstance(opNode) {
  const a = opNode.attrs;
  return {
    host:                            null,
    joinType:                        a.get('JoinType') ?? null,                  // e.g. "INNER_JOIN"
    broadcastJoin:                   a.get('BroadcastJoin') ?? null,             // "0" | "1"
    buildShareHashTable:             a.get('BuildShareHashTable') ?? null,
    shareHashTableEnabled:           a.get('ShareHashTableEnabled') ?? null,
    execTime_ns:                     parseScalarTime(a.get('ExecTime')),
    initTime_ns:                     parseScalarTime(a.get('InitTime')),
    buildHashTableTime_ns:           parseScalarTime(a.get('BuildHashTableTime')),
    buildTableInsertTime_ns:         parseScalarTime(a.get('BuildTableInsertTime')),
    buildRuntimeFilterTime_ns:       parseScalarTime(a.get('BuildRuntimeFilterTime')),
    buildExprCallTime_ns:            parseScalarTime(a.get('BuildExprCallTime')),
    mergeBuildBlockTime_ns:          parseScalarTime(a.get('MergeBuildBlockTime')),
    publishRuntimeFilterTime_ns:     parseScalarTime(a.get('PublishRuntimeFilterTime')),
    runtimeFilterInitTime_ns:        parseScalarTime(a.get('RuntimeFilterInitTime')),
    waitForDependency_ns:            parseScalarTime(a.get('WaitForDependency[HASH_JOIN_SINK_OPERATOR_DEPENDENCY]Time')),
    inputRows:                       parseRowCount(a.get('InputRows')),
    memoryUsagePeak:                 parseBytes(a.get('MemoryUsagePeak')),
    memoryUsageHashTable:            parseBytes(a.get('MemoryUsageHashTable')),
    memoryUsageBuildBlocks:          parseBytes(a.get('MemoryUsageBuildBlocks')),
    raw: opNode,
  };
}

// ── collectJoins — pair probe + sink across pipelines, then attach per-host ───

function walkOperators(root, fn) {
  if (!root) return;
  fn(root);
  for (const c of root.children) walkOperators(c, fn);
}

function findMergedSink(fragment, opId) {
  for (const pipe of fragment.pipelines) {
    let found = null;
    walkOperators(pipe.operators, (op) => {
      if (op.name === 'HASH_JOIN_SINK_OPERATOR' && op.id === opId) found = op;
    });
    if (found) return found;
  }
  return null;
}

function collectInstancesByName(ast, fragmentId, opId, name) {
  const out = [];
  const frag = ast.perHost.fragments.find(f => f.id === fragmentId);
  if (!frag) return out;
  for (const pipe of frag.pipelines) {
    for (const task of pipe.tasks) {
      walkOperators(task.operators, (op) => {
        if (op.name === name && op.id === opId) {
          out.push({ op, host: pipe.host });
        }
      });
    }
  }
  return out;
}

function sumNullable(arr) {
  let sum = null;
  for (const v of arr) {
    if (v === null || v === undefined) continue;
    if (sum === null) sum = 0;
    sum += v;
  }
  return sum;
}

function maxNullable(arr) {
  let max = null;
  for (const v of arr) {
    if (v === null || v === undefined) continue;
    if (max === null || v > max) max = v;
  }
  return max;
}

function buildRow(fragmentId, opId, mergedProbe, mergedSink, probeInsts, sinkInsts) {
  // Skew across probe instances' ExecTime.
  let skewProbeRatio = null;
  if (mergedProbe.execTime && mergedProbe.execTime.min_ns > 0) {
    skewProbeRatio = mergedProbe.execTime.max_ns / mergedProbe.execTime.min_ns;
  }

  // Build-time totals (sums + max) from per-host sink instances.
  const buildHashTimes = sinkInsts.map(i => i.buildHashTableTime_ns);
  const buildInsertTimes = sinkInsts.map(i => i.buildTableInsertTime_ns);
  const buildRFTimes = sinkInsts.map(i => i.buildRuntimeFilterTime_ns);

  return {
    fragmentId,
    operatorId: opId,
    joinType:     mergedProbe.joinType,
    distribution: mergedProbe.distribution,
    equalJoinConjunct: mergedProbe.equalJoinConjunct,
    mergedProbe,
    mergedSink,                                       // null if not found
    probeInstances: probeInsts,                       // [{ op, host }]
    sinkInstances:  sinkInsts,                        // [{ op, host }]
    probeRowsSum:   mergedProbe.probeRows?.sum ?? null,
    buildRowsSum:   mergedSink?.inputRows?.sum ?? null,
    rowsProducedSum: mergedProbe.rowsProduced?.sum ?? null,
    probeTime:      mergedProbe.execTime,             // {avg_ns, max_ns, min_ns}
    sinkTime:       mergedSink?.execTime ?? null,
    skewProbeRatio,
    buildHashTableTimeMax_ns:    maxNullable(buildHashTimes),
    buildHashTableTimeSum_ns:    sumNullable(buildHashTimes),
    buildTableInsertTimeSum_ns:  sumNullable(buildInsertTimes),
    buildRuntimeFilterTimeSum_ns: sumNullable(buildRFTimes),
    probeMemPeakMax:  mergedProbe.memoryUsagePeak?.max ?? null,
    sinkMemPeakMax:   mergedSink?.memoryUsagePeak?.max ?? null,
    hashTableMemMax:  mergedSink?.memoryUsageHashTable?.max ?? null,
    hashTableMemSum:  mergedSink?.memoryUsageHashTable?.sum ?? null,
  };
}

export function collectJoins(ast) {
  const rows = [];
  for (const frag of ast.mergedProfile.fragments) {
    for (const pipe of frag.pipelines) {
      walkOperators(pipe.operators, (op) => {
        if (op.name !== 'HASH_JOIN_OPERATOR') return;
        const probeMerged = typeHashJoin(op);
        const sinkOp      = findMergedSink(frag, op.id);
        const sinkMerged  = sinkOp ? typeHashJoinSink(sinkOp) : null;

        const probeInsts = collectInstancesByName(ast, frag.id, op.id, 'HASH_JOIN_OPERATOR')
          .map(({ op, host }) => {
            const inst = typeHashJoinInstance(op);
            inst.host = host;
            return inst;
          });
        const sinkInsts = collectInstancesByName(ast, frag.id, op.id, 'HASH_JOIN_SINK_OPERATOR')
          .map(({ op, host }) => {
            const inst = typeHashJoinSinkInstance(op);
            inst.host = host;
            return inst;
          });

        rows.push(buildRow(frag.id, op.id, probeMerged, sinkMerged, probeInsts, sinkInsts));
      });
    }
  }
  return rows;
}
