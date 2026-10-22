'use strict';
// Locates the pi CLI and a Node runtime, and exposes helpers for pi's on-disk state
// (agent dir, settings, auth, trust, session directories).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const config = require('./config');

const IS_WIN = process.platform === 'win32';
const PI_PKG = ['@earendil-works', 'pi-coding-agent'];

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  return env ? path.resolve(expandHome(env)) : path.join(os.homedir(), '.pi', 'agent');
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// pi CLI discovery
// ---------------------------------------------------------------------------

function normalizeCliPath(p) {
  if (!p) return null;
  p = expandHome(p.trim().replace(/^"|"$/g, ''));
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const inPkg = path.join(p, 'dist', 'bundle', 'cli.js');
      if (exists(inPkg)) return inPkg;
      const inModules = path.join(p, 'node_modules', ...PI_PKG, 'dist', 'bundle', 'cli.js');
      if (exists(inModules)) return inModules;
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

function globalNpmRoot() {
  return new Promise((resolve) => {
    const cmd = IS_WIN ? 'npm.cmd' : 'npm';
    execFile(cmd, ['root', '-g'], { timeout: 15000, windowsHide: true, shell: IS_WIN }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

let piCliCache = null;
async function findPiCli(force = false) {
  if (piCliCache && !force) return piCliCache;
  const cfg = config.load();
  const candidates = [cfg.piCliPath, process.env.PI_DESKTOP_PI_CLI];
  if (IS_WIN && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', ...PI_PKG));
  }
  if (!IS_WIN) {
    candidates.push('/usr/local/lib/node_modules/' + PI_PKG.join('/'));
    candidates.push('/usr/lib/node_modules/' + PI_PKG.join('/'));
    candidates.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', ...PI_PKG));
  }
  for (const c of candidates) {
    const p = normalizeCliPath(c);
    if (p && exists(p)) return (piCliCache = p);
  }
  const root = await globalNpmRoot();
  if (root) {
    const p = normalizeCliPath(path.join(root, ...PI_PKG));
    if (p && exists(p)) return (piCliCache = p);
  }
  return null;
}

function piPackageDir(cli) {
  // cli = <pkg>/dist/bundle/cli.js
  return cli ? path.resolve(path.dirname(cli), '..', '..') : null;
}

function piVersion(cli) {
  const pkg = readJson(path.join(piPackageDir(cli) || '', 'package.json'), null);
  return pkg ? pkg.version : null;
}

// ---------------------------------------------------------------------------
// Node runtime discovery. pi needs Node >= 22.19. Prefer a system Node so that
// processes spawned by the agent don't inherit ELECTRON_RUN_AS_NODE.
// ---------------------------------------------------------------------------

function versionOk(v) {
  const m = /^v?(\d+)\.(\d+)/.exec(v || '');
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

function nodeVersionOf(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-v'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

let nodeCache = null;
async function findNode(force = false) {
  if (nodeCache && !force) return nodeCache;
  const cfg = config.load();
  const tried = [];
  if (cfg.nodePath) tried.push(expandHome(cfg.nodePath));
  const exe = IS_WIN ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) tried.push(path.join(dir.replace(/^"|"$/g, ''), exe));
  }
  if (IS_WIN) tried.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  const seen = new Set();
  for (const bin of tried) {
    const key = IS_WIN ? bin.toLowerCase() : bin;
    if (seen.has(key) || !exists(bin)) continue;
    seen.add(key);
    const v = await nodeVersionOf(bin);
    if (versionOk(v)) return (nodeCache = { command: bin, env: {}, version: v, embedded: false });
  }
  // Fall back to Electron's bundled Node.
  return (nodeCache = {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    version: process.versions.node,
    embedded: true,
  });
}

// ---------------------------------------------------------------------------
// Settings / auth
// ---------------------------------------------------------------------------

function settingsFile(scope, cwd) {
  return scope === 'project' ? path.join(cwd, '.pi', 'settings.json') : path.join(agentDir(), 'settings.json');
}

function readSettings(scope, cwd) {
  return readJson(settingsFile(scope, cwd), {});
}

function writeSettings(scope, cwd, data) {
  writeJson(settingsFile(scope, cwd), data);
}

function authFile() {
  return path.join(agentDir(), 'auth.json');
}

function listAuth() {
  const data = readJson(authFile(), {});
  return Object.entries(data).map(([provider, cred]) => ({
    provider,
    type: (cred && cred.type) || 'unknown',
    hint: cred && typeof cred.key === 'string'
      ? (cred.key.startsWith('!') ? 'command' : `…${cred.key.slice(-4)}`)
      : '',
  }));
}

function setApiKey(provider, key) {
  const data = readJson(authFile(), {});
  data[provider] = { ...(data[provider] && data[provider].type === 'api_key' ? data[provider] : {}), type: 'api_key', key };
  writeJson(authFile(), data);
  try { fs.chmodSync(authFile(), 0o600); } catch { /* best effort */ }
}

function removeAuth(provider) {
  const data = readJson(authFile(), {});
  delete data[provider];
  writeJson(authFile(), data);
}

// ---------------------------------------------------------------------------
// Project trust (mirrors pi's trust-manager so the GUI can ask before spawning,
// because RPC mode cannot show pi's own trust prompt).
// ---------------------------------------------------------------------------

const TRUST_RESOURCES = ['settings.json', 'mcp.json', 'extensions', 'skills', 'prompts', 'themes', 'SYSTEM.md', 'APPEND_SYSTEM.md'];

function canonical(p) {
  try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); }
}

function needsTrust(cwd) {
  let dir = canonical(cwd);
  if (TRUST_RESOURCES.some((e) => exists(path.join(dir, '.pi', e)))) return true;
  const userSkills = path.join(canonical(os.homedir()), '.agents', 'skills');
  for (;;) {
    const s = path.join(dir, '.agents', 'skills');
    if (s !== userSkills && exists(s)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function trustFile() {
  return path.join(agentDir(), 'trust.json');
}

function trustDecision(cwd) {
  const data = readJson(trustFile(), {});
  let dir = canonical(cwd);
  for (;;) {
    if (data[dir] === true || data[dir] === false) return { decision: data[dir], path: dir };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function setTrust(cwd, decision) {
  const data = readJson(trustFile(), {});
  const key = canonical(cwd);
  if (decision === null) delete data[key];
  else data[key] = decision;
  const sorted = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k];
  writeJson(trustFile(), sorted);
}

function trustStatus(cwd) {
  const settings = readSettings('global');
  const saved = trustDecision(cwd);
  return {
    needsTrust: needsTrust(cwd),
    saved: saved ? saved.decision : null,
    savedPath: saved ? saved.path : null,
    defaultProjectTrust: settings.defaultProjectTrust || 'ask',
  };
}

// ---------------------------------------------------------------------------
// Session directories
// ---------------------------------------------------------------------------

function sessionsRoot() {
  const env = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (env) return { dir: path.resolve(expandHome(env)), flat: true };
  const s = readSettings('global');
  if (s.sessionDir) return { dir: path.resolve(expandHome(s.sessionDir)), flat: true };
  return { dir: path.join(agentDir(), 'sessions'), flat: false };
}

function sessionDirFor(cwd) {
  const root = sessionsRoot();
  if (root.flat) return root.dir;
  const safe = `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(root.dir, safe);
}

// ---------------------------------------------------------------------------
// Git / Git Bash detection (pi's bash tool needs bash.exe on PATH; Windows users
// often install Git in a non-default location with only ...\Git\cmd on PATH).
// ---------------------------------------------------------------------------

let gitCache;
function gitInfo() {
  if (gitCache) return gitCache;
  const exe = IS_WIN ? 'git.exe' : 'git';
  const bashExe = IS_WIN ? 'bash.exe' : 'bash';
  const dirs = (process.env.PATH || '').split(path.delimiter).map((d) => d.replace(/^"|"$/g, '')).filter(Boolean);
  let git = null;
  let bash = null;
  const has = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  for (const d of dirs) {
    const g = path.join(d, exe);
    if (!git && has(g)) git = g;
    const b = path.join(d, bashExe);
    if (!bash && IS_WIN && has(b)) bash = b;
  }
  if (IS_WIN) {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), 'D:\\tools', 'C:\\tools'].filter(Boolean);
    for (const r of roots) {
      const base = path.join(r, 'Git');
      if (!git && has(path.join(base, 'cmd', 'git.exe'))) git = path.join(base, 'cmd', 'git.exe');
      if (!git && has(path.join(base, 'bin', 'git.exe'))) git = path.join(base, 'bin', 'git.exe');
      if (!bash && has(path.join(base, 'bin', 'bash.exe'))) bash = path.join(base, 'bin', 'bash.exe');
      if (git && bash) break;
    }
  } else if (!bash) {
    for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) if (has(p)) { bash = p; break; }
  }
  gitCache = { git: git || (IS_WIN ? 'git.exe' : 'git'), bash, extraPathDirs: bash && git ? [path.dirname(git), path.dirname(bash)] : bash ? [path.dirname(bash)] : [] };
  return gitCache;
}

function childEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  const { extraPathDirs } = gitInfo();
  if (extraPathDirs.length) {
    const missing = extraPathDirs.filter((d) => !String(env.PATH || '').split(path.delimiter).includes(d));
    if (missing.length) env.PATH = [...missing, env.PATH].join(path.delimiter);
  }
  return env;
}

module.exports = {
  IS_WIN,
  agentDir,
  expandHome,
  readJson,
  writeJson,
  findPiCli,
  piPackageDir,
  piVersion,
  findNode,
  settingsFile,
  readSettings,
  writeSettings,
  authFile,
  listAuth,
  setApiKey,
  removeAuth,
  trustStatus,
  setTrust,
  sessionsRoot,
  sessionDirFor,
  canonical,
  gitInfo,
  childEnv,
};
