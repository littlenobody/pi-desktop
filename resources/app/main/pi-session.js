'use strict';
// One PiSession = one `pi --mode rpc` child process. Handles strict LF JSONL framing,
// request/response correlation, event forwarding and file-change tracking for review/revert.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const piEnv = require('./pi-env');

const DESKTOP_EXTENSION = path.join(__dirname, 'desktop-extension.js');
const DESKTOP_MARKER = '__pidesktop__:';

let seq = 0;

class PiSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.id         desktop-level session id (tab id)
   * @param {string} opts.cwd        working directory
   * @param {string} [opts.sessionFile] resume this session file
   * @param {string} [opts.forkFrom] fork this session file into a new session
   * @param {boolean|null} [opts.approve] true => --approve, false => --no-approve
   * @param {string[]} [opts.extraArgs]
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.opts = opts;
    this.proc = null;
    this.pending = new Map();
    this.stderrTail = '';
    this.buffer = Buffer.alloc(0);
    this.exited = false;
    this.changes = new Map(); // absPath -> { baseline: string|null, toolCalls: number }
    this.toolSnapshots = new Map(); // toolCallId -> { path, before: string|null }
    this.history = []; // [{ path, before, userTs, toolCallId }] in execution order (checkpoints)
    this.currentUserTs = null;
  }

  async start() {
    const cli = await piEnv.findPiCli();
    if (!cli) throw new Error('未找到 pi CLI。请先运行 `npm install -g @earendil-works/pi-coding-agent`，或在设置中指定 pi 路径。');
    const node = await piEnv.findNode();
    const args = [cli, '--mode', 'rpc', '-e', DESKTOP_EXTENSION];
    if (this.opts.sessionFile) args.push('--session', this.opts.sessionFile);
    else if (this.opts.forkFrom) args.push('--fork', this.opts.forkFrom);
    if (this.opts.approve === true) args.push('--approve');
    if (this.opts.approve === false) args.push('--no-approve');
    if (Array.isArray(this.opts.extraArgs)) args.push(...this.opts.extraArgs);

    const env = piEnv.childEnv({ ...node.env, PI_DESKTOP: '1' });
    if (!node.embedded) delete env.ELECTRON_RUN_AS_NODE;

    this.proc = spawn(node.command, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + text).slice(-16000);
      this.emit('stderr', text);
    });
    this.proc.stdin.on('error', () => { /* handled by exit */ });

    const exitPromise = new Promise((resolve) => {
      this.proc.on('error', (err) => {
        this.stderrTail += `\n${err.message}`;
        this._onExit(-1, null);
        resolve();
      });
      this.proc.on('exit', (code, signal) => {
        this._onExit(code, signal);
        resolve();
      });
    });
    this.exitPromise = exitPromise;

    // Wait for the process to answer get_state, which means startup finished.
    const state = await this.request({ type: 'get_state' }, 120000);
    return state;
  }

  _onExit(code, signal) {
    if (this.exited) return;
    this.exited = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`pi 进程已退出 (code ${code}${signal ? `, ${signal}` : ''})\n${this.stderrTail.slice(-3000)}`));
    }
    this.pending.clear();
    this.emit('exit', { code, signal, stderr: this.stderrTail.slice(-6000) });
  }

  _onStdout(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf(0x0a, start);
      if (nl === -1) break;
      let end = nl;
      if (end > start && this.buffer[end - 1] === 0x0d) end--;
      const line = this.buffer.toString('utf8', start, end);
      start = nl + 1;
      if (line.trim()) this._onRecord(line);
    }
    this.buffer = start >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(start);
  }

  _onRecord(line) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      this.emit('stderr', `[非 JSON 输出] ${line}\n`);
      return;
    }
    if (rec.type === 'response' && rec.id && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id);
      this.pending.delete(rec.id);
      clearTimeout(p.timer);
      if (rec.success) p.resolve(rec.data === undefined ? null : rec.data);
      else p.reject(new Error(rec.error || `${rec.command} failed`));
      return;
    }
    // Desktop extension back-channel (notify with marker).
    if (rec.type === 'extension_ui_request' && rec.method === 'notify' && typeof rec.message === 'string' && rec.message.startsWith(DESKTOP_MARKER)) {
      try {
        this.emit('desktop', JSON.parse(rec.message.slice(DESKTOP_MARKER.length)));
      } catch { /* ignore */ }
      return;
    }
    this._trackFileChanges(rec);
    this.emit('event', rec);
  }

  request(command, timeoutMs = 0) {
    if (this.exited || !this.proc) return Promise.reject(new Error('pi 进程未运行'));
    const id = typeof command.id === 'string' && command.id ? command.id : `d${++seq}`;
    if (this.pending.has(id)) return Promise.reject(new Error(`duplicate request id ${id}`));
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`命令 ${command.type} 超时`));
        }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this._write(payload);
    });
  }

  send(record) {
    if (this.exited || !this.proc) return;
    this._write(record);
  }

  _write(obj) {
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      this.emit('stderr', `write failed: ${err.message}\n`);
    }
  }

  async stop() {
    if (!this.proc || this.exited) return;
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    const timer = setTimeout(() => {
      try { this.proc.kill(); } catch { /* ignore */ }
    }, 4000);
    await this.exitPromise;
    clearTimeout(timer);
  }

  kill() {
    if (this.proc && !this.exited) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------------
  // File change tracking (for Cursor-style "review / revert" of agent edits)
  // -------------------------------------------------------------------------

  _resolve(p) {
    if (!p || typeof p !== 'string') return null;
    let s = p.trim();
    if (s.startsWith('@')) s = s.slice(1);
    s = piEnv.expandHome(s);
    return path.resolve(this.cwd, s);
  }

  _readOrNull(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
  }

  _trackFileChanges(rec) {
    if (rec.type === 'message_start' && rec.message && rec.message.role === 'user') {
      this.currentUserTs = rec.message.timestamp || Date.now();
      return;
    }
    if (rec.type === 'tool_execution_start' && (rec.toolName === 'edit' || rec.toolName === 'write')) {
      const file = this._resolve(rec.args && rec.args.path);
      if (!file) return;
      this.toolSnapshots.set(rec.toolCallId, { path: file, before: this._readOrNull(file), args: rec.args, tool: rec.toolName });
      return;
    }
    if (rec.type === 'tool_execution_end' && this.toolSnapshots.has(rec.toolCallId)) {
      const snap = this.toolSnapshots.get(rec.toolCallId);
      this.toolSnapshots.delete(rec.toolCallId);
      if (rec.isError) return;
      const after = this._readOrNull(snap.path);
      let before = snap.before;
      if (snap.tool === 'edit' && after !== null && (before === null || before === after)) {
        // Lost the race with the tool; reconstruct by reversing the replacements.
        before = reverseEdits(after, (snap.args && snap.args.edits) || []);
      }
      const existing = this.changes.get(snap.path);
      this.history.push({ path: snap.path, before, userTs: this.currentUserTs, toolCallId: rec.toolCallId });
      if (existing) {
        existing.toolCalls++;
      } else {
        this.changes.set(snap.path, { baseline: before, toolCalls: 1 });
      }
      this.emit('changes', this.listChanges());
    }
  }

  listChanges() {
    const out = [];
    for (const [file, info] of this.changes) {
      const current = this._readOrNull(file);
      const stat = lineStats(info.baseline || '', current || '');
      out.push({ path: file, created: info.baseline === null, deleted: current === null, added: stat.added, removed: stat.removed, toolCalls: info.toolCalls });
    }
    return out;
  }

  getBaseline(file) {
    const info = this.changes.get(file);
    return info ? info.baseline : undefined;
  }

  revert(file) {
    const info = this.changes.get(file);
    if (!info) return false;
    if (info.baseline === null) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, info.baseline, 'utf8');
    }
    this.changes.delete(file);
    this.emit('changes', this.listChanges());
    return true;
  }

  keep(file) {
    if (file) this.changes.delete(file);
    else this.changes.clear();
    this.emit('changes', this.listChanges());
  }

  /** Files modified by tool calls made at or after the user message with timestamp `userTs`. */
  checkpointFiles(userTs) {
    const files = new Map();
    for (const h of this.history) {
      if (h.userTs !== null && h.userTs >= userTs && !files.has(h.path)) files.set(h.path, h.before);
    }
    return [...files.keys()];
  }

  /** Restore every file touched since `userTs` to the content it had before the first such edit. */
  restoreCheckpoint(userTs) {
    const first = new Map();
    for (const h of this.history) {
      if (h.userTs !== null && h.userTs >= userTs && !first.has(h.path)) first.set(h.path, h.before);
    }
    const restored = [];
    for (const [file, before] of first) {
      try {
        if (before === null) {
          try { fs.unlinkSync(file); } catch { /* already gone */ }
        } else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, before, 'utf8');
        }
        restored.push(file);
        const info = this.changes.get(file);
        if (info && info.baseline === before) this.changes.delete(file);
      } catch (err) {
        this.emit('stderr', `restore failed for ${file}: ${err.message}\n`);
      }
    }
    this.history = this.history.filter((h) => !(h.userTs !== null && h.userTs >= userTs));
    this.emit('changes', this.listChanges());
    return restored;
  }
}

function reverseEdits(after, edits) {
  let text = after;
  const crlf = text.includes('\r\n');
  for (const e of [...edits].reverse()) {
    if (!e || typeof e.newText !== 'string' || typeof e.oldText !== 'string') continue;
    let newText = e.newText;
    let oldText = e.oldText;
    if (crlf) {
      newText = newText.replace(/\r?\n/g, '\r\n');
      oldText = oldText.replace(/\r?\n/g, '\r\n');
    }
    const idx = text.indexOf(newText);
    if (idx === -1) return null;
    text = text.slice(0, idx) + oldText + text.slice(idx + newText.length);
  }
  return text;
}

// Cheap line diff statistic (LCS on lines would be costly for big files; use multiset diff).
function lineStats(a, b) {
  const count = new Map();
  for (const l of a.split('\n')) count.set(l, (count.get(l) || 0) + 1);
  let added = 0;
  for (const l of b.split('\n')) {
    const c = count.get(l) || 0;
    if (c > 0) count.set(l, c - 1);
    else added++;
  }
  let removed = 0;
  for (const c of count.values()) removed += c;
  if (a === '') removed = 0;
  return { added, removed };
}

module.exports = { PiSession, DESKTOP_MARKER };
