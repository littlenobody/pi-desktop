// Editor area: Monaco-based tabs with preview mode, diff views, image/markdown preview and save handling.
import { api, h, icon, iconBtn, clear, basename, dirname, extname, relative, samePath, normCase, fileUrl, IMAGE_EXTS, Emitter, fileIconEl, IS_MAC, append } from './util.js';
import { toast, confirm, contextMenu, modal, prompt as promptBox } from './ui.js';
import { renderMarkdown } from './markdown.js';

let monacoReady = null;

export function loadMonaco() {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise((resolve, reject) => {
    const base = new URL('../node_modules/monaco-editor/min/', document.baseURI).href;
    window.MonacoEnvironment = {
      getWorkerUrl: () => `${base}vs/base/worker/workerMain.js`,
    };
    const req = window.require;
    req.config({ paths: { vs: `${base}vs` } });
    const lang = (navigator.language || '').toLowerCase().startsWith('zh') ? ['vs/nls.messages.zh-cn'] : [];
    req(lang, () => {
      req(['vs/editor/editor.main'], () => {
        defineThemes(window.monaco);
        resolve(window.monaco);
      }, reject);
    }, () => req(['vs/editor/editor.main'], () => { defineThemes(window.monaco); resolve(window.monaco); }, reject));
  });
  return monacoReady;
}

function defineThemes(monaco) {
  monaco.editor.defineTheme('pi-dark', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: {
      'editor.background': '#1f1f1f', 'editorGutter.background': '#1f1f1f', 'editor.lineHighlightBackground': '#2a2a2a80',
      'editorLineNumber.foreground': '#6e7681', 'editorLineNumber.activeForeground': '#cccccc', 'editorWidget.background': '#252526',
      'editorWidget.border': '#3c3c3c', 'minimap.background': '#1f1f1f', 'scrollbarSlider.background': '#79797966',
      'diffEditor.insertedTextBackground': '#2ea04333', 'diffEditor.removedTextBackground': '#f8514933',
    },
  });
  monaco.editor.defineTheme('pi-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff' } });
}

const LANG_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.json': 'json', '.jsonc': 'json', '.jsonl': 'json', '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown', '.py': 'python', '.pyw': 'python',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.scala': 'scala', '.lua': 'lua', '.r': 'r', '.dart': 'dart', '.sql': 'sql',
  '.html': 'html', '.htm': 'html', '.vue': 'html', '.svelte': 'html', '.xml': 'xml', '.svg': 'xml', '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.env': 'ini', '.properties': 'ini',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'powershell', '.psm1': 'powershell', '.bat': 'bat', '.cmd': 'bat',
  '.dockerfile': 'dockerfile', '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'protobuf', '.tf': 'hcl', '.sol': 'sol', '.pl': 'perl', '.ex': 'elixir', '.exs': 'elixir',
  '.clj': 'clojure', '.fs': 'fsharp', '.vb': 'vb', '.m': 'objective-c', '.pas': 'pascal', '.tex': 'plaintext', '.txt': 'plaintext', '.log': 'plaintext',
};

export function languageOf(file) {
  const b = basename(file).toLowerCase();
  if (b === 'dockerfile' || b.startsWith('dockerfile.')) return 'dockerfile';
  if (b === 'makefile') return 'plaintext';
  if (b.startsWith('.env')) return 'ini';
  if (b === '.gitignore' || b === '.npmrc') return 'ini';
  return LANG_BY_EXT[extname(file)] || 'plaintext';
}

let untitledSeq = 0;

/**
 * Tab kinds:
 *   file    { path }
 *   diff    { path, original, title, source: 'agent'|'git'|'staged' }
 *   image   { path }
 *   binary  { path }
 *   untitled{ path: 'untitled:N' }
 *   custom  { id, title, render(container) } (settings page etc.)
 */
export class EditorArea extends Emitter {
  constructor(wb) {
    super();
    this.wb = wb;
    this.tabs = [];
    this.active = null;
    this.docs = new Map(); // normPath -> {path, model, saved, mtime, bom, eol, viewState, disposed}
    this.el = h('div.editor-area');
    this.tabsEl = h('div.tabs', { ondblclick: (e) => { if (e.target === this.tabsEl) this.newUntitled(); } });
    this.crumbs = h('div.breadcrumbs');
    this.diffBar = h('div.editor-diffbar.hidden');
    this.host = h('div.editor-host');
    this.el.append(this.tabsEl, this.crumbs, this.diffBar, this.host);
    this.editor = null;
    this.diffEditor = null;
    this.monacoHost = h('div.monaco-host');
    this.diffHost = h('div.monaco-host.hidden');
    this.otherHost = h('div.monaco-host.hidden');
    this.watermark = this.renderWatermark();
    this.host.append(this.monacoHost, this.diffHost, this.otherHost, this.watermark);
    this.dragTab = null;
    this.render();
  }

  async init() {
    const monaco = await loadMonaco();
    this.monaco = monaco;
    const cfg = this.wb.config;
    const common = {
      automaticLayout: true,
      fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono'),
      fontSize: cfg.editorFontSize || 14,
      minimap: { enabled: cfg.minimap !== false },
      wordWrap: cfg.wordWrap || 'off',
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      scrollBeyondLastLine: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      stickyScroll: { enabled: true },
      fixedOverflowWidgets: true,
      theme: this.themeName(),
    };
    this.editor = monaco.editor.create(this.monacoHost, { ...common, model: null });
    this.diffEditor = monaco.editor.createDiffEditor(this.diffHost, { ...common, renderSideBySide: true, originalEditable: false, ignoreTrimWhitespace: false, renderMarginRevertIcon: true });
    this.editor.onDidChangeCursorPosition(() => this.emit('cursor'));
    this.editor.onDidChangeCursorSelection(() => this.emit('cursor'));
    this.editor.onDidFocusEditorText(() => this.emit('focus'));
    this.diffEditor.getModifiedEditor().onDidChangeCursorPosition(() => this.emit('cursor'));
    this.addEditorActions(this.editor);
    this.addEditorActions(this.diffEditor.getModifiedEditor());
    this.render();
    this.showActive();
  }

  themeName() {
    return document.body.classList.contains('theme-light') ? 'pi-light' : 'pi-dark';
  }

  applyConfig(cfg) {
    if (!this.monaco) return;
    this.monaco.editor.setTheme(this.themeName());
    const opts = { fontSize: cfg.editorFontSize || 14, minimap: { enabled: cfg.minimap !== false }, wordWrap: cfg.wordWrap || 'off' };
    this.editor.updateOptions(opts);
    this.diffEditor.updateOptions(opts);
  }

  addEditorActions(ed) {
    const m = this.monaco;
    ed.addAction({
      id: 'pi.addToChat', label: 'Pi: 将选区添加到聊天', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyL],
      contextMenuGroupId: '0_pi', contextMenuOrder: 1,
      run: () => this.addSelectionToChat(ed, false),
    });
    ed.addAction({
      id: 'pi.newChatWithSelection', label: 'Pi: 用选区新建聊天', keybindings: [m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.KeyL],
      contextMenuGroupId: '0_pi', contextMenuOrder: 2,
      run: () => this.addSelectionToChat(ed, true),
    });
    ed.addAction({
      id: 'pi.inlineEdit', label: 'Pi: 编辑选区（Ctrl+K）', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyK],
      contextMenuGroupId: '0_pi', contextMenuOrder: 3,
      run: () => this.inlineEdit(ed),
    });
    ed.addAction({
      id: 'pi.explain', label: 'Pi: 解释选中代码', contextMenuGroupId: '0_pi', contextMenuOrder: 4,
      run: () => this.quickAsk(ed, '解释这段代码的作用，以及值得注意的问题。'),
    });
    ed.addAction({
      id: 'pi.fix', label: 'Pi: 修复选中代码中的问题', contextMenuGroupId: '0_pi', contextMenuOrder: 5,
      run: () => this.quickAsk(ed, '找出并修复这段代码中的问题，直接修改文件。'),
    });
    ed.addAction({
      id: 'pi.save', label: '保存', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyS], run: () => this.save(),
    });
  }

  selectionContext(ed) {
    const model = ed.getModel();
    if (!model) return null;
    const tab = this.activeTab();
    const sel = ed.getSelection();
    let range = sel;
    let text = model.getValueInRange(sel);
    if (!text) {
      const line = sel.startLineNumber;
      range = new this.monaco.Range(line, 1, line, model.getLineMaxColumn(line));
      text = model.getLineContent(line);
    }
    return {
      path: tab && tab.path && !tab.path.startsWith('untitled:') ? tab.path : basename(tab ? tab.title || tab.path : 'untitled'),
      startLine: range.startLineNumber,
      endLine: range.endLineNumber,
      text,
      language: model.getLanguageId(),
    };
  }

  addSelectionToChat(ed, newChat) {
    const ctx = this.selectionContext(ed);
    if (ctx) this.wb.chat.addSelectionContext(ctx, { newChat });
  }

  quickAsk(ed, instruction) {
    const ctx = this.selectionContext(ed);
    if (ctx) this.wb.chat.sendWithContext(instruction, [ctx]);
  }

  async inlineEdit(ed) {
    const ctx = this.selectionContext(ed);
    if (!ctx) return;
    const instruction = await promptBox(`编辑 ${basename(ctx.path)}:${ctx.startLine}-${ctx.endLine}`, { placeholder: '描述要如何修改这段代码，例如：改成 async/await 并加上错误处理', okLabel: '发送给 Agent' });
    if (!instruction) return;
    this.wb.chat.sendWithContext(`请只修改 ${ctx.path} 第 ${ctx.startLine}-${ctx.endLine} 行的这段代码：${instruction}`, [ctx]);
  }

  // ------------------------------------------------------------------ documents
  docKey(p) {
    return normCase(p);
  }

  async loadDoc(p) {
    const key = this.docKey(p);
    if (this.docs.has(key)) return this.docs.get(key);
    const r = await api.invoke('fs:read', p);
    if (r.binary || r.tooLarge) return { path: p, binary: true, info: r };
    const uri = this.monaco.Uri.file(p);
    let model = this.monaco.editor.getModel(uri);
    if (model) model.setValue(r.text);
    else model = this.monaco.editor.createModel(r.text, languageOf(p), uri);
    const eol = r.eol === 'CRLF' ? this.monaco.editor.EndOfLineSequence.CRLF : this.monaco.editor.EndOfLineSequence.LF;
    model.pushEOL(eol);
    const doc = { path: p, model, savedVersion: model.getAlternativeVersionId(), mtime: r.mtime, bom: r.bom, eol: r.eol, viewState: null };
    model.onDidChangeContent(() => {
      this.updateDirty(doc);
      if (this.wb.config.autoSave) this.scheduleAutoSave(doc);
    });
    this.docs.set(key, doc);
    return doc;
  }

  isDirty(doc) {
    return !!doc && !!doc.model && doc.model.getAlternativeVersionId() !== doc.savedVersion;
  }

  updateDirty(doc) {
    const was = doc.dirty;
    doc.dirty = this.isDirty(doc);
    if (was !== doc.dirty) {
      this.renderTabs();
      this.emit('dirty');
    }
  }

  scheduleAutoSave(doc) {
    clearTimeout(doc.autoTimer);
    doc.autoTimer = setTimeout(() => { if (this.isDirty(doc) && !doc.path.startsWith('untitled:')) this.saveDoc(doc); }, 1000);
  }

  // ------------------------------------------------------------------ tabs
  findTab(pred) {
    return this.tabs.find(pred);
  }

  activeTab() {
    return this.tabs.find((t) => t.id === this.active) || null;
  }

  async openFile(p, opts = {}) {
    if (!p) return;
    if (!this.monaco) await loadMonaco();
    const ext = extname(p);
    let tab = this.findTab((t) => (t.kind === 'file' || t.kind === 'image' || t.kind === 'binary' || t.kind === 'untitled') && samePath(t.path, p));
    if (!tab) {
      const st = await api.invoke('fs:stat', p);
      if (!st.exists) {
        toast(`文件不存在: ${p}`, 'warning');
        return;
      }
      if (st.dir) {
        this.wb.explorer.reveal(p);
        return;
      }
      let kind = 'file';
      if (IMAGE_EXTS.has(ext) && ext !== '.svg') kind = 'image';
      tab = { id: `tab:${normCase(p)}`, kind, path: p, preview: !!opts.preview && !opts.pinned };
      if (kind === 'file') {
        try {
          const doc = await this.loadDoc(p);
          if (doc.binary) {
            tab.kind = 'binary';
            tab.info = doc.info;
          }
        } catch (err) {
          toast(`无法打开 ${basename(p)}: ${err.message}`, 'error');
          return;
        }
      }
      this.insertTab(tab);
    } else if (!opts.preview && tab.preview) {
      tab.preview = false;
    }
    this.activate(tab.id);
    if (opts.line && tab.kind === 'file') {
      setTimeout(() => {
        const ed = this.editor;
        ed.revealLineInCenter(opts.line);
        ed.setPosition({ lineNumber: opts.line, column: opts.column || 1 });
        if (opts.endLine) ed.setSelection(new this.monaco.Range(opts.line, 1, opts.endLine, 1e9));
        if (opts.highlight) {
          const deco = ed.createDecorationsCollection([{ range: new this.monaco.Range(opts.line, 1, opts.endLine || opts.line, 1), options: { isWholeLine: true, className: 'findMatch' } }]);
          setTimeout(() => deco.clear(), 1500);
        }
        ed.focus();
      }, 30);
    } else if (!opts.noFocus && tab.kind === 'file') {
      setTimeout(() => this.editor && this.editor.focus(), 30);
    }
    return tab;
  }

  insertTab(tab) {
    const previewIdx = this.tabs.findIndex((t) => t.preview);
    if (tab.preview && previewIdx !== -1) {
      const old = this.tabs[previewIdx];
      this.tabs.splice(previewIdx, 1, tab);
      this.disposeTab(old);
      return;
    }
    const activeIdx = this.tabs.findIndex((t) => t.id === this.active);
    this.tabs.splice(activeIdx === -1 ? this.tabs.length : activeIdx + 1, 0, tab);
  }

  newUntitled(text = '', language = 'plaintext') {
    if (!this.monaco) return;
    const n = ++untitledSeq;
    const p = `untitled:Untitled-${n}`;
    const model = this.monaco.editor.createModel(text, language, this.monaco.Uri.parse(`untitled:Untitled-${n}`));
    const doc = { path: p, model, savedVersion: text ? -1 : model.getAlternativeVersionId(), viewState: null };
    model.onDidChangeContent(() => this.updateDirty(doc));
    this.docs.set(this.docKey(p), doc);
    const tab = { id: `tab:${p}`, kind: 'untitled', path: p, title: `Untitled-${n}` };
    this.insertTab(tab);
    this.activate(tab.id);
    setTimeout(() => this.editor.focus(), 20);
    return tab;
  }

  /** Diff between `original` text and the current file content (live model). */
  async openDiff(p, original, { title, source = 'agent', onRevert, onKeep } = {}) {
    if (!this.monaco) await loadMonaco();
    const id = `diff:${source}:${normCase(p)}`;
    let tab = this.findTab((t) => t.id === id);
    if (tab) {
      tab.original = original;
      if (tab.originalModel) tab.originalModel.setValue(original === null ? '' : original);
    } else {
      let doc = null;
      try {
        const st = await api.invoke('fs:stat', p);
        if (st.exists) doc = await this.loadDoc(p);
      } catch { /* deleted file */ }
      if (doc && doc.binary) {
        toast('二进制文件无法显示差异', 'info');
        return;
      }
      const lang = languageOf(p);
      const originalModel = this.monaco.editor.createModel(original === null ? '' : original, lang);
      const modified = doc ? doc.model : this.monaco.editor.createModel('', lang);
      tab = { id, kind: 'diff', path: p, original, originalModel, modifiedModel: modified, ownsModified: !doc, title: title || `${basename(p)} (${source === 'git' ? '工作区' : source === 'staged' ? '暂存' : 'Agent 修改'})`, source, onRevert, onKeep };
      this.insertTab(tab);
    }
    this.activate(tab.id);
    return tab;
  }

  openCustom({ id, title, iconName, render, onClose }) {
    let tab = this.findTab((t) => t.id === id);
    if (!tab) {
      tab = { id, kind: 'custom', title, iconName, render, onClose, container: h('div.monaco-host') };
      this.insertTab(tab);
      render(tab.container, tab);
    }
    this.activate(tab.id);
    return tab;
  }

  activate(id) {
    const prev = this.activeTab();
    if (prev && prev.kind === 'file' && this.editor) {
      const doc = this.docs.get(this.docKey(prev.path));
      if (doc) doc.viewState = this.editor.saveViewState();
    }
    this.active = id;
    this.renderTabs();
    this.showActive();
    this.emit('active');
  }

  showActive() {
    const tab = this.activeTab();
    this.watermark.classList.toggle('hidden', !!tab);
    this.monacoHost.classList.add('hidden');
    this.diffHost.classList.add('hidden');
    this.otherHost.classList.add('hidden');
    this.diffBar.classList.add('hidden');
    clear(this.otherHost);
    this.renderCrumbs();
    if (!tab || !this.editor) return;
    if (tab.kind === 'file' || tab.kind === 'untitled') {
      const doc = this.docs.get(this.docKey(tab.path));
      if (!doc) return;
      this.monacoHost.classList.remove('hidden');
      if (tab.mdPreview) {
        this.monacoHost.classList.add('hidden');
        this.otherHost.classList.remove('hidden');
        const box = h('div.md-preview.md');
        renderMarkdown(box, doc.model.getValue());
        this.otherHost.appendChild(box);
        return;
      }
      if (this.editor.getModel() !== doc.model) {
        this.editor.setModel(doc.model);
        if (doc.viewState) this.editor.restoreViewState(doc.viewState);
      }
      this.editor.layout();
    } else if (tab.kind === 'diff') {
      this.diffHost.classList.remove('hidden');
      this.diffEditor.setModel({ original: tab.originalModel, modified: tab.modifiedModel });
      this.diffEditor.layout();
      this.renderDiffBar(tab);
    } else if (tab.kind === 'image') {
      this.otherHost.classList.remove('hidden');
      this.otherHost.appendChild(h('div.image-preview', h('img', { src: fileUrl(tab.path) + `&t=${Date.now()}`, alt: basename(tab.path) })));
    } else if (tab.kind === 'binary') {
      this.otherHost.classList.remove('hidden');
      const info = tab.info || {};
      this.otherHost.appendChild(h('div.binary-note', icon('file-binary'), h('div', info.tooLarge ? '文件过大，未在编辑器中打开。' : '该文件是二进制文件或使用了不支持的文本编码。'),
        h('button.btn.secondary', { onclick: () => api.invoke('shell:openPath', tab.path) }, '使用系统默认程序打开')));
    } else if (tab.kind === 'custom') {
      this.otherHost.classList.remove('hidden');
      this.otherHost.appendChild(tab.container);
    }
  }

  renderDiffBar(tab) {
    clear(this.diffBar);
    this.diffBar.classList.remove('hidden');
    const label = tab.source === 'agent' ? '本会话中 Agent 对此文件的修改（左：修改前，右：当前）' : tab.source === 'staged' ? 'HEAD ↔ 暂存区' : 'HEAD ↔ 工作区';
    append(this.diffBar, icon('diff'), h('span.grow.ellipsis', label));
    const ed = this.diffEditor;
    append(this.diffBar, 
      iconBtn('arrow-up', '上一处更改', () => ed.goToDiff && ed.goToDiff('previous')),
      iconBtn('arrow-down', '下一处更改', () => ed.goToDiff && ed.goToDiff('next')),
      iconBtn('split-horizontal', '切换并排/内联', () => {
        tab.inline = !tab.inline;
        ed.updateOptions({ renderSideBySide: !tab.inline });
      }),
      iconBtn('go-to-file', '打开文件', () => this.openFile(tab.path)));
    if (tab.onKeep) append(this.diffBar, h('button.btn.small', { onclick: () => { tab.onKeep(); this.closeTab(tab.id); } }, icon('check'), '保留'));
    if (tab.onRevert) append(this.diffBar, h('button.btn.small.secondary', { onclick: async () => { if (await tab.onRevert()) this.closeTab(tab.id); } }, icon('discard'), '撤销修改'));
  }

  renderCrumbs() {
    clear(this.crumbs);
    const tab = this.activeTab();
    if (!tab || !tab.path || tab.kind === 'custom' || tab.path.startsWith('untitled:')) {
      this.crumbs.classList.add('hidden');
      return;
    }
    this.crumbs.classList.remove('hidden');
    const rel = relative(this.wb.folder, tab.path);
    const parts = rel.split(/[\\/]/);
    parts.forEach((p, i) => {
      if (i) this.crumbs.appendChild(icon('chevron-right'));
      const last = i === parts.length - 1;
      this.crumbs.appendChild(h('span.crumb', { onclick: () => {
        if (!last) this.wb.explorer.reveal(this.wb.folder + '/' + parts.slice(0, i + 1).join('/'));
      } }, last ? fileIconEl(p, false) : null, last ? ' ' : '', p));
    });
    if (tab.kind === 'file' && languageOf(tab.path) === 'markdown') {
      this.crumbs.appendChild(h('span.spacer'));
      this.crumbs.appendChild(iconBtn(tab.mdPreview ? 'code' : 'open-preview', tab.mdPreview ? '显示源码' : '预览 Markdown', () => { tab.mdPreview = !tab.mdPreview; this.showActive(); }));
    }
  }

  renderTabs() {
    clear(this.tabsEl);
    for (const tab of this.tabs) {
      const doc = tab.path ? this.docs.get(this.docKey(tab.path)) : null;
      const dirty = (tab.kind === 'file' || tab.kind === 'untitled') && this.isDirty(doc);
      const title = tab.title || basename(tab.path);
      const dup = this.tabs.filter((t) => (t.title || basename(t.path || '')) === title).length > 1;
      const el = h(`div.tab${tab.id === this.active ? '.active' : ''}${tab.preview ? '.preview' : ''}${dirty ? '.dirty' : ''}`, {
        title: tab.path && !tab.path.startsWith('untitled:') ? tab.path : title,
        draggable: true,
        onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(tab.id); } },
        onclick: () => this.activate(tab.id),
        ondblclick: () => { tab.preview = false; this.renderTabs(); },
        oncontextmenu: (e) => { e.preventDefault(); this.tabMenu(tab, e.clientX, e.clientY); },
        ondragstart: (e) => { this.dragTab = tab.id; e.dataTransfer.effectAllowed = 'move'; if (tab.path) e.dataTransfer.setData('text/plain', tab.path); },
        ondragover: (e) => { if (this.dragTab) { e.preventDefault(); el.classList.add('drag-over'); } },
        ondragleave: () => el.classList.remove('drag-over'),
        ondrop: (e) => {
          el.classList.remove('drag-over');
          if (!this.dragTab || this.dragTab === tab.id) return;
          e.preventDefault();
          const from = this.tabs.findIndex((t) => t.id === this.dragTab);
          const [moved] = this.tabs.splice(from, 1);
          this.tabs.splice(this.tabs.findIndex((t) => t.id === tab.id), 0, moved);
          this.dragTab = null;
          this.renderTabs();
        },
        ondragend: () => { this.dragTab = null; },
      },
      tab.kind === 'diff' ? icon('diff') : tab.kind === 'custom' ? icon(tab.iconName || 'settings-gear') : fileIconEl(title, false),
      h('span.tab-label', title),
      dup && tab.path && !tab.path.startsWith('untitled:') ? h('span.tab-desc', basename(dirname(tab.path))) : null,
      h('button.icon-btn.tab-close', { title: '关闭', onclick: (e) => { e.stopPropagation(); this.closeTab(tab.id); } }, icon('close')));
      this.tabsEl.appendChild(el);
    }
    if (this.tabs.length) {
      this.tabsEl.appendChild(h('div.tabs-actions',
        this.activeTab() && this.activeTab().kind === 'file' ? iconBtn('comment-discussion', '将当前文件添加到聊天', () => this.wb.chat.addFileContext(this.activeTab().path)) : null,
        iconBtn('ellipsis', '更多', (e) => this.tabsMenu(e.clientX, e.clientY))));
    }
    const act = this.tabsEl.querySelector('.tab.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  tabMenu(tab, x, y) {
    const realPath = tab.path && !tab.path.startsWith('untitled:') ? tab.path : null;
    contextMenu(x, y, [
      { label: '关闭', keys: 'Ctrl+W', run: () => this.closeTab(tab.id) },
      { label: '关闭其他', run: () => this.closeOthers(tab.id) },
      { label: '关闭右侧', run: () => this.closeRight(tab.id) },
      { label: '关闭已保存', run: () => this.closeSaved() },
      { label: '全部关闭', run: () => this.closeAll() },
      { separator: true },
      realPath ? { label: '复制路径', run: () => api.invoke('clipboard:write', realPath) } : null,
      realPath ? { label: '复制相对路径', run: () => api.invoke('clipboard:write', relative(this.wb.folder, realPath)) } : null,
      realPath ? { label: '在资源管理器中显示', run: () => this.wb.explorer.reveal(realPath) } : null,
      realPath ? { label: '在系统文件管理器中显示', run: () => api.invoke('shell:reveal', realPath) } : null,
      realPath ? { separator: true } : null,
      realPath ? { label: '添加到聊天', icon: 'comment-discussion', run: () => this.wb.chat.addFileContext(realPath) } : null,
      tab.kind === 'file' && realPath ? { label: '与 Git HEAD 比较', icon: 'git-compare', run: () => this.wb.scm.openGitDiff(realPath) } : null,
      { label: tab.preview ? '固定标签' : '已固定', disabled: !tab.preview, run: () => { tab.preview = false; this.renderTabs(); } },
    ]);
  }

  tabsMenu(x, y) {
    contextMenu(x, y, [
      { label: '全部保存', run: () => this.saveAll() },
      { label: '全部关闭', run: () => this.closeAll() },
      { label: '关闭已保存', run: () => this.closeSaved() },
      { separator: true },
      { label: '自动换行', checked: this.wb.config.wordWrap === 'on', run: () => this.wb.patchConfig({ wordWrap: this.wb.config.wordWrap === 'on' ? 'off' : 'on' }) },
      { label: '显示小地图', checked: this.wb.config.minimap !== false, run: () => this.wb.patchConfig({ minimap: this.wb.config.minimap === false }) },
    ]);
  }

  async closeTab(id, { force = false } = {}) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return true;
    const tab = this.tabs[idx];
    if (!force && (tab.kind === 'file' || tab.kind === 'untitled')) {
      const doc = this.docs.get(this.docKey(tab.path));
      if (this.isDirty(doc)) {
        const r = await modal({
          title: `是否保存对 ${tab.title || basename(tab.path)} 的更改?`,
          body: h('div', '如果不保存，你的更改将丢失。'),
          buttons: [{ label: '取消', value: 'cancel' }, { label: '不保存', value: 'discard' }, { label: '保存', value: 'save', primary: true }],
        });
        if (!r || r === 'cancel') return false;
        if (r === 'save' && !(await this.saveDoc(doc))) return false;
        if (r === 'discard' && tab.kind === 'file') {
          doc.model.dispose();
          this.docs.delete(this.docKey(tab.path));
        }
      }
    }
    this.tabs.splice(idx, 1);
    this.disposeTab(tab);
    if (this.active === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.active = next ? next.id : null;
    }
    this.renderTabs();
    this.showActive();
    this.emit('active');
    return true;
  }

  disposeTab(tab) {
    if (tab.kind === 'diff') {
      if (this.diffEditor && this.diffEditor.getModel() && this.diffEditor.getModel().original === tab.originalModel) this.diffEditor.setModel(null);
      tab.originalModel.dispose();
      if (tab.ownsModified) tab.modifiedModel.dispose();
    } else if (tab.kind === 'untitled') {
      const doc = this.docs.get(this.docKey(tab.path));
      if (doc) { doc.model.dispose(); this.docs.delete(this.docKey(tab.path)); }
    } else if (tab.kind === 'custom' && tab.onClose) {
      tab.onClose();
    }
    // Release file models that no tab references any more (unless dirty).
    if (tab.kind === 'file') {
      const key = this.docKey(tab.path);
      const still = this.tabs.some((t) => (t.kind === 'file' || t.kind === 'diff') && this.docKey(t.path) === key);
      const doc = this.docs.get(key);
      if (!still && doc && !this.isDirty(doc)) {
        if (this.editor && this.editor.getModel() === doc.model) this.editor.setModel(null);
        doc.model.dispose();
        this.docs.delete(key);
      }
    }
  }

  async closeOthers(id) {
    for (const t of [...this.tabs]) if (t.id !== id && !(await this.closeTab(t.id))) return;
  }

  async closeRight(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    for (const t of this.tabs.slice(idx + 1)) if (!(await this.closeTab(t.id))) return;
  }

  async closeSaved() {
    for (const t of [...this.tabs]) {
      const doc = t.path ? this.docs.get(this.docKey(t.path)) : null;
      if (!this.isDirty(doc)) await this.closeTab(t.id);
    }
  }

  async closeAll() {
    for (const t of [...this.tabs]) if (!(await this.closeTab(t.id))) return false;
    return true;
  }

  dirtyDocs() {
    return [...this.docs.values()].filter((d) => this.isDirty(d));
  }

  // ------------------------------------------------------------------ save
  async save() {
    const tab = this.activeTab();
    if (!tab) return;
    if (tab.kind === 'diff') {
      const doc = this.docs.get(this.docKey(tab.path));
      if (doc) await this.saveDoc(doc);
      return;
    }
    if (tab.kind !== 'file' && tab.kind !== 'untitled') return;
    const doc = this.docs.get(this.docKey(tab.path));
    if (doc) await this.saveDoc(doc);
  }

  async saveAll() {
    for (const d of this.dirtyDocs()) if (!d.path.startsWith('untitled:')) await this.saveDoc(d);
  }

  async saveDoc(doc) {
    if (doc.path.startsWith('untitled:')) {
      const target = await api.invoke('dialog:save', { defaultPath: this.wb.folder ? `${this.wb.folder}/${basename(doc.path)}.txt` : undefined });
      if (!target) return false;
      await api.invoke('fs:write', target, doc.model.getValue(), {});
      const tab = this.findTab((t) => t.path === doc.path);
      const oldKey = this.docKey(doc.path);
      doc.model.dispose();
      this.docs.delete(oldKey);
      if (tab) {
        this.tabs.splice(this.tabs.indexOf(tab), 1);
        if (this.active === tab.id) this.active = null;
      }
      await this.openFile(target);
      return true;
    }
    try {
      const st = await api.invoke('fs:stat', doc.path);
      if (st.exists && doc.mtime && st.mtime > doc.mtime + 1 && !doc.conflictOk) {
        const ok = await confirm('文件已在磁盘上被修改', `${basename(doc.path)} 在磁盘上的内容比编辑器中的新（可能是 Agent 修改的）。\n是否用编辑器中的内容覆盖？`, { okLabel: '覆盖', danger: true });
        if (!ok) return false;
      }
      const r = await api.invoke('fs:write', doc.path, doc.model.getValue(), { bom: doc.bom });
      doc.mtime = r.mtime;
      doc.savedVersion = doc.model.getAlternativeVersionId();
      this.updateDirty(doc);
      this.renderTabs();
      this.emit('saved', doc.path);
      return true;
    } catch (err) {
      toast(`保存失败: ${err.message}`, 'error');
      return false;
    }
  }

  // ------------------------------------------------------------------ external changes
  async onFsChanged(paths) {
    for (const p of paths) {
      const doc = this.docs.get(this.docKey(p));
      if (!doc || !doc.model || doc.path.startsWith('untitled:')) continue;
      const st = await api.invoke('fs:stat', p);
      if (!st.exists) continue;
      if (doc.mtime && Math.abs(st.mtime - doc.mtime) < 1) continue;
      if (this.isDirty(doc)) {
        doc.conflict = true;
        continue;
      }
      try {
        const r = await api.invoke('fs:read', p);
        if (r.binary || r.tooLarge) continue;
        if (r.text !== doc.model.getValue()) {
          // Preserve undo stack by applying as an edit.
          doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: r.text }], () => null);
          doc.savedVersion = doc.model.getAlternativeVersionId();
        }
        doc.mtime = r.mtime;
        this.updateDirty(doc);
      } catch { /* ignore */ }
    }
    const tab = this.activeTab();
    if (tab && tab.kind === 'image' && paths.some((p) => samePath(p, tab.path))) this.showActive();
    if (tab && tab.mdPreview) this.showActive();
  }

  onPathRenamed(from, to) {
    for (const t of this.tabs) {
      if (t.path && samePath(t.path, from)) {
        t.path = to;
        t.id = `tab:${normCase(to)}`;
      }
    }
    this.renderTabs();
  }

  // ------------------------------------------------------------------ misc
  cursorInfo() {
    const tab = this.activeTab();
    if (!tab || !this.editor) return null;
    const ed = tab.kind === 'diff' ? this.diffEditor.getModifiedEditor() : this.editor;
    const model = ed.getModel();
    if (!model || (tab.kind !== 'file' && tab.kind !== 'untitled' && tab.kind !== 'diff')) return null;
    const pos = ed.getPosition();
    const sel = ed.getSelection();
    const selLen = sel ? model.getValueLengthInRange(sel) : 0;
    const doc = this.docs.get(this.docKey(tab.path));
    return {
      line: pos ? pos.lineNumber : 1,
      column: pos ? pos.column : 1,
      selected: selLen,
      language: model.getLanguageId(),
      eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
      bom: doc && doc.bom,
      tabSize: model.getOptions().tabSize,
      insertSpaces: model.getOptions().insertSpaces,
    };
  }

  setLanguage(lang) {
    const tab = this.activeTab();
    const doc = tab && this.docs.get(this.docKey(tab.path));
    if (doc) {
      this.monaco.editor.setModelLanguage(doc.model, lang);
      this.emit('cursor');
    }
  }

  setEol(eol) {
    const tab = this.activeTab();
    const doc = tab && this.docs.get(this.docKey(tab.path));
    if (doc) {
      doc.model.pushEOL(eol === 'CRLF' ? this.monaco.editor.EndOfLineSequence.CRLF : this.monaco.editor.EndOfLineSequence.LF);
      this.emit('cursor');
    }
  }

  async gotoLine() {
    const tab = this.activeTab();
    if (!tab || tab.kind !== 'file') return;
    const v = await promptBox('转到行', { placeholder: '行号[:列号]' });
    if (!v) return;
    const [l, c] = v.split(':').map((n) => parseInt(n, 10));
    if (l) this.openFile(tab.path, { line: l, column: c || 1 });
  }

  insertText(text) {
    const tab = this.activeTab();
    if (!tab || (tab.kind !== 'file' && tab.kind !== 'untitled')) {
      this.newUntitled(text);
      return;
    }
    const ed = this.editor;
    const sel = ed.getSelection();
    ed.executeEdits('pi-insert', [{ range: sel, text, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.focus();
  }

  layout() {
    if (this.editor) this.editor.layout();
    if (this.diffEditor) this.diffEditor.layout();
  }

  focus() {
    const tab = this.activeTab();
    if (tab && tab.kind === 'diff') this.diffEditor.getModifiedEditor().focus();
    else if (this.editor && tab) this.editor.focus();
  }

  serialize() {
    return {
      tabs: this.tabs.filter((t) => t.kind === 'file' || t.kind === 'image').map((t) => ({ path: t.path })),
      active: (this.activeTab() && this.activeTab().path) || null,
    };
  }

  async restore(state) {
    if (!state || !state.tabs) return;
    for (const t of state.tabs) {
      const st = await api.invoke('fs:stat', t.path).catch(() => ({ exists: false }));
      if (st.exists && !st.dir) await this.openFile(t.path, { pinned: true, noFocus: true });
    }
    if (state.active) {
      const tab = this.findTab((t) => samePath(t.path, state.active));
      if (tab) this.activate(tab.id);
    }
  }

  renderWatermark() {
    const mod = IS_MAC ? '⌘' : 'Ctrl';
    const row = (label, keys) => [h('div', label), h('div', keys.map((k) => h('kbd', k)).reduce((acc, k, i) => (i ? [...acc, ' ', k] : [k]), []))];
    return h('div.watermark',
      h('img.wm-logo', { src: 'assets/logo.svg', alt: '' }),
      h('div.wm-keys',
        row('打开聊天', [mod, 'I']),
        row('新建聊天', [mod, 'N']),
        row('转到文件', [mod, 'P']),
        row('命令面板', [mod, 'Shift', 'P']),
        row('选区添加到聊天', [mod, 'L']),
        row('切换终端', [mod, 'J'])));
  }

  render() {
    this.renderTabs();
  }
}
