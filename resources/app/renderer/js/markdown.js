// Markdown rendering for chat messages (marked + DOMPurify), with code-block toolbars
// and Monaco-based syntax colorization.
import { h, icon, api } from './util.js';
import { toast } from './ui.js';

const { marked } = window;
const DOMPurify = window.DOMPurify;

marked.setOptions({ gfm: true, breaks: false });

const LANG_ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', ps1: 'powershell', pwsh: 'powershell',
  yml: 'yaml', md: 'markdown', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp', h: 'c', cs: 'csharp', 'c#': 'csharp', rs: 'rust', kt: 'kotlin',
  golang: 'go', jsonc: 'json', jsonl: 'json', html: 'html', xml: 'xml', vue: 'html', svelte: 'html', dockerfile: 'dockerfile', docker: 'dockerfile',
  toml: 'ini', ini: 'ini', conf: 'ini', diff: 'plaintext', patch: 'plaintext', text: 'plaintext', txt: 'plaintext', plain: 'plaintext', bat: 'bat', cmd: 'bat',
};

export function monacoLang(lang) {
  const l = String(lang || '').trim().toLowerCase().split(/[\s{:]/)[0];
  return LANG_ALIASES[l] || l || 'plaintext';
}

const colorCache = new Map();
async function colorize(code, lang) {
  if (!window.monaco || code.length > 120000) return null;
  const key = `${lang}\u0000${code}`;
  if (colorCache.has(key)) return colorCache.get(key);
  try {
    const known = window.monaco.languages.getLanguages().some((l) => l.id === lang);
    if (!known) return null;
    const html = await window.monaco.editor.colorize(code, lang, { tabSize: 4 });
    if (colorCache.size > 400) colorCache.clear();
    colorCache.set(key, html);
    return html;
  } catch {
    return null;
  }
}

/** Hooks the chat view provides for code-block actions. */
export const mdHooks = {
  openFile: null, // (path, line) => void
  applyCode: null, // (code, lang, path?) => void
  insertTerminal: null, // (code) => void
};

const FILE_RE = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[\w@.\-\u4e00-\u9fa5]+(?:[\\/][\w@.\-\u4e00-\u9fa5]+)*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/;

/**
 * Render markdown into `container`. Returns the container.
 * `streaming` avoids expensive work (colorization) on every delta.
 */
export function renderMarkdown(container, text, { streaming = false } = {}) {
  let html;
  try {
    html = marked.parse(String(text || ''));
  } catch {
    html = `<pre>${String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;
  }
  container.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });
  enhance(container, streaming);
  return container;
}

function enhance(container, streaming) {
  for (const a of container.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (/^https?:/i.test(href)) api.invoke('shell:openExternal', href);
      else if (mdHooks.openFile) mdHooks.openFile(href.replace(/^file:\/\//, ''));
    });
    a.title = href;
  }
  for (const code of container.querySelectorAll('code')) {
    if (code.parentElement && code.parentElement.tagName === 'PRE') continue;
    const t = code.textContent.trim();
    if (t.length < 200 && FILE_RE.test(t) && /[\\/.]/.test(t)) {
      code.classList.add('file-link');
      code.title = '打开文件';
      code.addEventListener('click', () => {
        const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(t);
        if (mdHooks.openFile) mdHooks.openFile(m[1], m[2] ? Number(m[2]) : undefined);
      });
    }
  }
  for (const pre of [...container.querySelectorAll('pre')]) {
    const codeEl = pre.querySelector('code');
    if (!codeEl) continue;
    const cls = [...codeEl.classList].find((c) => c.startsWith('language-'));
    const rawLang = cls ? cls.slice(9) : '';
    // Allow ```ts path/to/file.ts style info strings.
    const info = rawLang.split(':');
    const lang = monacoLang(info[0]);
    const filePath = info[1] || '';
    const code = codeEl.textContent.replace(/\n$/, '');
    const block = h('div.code-block',
      h('div.cb-head',
        h('span.lang', filePath || rawLang || 'text'),
        mdHooks.insertTerminal && ['shell', 'powershell', 'bat'].includes(lang)
          ? h('button.icon-btn', { title: '在终端中运行', onclick: () => mdHooks.insertTerminal(code) }, icon('terminal')) : null,
        mdHooks.applyCode && !['shell', 'powershell', 'bat', 'plaintext'].includes(lang)
          ? h('button.icon-btn', { title: '插入到编辑器（替换选区）', onclick: () => mdHooks.applyCode(code, lang, filePath) }, icon('insert')) : null,
        h('button.icon-btn', { title: '复制', onclick: (e) => {
          api.invoke('clipboard:write', code);
          const b = e.currentTarget;
          b.replaceChildren(icon('check'));
          setTimeout(() => b.replaceChildren(icon('copy')), 1200);
        } }, icon('copy'))),
      pre.cloneNode(true));
    pre.replaceWith(block);
    if (!streaming) {
      const target = block.querySelector('pre code');
      colorize(code, lang).then((html2) => {
        if (html2 && target.isConnected) target.innerHTML = DOMPurify.sanitize(html2);
      });
    }
  }
}

export function copyText(text, msg = '已复制') {
  api.invoke('clipboard:write', text).then(() => toast(msg, 'info', { timeout: 1500 }));
}
