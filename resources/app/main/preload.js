'use strict';
// Exposes a narrow, promise-based API to the renderer.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invoke(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.ok) return r.value;
  throw new Error((r && r.error) || `${channel} failed`);
}

const listeners = new Map();

contextBridge.exposeInMainWorld('pi', {
  invoke,
  send: (channel, ...args) => {
    if (channel === 'term:write' || channel === 'term:resize') ipcRenderer.send(channel, ...args);
  },
  on: (channel, fn) => {
    const allowed = ['session:event', 'session:desktop', 'session:stderr', 'session:exit', 'session:changes', 'term:data', 'term:exit', 'fs:changed', 'menu:command', 'config:changed'];
    if (!allowed.includes(channel)) throw new Error('channel not allowed: ' + channel);
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  platform: process.platform,
  selftest: {
    shot: (name) => ipcRenderer.invoke('selftest:shot', name),
    done: (code) => ipcRenderer.invoke('selftest:done', code),
  },
});
void listeners;
