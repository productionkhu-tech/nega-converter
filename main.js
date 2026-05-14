const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

const isDev = !app.isPackaged;

function resolveFfmpegPath() {
  const raw = require('ffmpeg-static');
  if (!raw) throw new Error('ffmpeg-static not found');
  return raw.replace('app.asar', 'app.asar.unpacked');
}

const FFMPEG_PATH = resolveFfmpegPath();

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

function stripKnownPrefix(name) {
  return name.replace(/^(Nega|POS)_/, '');
}

function buildOutputPath(inputPath) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath);
  let outName;
  if (/^Nega_/.test(base)) {
    // 네거티브의 네거티브 = 원본 색. 원본을 덮지 않도록 POS_ 붙임.
    outName = `POS_${stripKnownPrefix(base)}`;
  } else if (/^POS_/.test(base)) {
    // POS_ 의 네거티브 = Nega_
    outName = `Nega_${stripKnownPrefix(base)}`;
  } else {
    outName = `Nega_${base}`;
  }
  // Guard against an empty stem (e.g. input was literally "Nega_.png")
  if (path.basename(outName, path.extname(outName)) === '') {
    outName = `Converted_${stripKnownPrefix(base)}`;
  }
  let outPath = path.join(dir, outName);
  let n = 1;
  while (fs.existsSync(outPath)) {
    const ext = path.extname(outName);
    const stem = outName.slice(0, outName.length - ext.length);
    outName = `${stem}_${n}${ext}`;
    outPath = path.join(dir, outName);
    n++;
  }
  return outPath;
}

function buildArgs(inputPath, outputPath, kind) {
  const ext = path.extname(inputPath).toLowerCase();
  const common = ['-hide_banner', '-loglevel', 'error', '-stats', '-y', '-i', inputPath, '-vf', 'negate'];

  if (kind === 'image') {
    if (ext === '.jpg' || ext === '.jpeg') {
      return [...common, '-q:v', '1', '-pix_fmt', 'yuvj444p', outputPath];
    }
    if (ext === '.png') {
      return [...common, '-compression_level', '6', outputPath];
    }
    if (ext === '.webp') {
      return [...common, '-quality', '100', '-lossless', '1', outputPath];
    }
    return [...common, outputPath];
  }

  // video
  return [
    ...common,
    '-c:v', 'libx264',
    '-crf', '15',
    '-preset', 'slow',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-map_metadata', '0',
    '-movflags', '+faststart',
    outputPath
  ];
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    const ffprobePath = FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, (m, ex) => `ffprobe${ex || ''}`);
    // ffmpeg-static doesn't ship ffprobe; fall back to ffmpeg -i parsing.
    if (!fs.existsSync(ffprobePath)) {
      const proc = spawn(FFMPEG_PATH, ['-hide_banner', '-i', filePath]);
      let buf = '';
      proc.stderr.on('data', (d) => { buf += d.toString(); });
      proc.on('close', () => {
        const m = buf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
          resolve(sec);
        } else {
          resolve(0);
        }
      });
      proc.on('error', () => resolve(0));
      return;
    }
    const proc = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => resolve(parseFloat(out) || 0));
    proc.on('error', () => resolve(0));
  });
}

const tasks = new Map(); // id -> { proc, cancelled }

function convertFile(taskId, inputPath, kind, duration, sender) {
  return new Promise((resolve) => {
    const outputPath = buildOutputPath(inputPath);
    const args = buildArgs(inputPath, outputPath, kind);
    const proc = spawn(FFMPEG_PATH, args);

    tasks.set(taskId, { proc, cancelled: false, outputPath });

    let stderrBuf = '';

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);

      if (kind === 'video' && duration > 0) {
        const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
          const pct = Math.max(0, Math.min(99, (sec / duration) * 100));
          sender.send('task:progress', { id: taskId, progress: pct });
        }
      }
    });

    proc.on('error', (err) => {
      tasks.delete(taskId);
      resolve({ ok: false, error: err.message, outputPath });
    });

    proc.on('close', (code) => {
      const info = tasks.get(taskId);
      tasks.delete(taskId);
      if (info && info.cancelled) {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        resolve({ ok: false, error: 'cancelled', outputPath, cancelled: true });
        return;
      }
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ ok: true, outputPath });
      } else {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        resolve({ ok: false, error: stderrBuf.trim() || `exit ${code}`, outputPath });
      }
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    backgroundColor: '#f3f3f3',
    title: 'Nega Converter',
    autoHideMenuBar: true,
    show: false,
    ...(isDev ? { icon: path.join(__dirname, 'build', 'icon.ico') } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // F12 toggles devtools even in packaged builds (for diagnostics)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' ||
        (input.control && input.shift && (input.key === 'I' || input.key === 'i')))) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  return win;
}

function setupAutoUpdate(win) {
  if (isDev) {
    console.log('[updater] dev mode — skipping update check');
    return;
  }

  autoUpdater.autoDownload = false;            // 사용자가 확인하기 전엔 다운로드 안 함
  autoUpdater.autoInstallOnAppQuit = true;     // 미설치 업데이트는 종료 시 적용

  let handled = false;

  autoUpdater.on('update-available', async (info) => {
    if (handled) return;
    handled = true;
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['지금 업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '업데이트 확인',
      message: `새 버전 ${info.version} 이(가) 있습니다.`,
      detail: '“지금 업데이트”를 누르면 다운로드 후 앱이 자동으로 종료되었다가 다시 실행됩니다.'
    });
    if (response === 0) {
      win.webContents.send('update:downloading');
      autoUpdater.downloadUpdate().catch((err) => {
        win.webContents.send('update:error', String((err && err.message) || err));
        dialog.showErrorBox('업데이트 실패', String((err && err.message) || err));
      });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    win.webContents.send('update:progress', {
      percent: p.percent || 0,
      transferred: p.transferred || 0,
      total: p.total || 0
    });
  });

  autoUpdater.on('update-downloaded', () => {
    win.webContents.send('update:ready');
    // 조용히 설치(isSilent=true) + 설치 후 자동 재실행(isForceRunAfter=true)
    setImmediate(() => {
      try { autoUpdater.quitAndInstall(true, true); } catch (e) {
        console.error('[updater] quitAndInstall failed:', e);
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err);
    win.webContents.send('update:error', String((err && err.message) || err));
  });

  // 앱을 열자마자 업데이트 확인
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] checkForUpdates failed:', err);
  });
}

ipcMain.handle('dialog:pickFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: '변환할 파일 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '이미지 / 영상', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] },
      { name: '모든 파일', extensions: ['*'] }
    ]
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('files:inspect', async (_e, paths) => {
  const out = [];
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      const kind = classify(p);
      if (!kind) {
        out.push({ path: p, kind: null, size: stat.size, duration: 0, supported: false });
        continue;
      }
      let duration = 0;
      if (kind === 'video') duration = await probeDuration(p);
      out.push({ path: p, kind, size: stat.size, duration, supported: true });
    } catch (e) {
      out.push({ path: p, kind: null, size: 0, duration: 0, supported: false, error: e.message });
    }
  }
  return out;
});

ipcMain.handle('task:run', async (e, { id, path: filePath, kind, duration }) => {
  return convertFile(id, filePath, kind, duration, e.sender);
});

ipcMain.handle('task:cancel', async (_e, id) => {
  const info = tasks.get(id);
  if (!info) return false;
  info.cancelled = true;
  try { info.proc.kill('SIGKILL'); } catch {}
  return true;
});

ipcMain.handle('shell:revealInFolder', async (_e, filePath) => {
  if (!filePath) return false;
  try { shell.showItemInFolder(filePath); return true; } catch { return false; }
});

ipcMain.handle('shell:openPath', async (_e, p) => {
  if (!p) return false;
  try { await shell.openPath(p); return true; } catch { return false; }
});

// ===== 중복 실행 방지 (single instance) =====
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 두 번째로 실행하면 기존 창을 앞으로 가져옴
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const win = createWindow();
    setupAutoUpdate(win);
  });
}

app.on('window-all-closed', () => {
  for (const { proc } of tasks.values()) {
    try { proc.kill('SIGKILL'); } catch {}
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
