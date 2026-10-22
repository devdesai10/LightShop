'use strict';
// Minimal, explicit bridge between the sandboxed page and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lightshopDesktop', {
  platform: process.platform,
  setTextFocus: (focused) => ipcRenderer.send('ls:text-focus', !!focused),
});
