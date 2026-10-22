// Bottom panel: integrated terminals (xterm.js + node-pty) and an output view for pi process logs.
import { api, h, icon, iconBtn, clear, Emitter, append } from './util.js';
import { contextMenu, toast } from './ui.js';

const THEMES = {
  dark: { background: '#181818', foreground: '#cccccc', cursor: '#aeafad', selectionBackground: '#264f78', black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5' },
  light: { background: '#f8f8f8', foreground: '#3b3b3b', cursor: '#000000', selectionBackground: '#add6ff', black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5' },
};

export class TerminalPanel extends Emitter {
  constructor(wb) {
    super();
    this.wb = wb;
    this.terms = [];
    this.active = null;
    this.tab = 'terminal'; // terminal | output
    this.outputSession = null;
    this.headEl = h('div.panel-head');
    this.host = h('div.term-host');
    this.listEl = h('div.term-list');
    this.output = h('div.output-view.hidden');
    this.bodyEl = h('div.panel-body', this.host, this.output, this.listEl);
    this.el = h('div.panel', this.headEl, this.bodyEl);
    api.on('term:data', ({ id, data }) => {
      const t = this.terms.find((x) => x.id === id);
      if (t) t.xterm.write(data);
    });
    api.on('term:exit', ({ id, code }) => {
      const t = this.terms.find((x) => x.id === id);
      if (!t) return;
      t.exited = true;
      t.xterm.write(`\r\n\x1b[90m[进程已退出，代码 ${code}]\x1b[0m\r\n`);
      this.renderList();
    });
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this.host);
    this.render();
  }

  theme() {
    return document.body.classList.contains('theme-light') ? THEMES.light : THEMES.dark;
  }

  applyTheme() {
    for (const t of this.terms) t.xterm.options.theme = this.theme();
  }

  async newTerminal({ cwd, shellId, command, args, title } = {}) {
    this.creating = true;
    try {
      return await this._newTerminal({ cwd, shellId, command, args, title });
    } finally {
      this.creating = false;
    }
  }

  async _newTerminal({ cwd, shellId, command, args, title }) {
    this.tab = 'terminal';
    this.wb.showPanel(true, { autoCreate: false });
    const xterm = new window.Terminal({
      fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono'),
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: this.theme(),
      windowsPty: this.wb.isWin ? { backend: 'conpty' } : undefined,
    });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    const container = h('div', { style: { height: '100%', width: '100%' } });
    this.host.appendChild(container);
    xterm.open(container);
    try { fit.fit(); } catch { /* not visible yet */ }
    let info;
    try {
      if (command === 'pi') info = await api.invoke('term:pi', { args: args || [], cols: xterm.cols, rows: xterm.rows });
      else info = await api.invoke('term:create', { cwd: cwd || this.wb.folder, shellId, cols: xterm.cols, rows: xterm.rows });
    } catch (err) {
      container.remove();
      xterm.dispose();
      toast(`无法启动终端: ${err.message}`, 'error');
      return null;
    }
    const t = { id: info.id, name: title || info.name, xterm, fit, container, exited: false };
    xterm.onData((d) => api.send('term:write', t.id, d));
    xterm.onResize(({ cols, rows }) => api.send('term:resize', t.id, cols, rows));
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'c' && xterm.hasSelection()) { api.invoke('clipboard:write', xterm.getSelection()); xterm.clearSelection(); return false; }
      if (mod && e.key.toLowerCase() === 'v') { api.invoke('clipboard:read').then((text) => xterm.paste(text)); return false; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { api.invoke('clipboard:write', xterm.getSelection()); return false; }
      // Let workbench shortcuts through
      if (mod && ['j', 'p', 'b', 'n', 'i', '`'].includes(e.key.toLowerCase())) return false;
      return true;
    });
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: '复制', disabled: !xterm.hasSelection(), run: () => api.invoke('clipboard:write', xterm.getSelection()) },
        { label: '粘贴', run: () => api.invoke('clipboard:read').then((text) => xterm.paste(text)) },
        { label: '全选', run: () => xterm.selectAll() },
        { label: '清除', run: () => xterm.clear() },
        { separator: true },
        { label: '将选中内容添加到聊天', disabled: !xterm.hasSelection(), run: () => { this.wb.chat.composer.setText(`${this.wb.chat.composer.ta.value}\n\`\`\`\n${xterm.getSelection()}\n\`\`\`\n`); this.wb.showChat(); } },
      ]);
    });
    this.terms.push(t);
    this.activate(t);
    return t;
  }

  activate(t) {
    this.active = t;
    this.tab = 'terminal';
    for (const x of this.terms) x.container.style.display = x === t ? 'block' : 'none';
    this.render();
    requestAnimationFrame(() => { this.fit(); t.xterm.focus(); });
  }

  kill(t) {
    api.invoke('term:kill', t.id);
    t.xterm.dispose();
    t.container.remove();
    this.terms = this.terms.filter((x) => x !== t);
    if (this.active === t) this.active = this.terms[this.terms.length - 1] || null;
    if (this.active) this.activate(this.active);
    else this.render();
  }

  fit() {
    if (!this.active || this.tab !== 'terminal' || !this.host.offsetParent) return;
    try { this.active.fit.fit(); } catch { /* ignore */ }
  }

  focus() {
    if (this.active) this.active.xterm.focus();
    else this.newTerminal();
  }

  async sendText(text) {
    let t = this.active;
    if (!t || t.exited) t = await this.newTerminal();
    if (!t) return;
    this.activate(t);
    api.send('term:write', t.id, text.replace(/\n$/, ''));
  }

  async openPiTui(args = []) {
    return this.newTerminal({ command: 'pi', args, title: 'pi' });
  }

  showOutput(session) {
    this.tab = 'output';
    this.wb.showPanel(true, { autoCreate: false });
    this.outputSession = session;
    if (this.unsubOut) this.unsubOut();
    this.unsubOut = session ? session.on('stderr', () => this.renderOutput()) : null;
    this.render();
  }

  renderOutput() {
    if (this.tab !== 'output') return;
    const s = this.outputSession;
    const near = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 30;
    this.output.textContent = s ? (s.stderr || '(pi 进程尚无日志输出)') : '(未选择会话)';
    if (near) this.output.scrollTop = this.output.scrollHeight;
  }

  render() {
    clear(this.headEl);
    append(this.headEl, 
      h(`div.panel-tab${this.tab === 'terminal' ? '.active' : ''}`, { onclick: () => { this.tab = 'terminal'; this.render(); if (!this.terms.length) this.newTerminal(); else this.activate(this.active || this.terms[0]); } }, '终端'),
      h(`div.panel-tab${this.tab === 'output' ? '.active' : ''}`, { onclick: () => this.showOutput(this.wb.chat.current) }, '输出 (pi)'),
      h('span.spacer'),
      this.tab === 'terminal' ? [
        iconBtn('add', '新建终端', () => this.newTerminal()),
        iconBtn('chevron-down', '选择 Shell', (e) => this.shellMenu(e.clientX, e.clientY)),
        iconBtn('robot', '在终端中运行 Pi TUI', () => this.openPiTui([])),
        this.active ? iconBtn('trash', '终止终端', () => this.kill(this.active)) : null,
      ] : [iconBtn('clear-all', '清除', () => { if (this.outputSession) this.outputSession.stderr = ''; this.renderOutput(); })],
      iconBtn('chevron-down', '隐藏面板', () => this.wb.showPanel(false)));
    this.host.classList.toggle('hidden', this.tab !== 'terminal');
    this.output.classList.toggle('hidden', this.tab !== 'output');
    this.listEl.classList.toggle('hidden', this.tab !== 'terminal' || this.terms.length < 2);
    this.renderList();
    this.renderOutput();
  }

  renderList() {
    clear(this.listEl);
    for (const t of this.terms) {
      this.listEl.appendChild(h(`div.term-item${t === this.active ? '.active' : ''}`, { onclick: () => this.activate(t) },
        icon(t.name === 'pi' ? 'robot' : 'terminal'), h('span.ellipsis', t.name + (t.exited ? ' (已退出)' : '')), iconBtn('trash', '终止', () => this.kill(t))));
    }
  }

  shellMenu(x, y) {
    const shells = this.wb.info.shells || [];
    contextMenu(x, y, [
      ...shells.map((s) => ({ label: s.name, checked: (this.wb.config.shell || shells[0].id) === s.id, run: () => this.newTerminal({ shellId: s.id }) })),
      { separator: true },
      ...shells.map((s) => ({ label: `设为默认: ${s.name}`, run: () => this.wb.patchConfig({ shell: s.id }) })),
    ]);
  }

  disposeAll() {
    for (const t of [...this.terms]) this.kill(t);
  }
}
