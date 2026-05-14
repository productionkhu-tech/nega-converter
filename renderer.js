(function () {
'use strict';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);

const dropzone = $('#dropzone');
const list = $('#list');
const empty = $('#empty');
const btnPick = $('#btn-pick');
const btnClear = $('#btn-clear');
const dzPick = $('#dz-pick');
const statusDot = $('#status-dot');
const statusText = $('#status-text');
const countDone = $('#count-done');
const countTotal = $('#count-total');
const rowTpl = $('#row-template');

let nextId = 1;
const items = new Map(); // id -> { path, kind, duration, size, state, el, outputPath }
const queue = [];
let runningCount = 0;
const MAX_CONCURRENT = 2;

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function formatDuration(sec) {
  if (!sec) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function basename(p) {
  return p.split(/[\\/]/).pop();
}

function targetPrefix(p) {
  const b = basename(p);
  if (/^Nega_/.test(b)) return 'POS';
  return 'Nega';
}
function isReverseInput(p) {
  return /^Nega_/.test(basename(p));
}

function updateCounters() {
  let done = 0;
  for (const it of items.values()) {
    if (it.state === 'done' || it.state === 'error' || it.state === 'cancelled') done++;
  }
  countDone.textContent = done;
  countTotal.textContent = items.size;

  const total = items.size;
  if (total === 0) {
    setStatus('idle', '대기 중');
  } else if (runningCount > 0 || queue.length > 0) {
    setStatus('busy', `변환 중… (${done}/${total})`);
  } else if (done === total) {
    let okCount = 0;
    let errCount = 0;
    for (const it of items.values()) {
      if (it.state === 'done') okCount++;
      else if (it.state === 'error') errCount++;
    }
    if (errCount === 0) setStatus('done', `전체 완료 (${okCount}개)`);
    else setStatus('err', `완료 ${okCount}개 · 실패 ${errCount}개`);
  } else {
    setStatus('idle', '대기 중');
  }
}

function setStatus(kind, text) {
  statusDot.className = 'dot ' + (kind === 'idle' ? '' : kind);
  statusText.textContent = text;
}

function addRow(info) {
  const id = nextId++;
  const node = rowTpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = String(id);
  node.dataset.kind = info.kind || 'unknown';
  node.dataset.state = 'pending';

  const nameEl = $('.row-name', node);
  nameEl.textContent = basename(info.path);
  nameEl.title = info.path;

  $('.meta-kind', node).textContent = info.kind === 'video' ? '영상' : info.kind === 'image' ? '이미지' : '미지원';
  $('.meta-size', node).textContent = formatSize(info.size);
  $('.meta-duration', node).textContent = info.kind === 'video' ? formatDuration(info.duration) : '';

  const reverse = isReverseInput(info.path);
  const prefix = targetPrefix(info.path);
  const dirEl = $('.meta-direction', node);
  if (info.supported) {
    dirEl.hidden = false;
    dirEl.textContent = reverse ? `원본 색 (POS_)` : `네거티브 (Nega_)`;
    dirEl.classList.toggle('restore', reverse);
  }

  const statusEl = $('.row-status', node);
  if (!info.supported) {
    statusEl.textContent = '지원하지 않는 형식';
    node.dataset.state = 'error';
  } else {
    statusEl.textContent = '대기 중';
  }

  $('.btn-remove', node).addEventListener('click', () => removeItem(id));
  $('.btn-cancel', node).addEventListener('click', () => cancelItem(id));
  $('.btn-reveal', node).addEventListener('click', () => {
    const it = items.get(id);
    if (it && it.outputPath) api.revealInFolder(it.outputPath);
  });

  list.appendChild(node);

  const item = {
    id,
    path: info.path,
    kind: info.kind,
    duration: info.duration || 0,
    size: info.size || 0,
    supported: !!info.supported,
    state: info.supported ? 'pending' : 'error',
    el: node,
    outputPath: null
  };
  items.set(id, item);

  if (item.supported) queue.push(id);
  updateCounters();
  pump();
  return id;
}

function removeItem(id) {
  const it = items.get(id);
  if (!it) return;
  if (it.state === 'running') {
    cancelItem(id);
  }
  it.el.remove();
  items.delete(id);
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  updateCounters();
}

async function cancelItem(id) {
  const it = items.get(id);
  if (!it) return;
  if (it.state === 'running') {
    await api.cancelTask(id);
  } else {
    const qi = queue.indexOf(id);
    if (qi >= 0) queue.splice(qi, 1);
    it.state = 'cancelled';
    it.el.dataset.state = 'cancelled';
    $('.row-status', it.el).textContent = '취소됨';
    updateCounters();
  }
}

function pump() {
  while (runningCount < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift();
    const it = items.get(id);
    if (!it || it.state !== 'pending') continue;
    startTask(it);
  }
}

async function startTask(it) {
  runningCount++;
  it.state = 'running';
  it.el.dataset.state = 'running';
  const reverse = isReverseInput(it.path);
  $('.row-status', it.el).textContent = reverse ? '복원 중…' : '변환 중…';
  $('.btn-cancel', it.el).hidden = false;
  $('.btn-remove', it.el).hidden = true;
  $('.row-progress-bar', it.el).style.width = it.kind === 'image' ? '40%' : '0%';
  updateCounters();

  const result = await api.runTask({ id: it.id, path: it.path, kind: it.kind, duration: it.duration });

  runningCount--;
  $('.btn-cancel', it.el).hidden = true;
  $('.btn-remove', it.el).hidden = false;

  if (result && result.ok) {
    it.state = 'done';
    it.outputPath = result.outputPath;
    it.el.dataset.state = 'done';
    $('.row-progress-bar', it.el).style.width = '100%';
    const statusEl = $('.row-status', it.el);
    statusEl.innerHTML = '';
    const txt = document.createElement('span');
    txt.textContent = '완료 · ';
    const link = document.createElement('span');
    link.className = 'out-link';
    link.textContent = basename(result.outputPath);
    link.title = result.outputPath;
    link.addEventListener('click', () => api.revealInFolder(result.outputPath));
    statusEl.appendChild(txt);
    statusEl.appendChild(link);
    $('.btn-reveal', it.el).hidden = false;
  } else if (result && result.cancelled) {
    it.state = 'cancelled';
    it.el.dataset.state = 'cancelled';
    $('.row-status', it.el).textContent = '취소됨';
  } else {
    it.state = 'error';
    it.el.dataset.state = 'error';
    const err = (result && result.error) ? String(result.error).split('\n').pop() : '실패';
    $('.row-status', it.el).textContent = `실패 · ${err}`;
  }
  updateCounters();
  pump();
}

api.onProgress(({ id, progress }) => {
  const it = items.get(id);
  if (!it || it.state !== 'running') return;
  const bar = $('.row-progress-bar', it.el);
  bar.style.width = `${progress}%`;
  const label = isReverseInput(it.path) ? '복원 중' : '변환 중';
  $('.row-status', it.el).textContent = `${label}… ${progress.toFixed(0)}%`;
});

async function ingestPaths(paths) {
  if (!paths || paths.length === 0) return;
  try {
    const inspected = await api.inspectFiles(paths);
    console.log('[ingest] inspected:', inspected);
    for (const info of inspected) addRow(info);
  } catch (e) {
    console.error('[ingest] error:', e);
    alert('파일 분석 오류: ' + (e && e.message ? e.message : e));
  }
}

// Pick files via dialog
async function pick() {
  try {
    const paths = await api.pickFiles();
    console.log('[pick] paths:', paths);
    if (paths && paths.length) ingestPaths(paths);
  } catch (e) {
    console.error('[pick] error:', e);
    alert('파일 선택 오류: ' + (e && e.message ? e.message : e));
  }
}
btnPick.addEventListener('click', pick);
dzPick.addEventListener('click', (e) => { e.stopPropagation(); pick(); });
dropzone.addEventListener('click', pick);
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
});

btnClear.addEventListener('click', () => {
  const ids = [...items.keys()];
  for (const id of ids) removeItem(id);
});

// Drag & drop — accept drops anywhere on the window
['dragenter', 'dragover'].forEach(evt => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('drag');
  });
});
window.addEventListener('dragleave', (e) => {
  // Only remove when leaving window (relatedTarget is null)
  if (!e.relatedTarget) dropzone.classList.remove('drag');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
  console.log('[drop] files:', files.length, files.map(f => ({ name: f.name, path: f.path, type: f.type, size: f.size })));
  const paths = files
    .map(f => (f && f.path) ? f.path : api.pathForFile(f))
    .filter(Boolean);
  console.log('[drop] resolved paths:', paths);
  if (!paths.length && files.length) {
    alert(`파일 경로를 읽지 못했습니다.\n파일 개수: ${files.length}\nF12로 콘솔을 열어 자세한 정보를 확인하세요.`);
    return;
  }
  if (paths.length) ingestPaths(paths);
});

updateCounters();
console.log('[boot] electron:', api.electronVersion, 'webUtils available:', api.webUtilsAvailable);

// ===== auto-update overlay =====
const updateOverlay = $('#update-overlay');
const updateBarFill = $('#update-bar-fill');
const updatePct = $('#update-pct');
const updateTitle = document.querySelector('.update-title');

if (api.onUpdateDownloading) {
  api.onUpdateDownloading(() => { updateOverlay.hidden = false; });
  api.onUpdateProgress((d) => {
    updateOverlay.hidden = false;
    const p = Math.max(0, Math.min(100, (d && d.percent) || 0));
    updateBarFill.style.width = p + '%';
    updatePct.textContent = p.toFixed(0) + '%';
  });
  api.onUpdateReady(() => {
    updateBarFill.style.width = '100%';
    updatePct.textContent = '100%';
    if (updateTitle) updateTitle.textContent = '재시작 중…';
  });
  api.onUpdateError(() => { updateOverlay.hidden = true; });
}

})();
