// Tiny browser-side assertion runner.
// Usage:
//   suite('Detect', () => {
//     test('JSON input', () => assertEqual(detect('{...'), 'json'));
//   });
//
// Results are appended to <table id="results"> in test/index.html.

const _state = { suites: [], currentSuite: null };

export function suite(name, body) {
  const s = { name, tests: [] };
  _state.suites.push(s);
  _state.currentSuite = s;
  body();
  _state.currentSuite = null;
}

export function test(name, body) {
  _state.currentSuite.tests.push({ name, body });
}

export function assertEqual(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

export function assertTrue(cond, message = '') {
  if (!cond) throw new Error(message || 'expected true');
}

export function assertContains(haystack, needle, message = '') {
  if (!haystack || !haystack.includes(needle)) {
    throw new Error(`${message}\n  expected to contain: ${JSON.stringify(needle)}\n  actual: ${JSON.stringify(haystack)}`);
  }
}

export async function run(rootEl) {
  let passed = 0, failed = 0;
  for (const s of _state.suites) {
    const header = document.createElement('h2');
    header.textContent = s.name;
    rootEl.appendChild(header);
    const table = document.createElement('table');
    table.className = 'results';
    rootEl.appendChild(table);
    for (const t of s.tests) {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.textContent = t.name;
      const resultCell = document.createElement('td');
      try {
        await t.body();
        resultCell.textContent = '✓';
        resultCell.className = 'pass';
        passed++;
      } catch (e) {
        resultCell.innerHTML = '✗ <pre>' + escapeHtml(String(e.message || e)) + '</pre>';
        resultCell.className = 'fail';
        failed++;
      }
      row.appendChild(nameCell);
      row.appendChild(resultCell);
      table.appendChild(row);
    }
  }
  const summary = document.createElement('div');
  summary.className = 'summary ' + (failed === 0 ? 'pass' : 'fail');
  summary.textContent = `${passed} passed, ${failed} failed`;
  rootEl.insertBefore(summary, rootEl.firstChild);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
