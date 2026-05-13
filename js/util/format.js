// Doris profile value parsers and formatters. Best-effort: null on unparseable input.
// See docs/superpowers/specs/2026-05-13-iteration-2-scan-summary-design.md §5

const DURATION_UNITS = {
  ns:  1,
  us:  1_000,
  ms:  1_000_000,
  s:   1_000_000_000,
  min: 60_000_000_000,
};

export function parseDuration(s) {
  if (typeof s !== 'string') return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(ns|us|ms|s|min)\s*$/.exec(s);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const factor = DURATION_UNITS[m[2]];
  return Math.round(value * factor);
}

export const parseScalarTime = parseDuration;

const BYTE_UNITS = {
  B:  1,
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  TB: 1024 * 1024 * 1024 * 1024,
};

export function parseBytes(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  const m = /^(-?\d+(?:\.\d+)?)(?:\s*(B|KB|MB|GB|TB))?$/.exec(t);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const factor = m[2] ? BYTE_UNITS[m[2]] : 1;
  return Math.round(value * factor);
}

const ROW_SUFFIX = { K: 1_000, M: 1_000_000, G: 1_000_000_000 };

export function parseRowCount(s) {
  if (typeof s !== 'string') return null;
  const inParens = /\((\d+)\)/.exec(s);
  if (inParens) return parseInt(inParens[1], 10);
  const bare = /^\s*(\d+)\s*$/.exec(s);
  if (bare) return parseInt(bare[1], 10);
  const sufM = /^\s*(\d+(?:\.\d+)?)([KMG])\s*$/.exec(s);
  if (sufM) return Math.round(parseFloat(sufM[1]) * ROW_SUFFIX[sufM[2]]);
  return null;
}

export function parseAvgMaxMin(s) {
  if (typeof s !== 'string') return null;
  const m = /avg\s+(\S+(?:\s\S+)?)\s*,\s*max\s+(\S+(?:\s\S+)?)\s*,\s*min\s+(\S+(?:\s\S+)?)/.exec(s);
  if (!m) return null;
  const avg = parseDuration(m[1].trim());
  const max = parseDuration(m[2].trim());
  const min = parseDuration(m[3].trim());
  if (avg === null || max === null || min === null) return null;
  return { avg_ns: avg, max_ns: max, min_ns: min };
}

function parseSAMM(s, valueParser) {
  if (typeof s !== 'string') return null;
  const m = /sum\s+(.+?)\s*,\s*avg\s+(.+?)\s*,\s*max\s+(.+?)\s*,\s*min\s+(.+)$/.exec(s);
  if (!m) return null;
  const sum = valueParser(m[1].trim());
  const avg = valueParser(m[2].trim());
  const max = valueParser(m[3].trim());
  const min = valueParser(m[4].trim());
  if (sum === null || avg === null || max === null || min === null) return null;
  return { sum, avg, max, min };
}

export function parseSumAvgMaxMin(s) {
  return parseSAMM(s, parseBytes);
}

export function parseSumAvgMaxMinRows(s) {
  return parseSAMM(s, parseRowCount);
}

export function parseArray(s, elem = parseDuration) {
  if (typeof s !== 'string') return null;
  const m = /^\s*\[(.*)\]\s*$/.exec(s);
  if (!m) return null;
  const body = m[1].trim();
  if (body === '') return [];
  const parts = body.split(',').map(x => x.trim()).filter(x => x !== '');
  const out = [];
  for (const p of parts) {
    const v = elem(p);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}
