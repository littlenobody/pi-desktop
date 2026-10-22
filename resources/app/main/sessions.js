'use strict';
// Saved-session discovery for the chat history list (mirrors what `/resume` shows).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const piEnv = require('./pi-env');

const cache = new Map(); // file -> { mtime, size, info }

async function readHead(file, maxBytes = 256 * 1024) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ');
  return '';
}

async function parseInfo(file, st) {
  const head = await readHead(file);
  const lines = head.split('\n');
  let header = null;
  let firstUser = '';
  let messages = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'session') header = rec;
    else if (rec.type === 'message' && rec.message) {
      if (rec.message.role === 'user') {
        messages++;
        if (!firstUser) firstUser = textOf(rec.message.content).slice(0, 200);
      } else if (rec.message.role === 'assistant') messages++;
    }
  }
  // The display name can be set at any time, so scan the tail as well.
  let name = null;
  const nameRe = /"type":"session_info"[^\n]*?"name":"((?:[^"\\]|\\.)*)"/g;
  let text = head;
  if (st.size > head.length) {
    try {
      const fh = await fsp.open(file, 'r');
      const len = Math.min(st.size, 512 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      await fh.close();
      text = head + '\n' + buf.toString('utf8');
    } catch { /* ignore */ }
  }
  let m;
  while ((m = nameRe.exec(text))) {
    try { name = JSON.parse(`"${m[1]}"`); } catch { name = m[1]; }
  }
  if (!header) return null;
  return {
    file,
    id: header.id,
    cwd: header.cwd,
    created: header.timestamp,
    modified: st.mtimeMs,
    size: st.size,
    name,
    firstMessage: firstUser,
    messages,
    parentSession: header.parentSession,
  };
}

async function listDir(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
    const file = path.join(dir, n);
    try {
      const st = await fsp.stat(file);
      const c = cache.get(file);
      if (c && c.mtime === st.mtimeMs && c.size === st.size) {
        if (c.info) out.push(c.info);
        return;
      }
      const info = await parseInfo(file, st);
      cache.set(file, { mtime: st.mtimeMs, size: st.size, info });
      if (info) out.push(info);
    } catch { /* ignore broken file */ }
  }));
  return out;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return piEnv.IS_WIN ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

async function list(cwd, all = false) {
  const root = piEnv.sessionsRoot();
  let items = [];
  if (all) {
    if (root.flat) items = await listDir(root.dir);
    else {
      let dirs = [];
      try { dirs = await fsp.readdir(root.dir); } catch { /* none */ }
      for (const d of dirs) items.push(...(await listDir(path.join(root.dir, d))));
    }
  } else {
    items = await listDir(piEnv.sessionDirFor(cwd));
    if (root.flat) items = items.filter((i) => samePath(i.cwd, cwd));
  }
  items.sort((a, b) => b.modified - a.modified);
  return items;
}

async function remove(file) {
  const root = path.resolve(piEnv.sessionsRoot().dir);
  const target = path.resolve(file);
  if (!target.startsWith(root) || !target.endsWith('.jsonl')) throw new Error('拒绝删除会话目录之外的文件');
  await fsp.unlink(target);
  cache.delete(target);
}

async function rename(file, name) {
  // Append a session_info entry, just like `/name` does. Only used for sessions that are not open.
  const text = await fsp.readFile(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  let lastId = null;
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (r.id && r.type !== 'session') lastId = r.id;
    } catch { /* ignore */ }
  }
  // Use the current leaf: the last appended entry. pi treats the last entry as the leaf.
  const entry = {
    type: 'session_info',
    id: Math.random().toString(16).slice(2, 10).padEnd(8, '0'),
    parentId: lastId,
    timestamp: new Date().toISOString(),
    name,
  };
  await fsp.appendFile(file, (text.endsWith('\n') ? '' : '\n') + JSON.stringify(entry) + '\n');
}

module.exports = { list, remove, rename };
