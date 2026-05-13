// Typed accessor for OLAP_SCAN_OPERATOR (merged side and per-host side).
// Doris 3.x: https://doris.apache.org/docs/3.x/query-acceleration/tuning/profiling-tools/
// Field names verified against samples/tpch/ profiles.

import {
  parseAvgMaxMin, parseSumAvgMaxMin, parseSumAvgMaxMinRows,
  parseScalarTime, parseBytes, parseRowCount, parseArray,
} from '../../util/format.js';

function extractTableFromHeader(header) {
  const m = /table name\s*=\s*([^(\s]+)/.exec(header);
  return m ? m[1] : null;
}

function extractCardinalityNumber(s) {
  if (!s) return null;
  const m = /^(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

// ── Merged-side accessor ───────────────────────────────────────────────────────
// Used on operators found in ast.mergedProfile (aggregate counters across all
// per-host instances — avg/max/min for times, sum/avg/max/min for rows/bytes).

export function typeOlapScan(opNode) {
  const a = opNode.attrs;
  return {
    table:             extractTableFromHeader(opNode.rawHeader),
    partitions:        a.get('PlanInfo.partitions') ?? null,
    tablets:           a.get('PlanInfo.tablets') ?? null,
    cardinality:       extractCardinalityNumber(a.get('PlanInfo.cardinality')),
    pushAggOp:         a.get('PlanInfo.pushAggOp') ?? null,
    execTime:          parseAvgMaxMin(a.get('ExecTime')),
    rowsProduced:      parseSumAvgMaxMinRows(a.get('RowsProduced')),
    blocksProduced:    parseSumAvgMaxMinRows(a.get('BlocksProduced')),
    memoryPeak:        parseSumAvgMaxMin(a.get('MemoryUsagePeak')),
    waitForDependency: parseAvgMaxMin(a.get('WaitForDependency[OLAP_SCAN_OPERATOR_DEPENDENCY]Time')),
    raw: opNode,
  };
}

// ── Per-host instance accessor ────────────────────────────────────────────────
// Used on operators found in ast.perHost (scalar values per single BE instance).

export function typeOlapScanInstance(opNode) {
  const a = opNode.attrs;
  return {
    host:                                  null,   // populated by collectScans
    execTime_ns:                           parseScalarTime(a.get('ExecTime')),
    rowsRead:                              parseRowCount(a.get('RowsRead')),
    rowsProduced:                          parseRowCount(a.get('RowsProduced')),
    blocksProduced:                        parseRowCount(a.get('BlocksProduced')),
    numScanners:                           parseRowCount(a.get('NumScanners')),
    tabletNum:                             parseRowCount(a.get('TabletNum')),
    memoryUsagePeak:                       parseBytes(a.get('MemoryUsagePeak')),
    waitForRuntimeFilter_ns:               parseScalarTime(a.get('WaitForRuntimeFilter')),
    scannerWorkerWaitTime_ns:              parseScalarTime(a.get('ScannerWorkerWaitTime')),
    waitForDependency_ns:                  parseScalarTime(a.get('WaitForDependency[OLAP_SCAN_OPERATOR_DEPENDENCY]Time')),

    pushDownAggregate:                     a.get('PushDownAggregate') ?? null,
    pushDownPredicates:                    a.get('PushDownPredicates') ?? null,
    runtimeFilters:                        a.get('RuntimeFilters') ?? null,

    perScannerRunningTime_ns:              parseArray(a.get('VScanner.PerScannerRunningTime'), parseScalarTime),
    perScannerRowsRead:                    parseArray(a.get('VScanner.PerScannerRowsRead'), parseRowCount),
    perScannerWaitTime_ns:                 parseArray(a.get('VScanner.PerScannerWaitTime'), parseScalarTime),

    rowsBloomFilterFiltered:               parseRowCount(a.get('VScanner.SegmentIterator.RowsBloomFilterFiltered')),
    rowsZoneMapRuntimePredicateFiltered:   parseRowCount(a.get('VScanner.SegmentIterator.RowsZoneMapRuntimePredicateFiltered')),
    rowsShortCircuitPredFiltered:          parseRowCount(a.get('VScanner.SegmentIterator.RowsShortCircuitPredFiltered')),
    rowsBitmapIndexFiltered:               parseRowCount(a.get('VScanner.SegmentIterator.RowsBitmapIndexFiltered')),
    rowsInvertedIndexFiltered:             parseRowCount(a.get('VScanner.SegmentIterator.RowsInvertedIndexFiltered')),

    raw: opNode,
  };
}

// ── collectScans — pair merged operators with per-host instances ───────────────

function walkOperators(root, fn) {
  if (!root) return;
  fn(root);
  for (const c of root.children) walkOperators(c, fn);
}

function collectInstances(ast, fragmentId, opId) {
  const out = [];
  const frag = ast.perHost.fragments.find(f => f.id === fragmentId);
  if (!frag) return out;
  for (const pipe of frag.pipelines) {
    for (const task of pipe.tasks) {
      walkOperators(task.operators, (op) => {
        if (op.name === 'OLAP_SCAN_OPERATOR' && op.id === opId) {
          const inst = typeOlapScanInstance(op);
          inst.host = pipe.host;
          out.push(inst);
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

function buildRow(fragmentId, operatorId, merged, instances) {
  const rowsReadSum                     = sumNullable(instances.map(i => i.rowsRead));
  const rowsProducedSum                 = sumNullable(instances.map(i => i.rowsProduced));
  const rowsBloomFilterFilteredSum      = sumNullable(instances.map(i => i.rowsBloomFilterFiltered));
  const rowsZoneMapRuntimePredicateFilteredSum = sumNullable(instances.map(i => i.rowsZoneMapRuntimePredicateFiltered));
  const rowsShortCircuitPredFilteredSum = sumNullable(instances.map(i => i.rowsShortCircuitPredFiltered));
  const rowsBitmapIndexFilteredSum      = sumNullable(instances.map(i => i.rowsBitmapIndexFiltered));
  const rowsInvertedIndexFilteredSum    = sumNullable(instances.map(i => i.rowsInvertedIndexFiltered));

  const filterSums = [
    rowsBloomFilterFilteredSum, rowsZoneMapRuntimePredicateFilteredSum,
    rowsShortCircuitPredFilteredSum, rowsBitmapIndexFilteredSum, rowsInvertedIndexFilteredSum,
  ];
  const totalFilteredRows = filterSums.some(s => s === null) ? null : filterSums.reduce((a, b) => a + b, 0);
  const filterPct = (totalFilteredRows === null || rowsReadSum === null)
    ? null
    : (totalFilteredRows / Math.max(rowsReadSum + totalFilteredRows, 1)) * 100;

  let skewMergedRatio = null;
  if (merged.execTime && merged.execTime.min_ns > 0) {
    skewMergedRatio = merged.execTime.max_ns / merged.execTime.min_ns;
  } else if (merged.execTime && merged.execTime.max_ns > 0) {
    skewMergedRatio = merged.execTime.max_ns;
  }

  const allScannerTimes = [];
  for (const inst of instances) {
    if (Array.isArray(inst.perScannerRunningTime_ns)) {
      for (const t of inst.perScannerRunningTime_ns) {
        if (t !== null && t !== undefined) allScannerTimes.push(t);
      }
    }
  }
  let skewScannerRatio = null;
  if (allScannerTimes.length >= 2) {
    const max = Math.max(...allScannerTimes);
    const min = Math.min(...allScannerTimes);
    skewScannerRatio = min > 0 ? max / min : null;
  }

  return {
    fragmentId, operatorId,
    table: merged.table,
    partitions: merged.partitions,
    tablets: merged.tablets,
    cardinality: merged.cardinality,
    pushAggOp: merged.pushAggOp,
    merged,
    instances,
    rowsReadSum, rowsProducedSum,
    rowsBloomFilterFilteredSum, rowsZoneMapRuntimePredicateFilteredSum,
    rowsShortCircuitPredFilteredSum, rowsBitmapIndexFilteredSum, rowsInvertedIndexFilteredSum,
    totalFilteredRows,
    filterPct,
    skewMergedRatio,
    skewScannerRatio,
    numScannersTotal: sumNullable(instances.map(i => i.numScanners)),
    tabletNumTotal:   sumNullable(instances.map(i => i.tabletNum)),
    memoryPeakMergedMax: merged.memoryPeak?.max ?? null,
  };
}

export function collectScans(ast) {
  const rows = [];
  for (const frag of ast.mergedProfile.fragments) {
    for (const pipe of frag.pipelines) {
      walkOperators(pipe.operators, (op) => {
        if (op.name !== 'OLAP_SCAN_OPERATOR') return;
        const merged = typeOlapScan(op);
        const instances = collectInstances(ast, frag.id, op.id);
        rows.push(buildRow(frag.id, op.id, merged, instances));
      });
    }
  }
  return rows;
}
