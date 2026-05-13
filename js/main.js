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
  fileMeta.textContent = `${file.name} (${file.size} bytes) — format=${result.ok ? result.ast.format : 'error'}`;
  window.__profile = currentProfile;   // exposed for quick manual inspection
  renderActive();
}

registerTab('Raw', renderRaw);
