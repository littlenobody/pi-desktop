// Sidebar views: Explorer (file tree), Search, Source Control, Chat History.
import { api, h, icon, iconBtn, clear, basename, dirname, join, relative, samePath, normCase, isInside, debounce, fmtTime, truncate, fileIconEl, IS_WIN } from './util.js';
import { contextMenu, confirm, prompt as promptBox, toast, quickPick } from './ui.js';
import { stripFileBlocks } from './session.js';

// =============================================================================================
// Explorer
// =============================================================================================
export class Explorer {
  constructor(wb) {
    this.wb = wb;
    this.expanded = new Set();
    this.children = new Map(); // normPath -> entries
    this.selected = null;
    this.selection = new Set();
    this.renaming = null;
    this.creating = null; // {parent, dir}
    this.gitStatus = new Map();
    this.el = h('div.tree', { tabindex: 0, onkeydown: (e) => this.onKey(e) });
    this.el.addEventListener('contextmenu', (e) => {
      if (e.target === this.el) { e.preventDefault(); this.menu(null, e.clientX, e.clientY); }
    });
    this.el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    this.el.addEventListener('drop', (e) => this.onExternalDrop(e, this.wb.folder));
    this.rows = [];
  }

  get root() { return this.wb.folder; }

  async load(dir) {
    try {
      const list = await api.invoke('fs:list', dir);
      this.children.set(normCase(dir), list);
      return list;
    } catch {
      this.children.set(normCase(dir), []);
      return [];
    }
  }

  async init() {
    this.expanded.add(normCase(this.root));
    await this.load(this.root);
    this.render();
  }

  async refresh() {
    const dirs = [...this.expanded];
    await Promise.all(dirs.map(async (d) => {
      const real = this.realPath(d);
      if (real) await this.load(real);
    }));
    this.render();
  }

  realPath(norm) {
    if (normCase(this.root) === norm) return this.root;
    for (const list of this.children.values()) {
      const hit = list.find((e) => normCase(e.path) === norm);
      if (hit) return hit.path;
    }
    return null;
  }

  onFsChanged = debounce(async (items) => {
    const dirs = new Set();
    for (const it of items) dirs.add(normCase(dirname(it.path)));
    let changed = false;
    for (const d of dirs) {
      if (this.expanded.has(d)) {
        const real = this.realPath(d) || (samePath(d, this.root) ? this.root : null);
        if (real) { await this.load(real); changed = true; }
      }
    }
    if (changed) this.render();
  }, 200);

  async toggle(entry, force) {
    const key = normCase(entry.path);
    const open = force !== undefined ? force : !this.expanded.has(key);
    if (open) {
      this.expanded.add(key);
      if (!this.children.has(key)) await this.load(entry.path);
    } else this.expanded.delete(key);
    this.render();
  }

  async reveal(p) {
    if (!isInside(p, this.root)) return;
    this.wb.showView('explorer');
    const rel = relative(this.root, p).split('/');
    let cur = this.root;
    for (let i = 0; i < rel.length - 1; i++) {
      cur = join(cur, rel[i]);
      this.expanded.add(normCase(cur));
      if (!this.children.has(normCase(cur))) await this.load(cur);
    }
    if (rel.length > 1 || rel[0]) {
      const st = await api.invoke('fs:stat', p);
      if (st.dir) {
        this.expanded.add(normCase(p));
        if (!this.children.has(normCase(p))) await this.load(p);
      }
    }
    this.selected = p;
    this.selection = new Set([normCase(p)]);
    this.render();
    const row = this.el.querySelector('.tree-row.selected');
    if (row) row.scrollIntoView({ block: 'center' });
  }

  setGitStatus(status) {
    this.gitStatus.clear();
    if (status && status.repo) {
      for (const f of status.files) {
        const code = f.index === '?' ? 'U' : f.work !== ' ' && f.work !== '?' ? f.work : f.index;
        this.gitStatus.set(normCase(f.path), code === 'R' ? 'M' : code);
        // propagate to parent dirs
        let d = dirname(f.path);
        while (d && isInside(d, this.root) && !samePath(d, this.root)) {
          const k = normCase(d);
          if (!this.gitStatus.has(k)) this.gitStatus.set(k, 'dir');
          d = dirname(d);
        }
      }
    }
    this.render();
  }

  refreshDecorations() {
    this.render();
  }

  render() {
    const scrollTop = this.el.parentElement ? this.el.parentElement.scrollTop : 0;
    clear(this.el);
    this.rows = [];
    if (!this.root) return;
    const agentChanged = new Set();
    for (const s of this.wb.chat.sessions) for (const c of s.changes || []) agentChanged.add(normCase(c.path));
    const walk = (dir, depth) => {
      const list = this.children.get(normCase(dir)) || [];
      if (this.creating && samePath(this.creating.parent, dir)) this.el.appendChild(this.createRow(depth));
      for (const e of list) {
        const key = normCase(e.path);
        const open = e.dir && this.expanded.has(key);
        const git = this.gitStatus.get(key);
        const cls = git && git !== 'dir' ? `.git-${git === '?' ? 'U' : git}` : '';
        const row = h(`div.tree-row${this.selection.has(key) ? '.selected' : ''}${cls}`, {
          style: { paddingLeft: `${8 + depth * 12}px` },
          draggable: true,
          title: e.path,
          onclick: (ev) => this.onClick(e, ev),
          ondblclick: () => { if (!e.dir) this.wb.editors.openFile(e.path, { pinned: true }); },
          oncontextmenu: (ev) => { ev.preventDefault(); ev.stopPropagation(); if (!this.selection.has(key)) { this.selection = new Set([key]); this.selected = e.path; this.render(); } this.menu(e, ev.clientX, ev.clientY); },
          ondragstart: (ev) => {
            const paths = this.selection.has(key) ? this.selectedPaths() : [e.path];
            ev.dataTransfer.setData('application/x-pi-path', paths.join('\n'));
            ev.dataTransfer.setData('text/plain', paths.map((p) => relative(this.root, p)).join(' '));
            ev.dataTransfer.effectAllowed = 'copyMove';
          },
          ondragover: (ev) => { if (e.dir) { ev.preventDefault(); row.classList.add('drop-target'); } },
          ondragleave: () => row.classList.remove('drop-target'),
          ondrop: (ev) => { row.classList.remove('drop-target'); if (e.dir) this.onDrop(ev, e.path); },
        },
        h('span.twistie', e.dir ? icon(open ? 'chevron-down' : 'chevron-right') : null),
        h('span.ficon', fileIconEl(e.name, e.dir, open)),
        this.renaming && samePath(this.renaming, e.path) ? this.renameInput(e) : h('span.name', e.name),
        agentChanged.has(key) ? h('span.deco', { title: 'Agent 修改过', style: { color: 'var(--link)' } }, '●') : git && git !== 'dir' ? h('span.deco', git === '?' ? 'U' : git) : git === 'dir' ? h('span.deco', { style: { color: 'var(--git-mod)', opacity: 0.6 } }, '•') : null);
        if (e.name.startsWith('.') && e.name !== '.pi') row.classList.add('ignored');
        this.el.appendChild(row);
        this.rows.push(e);
        if (open) walk(e.path, depth + 1);
      }
    };
    walk(this.root, 0);
    if (this.el.parentElement) this.el.parentElement.scrollTop = scrollTop;
  }

  createRow(depth) {
    const input = h('input.input.rename-input', { placeholder: this.creating.dir ? '文件夹名' : '文件名' });
    const finish = async (ok) => {
      const c = this.creating;
      this.creating = null;
      const name = input.value.trim();
      if (ok && name) {
        const p = join(c.parent, name);
        try {
          await api.invoke('fs:create', p, c.dir);
          await this.load(c.parent);
          if (!c.dir) this.wb.editors.openFile(p, { pinned: true });
          this.selected = p;
          this.selection = new Set([normCase(p)]);
        } catch (err) { toast(err.message, 'error'); }
      }
      this.render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
    input.addEventListener('blur', () => finish(true));
    setTimeout(() => input.focus(), 0);
    return h('div.tree-row', { style: { paddingLeft: `${8 + depth * 12}px` } }, h('span.twistie'), h('span.ficon', icon(this.creating.dir ? 'folder' : 'file')), input);
  }

  renameInput(e) {
    const input = h('input.input.rename-input', { value: e.name });
    const finish = async (ok) => {
      if (!this.renaming) return;
      this.renaming = null;
      const name = input.value.trim();
      if (ok && name && name !== e.name) {
        const to = join(dirname(e.path), name);
        try {
          await api.invoke('fs:rename', e.path, to);
          this.wb.editors.onPathRenamed(e.path, to);
          await this.load(dirname(e.path));
          this.selected = to;
          this.selection = new Set([normCase(to)]);
        } catch (err) { toast(err.message, 'error'); }
      }
      this.render();
      this.el.focus();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); ev.stopPropagation(); });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    setTimeout(() => {
      input.focus();
      const dot = e.dir ? -1 : e.name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : e.name.length);
    }, 0);
    return input;
  }

  onClick(e, ev) {
    const key = normCase(e.path);
    if (ev.ctrlKey || ev.metaKey) {
      if (this.selection.has(key)) this.selection.delete(key);
      else this.selection.add(key);
      this.selected = e.path;
      this.render();
      return;
    }
    if (ev.shiftKey && this.selected) {
      const a = this.rows.findIndex((r) => samePath(r.path, this.selected));
      const b = this.rows.findIndex((r) => samePath(r.path, e.path));
      const [lo, hi] = a < b ? [a, b] : [b, a];
      this.selection = new Set(this.rows.slice(lo, hi + 1).map((r) => normCase(r.path)));
      this.render();
      return;
    }
    this.selected = e.path;
    this.selection = new Set([key]);
    if (e.dir) this.toggle(e);
    else {
      this.render();
      this.wb.editors.openFile(e.path, { preview: true, noFocus: true });
    }
  }

  selectedPaths() {
    return this.rows.filter((r) => this.selection.has(normCase(r.path))).map((r) => r.path);
  }

  onKey(e) {
    if (this.renaming || this.creating) return;
    const idx = this.rows.findIndex((r) => samePath(r.path, this.selected));
    const cur = this.rows[idx];
    const select = (r) => { if (!r) return; this.selected = r.path; this.selection = new Set([normCase(r.path)]); this.render(); const el = this.el.querySelector('.tree-row.selected'); if (el) el.scrollIntoView({ block: 'nearest' }); };
    if (e.key === 'ArrowDown') { e.preventDefault(); select(this.rows[Math.min(this.rows.length - 1, idx + 1)]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(this.rows[Math.max(0, idx - 1)]); }
    else if (e.key === 'ArrowRight' && cur && cur.dir) { e.preventDefault(); this.toggle(cur, true); }
    else if (e.key === 'ArrowLeft' && cur) {
      e.preventDefault();
      if (cur.dir && this.expanded.has(normCase(cur.path))) this.toggle(cur, false);
      else select(this.rows.find((r) => samePath(r.path, dirname(cur.path))));
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      if (cur.dir) this.toggle(cur);
      else this.wb.editors.openFile(cur.path, { pinned: true });
    } else if (e.key === 'F2' && cur) { e.preventDefault(); this.renaming = cur.path; this.render(); }
    else if (e.key === 'Delete' && cur) { e.preventDefault(); this.deletePaths(this.selectedPaths()); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && cur) { this.clip = { paths: this.selectedPaths(), cut: false }; }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && cur) { this.clip = { paths: this.selectedPaths(), cut: true }; }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { this.paste(cur ? (cur.dir ? cur.path : dirname(cur.path)) : this.root); }
  }

  async paste(target) {
    if (!this.clip) return;
    for (const p of this.clip.paths) {
      let to = join(target, basename(p));
      try {
        if (this.clip.cut) await api.invoke('fs:rename', p, to);
        else {
          const st = await api.invoke('fs:stat', to);
          if (st.exists) {
            const ext = basename(p).includes('.') ? basename(p).slice(basename(p).lastIndexOf('.')) : '';
            to = join(target, `${basename(p).slice(0, basename(p).length - ext.length)} copy${ext}`);
          }
          await api.invoke('fs:copyFile', p, to);
        }
      } catch (err) { toast(err.message, 'error'); }
    }
    if (this.clip.cut) this.clip = null;
    await this.refresh();
  }

  async onDrop(ev, targetDir) {
    ev.preventDefault();
    ev.stopPropagation();
    const internal = ev.dataTransfer.getData('application/x-pi-path');
    if (internal) {
      for (const p of internal.split('\n').filter(Boolean)) {
        if (samePath(dirname(p), targetDir) || isInside(targetDir, p)) continue;
        try {
          const to = join(targetDir, basename(p));
          await api.invoke('fs:rename', p, to);
          this.wb.editors.onPathRenamed(p, to);
        } catch (err) { toast(err.message, 'error'); }
      }
      await this.refresh();
      return;
    }
    await this.onExternalDrop(ev, targetDir);
  }

  async onExternalDrop(ev, targetDir) {
    const files = [...(ev.dataTransfer.files || [])];
    if (!files.length) return;
    ev.preventDefault();
    for (const f of files) {
      const src = api.pathForFile(f);
      if (!src) continue;
      try { await api.invoke('fs:copyFile', src, join(targetDir, basename(src))); } catch (err) { toast(err.message, 'error'); }
    }
    await this.refresh();
  }

  async deletePaths(paths) {
    if (!paths.length) return;
    const ok = await confirm('删除', paths.length === 1 ? `确定要删除 “${basename(paths[0])}” 吗？\n可以从回收站中恢复。` : `确定要删除这 ${paths.length} 项吗？\n可以从回收站中恢复。`, { okLabel: '移到回收站', danger: true });
    if (!ok) return;
    for (const p of paths) {
      try {
        await api.invoke('shell:trash', p);
        const tab = this.wb.editors.findTab((t) => t.path && isInside(t.path, p));
        if (tab) await this.wb.editors.closeTab(tab.id, { force: true });
      } catch (err) { toast(err.message, 'error'); }
    }
    await this.refresh();
  }

  newEntry(dir, isDir) {
    const parent = dir || (this.selected ? (this.rows.find((r) => samePath(r.path, this.selected)) || {}).dir ? this.selected : dirname(this.selected) : this.root);
    this.expanded.add(normCase(parent));
    this.creating = { parent, dir: isDir };
    (this.children.has(normCase(parent)) ? Promise.resolve() : this.load(parent)).then(() => this.render());
  }

  collapseAll() {
    this.expanded = new Set([normCase(this.root)]);
    this.render();
  }

  menu(e, x, y) {
    const sel = this.selectedPaths();
    const multi = sel.length > 1;
    const dir = e ? (e.dir ? e.path : dirname(e.path)) : this.root;
    contextMenu(x, y, [
      { label: '新建文件…', icon: 'new-file', run: () => this.newEntry(dir, false) },
      { label: '新建文件夹…', icon: 'new-folder', run: () => this.newEntry(dir, true) },
      { separator: true },
      e ? { label: '添加到聊天', icon: 'comment-discussion', keys: '', run: () => this.wb.chat.composer.addFiles(multi ? sel : [e.path]).then(() => this.wb.showChat()) } : null,
      e && !e.dir ? { label: '在新聊天中讨论', icon: 'add', run: async () => { await this.wb.chat.newChat(); this.wb.chat.addFileContext(e.path); } } : null,
      e ? { separator: true } : null,
      e && !e.dir ? { label: '打开', run: () => this.wb.editors.openFile(e.path, { pinned: true }) } : null,
      e && !e.dir ? { label: '使用系统默认程序打开', run: () => api.invoke('shell:openPath', e.path) } : null,
      { label: '在系统文件管理器中显示', run: () => api.invoke('shell:reveal', e ? e.path : this.root) },
      { label: '在集成终端中打开', icon: 'terminal', run: () => this.wb.terminal.newTerminal({ cwd: dir }) },
      e && !e.dir ? { label: '与 Git HEAD 比较', icon: 'git-compare', run: () => this.wb.scm.openGitDiff(e.path) } : null,
      { separator: true },
      e ? { label: '剪切', keys: 'Ctrl+X', run: () => { this.clip = { paths: sel, cut: true }; } } : null,
      e ? { label: '复制', keys: 'Ctrl+C', run: () => { this.clip = { paths: sel, cut: false }; } } : null,
      { label: '粘贴', keys: 'Ctrl+V', disabled: !this.clip, run: () => this.paste(dir) },
      { separator: true },
      e ? { label: '复制路径', run: () => api.invoke('clipboard:write', sel.join('\n')) } : null,
      e ? { label: '复制相对路径', run: () => api.invoke('clipboard:write', sel.map((p) => relative(this.root, p)).join('\n')) } : null,
      e ? { separator: true } : null,
      e && !multi ? { label: '重命名', keys: 'F2', run: () => { this.renaming = e.path; this.render(); } } : null,
      e ? { label: '删除', keys: 'Delete', icon: 'trash', run: () => this.deletePaths(sel) } : null,
    ]);
  }
}

// =============================================================================================
// Search
// =============================================================================================
export class SearchView {
  constructor(wb) {
    this.wb = wb;
    this.opts = { caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' };
    this.collapsed = new Set();
    this.query = h('input', { placeholder: '搜索', spellcheck: false });
    this.replace = h('input', { placeholder: '替换', spellcheck: false });
    this.include = h('input.input', { placeholder: '包含的文件（例如 *.ts, src/**）', style: { height: '24px' } });
    this.exclude = h('input.input', { placeholder: '排除的文件', style: { height: '24px' } });
    const toggle = (key, ic, title) => {
      const b = iconBtn(ic, title, () => { this.opts[key] = !this.opts[key]; b.classList.toggle('active', this.opts[key]); this.run(); });
      return b;
    };
    this.showReplace = false;
    this.replaceRow = h('div.search-box.hidden', this.replace, iconBtn('replace-all', '全部替换', () => this.replaceAll()));
    this.details = h('div.col.hidden', { style: { gap: '6px' } }, this.include, this.exclude);
    this.form = h('div.search-form',
      h('div.row', { style: { gap: '2px' } },
        iconBtn('chevron-right', '切换替换', (e) => { this.showReplace = !this.showReplace; this.replaceRow.classList.toggle('hidden', !this.showReplace); e.currentTarget.replaceChildren(icon(this.showReplace ? 'chevron-down' : 'chevron-right')); }),
        h('div.col.grow', { style: { gap: '6px' } },
          h('div.search-box', this.query, toggle('caseSensitive', 'case-sensitive', '区分大小写'), toggle('wholeWord', 'whole-word', '全字匹配'), toggle('regex', 'regex', '使用正则表达式')),
          this.replaceRow)),
      h('div.row', { style: { justifyContent: 'flex-end' } }, iconBtn('ellipsis', '包含/排除', () => this.details.classList.toggle('hidden'))),
      this.details);
    this.summary = h('div.search-summary');
    this.results = h('div');
    this.el = h('div', this.form, this.summary, this.results);
    const go = debounce(() => this.run(), 300);
    this.query.addEventListener('input', go);
    this.include.addEventListener('input', go);
    this.exclude.addEventListener('input', go);
    this.query.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.run(); });
    this.seq = 0;
    this.data = null;
  }

  focus(text) {
    if (text) this.query.value = text;
    this.query.focus();
    this.query.select();
    if (text) this.run();
  }

  async run() {
    const q = this.query.value;
    const my = ++this.seq;
    if (!q) { clear(this.results); this.summary.textContent = ''; this.data = null; return; }
    this.summary.textContent = '搜索中…';
    try {
      const r = await api.invoke('fs:search', q, { ...this.opts, include: this.include.value, exclude: this.exclude.value });
      if (my !== this.seq) return;
      this.data = r;
      this.render();
    } catch (err) {
      if (my === this.seq) this.summary.textContent = `错误: ${err.message}`;
    }
  }

  render() {
    clear(this.results);
    const r = this.data;
    if (!r) return;
    const total = r.results.reduce((a, f) => a + f.items.length, 0);
    this.summary.textContent = total ? `${r.results.length} 个文件中有 ${total} 个结果${r.truncated ? '（结果过多，已截断）' : ''}` : '未找到结果';
    for (const f of r.results) {
      const key = normCase(f.file);
      const collapsed = this.collapsed.has(key);
      this.results.appendChild(h('div.search-file', { onclick: () => { if (collapsed) this.collapsed.delete(key); else this.collapsed.add(key); this.render(); }, title: f.file },
        icon(collapsed ? 'chevron-right' : 'chevron-down'), fileIconEl(f.file, false), h('span', basename(f.file)), h('span.dir', relative(this.wb.folder, dirname(f.file))), h('span.badge', String(f.items.length))));
      if (collapsed) continue;
      for (const m of f.items) {
        const line = m.text;
        const [s0] = m.ranges[0] || [0, 0];
        const startAt = Math.max(0, s0 - 30);
        const frag = [];
        let pos = startAt;
        for (const [a, b] of m.ranges) {
          if (a < pos) continue;
          frag.push(line.slice(pos, a));
          frag.push(h('mark', line.slice(a, b)));
          pos = b;
        }
        frag.push(line.slice(pos, pos + 200));
        this.results.appendChild(h('div.search-match', { title: line.trim(), onclick: () => this.wb.editors.openFile(f.file, { line: m.line, column: (m.ranges[0] || [0])[0] + 1, preview: true, highlight: true }) },
          h('span.ln', String(m.line)), startAt > 0 ? '…' : '', ...frag));
      }
    }
  }

  async replaceAll() {
    if (!this.data || !this.data.results.length) return;
    const n = this.data.results.length;
    if (!(await confirm('全部替换', `在 ${n} 个文件中将 “${this.query.value}” 替换为 “${this.replace.value}”？`, { okLabel: '替换', danger: true }))) return;
    let changed = 0;
    for (const f of this.data.results) {
      try { if (await api.invoke('fs:replace', f.file, this.query.value, this.replace.value, this.opts)) changed++; } catch (err) { toast(err.message, 'error'); }
    }
    toast(`已在 ${changed} 个文件中替换`, 'info');
    this.run();
  }
}

// =============================================================================================
// Source control
// =============================================================================================
export class ScmView {
  constructor(wb) {
    this.wb = wb;
    this.status = null;
    this.msg = h('textarea.textarea', { placeholder: '提交信息（Ctrl+Enter 提交）', rows: 2 });
    this.msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit(); } });
    this.commitBtn = h('button.btn', { onclick: () => this.commit() }, icon('check'), '提交');
    this.genBtn = iconBtn('sparkle', '让 Agent 生成提交信息', () => this.generateMessage());
    this.body = h('div');
    this.el = h('div', this.body);
    this.refreshSoon = debounce(() => this.refresh(), 400);
  }

  async refresh() {
    if (!this.wb.folder) return;
    try {
      this.status = await api.invoke('git:status');
    } catch {
      this.status = { repo: false };
    }
    this.wb.explorer.setGitStatus(this.status);
    this.render();
    this.wb.statusbar.render();
    this.wb.activitybar.render();
  }

  count() {
    return this.status && this.status.repo ? this.status.files.length : 0;
  }

  render() {
    clear(this.body);
    const st = this.status;
    if (!st) return;
    if (!st.repo) {
      this.body.appendChild(h('div.empty-view', '当前文件夹不是 Git 仓库。', h('button.btn', { onclick: async () => { await api.invoke('git:init'); this.refresh(); } }, '初始化仓库')));
      return;
    }
    const staged = st.files.filter((f) => f.index !== ' ' && f.index !== '?');
    const changes = st.files.filter((f) => f.work !== ' ' || f.index === '?');
    this.body.appendChild(h('div.scm-commit', h('div.row', this.msg), h('div.row', this.commitBtn, this.genBtn)));
    this.commitBtn.lastChild.textContent = staged.length ? `提交 (${staged.length})` : '提交全部';
    const section = (title, files, isStaged) => {
      if (!files.length) return;
      this.body.appendChild(h('div.section-head', icon('chevron-down'), h('span', `${title}`), h('span.badge', { style: { marginLeft: '6px' } }, String(files.length)),
        h('span.actions',
          isStaged ? iconBtn('remove', '全部取消暂存', () => this.op('unstage', files.map((f) => f.path)))
            : [iconBtn('discard', '放弃全部更改', () => this.discard(files.map((f) => f.path))), iconBtn('add', '全部暂存', () => this.op('stage', files.map((f) => f.path)))])));
      for (const f of files) {
        const code = isStaged ? f.index : f.index === '?' ? 'U' : f.work;
        const color = code === 'M' ? 'var(--git-mod)' : code === 'D' ? 'var(--git-del)' : 'var(--git-new)';
        this.body.appendChild(h('div.scm-file', { title: f.path, onclick: () => this.openGitDiff(f.path, false, isStaged) },
          fileIconEl(f.path, false), h('span', { style: { color, textDecoration: code === 'D' ? 'line-through' : '' } }, basename(f.rel)), h('span.dir', dirname(f.rel)),
          h('span.actions',
            iconBtn('go-to-file', '打开文件', () => this.wb.editors.openFile(f.path)),
            isStaged ? iconBtn('remove', '取消暂存', () => this.op('unstage', [f.path]))
              : [iconBtn('discard', '放弃更改', () => this.discard([f.path])), iconBtn('add', '暂存', () => this.op('stage', [f.path]))]),
          h('span.status', { style: { color } }, code)));
      }
    };
    section('暂存的更改', staged, true);
    section('更改', changes, false);
    if (!st.files.length) this.body.appendChild(h('div.empty-view', '没有更改。'));
  }

  async op(kind, files) {
    try { await api.invoke(`git:${kind}`, files); } catch (err) { toast(err.message, 'error'); }
    this.refresh();
  }

  async discard(files) {
    if (!(await confirm('放弃更改', `确定要放弃 ${files.length} 个文件的更改吗？此操作不可撤销（未跟踪的文件将被删除）。`, { okLabel: '放弃更改', danger: true }))) return;
    await this.op('discard', files);
  }

  async commit() {
    const message = this.msg.value.trim();
    if (!message) { toast('请输入提交信息', 'warning'); this.msg.focus(); return; }
    const staged = this.status.files.filter((f) => f.index !== ' ' && f.index !== '?');
    try {
      if (!staged.length) await api.invoke('git:stage', this.status.files.map((f) => f.path));
      await api.invoke('git:commit', message, {});
      this.msg.value = '';
      toast('已提交', 'info', { timeout: 2000 });
    } catch (err) {
      toast(err.message, 'error');
    }
    this.refresh();
  }

  async generateMessage() {
    const diff = await api.invoke('git:diffStaged').catch(() => '');
    const s = this.wb.chat.current;
    if (!s || s.status !== 'ready') { toast('需要一个运行中的聊天会话', 'warning'); return; }
    const prompt = diff
      ? `根据以下暂存的更改，写一条简洁的 Conventional Commits 风格提交信息（只输出提交信息本身，不要解释、不要代码块）：\n\n${diff}`
      : '查看 `git status` 和 `git diff`，写一条简洁的 Conventional Commits 风格提交信息（只输出提交信息本身，不要解释、不要代码块，也不要执行提交）。';
    this.genBtn.disabled = true;
    try {
      const off = s.on('settled', async () => {
        off();
        this.genBtn.disabled = false;
        const r = await s.request({ type: 'get_last_assistant_text' }).catch(() => null);
        if (r && r.text) this.msg.value = r.text.trim().replace(/^```\w*\n?|```$/g, '').trim();
      });
      await s.prompt(prompt);
      this.wb.showChat();
    } catch (err) {
      this.genBtn.disabled = false;
      toast(err.message, 'error');
    }
  }

  async openGitDiff(p, fallbackToFile = false, staged = false) {
    const head = await api.invoke('git:show', p, 'HEAD').catch(() => null);
    if (head === null && fallbackToFile) { this.wb.editors.openFile(p); return; }
    if (staged) {
      const idx = await api.invoke('git:show', p, ':0').catch(() => null);
      const tab = await this.wb.editors.openDiff(p, head === null ? '' : head, { source: 'staged', title: `${basename(p)} (暂存)` });
      if (tab && idx !== null) tab.modifiedModel = this.wb.editors.monaco.editor.createModel(idx, tab.originalModel.getLanguageId()), tab.ownsModified = true, this.wb.editors.showActive();
      return;
    }
    await this.wb.editors.openDiff(p, head === null ? '' : head, { source: 'git', title: `${basename(p)} (工作区)` });
  }

  async branchPicker() {
    const branches = await api.invoke('git:branches').catch(() => []);
    const cur = this.status && this.status.branch;
    const pick = await quickPick({
      items: [{ label: '创建新分支…', iconEl: icon('add'), value: { create: true }, alwaysShow: true }, ...branches.map((b) => ({ label: b, iconEl: icon(b === cur ? 'check' : 'git-branch'), value: b }))],
      placeholder: '切换分支',
    });
    if (!pick) return;
    try {
      if (pick.create) {
        const name = await promptBox('新分支名称');
        if (name) await api.invoke('git:checkout', name.trim(), true);
      } else await api.invoke('git:checkout', pick, false);
    } catch (err) { toast(err.message, 'error'); }
    this.refresh();
  }

  async sync() {
    const t = toast('正在同步（pull & push）…', 'info', { timeout: 0 });
    const pull = await api.invoke('git:run', ['pull', '--no-edit']);
    const push = pull.code === 0 ? await api.invoke('git:run', ['push']) : null;
    t.remove();
    if (pull.code !== 0) toast(`pull 失败:\n${pull.stderr || pull.stdout}`, 'error');
    else if (push && push.code !== 0) toast(`push 失败:\n${push.stderr || push.stdout}`, 'error');
    else toast('同步完成', 'info', { timeout: 2000 });
    this.refresh();
  }
}

// =============================================================================================
// History
// =============================================================================================
export class HistoryView {
  constructor(wb) {
    this.wb = wb;
    this.all = false;
    this.filter = h('input.input', { placeholder: '筛选会话', style: { width: '100%' } });
    this.filter.addEventListener('input', () => this.render());
    this.list = h('div');
    this.items = [];
    this.el = h('div', h('div', { style: { padding: '4px 12px 8px 20px' } }, this.filter), this.list);
    this.refreshSoon = debounce(() => this.refresh(), 500);
  }

  async refresh() {
    if (!this.wb.folder) return;
    this.items = await api.invoke('pi:sessions:list', this.all).catch(() => []);
    this.render();
  }

  render() {
    clear(this.list);
    const q = this.filter.value.toLowerCase();
    const open = this.wb.chat.sessions.filter((s) => s.sessionFile).map((s) => normCase(s.sessionFile));
    const items = this.items.filter((it) => !q || `${it.name || ''} ${it.firstMessage}`.toLowerCase().includes(q));
    if (!items.length) {
      this.list.appendChild(h('div.empty-view', this.items.length ? '没有匹配的会话' : '还没有会话。', h('button.btn', { onclick: () => this.wb.chat.newChat() }, '新建聊天')));
      return;
    }
    for (const it of items) {
      const title = it.name || truncate(stripFileBlocks(it.firstMessage).replace(/\s+/g, ' '), 80) || '(空会话)';
      this.list.appendChild(h(`div.hist-item${open.includes(normCase(it.file)) ? '.open' : ''}`, {
        title: `${it.file}\n${it.cwd}`,
        onclick: () => this.wb.chat.openSessionFile(it.file, it.cwd),
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: '打开', run: () => this.wb.chat.openSessionFile(it.file, it.cwd) },
            { label: '重命名', run: async () => {
              const v = await promptBox('会话名称', { value: it.name || '' });
              if (!v) return;
              const live = this.wb.chat.sessions.find((s) => s.sessionFile && samePath(s.sessionFile, it.file) && s.status === 'ready');
              if (live) await live.setName(v.trim());
              else await api.invoke('pi:sessions:rename', it.file, v.trim());
              this.refresh();
            } },
            { label: '在 Pi TUI 中打开', run: () => this.wb.terminal.openPiTui(['--session', it.file]) },
            { label: '导出 HTML…', run: async () => {
              const s = await this.wb.chat.newChat({ sessionFile: it.file });
              if (s) s.on('ready', () => this.wb.chat.runCommand('/export'));
            } },
            { label: '复制文件路径', run: () => api.invoke('clipboard:write', it.file) },
            { label: '在文件夹中显示', run: () => api.invoke('shell:reveal', it.file) },
            { separator: true },
            { label: '删除', icon: 'trash', run: () => this.wb.chat.deleteSession(it) },
          ]);
        },
      },
      h('div.t', title),
      h('div.m', h('span', fmtTime(it.modified)), h('span', `${it.messages} 条消息`), this.all ? h('span.ellipsis', basename(it.cwd)) : null),
      h('div.actions', iconBtn('trash', '删除', () => this.wb.chat.deleteSession(it)))));
    }
  }
}

// =============================================================================================
// Sidebar container
// =============================================================================================
export class Sidebar {
  constructor(wb) {
    this.wb = wb;
    this.view = 'explorer';
    this.explorer = new Explorer(wb);
    this.search = new SearchView(wb);
    this.scm = new ScmView(wb);
    this.history = new HistoryView(wb);
    this.head = h('div.view-head');
    this.body = h('div.view-body');
    this.el = h('div.sidebar', this.head, this.body);
  }

  show(view) {
    this.view = view;
    this.render();
    if (view === 'scm') this.scm.refresh();
    if (view === 'history') this.history.refresh();
  }

  refreshHistory() {
    if (this.view === 'history') this.history.refreshSoon();
  }

  render() {
    clear(this.head);
    clear(this.body);
    const folderName = this.wb.folder ? basename(this.wb.folder) : '';
    switch (this.view) {
      case 'explorer':
        this.head.append(h('span.title', `资源管理器${folderName ? ' · ' + folderName : ''}`),
          iconBtn('new-file', '新建文件', () => this.explorer.newEntry(null, false)),
          iconBtn('new-folder', '新建文件夹', () => this.explorer.newEntry(null, true)),
          iconBtn('refresh', '刷新', () => this.explorer.refresh()),
          iconBtn('collapse-all', '全部折叠', () => this.explorer.collapseAll()));
        this.body.appendChild(this.explorer.el);
        break;
      case 'search':
        this.head.append(h('span.title', '搜索'), iconBtn('refresh', '刷新', () => this.search.run()), iconBtn('clear-all', '清除', () => { this.search.query.value = ''; this.search.run(); }));
        this.body.appendChild(this.search.el);
        setTimeout(() => this.search.query.focus(), 0);
        break;
      case 'scm':
        this.head.append(h('span.title', `源代码管理${this.scm.status && this.scm.status.branch ? ' · ' + this.scm.status.branch : ''}`),
          iconBtn('git-branch', '切换分支', () => this.scm.branchPicker()),
          iconBtn('sync', '同步（pull & push）', () => this.scm.sync()),
          iconBtn('refresh', '刷新', () => this.scm.refresh()));
        this.body.appendChild(this.scm.el);
        break;
      case 'history':
        this.head.append(h('span.title', 'Agent 会话'),
          iconBtn('add', '新建聊天', () => this.wb.chat.newChat()),
          iconBtn(this.history.all ? 'folder' : 'globe', this.history.all ? '只看当前项目' : '显示所有项目', () => { this.history.all = !this.history.all; this.history.refresh(); this.render(); }),
          iconBtn('refresh', '刷新', () => this.history.refresh()));
        this.body.appendChild(this.history.el);
        break;
      default:
        break;
    }
  }
}

export { IS_WIN };
