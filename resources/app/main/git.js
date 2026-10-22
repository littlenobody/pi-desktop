'use strict';
// Minimal git integration for the Source Control view.
const { execFile } = require('child_process');
const path = require('path');
const piEnv = require('./pi-env');

function git(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(piEnv.gitInfo().git, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: opts.timeout || 60000, encoding: 'utf8', env: piEnv.childEnv() }, (err, stdout, stderr) => {
      if (err && !opts.allowFail) {
        err.message = (stderr || err.message || '').trim();
        return reject(err);
      }
      resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
    });
  });
}

async function root(cwd) {
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
    return path.resolve(stdout.trim());
  } catch {
    return null;
  }
}

async function status(cwd) {
  const top = await root(cwd);
  if (!top) return { repo: false };
  const { stdout } = await git(top, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  const parts = stdout.split('\0');
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith('## ')) {
      const m = /^## (?:No commits yet on )?([^.\s]+)?(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(rec);
      branch = (m && m[1]) || rec.slice(3);
      ahead = m && m[2] ? Number(m[2]) : 0;
      behind = m && m[3] ? Number(m[3]) : 0;
      continue;
    }
    const x = rec[0];
    const y = rec[1];
    const file = rec.slice(3);
    let orig;
    if (x === 'R' || x === 'C') orig = parts[++i];
    files.push({ path: path.join(top, file), rel: file, index: x, work: y, orig });
  }
  return { repo: true, root: top, branch, ahead, behind, files };
}

async function show(cwd, file, ref = 'HEAD') {
  const top = await root(cwd);
  if (!top) return null;
  const rel = path.relative(top, file).split(path.sep).join('/');
  const spec = ref === ':0' ? `:${rel}` : `${ref}:${rel}`;
  const r = await git(top, ['show', spec], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

async function stage(cwd, files) {
  const top = await root(cwd);
  await git(top, ['add', '-A', '--', ...files]);
}

async function unstage(cwd, files) {
  const top = await root(cwd);
  const r = await git(top, ['restore', '--staged', '--', ...files], { allowFail: true });
  if (r.code !== 0) await git(top, ['rm', '--cached', '-r', '-q', '--', ...files], { allowFail: true });
}

async function discard(cwd, files) {
  const top = await root(cwd);
  const st = await status(top);
  const untracked = new Set(st.files.filter((f) => f.index === '?' ).map((f) => path.resolve(f.path)));
  const tracked = files.filter((f) => !untracked.has(path.resolve(f)));
  const toClean = files.filter((f) => untracked.has(path.resolve(f)));
  if (tracked.length) await git(top, ['checkout', '--', ...tracked]);
  if (toClean.length) await git(top, ['clean', '-f', '-q', '--', ...toClean]);
}

async function commit(cwd, message, opts = {}) {
  const top = await root(cwd);
  const args = ['commit', '-m', message];
  if (opts.all) args.splice(1, 0, '-a');
  if (opts.amend) args.push('--amend');
  const r = await git(top, args);
  return r.stdout;
}

async function run(cwd, args) {
  const top = (await root(cwd)) || cwd;
  return git(top, args, { allowFail: true, timeout: 300000 });
}

async function branches(cwd) {
  const top = await root(cwd);
  if (!top) return [];
  const { stdout } = await git(top, ['branch', '--format=%(refname:short)']);
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function checkout(cwd, branch, create) {
  const top = await root(cwd);
  await git(top, create ? ['checkout', '-b', branch] : ['checkout', branch]);
}

async function diffStaged(cwd) {
  const top = await root(cwd);
  if (!top) return '';
  const { stdout } = await git(top, ['diff', '--cached', '--stat', '--patch', '--no-color'], { allowFail: true });
  return stdout.slice(0, 60000);
}

module.exports = { status, show, stage, unstage, discard, commit, run, branches, checkout, root, diffStaged };
