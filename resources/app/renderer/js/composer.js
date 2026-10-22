// Chat input: auto-growing textarea, context chips (@files, selections, images), slash/@ autocomplete,
// Cursor-style mode / model / thinking pills and send/stop button.
import { api, h, icon, iconBtn, clear, basename, relative, fuzzy, highlight, readFileAsBase64, guessMime, IMAGE_EXTS, extname, uid, fileIconEl, fmtTokens, append } from './util.js';
import { toast } from './ui.js';

export const BUILTIN_COMMANDS = [
  { name: 'model', description: '选择模型', args: '[provider/model]' },
  { name: 'thinking', description: '设置思考强度', args: '[level]' },
  { name: 'new', description: '在当前标签中开始新会话' },
  { name: 'resume', description: '切换到已保存的会话' },
  { name: 'name', description: '设置会话名称', args: '[name]' },
  { name: 'session', description: '显示会话信息与统计' },
  { name: 'tree', description: '浏览会话树并切换分支' },
  { name: 'fork', description: '从之前的用户消息创建新会话' },
  { name: 'clone', description: '在当前位置复制会话' },
  { name: 'compact', description: '压缩上下文', args: '[instructions]' },
  { name: 'import', description: '导入并恢复 JSONL 会话', args: '<path>' },
  { name: 'copy', description: '复制最后一条助手回复' },
  { name: 'export', description: '导出为 HTML 或 JSONL', args: '[path]' },
  { name: 'share', description: '上传为私有 GitHub Gist 并获得查看链接' },
  { name: 'settings', description: '打开设置' },
  { name: 'scoped-models', description: '配置用于循环切换的模型' },
  { name: 'login', description: '添加提供商认证', args: '[provider]' },
  { name: 'logout', description: '移除提供商认证' },
  { name: 'trust', description: '保存项目信任决策' },
  { name: 'reload', description: '重新加载扩展、技能、模板与上下文文件' },
  { name: 'tools', description: '启用/禁用 Agent 工具' },
  { name: 'system-prompt', description: '查看当前系统提示词' },
  { name: 'hotkeys', description: '显示快捷键' },
  { name: 'changelog', description: '显示 Pi 更新日志' },
  { name: 'debug', description: '显示 pi 进程日志' },
  { name: 'bug', description: '在 Pi TUI 中准备问题报告' },
  { name: 'tui', description: '在终端中用 Pi TUI 打开当前会话' },
  { name: 'quit', description: '关闭当前聊天标签' },
];

const MAX_FILE_INLINE = 256 * 1024;

export class Composer {
  constructor(pane) {
    this.pane = pane;
    this.wb = pane.wb;
    this.chips = [];
    this.ac = null; // {type, start, items, selected}
    this.histIdx = -1;
    this.el = h('div.composer');
    this.ctxRow = h('div.ctx-row');
    this.ta = h('textarea', { rows: 1, spellcheck: false, placeholder: '' });
    this.bar = h('div.cmp-bar');
    this.popup = h('div.ac-popup.hidden');
    this.el.append(this.popup, this.ctxRow, this.ta, this.bar);
    this.hint = h('div.composer-hint');
    this.bind();
    this.renderChips();
  }

  get session() { return this.pane.current; }

  bind() {
    const ta = this.ta;
    ta.addEventListener('input', () => { this.autosize(); this.updateAutocomplete(); this.pane.saveDraft(); this.renderBar(); });
    ta.addEventListener('keydown', (e) => this.onKey(e));
    ta.addEventListener('click', () => this.updateAutocomplete());
    ta.addEventListener('blur', () => setTimeout(() => this.closeAc(), 150));
    ta.addEventListener('paste', (e) => this.onPaste(e));
    this.el.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/plain' || t === 'application/x-pi-path')) {
        e.preventDefault();
        this.el.classList.add('dragover');
      }
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('dragover'));
    this.el.addEventListener('drop', (e) => this.onDrop(e));
  }

  autosize() {
    const ta = this.ta;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  focus() {
    this.ta.focus();
  }

  setText(text, cursorEnd = true) {
    this.ta.value = text || '';
    this.autosize();
    if (cursorEnd) this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
    this.renderBar();
  }

  // ------------------------------------------------------------------ chips
  addChip(chip) {
    const key = chip.kind === 'selection' ? `${chip.path}:${chip.startLine}-${chip.endLine}` : chip.kind === 'image' ? uid('img') : chip.path;
    if (this.chips.some((c) => c.key === key)) return;
    this.chips.push({ ...chip, key });
    this.renderChips();
    this.pane.saveDraft();
  }

  removeChip(key) {
    this.chips = this.chips.filter((c) => c.key !== key);
    this.renderChips();
    this.pane.saveDraft();
  }

  clearChips() {
    this.chips = [];
    this.renderChips();
  }

  renderChips() {
    clear(this.ctxRow);
    const folder = this.wb.folder;
    this.ctxRow.appendChild(h('span.chip.add', { title: '添加上下文 (@)', onclick: () => this.pickContext() }, icon('mention'), this.chips.length ? null : h('span.chip-label', '添加上下文')));
    for (const c of this.chips) {
      let label;
      let ic;
      if (c.kind === 'image') { label = c.name || '图片'; ic = h('img', { src: `data:${c.mimeType};base64,${c.data}` }); }
      else if (c.kind === 'selection') { label = `${basename(c.path)} (${c.startLine}-${c.endLine})`; ic = icon('list-selection'); }
      else if (c.kind === 'folder') { label = relative(folder, c.path) || basename(c.path); ic = icon('folder'); }
      else { label = basename(c.path); ic = fileIconEl(c.path, false); }
      this.ctxRow.appendChild(h('span.chip', { title: c.path || label, onclick: () => { if (c.path && c.kind !== 'image') this.wb.editors.openFile(c.path, c.startLine ? { line: c.startLine, endLine: c.endLine } : {}); } },
        ic, h('span.chip-label', label), iconBtn('close', '移除', () => this.removeChip(c.key))));
    }
  }

  async pickContext() {
    this.ta.focus();
    const pos = this.ta.selectionStart;
    const v = this.ta.value;
    const needSpace = pos > 0 && !/\s/.test(v[pos - 1]);
    this.ta.setRangeText((needSpace ? ' ' : '') + '@', pos, pos, 'end');
    this.updateAutocomplete();
  }

  async addFiles(paths) {
    for (const p of paths) {
      const st = await api.invoke('fs:stat', p).catch(() => ({ exists: false }));
      if (!st.exists) continue;
      if (st.dir) { this.addChip({ kind: 'folder', path: p }); continue; }
      if (IMAGE_EXTS.has(extname(p)) && extname(p) !== '.svg') {
        const r = await api.invoke('fs:read', p);
        if (r.base64) this.addChip({ kind: 'image', name: basename(p), path: p, data: r.base64, mimeType: guessMime(p) });
        continue;
      }
      this.addChip({ kind: 'file', path: p });
    }
  }

  async onPaste(e) {
    const items = [...(e.clipboardData ? e.clipboardData.items : [])];
    const images = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (images.length) {
      e.preventDefault();
      for (const it of images) {
        const file = it.getAsFile();
        const data = await readFileAsBase64(file);
        this.addChip({ kind: 'image', name: file.name || 'pasted.png', data, mimeType: file.type || 'image/png' });
      }
      return;
    }
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) {
      e.preventDefault();
      await this.addFiles(files.map((f) => api.pathForFile(f)).filter(Boolean));
    }
  }

  async onDrop(e) {
    this.el.classList.remove('dragover');
    e.preventDefault();
    const internal = e.dataTransfer.getData('application/x-pi-path');
    if (internal) {
      await this.addFiles(internal.split('\n').filter(Boolean));
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length) {
      const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
      if (paths.length) await this.addFiles(paths);
      else {
        for (const f of files) {
          if (f.type.startsWith('image/')) this.addChip({ kind: 'image', name: f.name, data: await readFileAsBase64(f), mimeType: f.type });
        }
      }
      return;
    }
    const text = e.dataTransfer.getData('text/plain');
    if (text) this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
  }

  /** Builds the final prompt text and image list from text + chips. */
  async buildPayload(text) {
    const blocks = [];
    const images = [];
    const mentions = [];
    for (const c of this.chips) {
      if (c.kind === 'image') images.push({ type: 'image', data: c.data, mimeType: c.mimeType });
      else if (c.kind === 'selection') blocks.push(`<selection path="${c.path}" lines="${c.startLine}-${c.endLine}">\n${c.text}\n</selection>`);
      else if (c.kind === 'folder') mentions.push(`@${relative(this.wb.folder, c.path) || c.path}/`);
      else if (c.kind === 'file') {
        try {
          const r = await api.invoke('fs:read', c.path);
          if (r.binary || r.tooLarge || (r.size || 0) > MAX_FILE_INLINE) mentions.push(`@${relative(this.wb.folder, c.path)}`);
          else blocks.push(`<file name="${c.path}">\n${r.text}\n</file>`);
        } catch {
          mentions.push(`@${relative(this.wb.folder, c.path)}`);
        }
      }
    }
    let full = text;
    if (mentions.length) full = `${mentions.join(' ')} ${full}`;
    if (blocks.length) full = `${blocks.join('\n')}\n${full}`;
    return { text: full, images };
  }

  // ------------------------------------------------------------------ keys
  onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (this.ac && !this.popup.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveAc(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveAc(-1); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey)) {
        if (this.ac.items.length) { e.preventDefault(); this.acceptAc(); return; }
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeAc(); return; }
    }
    const sendKey = this.wb.config.sendKey || 'enter';
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter') {
      if (e.altKey || (mod && e.shiftKey)) { e.preventDefault(); this.pane.submit('followUp'); return; }
      if (sendKey === 'enter' && !e.shiftKey && !mod) { e.preventDefault(); this.pane.submit('steer'); return; }
      if (sendKey === 'ctrl-enter' && mod) { e.preventDefault(); this.pane.submit('steer'); return; }
      return;
    }
    if (e.key === 'Escape') {
      if (this.session && this.session.running) { e.preventDefault(); e.stopPropagation(); this.pane.stop(); }
      return;
    }
    if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); this.pane.restoreQueue(); return; }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); this.pane.cycleThinking(); return; }
    if (e.key === 'ArrowUp' && !this.ta.value.trim() && this.session) {
      const hist = this.session.promptHistory;
      if (hist.length) { e.preventDefault(); this.histIdx = hist.length - 1; this.setText(hist[this.histIdx]); }
      return;
    }
    if (e.key === 'ArrowUp' && this.histIdx >= 0 && this.ta.selectionStart === 0) {
      e.preventDefault();
      this.histIdx = Math.max(0, this.histIdx - 1);
      this.setText(this.session.promptHistory[this.histIdx]);
      return;
    }
    if (e.key === 'ArrowDown' && this.histIdx >= 0 && this.ta.selectionStart === this.ta.value.length) {
      e.preventDefault();
      const hist = this.session.promptHistory;
      this.histIdx++;
      if (this.histIdx >= hist.length) { this.histIdx = -1; this.setText(''); } else this.setText(hist[this.histIdx]);
      return;
    }
    if (mod && e.key.toLowerCase() === 'l' && !e.shiftKey) { e.preventDefault(); this.pane.modelPicker(); return; }
    if (mod && e.key === '.') { e.preventDefault(); this.pane.toggleMode(); return; }
    if (e.key === 'Backspace' && this.ta.selectionStart === 0 && this.ta.selectionEnd === 0 && this.chips.length) {
      e.preventDefault();
      this.removeChip(this.chips[this.chips.length - 1].key);
    }
  }

  // ------------------------------------------------------------------ autocomplete
  async updateAutocomplete() {
    const ta = this.ta;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    // slash commands: only when the whole input is "/word" so far
    const slash = /^\/([\w:.-]*)$/.exec(before);
    if (slash && !ta.value.slice(pos).trim()) {
      this.showAc('slash', 0, this.commandItems(slash[1]));
      return;
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const start = pos - at[2].length - 1;
      const items = await this.fileItems(at[2]);
      if (ta.selectionStart !== pos) return;
      this.showAc('file', start, items);
      return;
    }
    // argument completion for /model and /thinking
    const arg = /^\/(model|thinking|login|logout)\s+(\S*)$/.exec(before);
    if (arg) {
      const items = await this.argItems(arg[1], arg[2]);
      this.showAc('arg', pos - arg[2].length, items);
      return;
    }
    this.closeAc();
  }

  commandItems(q) {
    const s = this.session;
    const ext = (s ? s.commands : []).map((c) => ({ name: c.name, description: c.description || '', source: c.source }));
    const builtin = BUILTIN_COMMANDS.map((c) => ({ ...c, source: 'builtin' }));
    const names = new Set(ext.map((c) => c.name));
    const all = [...builtin.filter((c) => !names.has(c.name)), ...ext];
    const scored = [];
    for (const c of all) {
      const m = fuzzy(q, c.name);
      if (m) scored.push({ ...c, _pos: m.positions, score: m.score + (c.name.startsWith(q) ? 50 : 0) });
    }
    if (q) scored.sort((a, b) => b.score - a.score);
    const srcName = { builtin: '内置', extension: '扩展', prompt: '模板', skill: '技能' };
    return scored.slice(0, 60).map((c) => ({
      label: `/${c.name}`, labelPos: c._pos ? c._pos.map((p) => p + 1) : null, desc: c.args ? `${c.args}  ${c.description}` : c.description, src: srcName[c.source] || c.source,
      insert: `/${c.name}${c.args || c.source === 'prompt' || c.source === 'skill' ? ' ' : ''}`,
      runNow: !c.args && c.source === 'builtin',
    }));
  }

  async fileItems(q) {
    const files = await this.wb.fileIndex();
    const folder = this.wb.folder;
    const out = [];
    const dirs = new Set();
    if (!q) {
      const open = this.wb.editors.tabs.filter((t) => t.kind === 'file').map((t) => relative(folder, t.path));
      const recent = [...new Set([...open, ...files.slice(0, 30)])].slice(0, 30);
      for (const r of recent) out.push({ rel: r, score: 0, pos: [] });
    } else {
      for (const f of files) {
        const m = fuzzy(q, f);
        if (m) out.push({ rel: f, score: m.score, pos: m.positions });
        const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
        if (d && !dirs.has(d)) dirs.add(d);
      }
      for (const d of dirs) {
        const m = fuzzy(q, d + '/');
        if (m && m.score > 5) out.push({ rel: d + '/', score: m.score - 2, pos: m.positions, dir: true });
      }
      out.sort((a, b) => b.score - a.score);
    }
    return out.slice(0, 50).map((f) => ({
      label: basename(f.rel.replace(/\/$/, '')) + (f.dir ? '/' : ''), desc: f.rel, icon: f.dir ? 'folder' : null, file: f.rel, dir: f.dir,
    }));
  }

  async argItems(cmd, q) {
    const s = this.session;
    if (!s) return [];
    if (cmd === 'model') {
      const models = await s.getModels().catch(() => []);
      return models.map((m) => ({ ref: `${m.provider}/${m.id}`, m })).map(({ ref, m }) => ({ ref, m, f: fuzzy(q, `${ref} ${m.name || ''}`) }))
        .filter((x) => x.f).sort((a, b) => b.f.score - a.f.score).slice(0, 40)
        .map((x) => ({ label: x.ref, desc: x.m.name || '', insert: x.ref, runNow: true }));
    }
    if (cmd === 'thinking') {
      return s.thinkingLevels.filter((l) => l.startsWith(q)).map((l) => ({ label: l, desc: l === s.state.thinkingLevel ? '当前' : '', insert: l, runNow: true }));
    }
    return [];
  }

  showAc(type, start, items) {
    if (!items.length) { this.closeAc(); return; }
    const prevSel = this.ac && this.ac.type === type ? this.ac.selected : 0;
    this.ac = { type, start, items, selected: Math.min(prevSel, items.length - 1) };
    this.renderAc();
  }

  renderAc() {
    const { items, selected, type } = this.ac;
    clear(this.popup);
    this.popup.classList.remove('hidden');
    this.popup.appendChild(h('div.ac-head', type === 'slash' ? '命令' : type === 'file' ? '文件与文件夹' : '参数'));
    items.forEach((it, i) => {
      const row = h(`div.ac-item${i === selected ? '.selected' : ''}`, {
        onmousedown: (e) => { e.preventDefault(); this.ac.selected = i; this.acceptAc(); },
        onmousemove: () => { if (this.ac.selected !== i) { this.ac.selected = i; this.renderAc(); } },
      },
      type === 'file' ? (it.icon ? icon(it.icon) : fileIconEl(it.label, false)) : null,
      h('span.ac-label', it.labelPos ? highlight(it.label, it.labelPos) : it.label),
      h('span.ac-desc', it.desc || ''),
      it.src ? h('span.ac-src', it.src) : null);
      this.popup.appendChild(row);
    });
    const sel = this.popup.querySelector('.ac-item.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  moveAc(d) {
    const n = this.ac.items.length;
    this.ac.selected = (this.ac.selected + d + n) % n;
    this.renderAc();
  }

  acceptAc() {
    const { type, start, items, selected } = this.ac;
    const it = items[selected];
    const ta = this.ta;
    const pos = ta.selectionStart;
    if (type === 'file') {
      ta.setRangeText('', start, pos, 'end');
      const abs = this.wb.absPath(it.file.replace(/\/$/, ''));
      if (it.dir) this.addChip({ kind: 'folder', path: abs });
      else this.addFiles([abs]);
    } else if (type === 'slash') {
      ta.value = it.insert;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      this.closeAc();
      if (it.runNow) { this.pane.submit('steer'); return; }
      this.updateAutocomplete();
      return;
    } else if (type === 'arg') {
      ta.setRangeText(it.insert, start, pos, 'end');
      this.closeAc();
      if (it.runNow) { this.pane.submit('steer'); return; }
    }
    this.closeAc();
    this.autosize();
    this.renderBar();
  }

  closeAc() {
    this.ac = null;
    this.popup.classList.add('hidden');
  }

  // ------------------------------------------------------------------ bar
  renderBar() {
    clear(this.bar);
    const s = this.session;
    const st = (s && s.state) || {};
    const model = st.model;
    const running = s && s.running;
    const mode = s ? s.mode : 'agent';
    this.ta.placeholder = !s ? '' : running ? '继续输入以引导 Agent（Enter 排队插入，Alt+Enter 完成后执行）…' : mode === 'ask' ? '提问（只读模式，不会修改文件）…  @ 添加上下文，/ 命令' : '让 Agent 写代码、改 bug、执行命令…  @ 添加上下文，/ 命令，! 运行命令';
    append(this.bar, 
      h(`button.pill.mode.${mode}`, { title: '切换模式 (Ctrl+.)', onclick: (e) => this.pane.modeMenu(e.currentTarget) },
        icon(mode === 'ask' ? 'comment-discussion' : 'infinity'), h('span.pill-label', mode === 'ask' ? 'Ask' : 'Agent'), icon('chevron-down')),
      h('button.pill', { title: '选择模型 (Ctrl+L / /model)', onclick: () => this.pane.modelPicker() },
        h('span.pill-label', model ? (model.name || model.id) : '未选择模型'), icon('chevron-down')),
      model && model.reasoning ? h('button.pill', { title: '思考强度 (Shift+Tab 循环)', onclick: (e) => this.pane.thinkingMenu(e.currentTarget) },
        icon('lightbulb'), h('span.pill-label', st.thinkingLevel || 'off')) : null,
      h('span.spacer'),
      this.contextMeter(),
      iconBtn('mention', '添加上下文 (@)', () => this.pickContext()),
      iconBtn('file-media', '附加图片', () => this.pickImages()),
      running && !this.ta.value.trim() && !this.chips.length
        ? h('button.send-btn.stop', { title: '停止 (Esc)', onclick: () => this.pane.stop() }, icon('debug-stop'))
        : h('button.send-btn', { title: running ? '排队发送（Enter）' : '发送 (Enter)', disabled: !s || s.status !== 'ready' || (!this.ta.value.trim() && !this.chips.length), onclick: () => this.pane.submit('steer') }, icon(running ? 'add' : 'arrow-up')));
    clear(this.hint);
  }

  contextMeter() {
    const s = this.session;
    const cu = s && s.contextUsage;
    if (!cu || !cu.contextWindow) return null;
    const pct = cu.percent === null || cu.percent === undefined ? null : Math.max(0, Math.min(100, cu.percent));
    const r = 7;
    const c = 2 * Math.PI * r;
    const color = pct === null ? 'var(--fg-faint)' : pct > 85 ? 'var(--err)' : pct > 65 ? 'var(--warn)' : 'var(--fg-muted)';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.classList.add('ctx-meter');
    svg.innerHTML = `<circle cx="9" cy="9" r="${r}" fill="none" stroke="var(--border-strong)" stroke-width="2"/><circle cx="9" cy="9" r="${r}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - (pct || 0) / 100)}" transform="rotate(-90 9 9)" stroke-linecap="round"/>`;
    return h('span.pill', { title: `上下文: ${cu.tokens === null ? '?' : fmtTokens(cu.tokens)} / ${fmtTokens(cu.contextWindow)}${pct !== null ? ` (${pct.toFixed(1)}%)` : ''}\n点击压缩上下文`, onclick: () => this.pane.runCommand('/compact') }, svg, pct !== null ? h('span', `${Math.round(pct)}%`) : null);
  }

  async pickImages() {
    const files = await api.invoke('dialog:open', { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
    if (files) await this.addFiles(files);
  }

  serializeDraft() {
    return { text: this.ta.value, chips: this.chips.filter((c) => c.kind !== 'image') };
  }

  restoreDraft(d) {
    this.chips = d && d.chips ? [...d.chips] : [];
    this.setText(d ? d.text : '');
    this.renderChips();
  }
}

export function toastErr(err) {
  toast(err && err.message ? err.message : String(err), 'error');
}
