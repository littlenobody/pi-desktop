// Workbench: Cursor-like layout (activity bar | sidebar | editor + panel | AI chat), title bar,
// status bar, command palette, keybindings and cross-component glue.
import { api, h, icon, iconBtn, clear, basename, relative, join, samePath, isInside, keyCombo, displayKey, IS_MAC, IS_WIN, debounce, fuzzy, resolveIn, append } from './util.js';
import { quickPick, toast, confirm, modal, prompt as promptBox, isModalOpen, contextMenu, closeContextMenu } from './ui.js';
import { EditorArea, loadMonaco } from './editor.js';
import { ChatPane } from './chat.js';
import { Sidebar } from './sidebar.js';
import { TerminalPanel } from './terminal.js';
import { openSettings } from './settings.js';
import { renderMarkdown } from './markdown.js';

const MENU_ORDER = [['file', '文件'], ['edit', '编辑'], ['view', '查看'], ['agent', 'Agent'], ['terminal', '终端'], ['help', '帮助']];

export class Workbench {
  constructor(info) {
    this.info = info;
    this.folder = info.folder;
    this.config = info.config;
    this.isMac = IS_MAC;
    this.isWin = IS_WIN;
    this.layout = { sidebar: 260, chat: 440, panel: 260, sidebarVisible: true, chatVisible: true, panelVisible: false, chatMaximized: false, view: 'explorer', ...(info.windowState && info.windowState.ui && info.windowState.ui.layout) };
    this.fileCache = null;
    this.saveState = debounce(() => this._saveState(), 600);
  }

  async mount(root) {
    this.root = root;
    this.titlebar = this.buildTitlebar();
    this.activitybar = new ActivityBar(this);
    this.sidebar = new Sidebar(this);
    this.explorer = this.sidebar.explorer;
    this.scm = this.sidebar.scm;
    this.editors = new EditorArea(this);
    this.terminal = new TerminalPanel(this);
    this.chat = new ChatPane(this);
    this.statusbar = new StatusBar(this);

    this.sashSidebar = h('div.sash.v');
    this.sashChat = h('div.sash.v');
    this.sashPanel = h('div.sash.h');
    this.center = h('div.center', this.editors.el, this.sashPanel, this.terminal.el);
    this.main = h('div.wb-main', this.activitybar.el, this.sidebar.el, this.sashSidebar, this.center, this.sashChat, this.chat.el);
    root.appendChild(h('div.workbench', this.titlebar, this.main, this.statusbar.el));
    this.bindSashes();
    this.applyLayout();
    this.bindGlobal();

    this.sidebar.show(this.layout.view || 'explorer');
    await this.explorer.init();
    this.scm.refresh();
    this.editors.on('active', () => { this.statusbar.render(); this.updateTitle(); this.saveState(); });
    this.editors.on('cursor', () => this.statusbar.renderCursor());
    this.editors.on('dirty', () => this.updateTitle());
    this.editors.on('saved', () => this.scm.refreshSoon());

    api.on('fs:changed', (items) => {
      this.fileCache = null;
      this.explorer.onFsChanged(items);
      this.editors.onFsChanged(items.map((i) => i.path));
      this.scm.refreshSoon();
    });
    api.on('menu:command', (id) => this.run(id));
    api.on('config:changed', (cfg) => this.onConfig(cfg));

    this.trustInfo = await api.invoke('pi:trust:status').catch(() => null);
    const ui = info(this);
    await this.editors.init().catch((err) => toast(`编辑器加载失败: ${err.message}`, 'error'));
    if (ui && ui.editors) this.editors.restore(ui.editors);
    const restored = ui && ui.chat ? await this.chat.restore(ui.chat) : false;
    if (!restored && this.info.pi.cli) await this.chat.newChat();
    else if (!this.info.pi.cli) this.chat.refresh();
    this.updateTitle();
    this.statusbar.render();
    if (!this.info.pi.cli) this.showMissingPi();
    window.addEventListener('beforeunload', () => { this._saveState(); });
  }

  // ------------------------------------------------------------------ layout
  applyLayout() {
    const L = this.layout;
    this.sidebar.el.style.width = `${L.sidebar}px`;
    this.sidebar.el.classList.toggle('hidden', !L.sidebarVisible);
    this.sashSidebar.classList.toggle('hidden', !L.sidebarVisible);
    this.chat.el.style.width = L.chatMaximized ? '' : `${L.chat}px`;
    this.chat.el.classList.toggle('maximized', !!L.chatMaximized);
    this.chat.el.classList.toggle('hidden', !L.chatVisible);
    this.sashChat.classList.toggle('hidden', !L.chatVisible || L.chatMaximized);
    this.center.classList.toggle('hidden', !!(L.chatMaximized && L.chatVisible));
    this.terminal.el.style.height = `${L.panel}px`;
    this.terminal.el.classList.toggle('hidden', !L.panelVisible);
    this.sashPanel.classList.toggle('hidden', !L.panelVisible);
    this.activitybar.render();
    this.statusbar && this.statusbar.render();
    requestAnimationFrame(() => { this.editors.layout(); this.terminal.fit(); });
    this.saveState();
  }

  bindSashes() {
    const drag = (sash, axis, onMove) => {
      sash.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const start = axis === 'x' ? e.clientX : e.clientY;
        sash.classList.add('dragging');
        document.body.classList.add(axis === 'x' ? 'resizing-v' : 'resizing-h');
        const move = (ev) => onMove((axis === 'x' ? ev.clientX : ev.clientY) - start);
        const up = () => {
          sash.classList.remove('dragging');
          document.body.classList.remove('resizing-v', 'resizing-h');
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          this.applyLayout();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    };
    let base = 0;
    this.sashSidebar.addEventListener('mousedown', () => { base = this.layout.sidebar; });
    drag(this.sashSidebar, 'x', (d) => { this.layout.sidebar = Math.max(170, Math.min(700, base + d)); this.sidebar.el.style.width = `${this.layout.sidebar}px`; this.editors.layout(); });
    this.sashChat.addEventListener('mousedown', () => { base = this.layout.chat; });
    drag(this.sashChat, 'x', (d) => { this.layout.chat = Math.max(300, Math.min(window.innerWidth - 360, base - d)); this.chat.el.style.width = `${this.layout.chat}px`; this.editors.layout(); });
    this.sashPanel.addEventListener('mousedown', () => { base = this.layout.panel; });
    drag(this.sashPanel, 'y', (d) => { this.layout.panel = Math.max(90, Math.min(window.innerHeight - 200, base - d)); this.terminal.el.style.height = `${this.layout.panel}px`; this.terminal.fit(); this.editors.layout(); });
    this.sashSidebar.addEventListener('dblclick', () => { this.layout.sidebar = 260; this.applyLayout(); });
    this.sashChat.addEventListener('dblclick', () => { this.layout.chat = 440; this.applyLayout(); });
  }

  showView(view) {
    if (this.layout.view === view && this.layout.sidebarVisible && view !== 'search') { /* keep */ }
    this.layout.view = view;
    this.layout.sidebarVisible = true;
    this.sidebar.show(view);
    this.applyLayout();
  }

  toggleView(view) {
    if (this.layout.view === view && this.layout.sidebarVisible) {
      this.layout.sidebarVisible = false;
      this.applyLayout();
    } else this.showView(view);
  }

  showChat() {
    if (!this.layout.chatVisible) {
      this.layout.chatVisible = true;
      this.applyLayout();
    }
  }

  toggleChat() {
    this.layout.chatVisible = !this.layout.chatVisible;
    this.applyLayout();
    if (this.layout.chatVisible) this.chat.focus();
  }

  focusChat() {
    this.showChat();
    this.chat.focus();
  }

  showPanel(visible, { autoCreate = true } = {}) {
    this.layout.panelVisible = visible;
    this.applyLayout();
    if (visible && autoCreate && !this.terminal.terms.length && !this.terminal.creating && this.terminal.tab === 'terminal') this.terminal.newTerminal();
  }

  togglePanel() {
    if (this.layout.panelVisible) {
      const focusedInPanel = this.terminal.el.contains(document.activeElement);
      if (!focusedInPanel && this.terminal.active) { this.terminal.focus(); return; }
      this.showPanel(false);
      this.editors.focus();
    } else {
      this.showPanel(true);
      setTimeout(() => this.terminal.focus(), 50);
    }
  }

  // ------------------------------------------------------------------ title bar
  buildTitlebar() {
    const menu = h('div.tb-menu', MENU_ORDER.map(([id, label]) => h('div.tb-menu-item', {
      onmousedown: (e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        api.invoke('menu:popup', id, r.left, r.bottom);
      },
    }, label)));
    this.titleCenter = h('div.command-center', { onclick: () => this.run('palette.files') }, icon('search'), h('span', this.folder ? basename(this.folder) : 'Pi Desktop'));
    return h('div.titlebar',
      h('img.tb-logo', { src: 'assets/logo.svg', alt: '' }),
      IS_MAC ? null : menu,
      h('div.tb-center', this.titleCenter),
      h('div.tb-right',
        iconBtn('layout-sidebar-left', '切换侧边栏 (Ctrl+B)', () => this.run('view.toggleSidebar')),
        iconBtn('layout-panel', '切换面板 (Ctrl+J)', () => this.run('view.togglePanel')),
        iconBtn('layout-sidebar-right', '切换 AI 面板 (Ctrl+Alt+B)', () => this.run('view.toggleChat')),
        iconBtn('settings-gear', '设置', () => this.openSettings())));
  }

  updateTitle() {
    const tab = this.editors && this.editors.activeTab();
    const dirty = this.editors && this.editors.dirtyDocs().length;
    const name = this.folder ? basename(this.folder) : 'Pi Desktop';
    const file = tab ? (tab.title || basename(tab.path || '')) : '';
    document.title = `${dirty ? '● ' : ''}${file ? file + ' - ' : ''}${name} - Pi Desktop`;
    api.invoke('window:title', document.title);
  }

  // ------------------------------------------------------------------ config
  async patchConfig(p) {
    this.config = await api.invoke('config:patch', p);
    return this.config;
  }

  onConfig(cfg) {
    const themeChanged = cfg.theme !== this.config.theme;
    this.config = cfg;
    applyAppearance(cfg);
    this.editors.applyConfig(cfg);
    if (themeChanged) this.terminal.applyTheme();
    this.chat.composer.renderBar();
  }

  // ------------------------------------------------------------------ helpers
  absPath(rel) {
    return resolveIn(this.folder, rel);
  }

  async fileIndex() {
    if (this.fileCache && Date.now() - this.fileCache.at < 30000) return this.fileCache.files;
    if (!this.fileCachePromise) {
      this.fileCachePromise = api.invoke('fs:files').then((r) => {
        this.fileCache = { files: r.files, at: Date.now() };
        this.fileCachePromise = null;
        return r.files;
      }).catch(() => { this.fileCachePromise = null; return []; });
    }
    return this.fileCachePromise;
  }

  async openPath(p, line) {
    if (!p) return;
    let target = p;
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(p);
    if (m && !(await api.invoke('fs:stat', p)).exists) {
      target = m[1];
      line = line || Number(m[2]);
    }
    target = resolveIn(this.folder, target);
    const st = await api.invoke('fs:stat', target);
    if (!st.exists) {
      // Try fuzzy match on file name
      const files = await this.fileIndex();
      const name = target.replace(/\\/g, '/').split('/').pop();
      const hit = files.find((f) => f === p || f.endsWith('/' + p.replace(/\\/g, '/'))) || files.find((f) => f.endsWith('/' + name) || f === name);
      if (hit) target = this.absPath(hit);
      else { toast(`找不到文件: ${p}`, 'warning'); return; }
    }
    if (st.dir) { this.explorer.reveal(target); return; }
    await this.editors.openFile(target, { line, highlight: !!line });
  }

  openSettings(section) {
    openSettings(this, section);
  }

  async openDoc(kind) {
    const p = await api.invoke('pi:paths');
    const file = kind === 'changelog' ? p.changelog : p.readme;
    if (!file) { toast('未找到 pi 安装目录', 'warning'); return; }
    const r = await api.invoke('fs:read', file).catch(() => null);
    if (!r || !r.text) { toast('无法读取文档', 'warning'); return; }
    this.editors.openCustom({
      id: `doc:${kind}`, title: kind === 'changelog' ? 'Pi 更新日志' : 'Pi README', iconName: 'book',
      render: (c) => { const box = h('div.md-preview.md'); renderMarkdown(box, r.text); c.appendChild(box); },
    });
  }

  // ------------------------------------------------------------------ trust / auth
  /** Returns true (--approve), false (--no-approve), undefined (let pi decide) or 'cancel'. */
  async resolveTrust() {
    const t = await api.invoke('pi:trust:status').catch(() => null);
    this.trustInfo = t;
    if (!t || !t.needsTrust) return undefined;
    if (t.saved !== null) return undefined;
    if (t.defaultProjectTrust !== 'ask') return undefined;
    if (this.trustAnswer !== undefined) return this.trustAnswer;
    const r = await modal({
      title: '信任此项目？', iconName: 'shield',
      body: h('div', { style: { maxWidth: '560px' } },
        h('p', `项目 ${this.folder} 包含 pi 项目资源（.pi/settings.json、扩展、技能、提示模板或 MCP 配置）。`),
        h('p.muted', '信任后 pi 会加载并执行这些资源（扩展以你的系统权限运行）。只信任你了解来源的项目。')),
      buttons: [{ label: '本次不信任', value: 'no' }, { label: '本次信任', value: 'once' }, { label: '始终信任', value: 'always', primary: true }],
    });
    if (!r) return 'cancel';
    if (r === 'always') { await api.invoke('pi:trust:set', null, true); this.trustAnswer = undefined; return undefined; }
    this.trustAnswer = r === 'once';
    return this.trustAnswer;
  }

  async trustDialog() {
    const t = await api.invoke('pi:trust:status');
    const r = await modal({
      title: '项目信任', iconName: 'shield',
      body: h('div', h('p', this.folder), h('p.muted', `当前保存的决定: ${t.saved === null ? '无' : t.saved ? '信任' : '不信任'}${t.savedPath && !samePath(t.savedPath, this.folder) ? `（继承自 ${t.savedPath}）` : ''}`), h('p.muted', `包含需要信任的资源: ${t.needsTrust ? '是' : '否'} · 全局默认: ${t.defaultProjectTrust}`)),
      buttons: [{ label: '清除决定', value: 'clear' }, { label: '不信任', value: 'no' }, { label: '信任', value: 'yes', primary: true }],
    });
    if (!r) return;
    await api.invoke('pi:trust:set', null, r === 'clear' ? null : r === 'yes');
    this.trustAnswer = undefined;
    toast('已保存。新建聊天或重启会话后生效。', 'info', { actions: [{ label: '重启当前会话', primary: true, run: () => this.chat.current && this.chat.current.restart() }] });
  }

  async loginDialog(providerArg) {
    const s = this.chat.current;
    let providers = [];
    if (s && s.status === 'ready') providers = [...new Set((await s.getModels(true).catch(() => [])).map((m) => m.provider))];
    const known = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'xai', 'groq', 'mistral', 'cerebras', 'zai', 'moonshotai', 'minimax', 'huggingface', 'fireworks', 'together', 'vercel-ai-gateway', 'github-copilot', 'nvidia', 'qwen-token-plan', 'kimi-coding', 'opencode', 'radius'];
    const all = [...new Set([...providers, ...known])];
    let provider = providerArg;
    if (!provider) {
      const pick = await quickPick({
        items: [{ label: 'OAuth / 订阅登录（在 Pi TUI 中运行 /login）', iconEl: icon('terminal'), value: '__tui__', alwaysShow: true }, ...all.map((p) => ({ label: p, iconEl: icon('key'), description: providers.includes(p) ? '已有可用模型' : '', value: p }))],
        placeholder: '选择要配置 API Key 的提供商（也可输入自定义 provider 名称）',
      });
      if (!pick) return;
      provider = pick.custom || pick;
    }
    if (provider === '__tui__') {
      await this.terminal.openPiTui([]);
      toast('在 Pi TUI 中输入 /login 完成登录，然后回到桌面端新建聊天或执行 /reload。', 'info', { timeout: 15000 });
      return;
    }
    const key = await promptBox(`${provider} API Key`, { password: true, message: '保存到 ~/.pi/agent/auth.json。以 ! 开头表示从命令输出读取（例如 !op read op://...）。' });
    if (!key) return;
    await api.invoke('pi:auth:set', provider, key.trim());
    toast(`已保存 ${provider} 的 API Key`, 'info', { actions: [{ label: '刷新模型', primary: true, run: () => this.chat.sessions.forEach((x) => { x.models = null; }) }] });
    for (const x of this.chat.sessions) x.models = null;
  }

  async logoutDialog() {
    const list = await api.invoke('pi:auth:list');
    if (!list.length) { toast('auth.json 中没有保存的凭据', 'info'); return; }
    const pick = await quickPick({ items: list.map((a) => ({ label: a.provider, description: a.type, value: a.provider })), placeholder: '选择要移除凭据的提供商' });
    if (!pick) return;
    await api.invoke('pi:auth:remove', pick);
    toast(`已移除 ${pick}`, 'info');
  }

  showMissingPi() {
    modal({
      title: '未找到 pi', iconName: 'warning',
      body: h('div', { style: { maxWidth: '560px', lineHeight: 1.7 } },
        h('p', 'Pi Desktop 需要已安装的 pi CLI（@earendil-works/pi-coding-agent）。'),
        h('pre', 'npm install -g @earendil-works/pi-coding-agent'),
        h('p.muted', '安装后点击“重新检测”。如果安装在非标准位置，可在设置 → 运行环境中指定路径。')),
      buttons: [{ label: '稍后', value: false }, { label: '在终端中安装', value: 'install' }, { label: '重新检测', value: 'detect', primary: true }],
    }).then(async (r) => {
      if (r === 'install') this.terminal.sendText('npm install -g @earendil-works/pi-coding-agent\r');
      if (r === 'detect') {
        const d = await api.invoke('app:redetect');
        if (d.cli) { this.info.pi = { cli: d.cli, version: d.version }; toast(`已找到 pi ${d.version}`, 'info'); this.chat.newChat(); }
        else this.showMissingPi();
      }
    });
  }

  showHotkeys() {
    const rows = COMMANDS.filter((c) => c.keys).map((c) => h('tr', h('td', c.label), h('td', h('kbd', displayKey(c.keys)))));
    const chatKeys = [
      ['发送（Agent 运行中为插入引导 steer）', 'Enter'], ['完成后执行（follow-up）', 'Alt+Enter'], ['换行', 'Shift+Enter'], ['中止', 'Esc'], ['取回排队消息', 'Alt+↑'],
      ['循环思考强度', 'Shift+Tab'], ['选择模型', 'Ctrl+L（聊天输入框内）'], ['切换 Agent/Ask', 'Ctrl+.'], ['历史输入', '↑ / ↓'], ['添加上下文', '@'], ['命令', '/'], ['运行命令（加入上下文 / 不加入）', '!cmd / !!cmd'],
    ].map(([a, b]) => h('tr', h('td', a), h('td', h('kbd', b))));
    modal({ title: '键盘快捷键', wide: true, body: h('div', h('h4', '工作台'), h('table.kv-table', rows), h('h4', '聊天输入框'), h('table.kv-table', chatKeys)) });
  }

  // ------------------------------------------------------------------ commands
  async run(id) {
    const cmd = COMMANDS.find((c) => c.id === id);
    if (!cmd) { console.warn('unknown command', id); return; }
    try {
      await cmd.run(this);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async commandPalette(initial = '>') {
    const items = COMMANDS.filter((c) => !c.hidden).map((c) => ({ label: c.label, description: c.category || '', keys: c.keys ? displayKey(c.keys) : '', value: c.id }));
    const s = this.chat.current;
    if (s && s.commands.length) {
      for (const c of s.commands) items.push({ label: `/${c.name}`, description: c.description || c.source, value: `slash:${c.name}` });
    }
    const id = await quickPick({ items, placeholder: '输入命令名称', value: initial === '>' ? '' : initial, matchOn: ['label', 'description'] });
    if (!id) return;
    if (typeof id === 'string' && id.startsWith('slash:')) {
      this.chat.composer.setText(`/${id.slice(6)} `);
      this.focusChat();
      return;
    }
    this.run(id);
  }

  async quickOpen() {
    if (!this.folder) return this.openFolder();
    const files = await this.fileIndex();
    const open = this.editors.tabs.filter((t) => t.kind === 'file').map((t) => relative(this.folder, t.path));
    const items = (q) => {
      if (q.startsWith('>')) return COMMANDS.filter((c) => !c.hidden).map((c) => ({ label: c.label, description: c.category || '', keys: c.keys ? displayKey(c.keys) : '', value: { cmd: c.id } }));
      if (q.startsWith(':')) return [{ label: `转到第 ${q.slice(1) || '?'} 行`, value: { line: q.slice(1) }, alwaysShow: true }];
      if (q.startsWith('#') || q.startsWith('@')) return [{ label: `在文件中搜索 “${q.slice(1)}”`, value: { search: q.slice(1) }, alwaysShow: true }];
      if (!q) return open.length ? [{ separator: true, label: '最近打开' }, ...open.map((f) => ({ label: basename(f), description: f, value: { file: f } }))] : files.slice(0, 50).map((f) => ({ label: basename(f), description: f, value: { file: f } }));
      const scored = [];
      for (const f of files) {
        const m = fuzzy(q, f);
        if (m) scored.push({ f, score: m.score + (open.includes(f) ? 5 : 0), pos: m.positions });
      }
      scored.sort((a, b) => b.score - a.score);
      const out = scored.slice(0, 80).map((x) => {
        const base = basename(x.f);
        const off = x.f.length - base.length;
        return { label: base, description: x.f, _pos: x.pos.filter((p) => p >= off).map((p) => p - off), value: { file: x.f } };
      });
      out.dynamic = true;
      return out;
    };
    const pick = await quickPick({ items, placeholder: '按名称搜索文件（> 命令，: 行号，# 搜索文本）', matchOn: ['label', 'description'] });
    if (!pick) return;
    if (pick.cmd) this.run(pick.cmd);
    else if (pick.line) this.editors.gotoLine();
    else if (pick.search !== undefined) { this.showView('search'); this.sidebar.search.focus(pick.search); }
    else if (pick.file) this.editors.openFile(this.absPath(pick.file), { pinned: true });
  }

  async openFolder(newWindow = false) {
    await api.invoke('window:open', null, { newWindow });
  }

  async recentPicker() {
    const recent = (await api.invoke('app:info')).recent;
    const pick = await quickPick({ items: recent.map((f) => ({ label: basename(f), description: f, iconEl: icon('folder'), value: f, buttons: [{ icon: 'close', title: '从列表移除', run: (it) => { api.invoke('recent:remove', it.value); } }] })), placeholder: '打开最近的文件夹（Ctrl+Enter 在新窗口打开）' });
    if (pick) await api.invoke('window:open', pick, {});
  }

  // ------------------------------------------------------------------ global keys
  bindGlobal() {
    window.addEventListener('keydown', (e) => {
      if (isModalOpen()) return;
      const combo = keyCombo(e);
      const inMonaco = e.target.closest && e.target.closest('.monaco-editor');
      const inTerm = e.target.closest && e.target.closest('.xterm');
      const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) && !inMonaco && !inTerm;
      for (const c of COMMANDS) {
        if (!c.keys || (c.keys !== combo && !(c.altKeys || []).includes(combo))) continue;
        if (c.when && !c.when(this, { inMonaco, inTerm, inInput })) continue;
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        this.run(c.id);
        return;
      }
    }, true);
    window.addEventListener('resize', debounce(() => { this.editors.layout(); this.terminal.fit(); }, 50));
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const files = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
      for (const f of files) {
        api.invoke('fs:stat', f).then((st) => {
          if (st.dir) api.invoke('window:open', f, {});
          else this.editors.openFile(f, { pinned: true });
        });
      }
    });
  }

  _saveState() {
    if (!this.folder || !this.editors) return;
    api.invoke('state:save', { layout: this.layout, editors: this.editors.serialize(), chat: this.chat.serialize() }).catch(() => {});
  }
}

function info(wb) {
  return wb.info.windowState && wb.info.windowState.ui;
}

export function applyAppearance(cfg) {
  document.body.classList.toggle('theme-light', cfg.theme === 'light');
  document.body.classList.toggle('theme-dark', cfg.theme !== 'light');
  document.documentElement.style.setProperty('--ui-size', `${cfg.uiFontSize || 13}px`);
  document.documentElement.style.setProperty('--chat-size', `${cfg.chatFontSize || 13}px`);
}

// =============================================================================================
// Activity bar
// =============================================================================================
class ActivityBar {
  constructor(wb) {
    this.wb = wb;
    this.el = h('div.activitybar');
  }

  render() {
    clear(this.el);
    const L = this.wb.layout;
    const scmCount = this.wb.scm ? this.wb.scm.count() : 0;
    const chatRunning = this.wb.chat ? this.wb.chat.sessions.filter((s) => s.running).length : 0;
    const item = (view, ic, title, badge) => h(`div.ab-item${L.sidebarVisible && L.view === view ? '.active' : ''}`, { title, onclick: () => this.wb.toggleView(view) }, icon(ic), badge ? h('span.badge', String(badge)) : null);
    append(this.el, 
      item('explorer', 'files', '资源管理器 (Ctrl+Shift+E)'),
      item('search', 'search', '搜索 (Ctrl+Shift+F)'),
      item('scm', 'source-control', '源代码管理 (Ctrl+Shift+G)', scmCount > 99 ? '99+' : scmCount || null),
      item('history', 'history', 'Agent 会话历史', null),
      h(`div.ab-item${L.chatVisible ? '.active' : ''}`, { title: 'AI 聊天 (Ctrl+I)', onclick: () => this.wb.toggleChat() }, icon('comment-discussion'), chatRunning ? h('span.badge', String(chatRunning)) : null),
      h('div.ab-bottom',
        h('div.ab-item', { title: '终端 (Ctrl+J)', onclick: () => this.wb.togglePanel() }, icon('terminal')),
        h('div.ab-item', { title: '设置', onclick: (e) => contextMenu(e.clientX + 10, e.clientY - 150, [
          { label: '设置', icon: 'settings-gear', keys: 'Ctrl+,', run: () => this.wb.openSettings() },
          { label: '命令面板', icon: 'symbol-event', keys: 'Ctrl+Shift+P', run: () => this.wb.commandPalette() },
          { label: '键盘快捷键', icon: 'keyboard', run: () => this.wb.showHotkeys() },
          { label: '切换主题', icon: 'color-mode', run: () => this.wb.run('view.toggleTheme') },
          { separator: true },
          { label: '提供商与登录', icon: 'key', run: () => this.wb.openSettings('auth') },
        ]) }, icon('settings-gear'))));
  }
}

// =============================================================================================
// Status bar
// =============================================================================================
class StatusBar {
  constructor(wb) {
    this.wb = wb;
    this.el = h('div.statusbar');
    this.cursorEl = h('span.sb-right');
  }

  render() {
    clear(this.el);
    const wb = this.wb;
    const st = wb.scm && wb.scm.status;
    const s = wb.chat && wb.chat.current;
    const item = (content, title, onclick) => h(`span.sb-item${onclick ? '.clickable' : ''}`, { title, onclick }, content);
    if (st && st.repo) {
      this.el.appendChild(item([icon('git-branch'), st.branch || '(detached)', st.ahead || st.behind ? ` ↑${st.ahead} ↓${st.behind}` : ''], '切换分支', () => wb.scm.branchPicker()));
      this.el.appendChild(item([icon('sync')], '同步', () => wb.scm.sync()));
    }
    if (st && st.repo && st.files.length) this.el.appendChild(item([icon('diff-modified'), String(st.files.length)], '更改', () => wb.showView('scm')));
    if (s) {
      const model = s.state.model;
      this.el.appendChild(item([icon('sparkle'), model ? (model.name || model.id) : '无模型', s.state.thinkingLevel && model && model.reasoning ? ` · ${s.state.thinkingLevel}` : ''], '选择模型', () => wb.chat.modelPicker()));
      const cu = s.contextUsage;
      if (cu && cu.contextWindow) {
        const pct = cu.percent === null || cu.percent === undefined ? '?' : `${cu.percent.toFixed(1)}%`;
        this.el.appendChild(item([icon('dashboard'), `${pct} / ${fmtK(cu.contextWindow)}`], '上下文用量（点击压缩）', () => wb.chat.runCommand('/compact')));
      }
      if (s.stats && (s.stats.cost || (s.stats.tokens && s.stats.tokens.total))) {
        const tk = s.stats.tokens || {};
        this.el.appendChild(item([`↑${fmtK(tk.input + (tk.cacheRead || 0))} ↓${fmtK(tk.output)}`, s.stats.cost ? ` $${s.stats.cost.toFixed(3)}` : ''], '本会话累计用量', () => wb.chat.runCommand('/session')));
      }
      if (s.running) this.el.appendChild(item([icon('loading', 'spin'), '运行中'], '中止 (Esc)', () => wb.chat.stop()));
    }
    const running = wb.chat ? wb.chat.sessions.filter((x) => x.running).length : 0;
    if (running > 1) this.el.appendChild(item([icon('pulse'), `${running} 个会话运行中`], ''));
    this.el.appendChild(this.cursorEl);
    this.renderCursor();
  }

  renderCursor() {
    clear(this.cursorEl);
    const c = this.wb.editors && this.wb.editors.cursorInfo();
    if (!c) return;
    const item = (text, title, onclick) => h('span.sb-item.clickable', { title, onclick }, text);
    append(this.cursorEl, 
      item(`行 ${c.line}，列 ${c.column}${c.selected ? `（已选择 ${c.selected}）` : ''}`, '转到行', () => this.wb.editors.gotoLine()),
      item(c.insertSpaces ? `空格: ${c.tabSize}` : `制表符: ${c.tabSize}`, '缩进'),
      item(c.bom ? 'UTF-8 with BOM' : 'UTF-8', '编码'),
      item(c.eol, '切换行尾序列', () => this.wb.editors.setEol(c.eol === 'LF' ? 'CRLF' : 'LF')),
      item(c.language, '选择语言模式', async () => {
        const langs = this.wb.editors.monaco.languages.getLanguages().map((l) => ({ label: (l.aliases && l.aliases[0]) || l.id, description: l.id, value: l.id }));
        const pick = await quickPick({ items: langs, placeholder: '选择语言模式' });
        if (pick) this.wb.editors.setLanguage(pick);
      }));
  }
}

function fmtK(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// =============================================================================================
// Commands & keybindings
// =============================================================================================
const notInTerm = (wb, ctx) => !ctx.inTerm;
const COMMANDS = [
  // chat
  { id: 'chat.focus', label: '聚焦 AI 聊天', category: 'Agent', keys: 'mod+i', run: (wb) => wb.focusChat() },
  { id: 'chat.new', label: '新建聊天', category: 'Agent', keys: 'mod+n', run: (wb) => wb.chat.newChat().then(() => wb.focusChat()) },
  { id: 'chat.history', label: '打开会话历史…', category: 'Agent', keys: 'mod+alt+h', run: (wb) => wb.chat.historyPicker() },
  { id: 'chat.import', label: '导入会话 (JSONL)…', category: 'Agent', run: (wb) => wb.chat.runCommand('/import') },
  { id: 'chat.model', label: '选择模型…', category: 'Agent', keys: 'mod+shift+m', run: (wb) => wb.chat.modelPicker() },
  { id: 'chat.thinking', label: '循环思考强度', category: 'Agent', run: (wb) => wb.chat.cycleThinking() },
  { id: 'chat.mode', label: '切换 Agent / Ask 模式', category: 'Agent', run: (wb) => wb.chat.toggleMode() },
  { id: 'chat.tree', label: '会话树 (/tree)', category: 'Agent', run: (wb) => wb.chat.runCommand('/tree') },
  { id: 'chat.fork', label: '分叉会话 (/fork)', category: 'Agent', run: (wb) => wb.chat.runCommand('/fork') },
  { id: 'chat.clone', label: '克隆会话 (/clone)', category: 'Agent', run: (wb) => wb.chat.runCommand('/clone') },
  { id: 'chat.compact', label: '压缩上下文 (/compact)', category: 'Agent', run: (wb) => wb.chat.runCommand('/compact') },
  { id: 'chat.session', label: '会话信息 (/session)', category: 'Agent', run: (wb) => wb.chat.runCommand('/session') },
  { id: 'chat.export', label: '导出会话 (/export)', category: 'Agent', run: (wb) => wb.chat.runCommand('/export') },
  { id: 'chat.share', label: '分享会话 (/share)', category: 'Agent', run: (wb) => wb.chat.runCommand('/share') },
  { id: 'chat.copy', label: '复制最后的回复 (/copy)', category: 'Agent', run: (wb) => wb.chat.runCommand('/copy') },
  { id: 'chat.rename', label: '重命名会话 (/name)', category: 'Agent', run: (wb) => wb.chat.runCommand('/name') },
  { id: 'chat.reload', label: '重新加载扩展/技能/模板 (/reload)', category: 'Agent', run: (wb) => wb.chat.runCommand('/reload') },
  { id: 'chat.tools', label: '管理工具…', category: 'Agent', run: (wb) => wb.chat.toolsDialog() },
  { id: 'chat.systemPrompt', label: '查看系统提示词', category: 'Agent', run: (wb) => wb.chat.runCommand('/system-prompt') },
  { id: 'chat.stop', label: '中止 Agent', category: 'Agent', keys: 'mod+shift+backspace', run: (wb) => wb.chat.stop() },
  { id: 'chat.toggleTools', label: '展开/折叠工具输出', category: 'Agent', keys: 'mod+o', when: (wb) => wb.chat.el.contains(document.activeElement), run: (wb) => wb.chat.toggleExpandTools() },
  { id: 'chat.close', label: '关闭当前聊天', category: 'Agent', run: (wb) => wb.chat.current && wb.chat.closeChat(wb.chat.current) },
  { id: 'chat.next', label: '下一个聊天', category: 'Agent', keys: 'mod+alt+]', run: (wb) => cycleChat(wb, 1) },
  { id: 'chat.prev', label: '上一个聊天', category: 'Agent', keys: 'mod+alt+[', run: (wb) => cycleChat(wb, -1) },
  { id: 'chat.revertAll', label: '撤销 Agent 的全部文件修改', category: 'Agent', run: (wb) => wb.chat.current && wb.chat.revertAll(wb.chat.current) },
  { id: 'auth.login', label: '登录提供商 / 配置 API Key (/login)', category: 'Agent', run: (wb) => wb.loginDialog() },
  { id: 'auth.logout', label: '移除提供商凭据 (/logout)', category: 'Agent', run: (wb) => wb.logoutDialog() },
  { id: 'pi.trust', label: '项目信任 (/trust)', category: 'Agent', run: (wb) => wb.trustDialog() },
  { id: 'pi.tui', label: '在终端中运行 Pi TUI', category: 'Agent', run: (wb) => wb.chat.openInTui(wb.chat.current) },
  // palette / navigation
  { id: 'palette.commands', label: '显示所有命令', category: '视图', keys: 'mod+shift+p', altKeys: ['f1'], run: (wb) => wb.commandPalette() },
  { id: 'palette.files', label: '转到文件…', category: '视图', keys: 'mod+p', altKeys: ['mod+e'], run: (wb) => wb.quickOpen() },
  { id: 'editor.gotoLine', label: '转到行…', category: '编辑器', keys: 'mod+g', run: (wb) => wb.editors.gotoLine() },
  // files
  { id: 'folder.open', label: '打开文件夹…', category: '文件', keys: 'mod+o', run: (wb) => wb.openFolder() },
  { id: 'folder.openNewWindow', label: '在新窗口中打开文件夹…', category: '文件', run: (wb) => wb.openFolder(true) },
  { id: 'folder.recent', label: '打开最近的文件夹…', category: '文件', keys: 'mod+r', run: (wb) => wb.recentPicker() },
  { id: 'folder.close', label: '关闭文件夹', category: '文件', run: async (wb) => { if (await wb.editors.closeAll()) { await wb.chat.disposeAll(); api.invoke('window:close-folder'); } } },
  { id: 'window.new', label: '新建窗口', category: '文件', keys: 'mod+shift+n', run: () => api.invoke('window:new') },
  { id: 'file.open', label: '打开文件…', category: '文件', run: async (wb) => { const f = await api.invoke('dialog:open', { properties: ['openFile', 'multiSelections'], defaultPath: wb.folder || undefined }); if (f) for (const p of f) wb.editors.openFile(p, { pinned: true }); } },
  { id: 'file.newUntitled', label: '新建无标题文件', category: '文件', keys: 'mod+alt+n', run: (wb) => wb.editors.newUntitled() },
  { id: 'file.save', label: '保存', category: '文件', keys: 'mod+s', run: (wb) => wb.editors.save() },
  { id: 'file.saveAll', label: '全部保存', category: '文件', keys: 'mod+alt+s', run: (wb) => wb.editors.saveAll() },
  { id: 'editor.close', label: '关闭编辑器', category: '文件', keys: 'mod+w', when: notInTerm, run: (wb) => { const t = wb.editors.activeTab(); if (t) wb.editors.closeTab(t.id); } },
  { id: 'editor.closeAll', label: '关闭所有编辑器', category: '文件', run: (wb) => wb.editors.closeAll() },
  { id: 'editor.nextTab', label: '下一个编辑器', category: '编辑器', keys: 'mod+tab', altKeys: ['mod+pagedown'], run: (wb) => cycleTab(wb, 1) },
  { id: 'editor.prevTab', label: '上一个编辑器', category: '编辑器', keys: 'mod+shift+tab', altKeys: ['mod+pageup'], run: (wb) => cycleTab(wb, -1) },
  { id: 'editor.find', label: '查找', category: '编辑器', hidden: true, run: (wb) => wb.editors.editor && (wb.editors.editor.focus(), wb.editors.editor.getAction('actions.find').run()) },
  { id: 'editor.replace', label: '替换', category: '编辑器', hidden: true, run: (wb) => wb.editors.editor && (wb.editors.editor.focus(), wb.editors.editor.getAction('editor.action.startFindReplaceAction').run()) },
  { id: 'editor.addToChat', label: '将当前文件添加到聊天', category: 'Agent', run: (wb) => { const t = wb.editors.activeTab(); if (t && t.path) wb.chat.addFileContext(t.path); } },
  // views
  { id: 'view.explorer', label: '显示资源管理器', category: '视图', keys: 'mod+shift+e', run: (wb) => wb.toggleView('explorer') },
  { id: 'view.search', label: '在文件中搜索', category: '视图', keys: 'mod+shift+f', run: (wb) => { wb.showView('search'); const sel = wb.editors.editor && wb.editors.editor.getModel() ? wb.editors.editor.getModel().getValueInRange(wb.editors.editor.getSelection()) : ''; wb.sidebar.search.focus(sel && !sel.includes('\n') ? sel : ''); } },
  { id: 'view.scm', label: '显示源代码管理', category: '视图', keys: 'mod+shift+g', run: (wb) => wb.toggleView('scm') },
  { id: 'view.history', label: '显示 Agent 会话历史', category: '视图', run: (wb) => wb.toggleView('history') },
  { id: 'view.toggleSidebar', label: '切换侧边栏', category: '视图', keys: 'mod+b', run: (wb) => { wb.layout.sidebarVisible = !wb.layout.sidebarVisible; wb.applyLayout(); } },
  { id: 'view.toggleChat', label: '切换 AI 面板', category: '视图', keys: 'mod+alt+b', run: (wb) => wb.toggleChat() },
  { id: 'view.maximizeChat', label: '最大化/还原 AI 面板', category: '视图', keys: 'mod+alt+m', run: (wb) => { wb.layout.chatMaximized = !wb.layout.chatMaximized; wb.layout.chatVisible = true; wb.applyLayout(); } },
  { id: 'view.togglePanel', label: '切换终端面板', category: '视图', keys: 'mod+j', altKeys: ['mod+`'], run: (wb) => wb.togglePanel() },
  { id: 'view.toggleTheme', label: '切换深色/浅色主题', category: '视图', run: (wb) => wb.patchConfig({ theme: wb.config.theme === 'light' ? 'dark' : 'light' }) },
  { id: 'view.zoomIn', label: '放大', category: '视图', keys: 'mod+=', run: () => api.invoke('window:zoom', 0.5) },
  { id: 'view.zoomOut', label: '缩小', category: '视图', keys: 'mod+-', run: () => api.invoke('window:zoom', -0.5) },
  { id: 'view.zoomReset', label: '重置缩放', category: '视图', keys: 'mod+0', run: () => api.invoke('window:zoom', 0) },
  { id: 'view.devtools', label: '切换开发者工具', category: '视图', keys: 'mod+shift+i', run: () => api.invoke('devtools') },
  { id: 'view.reload', label: '重新加载窗口', category: '视图', run: () => location.reload() },
  // terminal
  { id: 'terminal.new', label: '新建终端', category: '终端', keys: 'mod+shift+`', run: (wb) => wb.terminal.newTerminal() },
  { id: 'terminal.output', label: '显示 pi 进程日志', category: '终端', run: (wb) => wb.terminal.showOutput(wb.chat.current) },
  // scm
  { id: 'git.commit', label: 'Git: 提交', category: 'Git', run: (wb) => { wb.showView('scm'); setTimeout(() => wb.scm.msg.focus(), 50); } },
  { id: 'git.branch', label: 'Git: 切换分支', category: 'Git', run: (wb) => wb.scm.branchPicker() },
  { id: 'git.sync', label: 'Git: 同步', category: 'Git', run: (wb) => wb.scm.sync() },
  // settings / help
  { id: 'settings.open', label: '打开设置', category: '首选项', keys: 'mod+,', run: (wb) => wb.openSettings() },
  { id: 'settings.pi', label: '打开 Pi 设置', category: '首选项', run: (wb) => wb.openSettings('settings') },
  { id: 'settings.auth', label: '提供商与登录', category: '首选项', run: (wb) => wb.openSettings('auth') },
  { id: 'settings.models', label: '模型', category: '首选项', run: (wb) => wb.openSettings('models') },
  { id: 'settings.files', label: '编辑 Pi 配置文件', category: '首选项', run: (wb) => wb.openSettings('files') },
  { id: 'help.hotkeys', label: '键盘快捷键', category: '帮助', run: (wb) => wb.showHotkeys() },
  { id: 'help.readme', label: 'Pi 文档 (README)', category: '帮助', run: (wb) => wb.openDoc('readme') },
  { id: 'help.changelog', label: 'Pi 更新日志', category: '帮助', run: (wb) => wb.openDoc('changelog') },
  { id: 'help.about', label: '关于', category: '帮助', run: (wb) => wb.openSettings('about') },
];

function cycleTab(wb, d) {
  const tabs = wb.editors.tabs;
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.id === wb.editors.active);
  wb.editors.activate(tabs[(i + d + tabs.length) % tabs.length].id);
}

function cycleChat(wb, d) {
  const list = wb.chat.sessions;
  if (!list.length) return;
  const i = list.indexOf(wb.chat.current);
  wb.chat.activate(list[(i + d + list.length) % list.length]);
}

export { COMMANDS, loadMonaco, join, isInside, confirm };
