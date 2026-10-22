'use strict';
// Workspace file-system services: tree listing, read/write, watch, quick-open file list and search.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const piEnv = require('./pi-env');

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', '.DS_Store', '__pycache__', '.idea', '.vs', 'dist-electron']);
const MAX_READ = 20 * 1024 * 1024;

async function list(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try { isDir = (await fsp.stat(path.join(dir, e.name))).isDirectory(); } catch { /* broken link */ }
    }
    out.push({ name: e.name, path: path.join(dir, e.name), dir: isDir });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.dir ? -1 : 1));
  return out;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function read(file) {
  const st = await fsp.stat(file);
  if (st.size > MAX_READ) return { tooLarge: true, size: st.size };
  const buf = await fsp.readFile(file);
  if (looksBinary(buf)) return { binary: true, size: st.size, base64: st.size < 8 * 1024 * 1024 ? buf.toString('base64') : null };
  let text = buf.toString('utf8');
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); bom = true; }
  return { text, bom, size: st.size, mtime: st.mtimeMs, eol: text.includes('\r\n') ? 'CRLF' : 'LF' };
}

async function write(file, text, opts = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, (opts.bom ? '\ufeff' : '') + text, 'utf8');
  const st = await fsp.stat(file);
  return { mtime: st.mtimeMs };
}

async function create(file, isDir) {
  if (fs.existsSync(file)) throw new Error('已存在: ' + path.basename(file));
  if (isDir) await fsp.mkdir(file, { recursive: true });
  else {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '');
  }
}

async function rename(from, to) {
  if (fs.existsSync(to)) throw new Error('目标已存在');
  await fsp.rename(from, to);
}

async function stat(file) {
  try {
    const st = await fsp.stat(file);
    return { exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  } catch {
    return { exists: false };
  }
}

// ---------------------------------------------------------------------------
// Watching (one watcher per window folder)
// ---------------------------------------------------------------------------

function watch(folder, onChange) {
  let watcher = null;
  const pending = new Map();
  let timer = null;
  const flush = () => {
    timer = null;
    const items = [...pending.entries()].map(([p, type]) => ({ path: p, type }));
    pending.clear();
    if (items.length) onChange(items);
  };
  try {
    watcher = fs.watch(folder, { recursive: true }, (type, name) => {
      if (!name) return;
      const rel = String(name);
      const first = rel.split(/[\\/]/)[0];
      if (first === '.git' || first === 'node_modules') return;
      pending.set(path.join(folder, rel), type);
      if (!timer) timer = setTimeout(flush, 150);
    });
    watcher.on('error', () => { /* folder removed etc. */ });
  } catch {
    // recursive watch unsupported (older Linux kernels/Node); the UI still refreshes on demand.
  }
  return () => {
    clearTimeout(timer);
    try { watcher && watcher.close(); } catch { /* ignore */ }
  };
}

// ---------------------------------------------------------------------------
// ripgrep helpers (pi downloads rg into its agent bin directory)
// ---------------------------------------------------------------------------

function rgPath() {
  const exe = piEnv.IS_WIN ? 'rg.exe' : 'rg';
  const bundled = path.join(piEnv.agentDir(), 'bin', exe);
  if (fs.existsSync(bundled)) return bundled;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

function runRg(args, cwd, onLine, limitLines) {
  return new Promise((resolve, reject) => {
    const rg = rgPath();
    if (!rg) return reject(new Error('no-rg'));
    const child = spawn(rg, args, { cwd, windowsHide: true });
    let buf = '';
    let count = 0;
    let stopped = false;
    child.stdout.on('data', (d) => {
      if (stopped) return;
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line) {
          onLine(line);
          if (++count >= limitLines) {
            stopped = true;
            child.kill();
            break;
          }
        }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', () => {
      if (!stopped && buf.trim()) onLine(buf.trim());
      resolve(stopped);
    });
  });
}

async function walk(folder, limit) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    let entries;
    try { entries = await fsp.readdir(path.join(folder, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(r);
      } else {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

async function files(folder, limit = 30000) {
  const out = [];
  try {
    const truncated = await runRg(['--files', '--hidden', '-g', '!.git'], folder, (l) => out.push(l.replace(/\\/g, '/')), limit);
    return { files: out, truncated };
  } catch {
    const list2 = await walk(folder, limit);
    return { files: list2, truncated: list2.length >= limit };
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function search(folder, query, opts = {}) {
  if (!query) return { results: [], truncated: false };
  const results = new Map();
  let matches = 0;
  const maxMatches = 3000;
  const add = (file, line, text, ranges) => {
    if (!results.has(file)) results.set(file, []);
    results.get(file).push({ line, text: text.length > 400 ? text.slice(0, 400) : text, ranges });
    matches++;
  };
  const args = ['--json', '--hidden', '-g', '!.git', '--max-columns', '1000'];
  if (!opts.caseSensitive) args.push('-i');
  if (!opts.regex) args.push('-F');
  if (opts.wholeWord) args.push('-w');
  for (const g of String(opts.include || '').split(',').map((s) => s.trim()).filter(Boolean)) args.push('-g', g);
  for (const g of String(opts.exclude || '').split(',').map((s) => s.trim()).filter(Boolean)) args.push('-g', `!${g}`);
  args.push('--', query, '.');
  try {
    const truncated = await runRg(args, folder, (line) => {
      let rec;
      try { rec = JSON.parse(line); } catch { return; }
      if (rec.type !== 'match') return;
      const file = path.join(folder, rec.data.path.text || '');
      const text = (rec.data.lines.text || '').replace(/\r?\n$/, '');
      const ranges = (rec.data.submatches || []).map((m) => [m.start, m.end]);
      // rg reports byte offsets; convert to UTF-16 indices.
      const buf = Buffer.from(text, 'utf8');
      const conv = (b) => buf.subarray(0, b).toString('utf8').length;
      add(file, rec.data.line_number, text, ranges.map(([s, e]) => [conv(s), conv(e)]));
    }, maxMatches * 2);
    return { results: [...results.entries()].map(([file, items]) => ({ file, items })), truncated: truncated || matches >= maxMatches };
  } catch (err) {
    if (err.message !== 'no-rg') throw err;
  }
  // Fallback: pure JS search
  const flags = opts.caseSensitive ? 'g' : 'gi';
  let source = opts.regex ? query : escapeRegex(query);
  if (opts.wholeWord) source = `\\b${source}\\b`;
  const re = new RegExp(source, flags);
  const list2 = await walk(folder, 20000);
  for (const rel of list2) {
    if (matches >= maxMatches) break;
    const file = path.join(folder, rel);
    let text;
    try {
      const st = await fsp.stat(file);
      if (st.size > 2 * 1024 * 1024) continue;
      const buf = await fsp.readFile(file);
      if (looksBinary(buf)) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches < maxMatches; i++) {
      re.lastIndex = 0;
      const ranges = [];
      let m;
      while ((m = re.exec(lines[i])) && ranges.length < 50) {
        ranges.push([m.index, m.index + m[0].length]);
        if (m[0].length === 0) re.lastIndex++;
      }
      if (ranges.length) add(file, i + 1, lines[i], ranges);
    }
  }
  return { results: [...results.entries()].map(([file, items]) => ({ file, items })), truncated: matches >= maxMatches };
}

async function replaceInFile(file, query, replacement, opts = {}) {
  const text = await fsp.readFile(file, 'utf8');
  const flags = opts.caseSensitive ? 'g' : 'gi';
  let source = opts.regex ? query : escapeRegex(query);
  if (opts.wholeWord) source = `\\b${source}\\b`;
  const next = text.replace(new RegExp(source, flags), opts.regex ? replacement : () => replacement);
  if (next !== text) await fsp.writeFile(file, next, 'utf8');
  return next !== text;
}

module.exports = { list, read, write, create, rename, stat, watch, files, search, replaceInFile };
