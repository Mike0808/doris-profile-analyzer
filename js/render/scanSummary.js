import { el } from '../util/dom.js';
import { collectScans } from '../parser/operators/olapScan.js';
import { formatNs, formatBytes, formatRows, formatPct } from '../util/format.js';

const COLUMNS = [
  { key: 'expander',      label: '',            align: 'left'  },
  { key: 'table',         label: 'Table',       align: 'left'  },
  { key: 'partTab',       label: 'Part/Tab',    align: 'left'  },
  { key: 'cardinality',   label: 'Cardinality', align: 'right' },
  { key: 'rowsRead',      label: 'Rows Read',   align: 'right' },
  { key: 'rowsProd',      label: 'Rows Prod',   align: 'right' },
  { key: 'filterPct',     label: 'Filter %',    align: 'right' },
  { key: 'execTime',      label: 'ExecTime',    align: 'right' },
  { key: 'skew',          label: 'Skew',        align: 'right' },
  { key: 'memPeak',       label: 'Mem Peak',    align: 'right' },
];

function partTabString(row) {
  const tab = row.tablets ? row.tablets.split(',')[0] : null;
  if (row.partitions && tab) return `${row.partitions.split(' ')[0]}, ${tab}`;
  return row.partitions || tab || '—';
}

function execTimeRange(merged) {
  if (!merged.execTime) return '—';
  return `${formatNs(merged.execTime.min_ns)}…${formatNs(merged.execTime.max_ns)}`;
}

function skewValue(row) {
  return Math.max(row.skewMergedRatio ?? 0, row.skewScannerRatio ?? 0);
}

function skewText(row) {
  const r = skewValue(row);
  if (!r || !Number.isFinite(r)) return '—';
  return `${r.toFixed(1)}×`;
}

function skewClass(row) {
  const r = skewValue(row);
  if (!Number.isFinite(r)) return '';
  if (r > 10) return ' skew-high';
  if (r > 3)  return ' skew-medium';
  return '';
}

function filterClass(row) {
  if (row.filterPct === null) return '';
  if (row.filterPct >= 50) return ' filter-good';
  return '';
}

function renderCell(value, align) {
  return el('div', { class: 'cell' + (align === 'right' ? ' numeric' : '') }, String(value));
}

function getSortValue(row, key) {
  switch (key) {
    case 'table':       return row.table ?? '';
    case 'partTab':     return row.partitions ?? '';
    case 'cardinality': return row.cardinality ?? -1;
    case 'rowsRead':    return row.rowsReadSum ?? -1;
    case 'rowsProd':    return row.rowsProducedSum ?? -1;
    case 'filterPct':   return row.filterPct ?? -1;
    case 'execTime':    return row.merged.execTime?.max_ns ?? -1;
    case 'skew':        return skewValue(row);
    case 'memPeak':     return row.memoryPeakMergedMax ?? -1;
    default:            return 0;
  }
}

function sortRows(rows, key, dir) {
  return [...rows].sort((a, b) => {
    const av = getSortValue(a, key);
    const bv = getSortValue(b, key);
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

export function renderScanSummary(container, ast) {
  const wrap = el('div', { class: 'scan-summary' });
  const allRows = collectScans(ast);

  if (allRows.length === 0) {
    wrap.appendChild(el('div', { class: 'empty-state' }, 'No OLAP scan operators in this profile.'));
    container.appendChild(wrap);
    return;
  }

  let sortKey = 'execTime';
  let sortDir = 'desc';
  const expanded = new Set();

  function render() {
    const sorted = sortRows(allRows, sortKey, sortDir);
    const table = el('div', { class: 'scan-summary-table' });

    for (const col of COLUMNS) {
      if (col.key === 'expander') {
        table.appendChild(el('div', { class: 'header' }, ''));
        continue;
      }
      const isActive = col.key === sortKey;
      const cls = 'header sortable' + (col.align === 'right' ? ' numeric' : '') + (isActive ? ' active' : '');
      const h = el('div', { class: cls }, [
        col.label,
        el('span', { class: 'sort-ind' }, isActive ? (sortDir === 'asc' ? '▲' : '▼') : '◇'),
      ]);
      h.addEventListener('click', () => {
        if (sortKey === col.key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = col.key; sortDir = col.align === 'right' ? 'desc' : 'asc'; }
        wrap.removeChild(table);
        render();
      });
      table.appendChild(h);
    }

    for (const row of sorted) {
      const rowKey = `${row.fragmentId}-${row.operatorId}`;
      const isExpanded = expanded.has(rowKey);
      const expCell = el('div', { class: 'cell expander' }, isExpanded ? '▾' : '▸');
      expCell.addEventListener('click', () => {
        if (isExpanded) expanded.delete(rowKey);
        else expanded.add(rowKey);
        wrap.removeChild(table);
        render();
      });
      table.appendChild(expCell);
      table.appendChild(renderCell(row.table ?? '—', 'left'));
      table.appendChild(renderCell(partTabString(row), 'left'));
      table.appendChild(renderCell(formatRows(row.cardinality), 'right'));
      table.appendChild(renderCell(formatRows(row.rowsReadSum), 'right'));
      table.appendChild(renderCell(formatRows(row.rowsProducedSum), 'right'));
      table.appendChild(el('div', { class: 'cell numeric' + filterClass(row) }, formatPct(row.filterPct)));
      table.appendChild(renderCell(execTimeRange(row.merged), 'right'));
      table.appendChild(el('div', { class: 'cell numeric' + skewClass(row) }, skewText(row)));
      table.appendChild(renderCell(formatBytes(row.memoryPeakMergedMax), 'right'));

      if (isExpanded) {
        table.appendChild(renderExpandedPanel(row));
      }
    }
    wrap.appendChild(table);
  }

  render();
  container.appendChild(wrap);
}

function renderExpandedPanel(row) {
  const panel = el('div', { class: 'expanded' });

  // PlanInfo dump.
  const planInfoLines = [];
  for (const [k, v] of row.merged.raw.attrs) {
    if (k.startsWith('PlanInfo.') || k === 'PlanInfo') {
      planInfoLines.push(`${k}: ${v}`);
    }
  }
  if (planInfoLines.length > 0) {
    panel.appendChild(el('h3', {}, 'PlanInfo'));
    panel.appendChild(el('div', { class: 'planinfo' }, planInfoLines.join('\n')));
  }

  if (row.instances.length === 0) {
    panel.appendChild(el('div', { class: 'empty-state' }, 'Per-instance details unavailable.'));
    return panel;
  }

  // Per-instance table.
  panel.appendChild(el('h3', {}, `Per-instance (${row.instances.length} tasks)`));
  const instTable = el('table');
  const head = el('tr', {}, [
    el('th', {}, 'Host'),
    el('th', {}, 'ExecTime'),
    el('th', {}, 'Rows Read'),
    el('th', {}, 'Scanners'),
    el('th', {}, 'Mem Peak'),
  ]);
  instTable.appendChild(head);
  for (const inst of row.instances) {
    instTable.appendChild(el('tr', {}, [
      el('td', {}, inst.host ?? '—'),
      el('td', {}, formatNs(inst.execTime_ns)),
      el('td', {}, formatRows(inst.rowsRead)),
      el('td', {}, String(inst.numScanners ?? '—')),
      el('td', {}, formatBytes(inst.memoryUsagePeak)),
    ]));
  }
  panel.appendChild(instTable);

  // Filter breakdown.
  panel.appendChild(el('h3', {}, 'Filter breakdown'));
  const filters = [
    ['BloomFilter',   row.rowsBloomFilterFilteredSum],
    ['ZoneMap',       row.rowsZoneMapRuntimePredicateFilteredSum],
    ['ShortCircuit',  row.rowsShortCircuitPredFilteredSum],
    ['BitmapIndex',   row.rowsBitmapIndexFilteredSum],
    ['InvertedIndex', row.rowsInvertedIndexFilteredSum],
  ];
  const fTable = el('table');
  fTable.appendChild(el('tr', {}, [el('th', {}, 'Filter'), el('th', {}, 'Rows filtered')]));
  for (const [name, cnt] of filters) {
    fTable.appendChild(el('tr', {}, [el('td', {}, name), el('td', {}, formatRows(cnt))]));
  }
  panel.appendChild(fTable);

  // Per-scanner skew.
  const allTimes = [];
  for (const inst of row.instances) {
    if (Array.isArray(inst.perScannerRunningTime_ns)) {
      allTimes.push(...inst.perScannerRunningTime_ns.filter(t => t !== null));
    }
  }
  if (allTimes.length >= 2) {
    panel.appendChild(el('h3', {}, `Per-scanner skew (${allTimes.length} scanners)`));
    const sortedTimes = [...allTimes].sort((a, b) => a - b);
    const min = sortedTimes[0];
    const max = sortedTimes[sortedTimes.length - 1];
    const median = sortedTimes[Math.floor(sortedTimes.length / 2)];
    const ratio = min > 0 ? max / min : null;
    panel.appendChild(el('div', { class: 'scanner-skew' }, [
      el('span', {}, [el('span', { class: 'label' }, 'min: '), formatNs(min)]),
      el('span', {}, [el('span', { class: 'label' }, 'median: '), formatNs(median)]),
      el('span', {}, [el('span', { class: 'label' }, 'max: '), formatNs(max)]),
      el('span', {}, [el('span', { class: 'label' }, 'ratio: '), ratio ? `${ratio.toFixed(1)}×` : '—']),
    ]));
  }

  return panel;
}
