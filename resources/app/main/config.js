'use strict';
// Desktop-level configuration and persisted UI state (stored in Electron userData).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  piCliPath: '',        // empty = auto detect
  nodePath: '',         // empty = auto detect (system node >= 22.19, else Electron's bundled Node)
  shell: '',            // empty = platform default
  uiFontSize: 13,
  editorFontSize: 14,
  chatFontSize: 13,
  autoSave: false,
  notifyOnDone: true,
  showThinking: true,
  wordWrap: 'off',
  theme: 'dark',        // dark | light
  sendKey: 'enter',     // enter | ctrl-enter
  minimap: true,
  recent: [],
  lastOpened: [],
  windows: {},          // folder -> saved window state
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!cache) return;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file());
  } catch (err) {
    console.error('config save failed', err);
  }
}

function get() {
  const c = load();
  const { windows, ...rest } = c;
  return rest;
}

function patch(p) {
  const c = load();
  for (const [k, v] of Object.entries(p || {})) {
    if (k === 'windows' || k === 'recent') continue;
    if (k in DEFAULTS) c[k] = v;
  }
  save();
  return get();
}

function addRecent(folder) {
  const c = load();
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  c.recent = [folder, ...c.recent.filter((f) => norm(f) !== norm(folder))].slice(0, 20);
  save();
}

function removeRecent(folder) {
  const c = load();
  c.recent = c.recent.filter((f) => f !== folder);
  save();
}

function windowState(folder) {
  return load().windows[folder] || null;
}

function saveWindowState(folder, state) {
  const c = load();
  c.windows[folder] = state;
  // keep the map bounded
  const keys = Object.keys(c.windows);
  if (keys.length > 50) {
    for (const k of keys.slice(0, keys.length - 50)) delete c.windows[k];
  }
  save();
}

module.exports = { load, get, patch, flush, addRecent, removeRecent, windowState, saveWindowState, DEFAULTS };
