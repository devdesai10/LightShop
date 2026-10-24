'use strict';
// LightShop desktop shell: serves the built web app (dist/) from a private app:// origin inside a
// locked-down BrowserWindow. No Node access in the page; only a tiny preload bridge.

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'lightshop';
const ORIGIN = `${SCHEME}://${HOST}`;
const DIST = path.join(__dirname, '..', 'dist');
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Permissions the app actually uses; everything else (camera, mic, location, ...) is denied.
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'fileSystem', 'storage-access']);

// Cmd/Ctrl shortcuts the web app handles itself (editor undo, copy/paste pixels, zoom, panels...).
// While no text field is focused these go to the page instead of the native menu.
const PAGE_SHORTCUT_KEYS = new Set(['z', 'y', 'a', 'c', 'x', 'v', 'd', 'n', 'o', 's', 'w', 'e', 'j', 'l', 'm', 'i', 'u', 'b', 't', '0', '1', '=', '+', '-', 'backspace']);

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
let textFocus = false;

async function serve(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(DIST, path.normalize(rel));
  if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
  const res = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(res.headers);
  if (file.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
  return new Response(res.body, { status: res.status, headers });
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

// ---------------------------------------------------------------- Editor exports
// Export As: the page asks for a Save dialog, then hands over the encoded file. Quick Export: the page hands
// over a file to save as a new file in Downloads. The page never names a path: files are written only where
// the user chose in the dialog, or as a new file in Downloads. Tokens let it show a saved file in Finder.

const SAVE_TYPES = { png: 'PNG image', jpg: 'JPEG image', webp: 'WebP image', psd: 'Photoshop document' };
/** token -> { file, written } */
const savedFiles = new Map();
let exportPrefs = null;

const fromPage = (event) => !!mainWindow && event.sender === mainWindow.webContents && String(event.senderFrame?.url ?? '').startsWith(`${ORIGIN}/`);

function prefsFile() {
  return path.join(app.getPath('userData'), 'export-prefs.json');
}
function loadExportPrefs() {
  if (!exportPrefs) {
    try {
      exportPrefs = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    } catch {
      exportPrefs = {};
    }
  }
  return exportPrefs;
}
function saveExportPrefs() {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify(exportPrefs));
  } catch (e) {
    console.warn('Could not save export preferences', e);
  }
}

function isDir(p) {
  try {
    return typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A file name the page suggested, made safe: no folders, no characters file systems reject, extension `ext`. */
function safeFileName(name, ext) {
  const base = path
    .basename(String(name ?? ''))
    .replace(/\.(png|jpe?g|webp|psd)$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 200);
  return `${base || 'Untitled'}.${ext}`;
}

function fileData(data) {
  let buf = null;
  if (data instanceof Uint8Array) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  if (!buf || !buf.length) throw new Error('No file data');
  return buf;
}

/** How a folder is named to the user: "Downloads", "Pictures", "Wallpapers"... */
function folderLabel(file) {
  const dir = path.dirname(file);
  return path.basename(dir) || dir;
}

function rememberFile(file, written) {
  const token = crypto.randomUUID();
  savedFiles.set(token, { file, written });
  if (savedFiles.size > 200) savedFiles.delete(savedFiles.keys().next().value);
  return token;
}

function saveFailure(e, file) {
  const code = e && e.code;
  const error = code === 'EACCES' || code === 'EPERM' ? 'denied' : code === 'ENOSPC' || code === 'EDQUOT' ? 'full' : 'other';
  return { ok: false, error, message: String((e && e.message) || e), folder: folderLabel(file) };
}

function setupExports() {
  ipcMain.handle('ls:choose-save-file', async (event, o) => {
    if (!fromPage(event)) throw new Error('Not allowed');
    const ext = o && Object.prototype.hasOwnProperty.call(SAVE_TYPES, o.ext) ? o.ext : null;
    if (!ext) throw new Error('Unknown file type');
    const prefs = loadExportPrefs();
    const dir = isDir(prefs.lastSaveDir) ? prefs.lastSaveDir : app.getPath('downloads');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Export As',
      buttonLabel: 'Export',
      defaultPath: path.join(dir, safeFileName(o.name, ext)),
      filters: [{ name: SAVE_TYPES[ext], extensions: [ext] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return null;
    let file = r.filePath;
    if (path.extname(file).toLowerCase() !== `.${ext}`) file += `.${ext}`;
    prefs.lastSaveDir = path.dirname(file);
    saveExportPrefs();
    return { token: rememberFile(file, false), name: path.basename(file) };
  });

  ipcMain.handle('ls:write-save-file', async (event, token, data) => {
    if (!fromPage(event)) throw new Error('Not allowed');
    const entry = savedFiles.get(token);
    if (!entry || entry.written) throw new Error('Unknown export');
    try {
      await fs.promises.writeFile(entry.file, fileData(data));
    } catch (e) {
      return saveFailure(e, entry.file);
    }
    entry.written = true;
    return { ok: true, token, name: path.basename(entry.file), folder: folderLabel(entry.file) };
  });

  ipcMain.handle('ls:quick-save', async (event, o) => {
    if (!fromPage(event)) throw new Error('Not allowed');
    const ext = path.extname(String(o?.name ?? '')).slice(1).toLowerCase();
    if (!['png', 'jpg', 'webp'].includes(ext)) throw new Error('Unknown file type');
    const buf = fileData(o.data);
    const dir = app.getPath('downloads');
    const name = safeFileName(o.name, ext);
    let file = path.join(dir, name);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // A new file: numbered when the name is taken (and never over an existing one).
      for (let i = 0; i < 20; i++) {
        file = uniquePath(dir, name);
        try {
          await fs.promises.writeFile(file, buf, { flag: 'wx' });
          return { ok: true, token: rememberFile(file, true), name: path.basename(file), folder: folderLabel(file) };
        } catch (e) {
          if (!e || e.code !== 'EEXIST') throw e;
        }
      }
      throw new Error('Could not find a free file name');
    } catch (e) {
      return saveFailure(e, file);
    }
  });

  ipcMain.on('ls:reveal-file', (event, token) => {
    if (!fromPage(event)) return;
    const entry = savedFiles.get(token);
    if (entry && entry.written) shell.showItemInFolder(entry.file);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    title: 'LightShop',
    backgroundColor: '#141416',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${ORIGIN}/index.html`);

  // Only the bundled app may load in this window; real links open in the default browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Route Cmd shortcuts: text fields get native editing; everything else goes to the app.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const pageOwned = (input.meta || input.control) && !textFocus && PAGE_SHORTCUT_KEYS.has(key);
    win.webContents.setIgnoreMenuShortcuts(pageOwned);
  });

  // The page blocks unload while Editor documents are unsaved; ask instead of silently refusing.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quit Anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have Editor documents that are not saved to the Library.',
      detail: 'Their changes will be lost if you quit now.',
    });
    if (choice === 0) event.preventDefault();
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }],
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Show App Data in Finder',
          click: () => shell.openPath(app.getPath('userData')),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  protocol.handle(SCHEME, serve);

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Exports save straight into ~/Downloads (like the browser build), without one dialog per file.
  ses.on('will-download', (_event, item) => {
    const target = uniquePath(app.getPath('downloads'), item.getFilename());
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      if (state === 'completed' && process.platform === 'darwin') app.dock?.downloadFinished(target);
    });
  });

  ipcMain.on('ls:text-focus', (event, focused) => {
    if (mainWindow && event.sender === mainWindow.webContents) textFocus = !!focused;
  });
  setupExports();

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
