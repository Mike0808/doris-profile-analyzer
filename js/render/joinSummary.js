import { el } from '../util/dom.js';
import { collectJoins } from '../parser/operators/hashJoin.js';
import { formatNs, formatBytes, formatRows } from '../util/format.js';

const COLUMNS = [
  { key: 'expander',   label: '',             align: 'left'  },
  { key: 'joinId',     label: 'Join',         align: 'left'  },
  { key: 'joinType',   label: 'Type',         align: 'left'  },
  { key: 'distrib',    label: 'Distribution', align: 'left'  },
  { key: 'buildRows',  label: 'Build Rows',   align: 'right' },
  { key: 'probeRows',  label: 'Probe Rows',   align: 'right' },
  { key: 'buildTime',  label: 'Build Time',   align: 'right' },
  { key: 'probeTime',  label: 'Probe Time',   align: 'right' },
  { key: 'htMem',      label: 'HashTbl Mem',  align: 'right' },
  { key: 'skew',       label: 'Skew',         align: 'right' },
];

function joinIdString(row) { return `F${row.fragmentId}/J${row.operatorId}`; }

function probeTimeText(row) {
  if (!row.probeTime) return '—';
  return `${formatNs(row.probeTime.min_ns)}…${formatNs(row.probeTime.max_ns)}`;
}

function skewText(row) {
  const r = row.skewProbeRatio;
  if (!r || !Number.isFinite(r)) return '—';
  return `${r.toFixed(1)}×`;
}

function skewClass(row) {
  const r = row.skewProbeRatio;
  if (!Number.isFinite(r)) return '';
  if (r > 10) return ' skew-high';
  if (r > 3)  return ' skew-medium';
  return '';
}

// Build time slower than probe → build is likely the bottleneck. Highlight.
function buildBottleneckClass(row) {
  const b = row.buildHashTableTimeMax_ns;
  const p = row.probeTime?.max_ns ?? null;
  if (b === null || p === null || p === 0) return '';
  return b > p ? ' build-heavy' : '';
}

function renderCell(value, align) {
  return el('div', { class: 'cell' + (align === 'right' ? ' numeric' : '') }, String(value));
}

function getSortValue(row, key) {
  switch (key) {
    case 'joinId':    return `${row.fragmentId}.${row.operatorId}`;
    case 'joinType':  return row.joinType ?? '';
    case 'distrib':   return row.distribution ?? '';
    case 'buildRows': return row.buildRowsSum ?? -1;
    case 'probeRows': return row.probeRowsSum ?? -1;
    case 'buildTime': return row.buildHashTableTimeMax_ns ?? -1;
    case 'probeTime': return row.probeTime?.max_ns ?? -1;
    case 'htMem':     return row.hashTableMemSum ?? -1;
    case 'skew':      return row.skewProbeRatio ?? 0;
    default:          return 0;
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

export function renderJoinSummary(container, ast) {
  const wrap = el('div', { class: 'join-summary' });
  const allRows = collectJoins(ast);

  if (allRows.length === 0) {
    wrap.appendChild(el('div', { class: 'empty-state' }, 'No hash join operators in this profile.'));
    container.appendChild(wrap);
    return;
  }

  let sortKey = 'probeTime';
  let sortDir = 'desc';
  const expanded = new Set();

  function render() {
    const sorted = sortRows(allRows, sortKey, sortDir);
    const table = el('div', { class: 'join-summary-table' });

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
      table.appendChild(renderCell(joinIdString(row), 'left'));
      table.appendChild(renderCell(row.joinType ?? '—', 'left'));
      table.appendChild(renderCell(row.distribution ?? '—', 'left'));
      table.appendChild(renderCell(formatRows(row.buildRowsSum), 'right'));
      table.appendChild(renderCell(formatRows(row.probeRowsSum), 'right'));
      table.appendChild(el('div', { class: 'cell numeric' + buildBottleneckClass(row) }, formatNs(row.buildHashTableTimeMax_ns)));
      table.appendChild(renderCell(probeTimeText(row), 'right'));
      table.appendChild(renderCell(formatBytes(row.hashTableMemSum), 'right'));
      table.appendChild(el('div', { class: 'cell numeric' + skewClass(row) }, skewText(row)));

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

  // PlanInfo dump (probe-side has the join op + conjunct + runtime filters).
  const planInfoLines = [];
  for (const [k, v] of row.mergedProbe.raw.attrs) {
    if (k.startsWith('PlanInfo.') || k === 'PlanInfo') {
      planInfoLines.push(`${k}: ${v}`);
    }
  }
  if (planInfoLines.length > 0) {
    panel.appendChild(el('h3', {}, 'PlanInfo'));
    panel.appendChild(el('div', { class: 'planinfo' }, planInfoLines.join('\n')));
  }

  // Build-time breakdown summary line.
  if (row.buildHashTableTimeMax_ns !== null || row.buildTableInsertTimeSum_ns !== null) {
    panel.appendChild(el('h3', {}, 'Build phase (per-instance times)'));
    panel.appendChild(el('div', { class: 'time-breakdown' }, [
      span('hash-table max:', formatNs(row.buildHashTableTimeMax_ns)),
      span('hash-table sum:', formatNs(row.buildHashTableTimeSum_ns)),
      span('insert sum:',     formatNs(row.buildTableInsertTimeSum_ns)),
      span('runtime-filter sum:', formatNs(row.buildRuntimeFilterTimeSum_ns)),
    ]));
  }

  // Per-instance build table.
  if (row.sinkInstances.length > 0) {
    panel.appendChild(el('h3', {}, `Build instances (${row.sinkInstances.length})`));
    const t = el('table');
    t.appendChild(el('tr', {}, [
      el('th', {}, 'Host'),
      el('th', {}, 'ExecTime'),
      el('th', {}, 'BuildHashTable'),
      el('th', {}, 'BuildRuntimeFilter'),
      el('th', {}, 'InputRows'),
      el('th', {}, 'HashTable Mem'),
      el('th', {}, 'Mem Peak'),
    ]));
    for (const inst of row.sinkInstances) {
      t.appendChild(el('tr', {}, [
        el('td', {}, inst.host ?? '—'),
        el('td', {}, formatNs(inst.execTime_ns)),
        el('td', {}, formatNs(inst.buildHashTableTime_ns)),
        el('td', {}, formatNs(inst.buildRuntimeFilterTime_ns)),
        el('td', {}, formatRows(inst.inputRows)),
        el('td', {}, formatBytes(inst.memoryUsageHashTable)),
        el('td', {}, formatBytes(inst.memoryUsagePeak)),
      ]));
    }
    panel.appendChild(t);
  }

  // Per-instance probe table.
  if (row.probeInstances.length > 0) {
    panel.appendChild(el('h3', {}, `Probe instances (${row.probeInstances.length})`));
    const t = el('table');
    t.appendChild(el('tr', {}, [
      el('th', {}, 'Host'),
      el('th', {}, 'ExecTime'),
      el('th', {}, 'SearchHashTable'),
      el('th', {}, 'WaitDep'),
      el('th', {}, 'ProbeRows'),
      el('th', {}, 'RowsProduced'),
      el('th', {}, 'Mem Peak'),
    ]));
    for (const inst of row.probeInstances) {
      t.appendChild(el('tr', {}, [
        el('td', {}, inst.host ?? '—'),
        el('td', {}, formatNs(inst.execTime_ns)),
        el('td', {}, formatNs(inst.probeWhenSearchHashTableTime_ns)),
        el('td', {}, formatNs(inst.waitForDependency_ns)),
        el('td', {}, formatRows(inst.probeRows)),
        el('td', {}, formatRows(inst.rowsProduced)),
        el('td', {}, formatBytes(inst.memoryUsagePeak)),
      ]));
    }
    panel.appendChild(t);
  }

  if (row.sinkInstances.length === 0 && row.probeInstances.length === 0) {
    panel.appendChild(el('div', { class: 'empty-state' }, 'Per-instance details unavailable.'));
  }

  return panel;
}

function span(labelText, valueText) {
  return el('span', {}, [
    el('span', { class: 'label' }, labelText + ' '),
    String(valueText),
  ]);
}
