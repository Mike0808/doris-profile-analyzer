import { runPipeline } from './parser/textParser.js';

const openBtn   = document.getElementById('open-btn');
const fileInput = document.getElementById('file-input');
const overlay   = document.getElementById('drop-overlay');
const fileMeta  = document.getElementById('file-meta');

let currentProfile = null;   // { fileName, sizeBytes, result }

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
  // Rendering wired up in Task 15.
  window.__profile = currentProfile;   // exposed for quick manual inspection
}
