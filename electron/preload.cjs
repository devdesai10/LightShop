'use strict';
// Minimal, explicit bridge between the sandboxed page and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lightshopDesktop', {
  platform: process.platform,
  setTextFocus: (focused) => ipcRenderer.send('ls:text-focus', !!focused),
  // Editor exports (see setupExports in main.cjs).
  chooseSaveFile: (o) => ipcRenderer.invoke('ls:choose-save-file', { name: String(o?.name ?? ''), ext: String(o?.ext ?? '') }),
  writeSaveFile: (token, data) => ipcRenderer.invoke('ls:write-save-file', String(token), data),
  quickSave: (o) => ipcRenderer.invoke('ls:quick-save', { name: String(o?.name ?? ''), data: o?.data }),
  revealFile: (token) => ipcRenderer.send('ls:reveal-file', String(token)),
});
