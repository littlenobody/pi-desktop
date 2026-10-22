// Small DOM / string / path helpers shared by the renderer modules.

export const api = window.pi;
export const IS_WIN = api.platform === 'win32';
export const IS_MAC = api.platform === 'darwin';

/**
 * Hyperscript-style element builder.
 * h('div.cls#id', {onclick, title, style:{}, dataset:{}}, children...)
 */
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][^.#]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  appendList(el, children);
  return el;
}

export function append(el, ...children) {
  appendList(el, children);
  return el;
}

function appendList(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendList(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name, extra = '') {
  const el = document.createElement('i');
  el.className = `codicon codicon-${name}${extra ? ' ' + extra : ''}`;
  return el;
}

export function iconBtn(name, title, onclick, cls = '') {
  const b = h('button.icon-btn', { title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); onclick && onclick(e); } }, icon(name));
  if (cls) b.className += ' ' + cls;
  return b;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function throttleRaf(fn) {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}

export class Emitter {
  constructor() { this.map = new Map(); }
  on(ev, fn) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev).add(fn);
    return () => this.map.get(ev).delete(fn);
  }
  emit(ev, ...args) {
    for (const fn of this.map.get(ev) || []) {
      try { fn(...args); } catch (err) { console.error(err); }
    }
  }
}

// ---------------------------------------------------------------- paths
export const SEP = IS_WIN ? '\\' : '/';

export function basename(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

export function dirname(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i === -1) return '';
  if (i === 0) return s.slice(0, 1);
  if (IS_WIN && i === 2 && s[1] === ':') return s.slice(0, 3);
  return s.slice(0, i);
}

export function join(...parts) {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    if (!out) out = p;
    else out = out.replace(/[\\/]+$/, '') + SEP + String(p).replace(/^[\\/]+/, '');
  }
  return IS_WIN ? out.replace(/\//g, '\\') : out;
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i).toLowerCase();
}

export function normCase(p) {
  return IS_WIN ? String(p).toLowerCase().replace(/\//g, '\\') : String(p);
}

export function samePath(a, b) {
  return !!a && !!b && normCase(a).replace(/[\\/]+$/, '') === normCase(b).replace(/[\\/]+$/, '');
}

export function isInside(child, parent) {
  const c = normCase(child);
  const p = normCase(parent).replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + (IS_WIN ? '\\' : '/'));
}

export function relative(from, to) {
  if (!from) return to;
  if (isInside(to, from)) {
    const r = String(to).slice(String(from).replace(/[\\/]+$/, '').length + 1);
    return r.replace(/\\/g, '/');
  }
  return to;
}

export function isAbsolute(p) {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
}

export function resolveIn(folder, p) {
  if (!p) return p;
  let s = String(p).trim();
  if (s.startsWith('@')) s = s.slice(1);
  if (s.startsWith('~')) return s;
  return isAbsolute(s) ? s : join(folder, s);
}

export function fileUrl(p) {
  return `pidesk://file/?p=${encodeURIComponent(p)}`;
}

// ---------------------------------------------------------------- formatting
export function fmtTokens(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M';
}

export function fmtCost(c) {
  if (!c) return '$0';
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

export function fmtDuration(ms) {
  if (ms === undefined || ms === null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m${Math.round((ms % 60000) / 1000)}s`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400 && now.getDate() === d.getDate()) return `今天 ${d.toTimeString().slice(0, 5)}`;
  if (diff < 86400 * 2) return `昨天 ${d.toTimeString().slice(0, 5)}`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleDateString();
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}

// ---------------------------------------------------------------- fuzzy matching
/** Returns {score, positions} or null. Lower-case subsequence match with bonuses. */
export function fuzzy(query, text) {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue;
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    const isStart = idx === 0 || /[\\/._\-\s]/.test(t[idx - 1]) || (text[idx] !== t[idx] && text[idx - 1] === t[idx - 1]);
    score += idx === prev + 1 ? 6 : 1;
    if (isStart) score += 4;
    score -= Math.min(3, (idx - ti) * 0.05);
    positions.push(idx);
    prev = idx;
    ti = idx + 1;
  }
  // prefer matches in the basename
  const slash = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (positions.length && positions[0] > slash) score += 8;
  score -= t.length * 0.01;
  return { score, positions };
}

export function highlight(text, positions) {
  if (!positions || !positions.length) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  const set = new Set(positions);
  let buf = '';
  let inHl = false;
  const flush = () => {
    if (!buf) return;
    frag.appendChild(inHl ? h('span.hl', buf) : document.createTextNode(buf));
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const hl = set.has(i);
    if (hl !== inHl) {
      flush();
      inHl = hl;
    }
    buf += text[i];
  }
  flush();
  return frag;
}

// ---------------------------------------------------------------- keyboard
export function keyCombo(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = e.key;
  if (k === ' ') k = 'space';
  else if (k.length === 1) k = k.toLowerCase();
  else k = k.toLowerCase();
  if (e.code === 'Backquote') k = '`';
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  if (e.code === 'Equal') k = '=';
  if (e.code === 'Minus') k = '-';
  if (e.code === 'Comma') k = ',';
  if (e.code === 'Slash') k = '/';
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
  if (!['control', 'shift', 'alt', 'meta'].includes(k)) parts.push(k);
  return parts.join('+');
}

export function displayKey(combo) {
  return combo.split('+').map((p) => {
    if (p === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
    if (p === 'alt') return IS_MAC ? '⌥' : 'Alt';
    if (p === 'shift') return IS_MAC ? '⇧' : 'Shift';
    if (p === 'enter') return 'Enter';
    if (p === 'escape') return 'Esc';
    return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
  }).join(IS_MAC ? '' : '+');
}

// ---------------------------------------------------------------- misc
export function uid(prefix = 'id') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function guessMime(p) {
  const ext = extname(p);
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }[ext] || '';
}

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg']);

export function fileIcon(name, isDir, open) {
  if (isDir) return open ? 'folder-opened' : 'folder';
  const ext = extname(name);
  const lower = name.toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'file-media';
  if (['.md', '.markdown', '.mdx'].includes(ext)) return 'markdown';
  if (['.json', '.jsonc', '.jsonl'].includes(ext)) return 'json';
  if (['.zip', '.gz', '.tar', '.7z', '.rar', '.tgz'].includes(ext)) return 'file-zip';
  if (['.pdf'].includes(ext)) return 'file-pdf';
  if (lower === 'package.json' || lower === 'cargo.toml') return 'package';
  if (lower.startsWith('.git')) return 'source-control';
  if (['.sh', '.bash', '.ps1', '.bat', '.cmd', '.zsh'].includes(ext)) return 'terminal';
  if (['.yml', '.yaml', '.toml', '.ini', '.env', '.conf', '.cfg', '.xml'].includes(ext) || lower.startsWith('.env')) return 'settings';
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.vue', '.svelte', '.html', '.css', '.scss', '.less', '.sql', '.lua', '.dart', '.scala'].includes(ext)) return 'file-code';
  return 'file';
}

const ICON_COLORS = {
  '.ts': '#3178c6', '.tsx': '#3178c6', '.js': '#e8d44d', '.jsx': '#61dafb', '.mjs': '#e8d44d', '.cjs': '#e8d44d', '.json': '#cbcb41', '.md': '#519aba',
  '.py': '#3572a5', '.go': '#00add8', '.rs': '#dea584', '.java': '#b07219', '.css': '#563d7c', '.scss': '#c6538c', '.html': '#e34c26', '.vue': '#41b883',
  '.c': '#555599', '.cpp': '#f34b7d', '.cs': '#178600', '.rb': '#cc342d', '.php': '#777bb4', '.sql': '#e38c00', '.sh': '#89e051', '.yml': '#cb171e', '.yaml': '#cb171e',
};

export function fileIconEl(name, isDir, open) {
  const el = icon(fileIcon(name, isDir, open));
  const color = isDir ? '' : ICON_COLORS[extname(name)];
  if (color) el.style.color = color;
  else if (isDir) el.style.color = 'var(--fg-muted)';
  return el;
}
