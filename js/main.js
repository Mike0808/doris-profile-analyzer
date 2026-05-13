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
  if (!currentProfile) {
    content.appendChild(el('div', { class: 'empty-state' }, 'Open a Doris profile to begin'));
    return;
  }
  if (!currentProfile.result.ok) {
    // Render the raw input directly so the user can see what arrived.
    const fakeAst = { sourceText: currentProfile.rawInput, warnings: [] };
    content.appendChild(el('div', { class: 'banner' }, 'Could not parse: ' + currentProfile.result.error + ' — showing raw input'));
    t.renderer(content, fakeAst);
    return;
  }
  const ast = currentProfile.result.ast;
  if (ast.mergedProfile.fragments.length === 0 && ast.summary.size === 0) {
    content.appendChild(el('div', { class: 'banner' }, "Doesn't look like a Doris profile — showing raw text"));
  }
  t.renderer(content, ast);
}

openBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) loadFile(fileInput.files[0]);
});

// Drag counter pattern: dragenter/dragleave fire between sibling elements during
// a drag, so tracking a counter is the only reliable way to know when the cursor
// has truly left the window.
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  overlay.classList.add('visible');
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    overlay.classList.remove('visible');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  overlay.classList.remove('visible');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    loadFile(e.dataTransfer.files[0]);
  }
});

async function loadFile(file) {
  let text;
  try {
    text = await file.text();
  } catch (e) {
    toast('Failed to read file: ' + (e.message || e));
    return;
  }
  const result = runPipeline(text);
  currentProfile = { fileName: file.name, sizeBytes: file.size, result, rawInput: text };
  if (!result.ok) {
    toast(result.error);
  }
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

function toast(msg, ms = 4000) {
  const t = el('div', { class: 'toast' }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
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
