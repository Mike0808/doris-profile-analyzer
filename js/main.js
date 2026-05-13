import { runPipeline } from './parser/textParser.js';
import { el, clear } from './util/dom.js';
import { renderRaw } from './render/raw.js';

const openBtn   = document.getElementById('open-btn');
const fileInput = document.getElementById('file-input');
const overlay   = document.getElementById('drop-overlay');
const fileMeta  = document.getElementById('file-meta');

const tabsNav   = document.getElementById('tabs');
const content   = document.getElementById('content');

let currentProfile = null;   // { fileName, sizeBytes, result }

const tabs = [];          // [{ name, renderer, button }]
let activeTab = null;

export function registerTab(name, renderer) {
  const button = el('button', { class: 'tab' }, name);
  button.addEventListener('click', () => activateTab(name));
  tabsNav.appendChild(button);
  tabs.push({ name, renderer, button });
  if (activeTab === null) activateTab(name);
}

function activateTab(name) {
  activeTab = name;
  for (const t of tabs) {
    t.button.classList.toggle('active', t.name === name);
  }
  renderActive();
}

function renderActive() {
  clear(content);
  if (!activeTab) return;
  const t = tabs.find(x => x.name === activeTab);
  if (!t) return;
  if (!currentProfile || !currentProfile.result.ok) {
    content.appendChild(el('div', { class: 'empty-state' }, 'Open a Doris profile to begin'));
    return;
  }
  t.renderer(content, currentProfile.result.ast);
}

openBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) loadFile(fileInput.files[0]);
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  overlay.classList.add('visible');
});
window.addEventListener('dragleave', (e) => {
  if (e.target === overlay || e.relatedTarget === null) {
    overlay.classList.remove('visible');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  overlay.classList.remove('visible');
  if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
});

async function loadFile(file) {
  const text = await file.text();
  const result = runPipeline(text);
  currentProfile = { fileName: file.name, sizeBytes: file.size, result };
  renderHeader();
  renderActive();
  window.__profile = currentProfile;
}

function renderHeader() {
  clear(fileMeta);
  if (!currentProfile) return;
  const { fileName, sizeBytes, result } = currentProfile;
  fileMeta.appendChild(field('file', fileName));
  fileMeta.appendChild(field('size', formatBytes(sizeBytes)));
  if (!result.ok) {
    fileMeta.appendChild(field('error', result.error, 'fail'));
    return;
  }
  fileMeta.appendChild(field('format', result.ast.format));
  for (const k of ['Profile ID', 'Total', 'Task State']) {
    const v = result.ast.summary.get(k);
    if (v) fileMeta.appendChild(field(k, v));
  }
  if (result.ast.warnings.length > 0) {
    const badge = el('span', { class: 'badge' }, `⚠ ${result.ast.warnings.length} warnings`);
    badge.addEventListener('click', toggleWarningsPanel);
    fileMeta.appendChild(badge);
  }
}

function field(k, v, cls) {
  return el('span', { class: 'field' + (cls ? ' ' + cls : '') }, [
    el('span', { class: 'k' }, k + ':'),
    el('span', { class: 'v' }, String(v)),
  ]);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Warnings panel.
const warningsPanel = el('div', { class: 'warnings-panel', id: 'warnings-panel' });
document.body.appendChild(warningsPanel);

function toggleWarningsPanel() {
  const visible = warningsPanel.classList.toggle('visible');
  if (visible) {
    clear(warningsPanel);
    for (const w of currentProfile.result.ast.warnings) {
      warningsPanel.appendChild(el('div', { class: 'w-row' }, [
        el('span', { class: 'w-line' }, `L${w.line + 1}:`),
        document.createTextNode(w.message),
      ]));
    }
  }
}

registerTab('Raw', renderRaw);
