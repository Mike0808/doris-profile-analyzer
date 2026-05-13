import { el } from '../util/dom.js';
import { collectScans } from '../parser/operators/olapScan.js';
import { formatNs, formatBytes, formatRows, formatPct } from '../util/format.js';

const COLUMNS = [
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

export function renderScanSummary(container, ast) {
  const wrap = el('div', { class: 'scan-summary' });
  const rows = collectScans(ast);

  if (rows.length === 0) {
    wrap.appendChild(el('div', { class: 'empty-state' }, 'No OLAP scan operators in this profile.'));
    container.appendChild(wrap);
    return;
  }

  const table = el('div', { class: 'scan-summary-table' });
  for (const col of COLUMNS) {
    table.appendChild(el('div', { class: 'header' + (col.align === 'right' ? ' numeric' : '') }, col.label));
  }
  for (const row of rows) {
    table.appendChild(renderCell(row.table ?? '—', 'left'));
    table.appendChild(renderCell(partTabString(row), 'left'));
    table.appendChild(renderCell(formatRows(row.cardinality), 'right'));
    table.appendChild(renderCell(formatRows(row.rowsReadSum), 'right'));
    table.appendChild(renderCell(formatRows(row.rowsProducedSum), 'right'));
    table.appendChild(el('div', { class: 'cell numeric' + filterClass(row) }, formatPct(row.filterPct)));
    table.appendChild(renderCell(execTimeRange(row.merged), 'right'));
    table.appendChild(el('div', { class: 'cell numeric' + skewClass(row) }, skewText(row)));
    table.appendChild(renderCell(formatBytes(row.memoryPeakMergedMax), 'right'));
  }
  wrap.appendChild(table);
  container.appendChild(wrap);
}
