const electron = require('electron');
const { contextBridge, ipcRenderer } = electron;
const webUtils = electron.webUtils;

function pathForFile(file) {
  if (webUtils && typeof webUtils.getPathForFile === 'function') {
    try {
      const p = webUtils.getPathForFile(file);
      if (p) return p;
    } catch (_) {}
  }
  if (file && typeof file.path === 'string') return file.path;
  return '';
}

contextBridge.exposeInMainWorld('api', {
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  inspectFiles: (paths) => ipcRenderer.invoke('files:inspect', paths),
  runTask: (payload) => ipcRenderer.invoke('task:run', payload),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  revealInFolder: (p) => ipcRenderer.invoke('shell:revealInFolder', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('task:progress', handler);
    return () => ipcRenderer.removeListener('task:progress', handler);
  },
  pathForFile,
  webUtilsAvailable: !!(webUtils && webUtils.getPathForFile),
  electronVersion: process.versions.electron || '',

  // ===== auto-update events =====
  onUpdateDownloading: (cb) => ipcRenderer.on('update:downloading', () => cb()),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, d) => cb(d)),
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', () => cb()),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (_e, msg) => cb(msg))
});
