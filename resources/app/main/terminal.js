'use strict';
// Integrated terminal processes. Uses node-pty (ConPTY on Windows) when available and
// falls back to plain pipes so the panel still works if the native module fails to load.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const piEnv = require('./pi-env');

let pty = null;
let ptyError = null;
try {
  pty = require('node-pty');
} catch (err) {
  ptyError = err;
}

function findGitBash() {
  return piEnv.gitInfo().bash;
}

function shells() {
  if (process.platform === 'win32') {
    const list = [];
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const pwsh = (process.env.PATH || '').split(';').map((d) => path.join(d, 'pwsh.exe')).find((p) => fs.existsSync(p));
    if (pwsh) list.push({ id: 'pwsh', name: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });
    list.push({ id: 'powershell', name: 'Windows PowerShell', file: path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] });
    list.push({ id: 'cmd', name: 'Command Prompt', file: path.join(sys, 'System32', 'cmd.exe'), args: [] });
    const gb = findGitBash();
    if (gb) list.push({ id: 'gitbash', name: 'Git Bash', file: gb, args: ['--login', '-i'] });
    const wsl = path.join(sys, 'System32', 'wsl.exe');
    if (fs.existsSync(wsl)) list.push({ id: 'wsl', name: 'WSL', file: wsl, args: [] });
    return list;
  }
  const sh = process.env.SHELL || '/bin/bash';
  return [{ id: 'default', name: path.basename(sh), file: sh, args: ['-l'] }];
}

function defaultShell() {
  const cfg = config.load();
  const all = shells();
  return all.find((s) => s.id === cfg.shell) || all[0];
}

class TerminalManager {
  constructor(send) {
    this.send = send;
    this.terms = new Map();
    this.seq = 0;
  }

  create({ cwd, shellId, cols, rows, command, args, env }) {
    const id = `t${++this.seq}`;
    let sh = shellId ? shells().find((s) => s.id === shellId) : defaultShell();
    if (!sh) sh = defaultShell();
    const file = command || sh.file;
    const argv = command ? args || [] : sh.args;
    const termEnv = { ...piEnv.childEnv(env), TERM_PROGRAM: 'pi-desktop', COLORTERM: 'truecolor' };
    delete termEnv.ELECTRON_RUN_AS_NODE;
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    let proc;
    if (pty) {
      try {
        proc = pty.spawn(file, argv, {
          name: 'xterm-256color',
          cols: Math.max(2, cols || 80),
          rows: Math.max(2, rows || 24),
          cwd: dir,
          env: termEnv,
          useConpty: process.platform === 'win32' ? true : undefined,
        });
        proc.onData((d) => this.send('term:data', { id, data: d }));
        proc.onExit(({ exitCode }) => {
          this.terms.delete(id);
          this.send('term:exit', { id, code: exitCode });
        });
        this.terms.set(id, { kind: 'pty', proc });
        return { id, name: command ? path.basename(file) : sh.name, pty: true };
      } catch (err) {
        ptyError = err;
      }
    }
    // Pipe fallback (no line editing / colors depend on the program)
    const child = spawn(file, argv, { cwd: dir, env: termEnv, windowsHide: true });
    child.stdout.on('data', (d) => this.send('term:data', { id, data: d.toString('utf8').replace(/\r?\n/g, '\r\n') }));
    child.stderr.on('data', (d) => this.send('term:data', { id, data: d.toString('utf8').replace(/\r?\n/g, '\r\n') }));
    child.on('exit', (code) => {
      this.terms.delete(id);
      this.send('term:exit', { id, code });
    });
    child.on('error', (err) => this.send('term:data', { id, data: `\r\n[${err.message}]\r\n` }));
    this.terms.set(id, { kind: 'pipe', proc: child, line: '' });
    this.send('term:data', { id, data: `\x1b[33m[node-pty 不可用，使用简化终端: ${ptyError ? ptyError.message : ''}]\x1b[0m\r\n` });
    return { id, name: command ? path.basename(file) : sh.name, pty: false };
  }

  write(id, data) {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.kind === 'pty') {
      t.proc.write(data);
      return;
    }
    // naive line discipline for pipe mode
    for (const ch of data) {
      if (ch === '\r') {
        this.send('term:data', { id, data: '\r\n' });
        t.proc.stdin.write(t.line + os.EOL);
        t.line = '';
      } else if (ch === '\x7f') {
        if (t.line.length) {
          t.line = t.line.slice(0, -1);
          this.send('term:data', { id, data: '\b \b' });
        }
      } else if (ch === '\x03') {
        try { t.proc.kill('SIGINT'); } catch { /* ignore */ }
      } else {
        t.line += ch;
        this.send('term:data', { id, data: ch });
      }
    }
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (t && t.kind === 'pty') {
      try { t.proc.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* ignore */ }
    }
  }

  kill(id) {
    const t = this.terms.get(id);
    if (!t) return;
    try { t.proc.kill(); } catch { /* ignore */ }
    this.terms.delete(id);
  }

  disposeAll() {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

module.exports = { TerminalManager, shells };
