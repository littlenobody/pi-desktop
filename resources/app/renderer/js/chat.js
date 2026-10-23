// AI chat pane: multiple concurrent pi sessions (tabs), transcript view, review bar,
// slash-command handling and all session-level operations.
import { api, h, icon, iconBtn, clear, basename, relative, resolveIn, textOfContent, fmtTokens, fmtCost, fmtTime, truncate, throttleRaf, samePath, uid, append } from './util.js';
import { modal, confirm, prompt as promptBox, editorPrompt, quickPick, contextMenu, toast, alertBox } from './ui.js';
import { ChatSession, stripFileBlocks } from './session.js';
import { buildItems, renderItem, updateThinking, pinThinking } from './chat-render.js';
import { Composer, BUILTIN_COMMANDS } from './composer.js';
import { mdHooks, renderMarkdown, copyText } from './markdown.js';

export class ChatPane {
  constructor(wb) {
    this.wb = wb;
    this.sessions = [];
    this.current = null;
    this.drafts = new Map();
    this.nodes = new Map(); // item key -> {el, sig}
    this.stick = true;
    this.el = h('div.chat-pane');
    this.tabsEl = h('div.ct-list');
    this.header = h('div.chat-tabs', this.tabsEl,
      iconBtn('add', '新建聊天 (Ctrl+N)', () => this.newChat()),
      iconBtn('history', '会话历史', () => this.historyPicker()),
      iconBtn('ellipsis', '更多', (e) => this.moreMenu(e.clientX, e.clientY)));
    this.scroll = h('div.chat-scroll');
    this.list = h('div');
    this.banner = h('div');
    this.scroll.append(this.banner, this.list);
    this.jump = h('button.icon-btn.jump-bottom.hidden', { title: '滚动到底部', onclick: () => this.scrollToBottom(true) }, icon('arrow-down'));
    this.status = h('div.chat-status');
    this.widgetsAbove = h('div.chat-widgets');
    this.widgetsBelow = h('div.chat-widgets');
    this.queueBox = h('div.queue-box');
    this.review = h('div.review-bar.hidden');
    this.composer = new Composer(this);
    this.body = h('div.chat-body', this.scroll, this.jump);
    this.el.append(this.header, this.body, this.status, this.widgetsAbove, this.queueBox, this.review, this.composer.el, this.composer.hint, this.widgetsBelow);
    this.pinToken = 0;
    this.pinning = false; // 强制滚底的短暂窗口内，忽略由内容重排产生的 scroll 事件，避免 stick 被误清
    this.scroll.addEventListener('scroll', () => {
      if (this.pinning) return;
      const near = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 40;
      this.stick = near;
      this.jump.classList.toggle('hidden', near);
    });
    // 内容在滚底之后继续变高（图片解码、代码块等）时，保持贴底
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { if (this.stick) this.scroll.scrollTop = this.scroll.scrollHeight; }).observe(this.list);
    }
    this.refreshSoon = throttleRaf(() => this.refresh());
    this.statusTimer = setInterval(() => { if (this.current && (this.current.running || this.current.retry)) this.renderStatus(); }, 1000);
    this.reviewCollapsed = false;

    mdHooks.openFile = (p, line) => this.wb.openPath(resolveIn(this.wb.folder, p), line);
    mdHooks.applyCode = (code) => this.wb.editors.insertText(code);
    mdHooks.insertTerminal = (code) => this.wb.terminal.sendText(code);
  }

  // ------------------------------------------------------------------ session tabs
  async newChat({ sessionFile = null, activate = true, lazy = false, title = '' } = {}) {
    if (!this.wb.folder) {
      toast('请先打开一个文件夹', 'warning');
      return null;
    }
    if (sessionFile) {
      const existing = this.sessions.find((s) => s.sessionFile && samePath(s.sessionFile, sessionFile));
      if (existing) {
        this.activate(existing);
        return existing;
      }
    }
    const approve = await this.wb.resolveTrust();
    if (approve === 'cancel') return null;
    const s = new ChatSession({ sessionFile, title, approve: approve === undefined ? undefined : approve, mode: this.wb.config.defaultMode || 'agent', approval: this.wb.config.approval || 'auto' });
    s.view = { toolExpand: new Map(), thinkingOpen: new Set(), noteOpen: new Set(), userOpen: new Set(), editingKey: null };
    this.wire(s);
    this.sessions.push(s);
    if (activate) this.activate(s);
    this.renderTabs();
    if (!lazy) s.start();
    this.wb.saveState();
    return s;
  }

  wire(s) {
    s.on('change', () => { if (s === this.current) this.refreshSoon(); this.renderTabs(); });
    s.on('stream', () => { if (s === this.current) this.refreshSoon(); });
    s.on('tool', () => { if (s === this.current) this.refreshSoon(); });
    s.on('bash', () => { if (s === this.current) this.refreshSoon(); });
    s.on('running', () => { this.renderTabs(); if (s === this.current) { this.composer.renderBar(); this.renderStatus(); } });
    s.on('status', () => { if (s === this.current) { this.renderStatus(); this.renderWidgets(); } });
    s.on('stats', () => { if (s === this.current) { this.composer.renderBar(); this.wb.statusbar.render(); } });
    s.on('queue', () => { if (s === this.current) this.renderQueue(); });
    s.on('changes', () => { if (s === this.current) this.renderReview(); this.wb.explorer.refreshDecorations(); });
    s.on('title', () => { this.renderTabs(); this.wb.saveState(); this.wb.sidebar.refreshHistory(); });
    s.on('commands', () => {});
    s.on('ready', () => {
      this.renderTabs();
      if (s === this.current) { this.composer.renderBar(); this.refresh(); this.scrollToBottom(true); }
      this.wb.saveState();
    });
    s.on('exit', () => { this.renderTabs(); if (s === this.current) this.refresh(); });
    s.on('notify', ({ message, type }) => toast(message, type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info'));
    s.on('editorText', (text) => { if (s === this.current) this.composer.setText(text); else this.drafts.set(s.key, { text, chips: [] }); });
    s.on('dialog', (rec) => this.handleDialog(s, rec));
    s.on('approval', () => {
      if (s !== this.current) { s.unread = true; this.renderTabs(); }
      api.invoke('window:flash');
    });
    s.on('settled', (rec) => {
      this.wb.sidebar.refreshHistory();
      this.wb.scm.refreshSoon();
      if (s !== this.current || !document.hasFocus()) {
        s.unread = true;
        this.renderTabs();
        if (this.wb.config.notifyOnDone !== false) api.invoke('notify', `Pi · ${truncate(s.title, 40)}`, rec.aborted ? '已中止' : '已完成');
      }
    });
  }

  activate(s) {
    if (this.current === s) return;
    if (this.current) {
      this.drafts.set(this.current.key, this.composer.serializeDraft());
    }
    this.current = s;
    s.unread = false;
    clear(this.list);
    this.nodes.clear();
    this.composer.restoreDraft(this.drafts.get(s.key));
    if (s.status === 'idle') s.start();
    this.renderTabs();
    this.refresh();
    this.renderReview();
    this.renderQueue();
    this.renderWidgets();
    this.composer.renderBar();
    this.wb.statusbar.render();
    this.scrollToBottom(true); // 进入聊天固定定位到最底部
    this.wb.saveState();
  }

  async closeChat(s) {
    if (s.running && !(await confirm('关闭聊天', 'Agent 正在运行，关闭将中止当前任务。确定关闭吗？', { okLabel: '关闭', danger: true }))) return;
    const idx = this.sessions.indexOf(s);
    this.sessions.splice(idx, 1);
    this.drafts.delete(s.key);
    await s.stop();
    if (this.current === s) {
      this.current = null;
      const next = this.sessions[Math.min(idx, this.sessions.length - 1)];
      if (next) this.activate(next);
      else { this.refresh(); this.composer.renderBar(); this.renderReview(); this.renderQueue(); }
    }
    this.renderTabs();
    this.wb.saveState();
  }

  renderTabs() {
    clear(this.tabsEl);
    for (const s of this.sessions) {
      const dot = s.status === 'error' || s.status === 'exited' ? 'error' : s.approvals.size ? 'waiting' : s.running ? 'running' : s.unread ? 'unread' : null;
      this.tabsEl.appendChild(h(`div.chat-tab${s === this.current ? '.active' : ''}`, {
        title: `${s.title}${s.sessionFile ? '\n' + s.sessionFile : ''}`,
        onclick: () => this.activate(s),
        onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); this.closeChat(s); } },
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: '重命名', icon: 'edit', run: () => { this.activate(s); this.runCommand('/name'); } },
            { label: '在终端中用 Pi TUI 打开', icon: 'terminal', run: () => this.openInTui(s) },
            { label: '复制会话文件路径', icon: 'copy', disabled: !s.sessionFile, run: () => api.invoke('clipboard:write', s.sessionFile) },
            { label: '重启 pi 进程', icon: 'refresh', run: () => s.restart() },
            { separator: true },
            { label: '关闭', icon: 'close', run: () => this.closeChat(s) },
            { label: '关闭其他', run: async () => { for (const o of [...this.sessions]) if (o !== s) await this.closeChat(o); } },
          ]);
        },
      },
      dot ? h(`span.ct-dot.${dot}`) : null,
      h('span.ct-title', s.status === 'starting' ? '启动中…' : s.title),
      h('button.icon-btn.ct-close', { title: '关闭聊天', onclick: (e) => { e.stopPropagation(); this.closeChat(s); } }, icon('close'))));
    }
    const act = this.tabsEl.querySelector('.chat-tab.active');
    if (act) act.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    this.wb.activitybar && this.wb.activitybar.render();
  }

  // ------------------------------------------------------------------ transcript
  viewFor(s) {
    const v = s.view;
    v.folder = this.wb.folder;
    v.session = s;
    v.showThinking = this.wb.config.showThinking !== false;
    v.expandAll = !!this.wb.config.expandTools;
    v.refresh = () => this.refreshSoon();
    v.hooks = {
      openFile: (p, line) => this.wb.openPath(resolveIn(this.wb.folder, p), line),
      openChangeDiff: (p) => this.openChangeDiff(s, p),
    };
    v.actions = {
      copy: (t) => copyText(t),
      copyAssistant: (m) => copyText(textOfContent(m.content)),
      editUser: (item) => { v.editingKey = item.key; this.refresh(); },
      retry: (m) => this.retryAssistant(s, m),
      fork: (item) => this.forkAt(s, item.entryId),
      label: (item) => this.labelEntry(s, item),
      restoreCheckpoint: (item) => this.restoreCheckpoint(s, item),
      showSummary: (title, text) => modal({ title, body: renderMarkdown(h('div.md'), text), wide: true }),
    };
    v.renderEditor = (item, text) => this.renderUserEditor(s, item, text);
    return v;
  }

  refresh() {
    const s = this.current;
    this.renderBanner();
    if (!s) {
      clear(this.list);
      this.nodes.clear();
      this.scroll.classList.add('empty');
      this.list.appendChild(this.emptyState());
      return;
    }
    const view = this.viewFor(s);
    const items = buildItems(s, view);
    const empty = !items.length && s.status !== 'error' && s.status !== 'exited';
    this.scroll.classList.toggle('empty', empty);
    if (empty) {
      clear(this.list);
      this.nodes.clear();
      this.list.appendChild(this.emptyState());
      return;
    }
    if (this.list.firstChild && this.list.firstChild.classList && this.list.firstChild.classList.contains('chat-empty')) clear(this.list);
    const wasStuck = this.stick;
    const keep = new Set();
    let prev = null;
    for (const item of items) {
      keep.add(item.key);
      let node = this.nodes.get(item.key);
      if (!node || node.sig !== item.sig) {
        if (node && item.kind === 'thinking' && node.kind === 'thinking' && node.streaming && item.streaming) {
          // 流式思考：原地更新文字，不重建节点
          updateThinking(node.el, item);
          node.sig = item.sig;
        } else {
          const el = renderItem(item, view);
          if (node) node.el.replaceWith(el);
          node = { el, sig: item.sig, kind: item.kind, streaming: !!item.streaming };
          this.nodes.set(item.key, node);
        }
      }
      const expectedNext = prev ? prev.nextSibling : this.list.firstChild;
      if (node.el !== expectedNext) this.list.insertBefore(node.el, expectedNext);
      prev = node.el;
      if (item.kind === 'thinking' && item.streaming) pinThinking(node.el);
    }
    for (const [k, node] of this.nodes) {
      if (!keep.has(k)) {
        node.el.remove();
        this.nodes.delete(k);
      }
    }
    this.renderStatus();
    if (wasStuck) this.scrollToBottom();
  }

  scrollToBottom(force) {
    const apply = () => {
      if (this.stick) this.scroll.scrollTop = this.scroll.scrollHeight;
      this.jump.classList.add('hidden');
    };
    if (!force) {
      requestAnimationFrame(apply);
      return;
    }
    this.stick = true;
    this.pinning = true;
    const token = ++this.pinToken;
    apply(); // 同步滚一次，随后两帧再补滚，覆盖异步布局
    requestAnimationFrame(() => {
      if (token !== this.pinToken) return;
      this.stick = true;
      apply();
      requestAnimationFrame(() => {
        if (token !== this.pinToken) return;
        this.stick = true;
        apply();
        this.pinning = false;
      });
    });
  }

  emptyState() {
    const mod = this.wb.isMac ? '⌘' : 'Ctrl';
    if (!this.current) {
      return h('div.chat-empty', h('img', { src: 'assets/logo.svg' }), h('div', '没有打开的聊天'),
        h('button.btn', { onclick: () => this.newChat() }, icon('add'), '新建聊天'),
        h('button.btn.secondary', { onclick: () => this.historyPicker() }, icon('history'), '打开历史会话'));
    }
    const s = this.current;
    return h('div.chat-empty', h('img', { src: 'assets/logo.svg' }),
      h('div', s.status === 'starting' ? h('span', icon('loading', 'spin'), ' 正在启动 pi…') : 'Pi 已就绪，开始描述你的任务'),
      h('div.hints',
        h('div', h('kbd', '@'), '引用文件或文件夹作为上下文'),
        h('div', h('kbd', '/'), '命令、提示模板与技能'),
        h('div', h('kbd', '!'), '运行 shell 命令并把输出加入上下文（!! 不加入）'),
        h('div', h('kbd', `${mod}+L`), '编辑器选区加入聊天'),
        h('div', h('kbd', 'Alt+Enter'), 'Agent 完成后再执行（follow-up）'),
        h('div', h('kbd', 'Esc'), '中止当前任务')));
  }

  renderBanner() {
    clear(this.banner);
    const s = this.current;
    if (!s) return;
    if (s.status === 'error') {
      this.banner.appendChild(h('div.chat-banner.err', icon('error'), h('div.grow', h('div', 'pi 启动失败'), h('pre', s.startError || ''),
        h('div.row', { style: { marginTop: '6px' } },
          h('button.btn.small', { onclick: () => s.restart() }, '重试'),
          h('button.btn.small.secondary', { onclick: () => this.wb.openSettings('pi') }, '配置 pi 路径'),
          h('button.btn.small.secondary', { onclick: () => this.showLog(s) }, '查看日志')))));
    } else if (s.status === 'exited') {
      const info = s.exitInfo || {};
      this.banner.appendChild(h('div.chat-banner.warn', icon('warning'), h('div.grow', h('div', `pi 进程已退出 (code ${info.code ?? '?'})`), info.stderr ? h('pre', info.stderr.slice(-2000)) : null,
        h('div.row', { style: { marginTop: '6px' } }, h('button.btn.small', { onclick: () => s.restart() }, '重新启动并恢复会话')))));
    } else if (s.trusted === false && this.wb.trustInfo && this.wb.trustInfo.needsTrust) {
      this.banner.appendChild(h('div.chat-banner.warn', icon('shield'), h('div.grow', '项目未被信任：项目中的 .pi 设置、扩展、技能与模板未加载。',
        h('div', h('a', { onclick: () => this.runCommand('/trust') }, '信任此项目…')))));
    }
  }

  renderStatus() {
    clear(this.status);
    const s = this.current;
    if (!s) return;
    const parts = [];
    if (s.compacting) parts.push(h('span.row', icon('loading', 'spin'), `正在压缩上下文（${s.compacting === 'threshold' ? '接近上限' : s.compacting === 'overflow' ? '上下文溢出' : '手动'}）…`, iconBtn('debug-stop', '取消', () => s.abort())));
    else if (s.retry) {
      const left = Math.max(0, Math.ceil((s.retry.at + s.retry.delayMs - Date.now()) / 1000));
      parts.push(h('span.row.warn', icon('sync', 'spin'), `${s.retry.summary ? '摘要' : ''}重试 ${s.retry.attempt}/${s.retry.maxAttempts}${left ? `（${left}s 后）` : ''}: ${truncate(s.retry.errorMessage || '', 80)}`, iconBtn('debug-stop', '停止重试', () => s.request({ type: 'abort_retry' }))));
    } else if (s.running) {
      const tool = [...s.toolLive.values()].reverse().find((t) => t.status === 'running');
      const label = s.approvals.size ? '等待确认工具调用' : tool ? `正在${({ bash: '运行命令', read: '读取文件', edit: '编辑文件', write: '写入文件', grep: '搜索', find: '查找', ls: '列目录' })[tool.toolName] || '调用 ' + tool.toolName}` : s.streaming && s.streaming.content.some((c) => c && c.type === 'thinking' && !c.text) && !s.streaming.content.some((c) => c && c.type === 'text') ? '思考中' : '生成中';
      parts.push(h('span.row', icon('loading', 'spin'), h('span.pulse', `${label}…`)));
    }
    for (const [k, v] of s.statuses) parts.push(h('span.tag', { title: k }, v));
    append(this.status, ...parts);
  }

  renderWidgets() {
    clear(this.widgetsAbove);
    clear(this.widgetsBelow);
    const s = this.current;
    if (!s) return;
    for (const [k, w] of s.widgets) {
      (w.placement === 'belowEditor' ? this.widgetsBelow : this.widgetsAbove).appendChild(h('div.chat-widget', { title: k }, w.lines.join('\n')));
    }
  }

  renderQueue() {
    clear(this.queueBox);
    const s = this.current;
    if (!s) return;
    const q = [...s.queue.steering.map((t) => ({ t, k: 'steer' })), ...s.queue.followUp.map((t) => ({ t, k: 'followUp' }))];
    for (const it of q) {
      this.queueBox.appendChild(h('div.queue-item', icon(it.k === 'steer' ? 'debug-step-into' : 'debug-continue'), h('span.q-text', { title: it.t }, it.t), h('span.faint', it.k === 'steer' ? '插入' : '完成后')));
    }
    if (q.length) {
      this.queueBox.appendChild(h('div.row', { style: { justifyContent: 'flex-end' } }, h('a', { onclick: () => this.restoreQueue() }, '取回到输入框 (Alt+↑)')));
    }
  }

  renderReview() {
    const s = this.current;
    const changes = s ? s.changes : [];
    clear(this.review);
    this.review.classList.toggle('hidden', !changes.length);
    this.review.classList.toggle('collapsed', this.reviewCollapsed);
    if (!changes.length) return;
    const add = changes.reduce((a, c) => a + c.added, 0);
    const del = changes.reduce((a, c) => a + c.removed, 0);
    append(this.review, 
      h('div.rb-head', { onclick: () => { this.reviewCollapsed = !this.reviewCollapsed; this.renderReview(); } },
        icon(this.reviewCollapsed ? 'chevron-right' : 'chevron-down'),
        h('span.grow', `${changes.length} 个文件已更改`),
        h('span', { style: { color: 'var(--add)', fontFamily: 'var(--font-mono)', fontSize: '11px' } }, `+${add}`),
        h('span', { style: { color: 'var(--del)', fontFamily: 'var(--font-mono)', fontSize: '11px' } }, `-${del}`),
        h('button.btn.small.secondary', { title: '撤销本会话中 Agent 的全部文件修改', onclick: async (e) => { e.stopPropagation(); await this.revertAll(s); } }, '全部撤销'),
        h('button.btn.small', { title: '接受修改（清空审阅列表）', onclick: (e) => { e.stopPropagation(); api.invoke('session:keep', s.rpcId, null); } }, '全部保留')),
      h('div.rb-list', changes.map((c) => h('div.rb-file', { onclick: () => this.openChangeDiff(s, c.path), title: c.path },
        icon(c.created ? 'diff-added' : c.deleted ? 'diff-removed' : 'diff-modified'),
        h('span', basename(c.path)),
        h('span.dir', relative(this.wb.folder, c.path)),
        h('span.add', `+${c.added}`), c.removed ? h('span.del', `-${c.removed}`) : null,
        h('span.actions',
          iconBtn('go-to-file', '打开文件', () => this.wb.editors.openFile(c.path)),
          iconBtn('discard', '撤销此文件的修改', () => this.revertFile(s, c.path)),
          iconBtn('check', '保留', () => api.invoke('session:keep', s.rpcId, c.path)))))));
  }

  async openChangeDiff(s, p) {
    const r = await api.invoke('session:baseline', s.rpcId, p).catch(() => ({ tracked: false }));
    if (r.tracked) {
      await this.wb.editors.openDiff(p, r.text, {
        source: 'agent',
        onKeep: () => api.invoke('session:keep', s.rpcId, p),
        onRevert: () => this.revertFile(s, p),
      });
    } else {
      await this.wb.scm.openGitDiff(p, true);
    }
  }

  async revertFile(s, p) {
    if (!(await confirm('撤销修改', `将 ${basename(p)} 恢复到 Agent 修改之前的内容？`, { okLabel: '撤销', danger: true }))) return false;
    await api.invoke('session:revert', s.rpcId, p);
    toast(`已撤销 ${basename(p)}`, 'info', { timeout: 2000 });
    return true;
  }

  async revertAll(s) {
    if (!(await confirm('撤销全部修改', `将本会话中 Agent 修改过的 ${s.changes.length} 个文件恢复到修改前的状态？`, { okLabel: '全部撤销', danger: true }))) return;
    for (const c of [...s.changes]) await api.invoke('session:revert', s.rpcId, c.path);
    toast('已撤销全部修改', 'info', { timeout: 2000 });
  }

  // ------------------------------------------------------------------ message actions
  renderUserEditor(s, item, text) {
    const ta = h('textarea', { rows: 3, spellcheck: false });
    ta.value = text;
    const revert = h('input', { type: 'checkbox' });
    const files = [];
    api.invoke('session:checkpoint-files', s.rpcId, item.message.timestamp).then((list) => {
      files.push(...list);
      if (list.length) { revert.checked = true; info.textContent = `同时撤销此后 Agent 修改的 ${list.length} 个文件`; label.classList.remove('hidden'); }
    }).catch(() => {});
    const info = h('span');
    const label = h('label.checkbox.hidden', revert, info);
    const cancel = () => { s.view.editingKey = null; this.refresh(); };
    const submit = async () => {
      const newText = ta.value.trim();
      if (!newText) return;
      s.view.editingKey = null;
      try {
        if (s.running) await s.abort();
        if (revert.checked && files.length) await api.invoke('session:restore-checkpoint', s.rpcId, item.message.timestamp);
        const images = Array.isArray(item.message.content) ? item.message.content.filter((c) => c.type === 'image') : [];
        const original = typeof item.message.content === 'string' ? item.message.content : textOfContent(item.message.content);
        const prefix = original.match(/^(?:<(?:file|selection) [^>]*>[\s\S]*?<\/(?:file|selection)>\n?)*/);
        const r = await s.navigate(item.entryId, { summarize: false });
        if (r && r.cancelled) { toast('切换分支被扩展取消', 'warning'); return; }
        await s.prompt((prefix ? prefix[0] : '') + newText, images);
      } catch (err) {
        toast(err.message, 'error');
      }
      this.refresh();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    });
    const box = h('div.msg', h('div.composer', { style: { margin: '0' } }, ta,
      h('div.cmp-bar', label, h('span.spacer'), h('button.btn.small.secondary', { onclick: cancel }, '取消'), h('button.btn.small', { onclick: submit }, '发送'))),
    h('div.msg-meta', icon('info'), '将从这条消息处创建新分支，原对话仍保存在会话树中 (/tree)'));
    setTimeout(() => { ta.focus(); ta.style.height = `${Math.min(ta.scrollHeight + 4, 300)}px`; }, 0);
    return box;
  }

  async retryAssistant(s, m) {
    // Find the user entry that produced this assistant message.
    const branch = s.branch();
    let userEntry = null;
    for (const e of branch) {
      if (e.type === 'message' && e.message.role === 'user') userEntry = e;
      if (e.type === 'message' && e.message.timestamp === m.timestamp && e.message.role === 'assistant') break;
    }
    if (!userEntry) { toast('找不到对应的用户消息', 'warning'); return; }
    try {
      if (s.running) await s.abort();
      const content = userEntry.message.content;
      const text = typeof content === 'string' ? content : textOfContent(content);
      const images = Array.isArray(content) ? content.filter((c) => c.type === 'image') : [];
      const r = await s.navigate(userEntry.id, { summarize: false });
      if (r && r.cancelled) return;
      await s.prompt(text, images);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async forkAt(s, entryId) {
    if (!s.sessionFile) { toast('当前会话尚未保存，无法分叉', 'warning'); return; }
    const ns = await this.newChat({ sessionFile: s.sessionFile, lazy: true });
    if (!ns) return;
    ns.sessionFile = s.sessionFile;
    await ns.start();
    try {
      const r = await ns.fork(entryId);
      if (r.cancelled) { toast('分叉被扩展取消', 'warning'); return; }
      if (r.text) this.composer.setText(r.text);
      toast('已分叉为新会话', 'info', { timeout: 2000 });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async labelEntry(s, item) {
    const v = await promptBox('设置标签', { value: item.label || '', message: '标签会显示在会话树 (/tree) 中，留空则清除。' });
    if (v === undefined) return;
    await s.setLabel(item.entryId, v.trim() || undefined).catch((err) => toast(err.message, 'error'));
  }

  async restoreCheckpoint(s, item) {
    const files = await api.invoke('session:checkpoint-files', s.rpcId, item.message.timestamp).catch(() => []);
    if (!files.length) {
      toast('此消息之后没有可撤销的文件修改（仅能撤销本次打开期间 Agent 通过 edit/write 做的修改）', 'info');
      return;
    }
    const ok = await confirm('恢复检查点', `将以下 ${files.length} 个文件恢复到发送此消息之前的状态：\n\n${files.map((f) => relative(this.wb.folder, f)).join('\n')}\n\n对话本身不会改变；如需从这里重新开始，请使用“编辑并重新发送”。`, { okLabel: '恢复', danger: true });
    if (!ok) return;
    const restored = await api.invoke('session:restore-checkpoint', s.rpcId, item.message.timestamp);
    toast(`已恢复 ${restored.length} 个文件`, 'info');
  }

  // ------------------------------------------------------------------ submit
  saveDraft() {
    if (this.current) this.drafts.set(this.current.key, this.composer.serializeDraft());
  }

  async submit(behavior = 'steer') {
    let s = this.current;
    const raw = this.composer.ta.value;
    const text = raw.trim();
    if (!text && !this.composer.chips.length) return;
    if (!s) {
      s = await this.newChat();
      if (!s) return;
    }
    if (s.status !== 'ready') {
      if (s.status === 'starting') { toast('pi 正在启动，请稍候…', 'info', { timeout: 1500 }); return; }
      toast('会话未运行', 'warning');
      return;
    }
    // Built-in commands (handled by the desktop, like pi's interactive mode).
    if (text.startsWith('/') && !this.composer.chips.length) {
      const handled = await this.runCommand(text);
      if (handled) {
        this.composer.setText('');
        this.composer.closeAc();
        return;
      }
    }
    // !cmd / !!cmd
    if (/^!{1,2}\S/.test(text) && !this.composer.chips.length) {
      const exclude = text.startsWith('!!');
      const cmd = text.slice(exclude ? 2 : 1).trim();
      this.composer.setText('');
      s.promptHistory.push(text);
      this.stick = true;
      s.bash(cmd, exclude).catch((err) => toast(err.message, 'error'));
      return;
    }
    const payload = await this.composer.buildPayload(text);
    this.composer.setText('');
    this.composer.clearChips();
    this.composer.histIdx = -1;
    this.drafts.delete(s.key);
    this.stick = true;
    try {
      if (s.running && !text.startsWith('/')) {
        if (behavior === 'followUp') await s.followUp(payload.text, payload.images);
        else await s.steer(payload.text, payload.images);
        s.promptHistory.push(text);
      } else {
        const r = await s.prompt(payload.text, payload.images, behavior);
        if (r && r.disposition === 'handled') s.refreshStats();
      }
    } catch (err) {
      toast(err.message, 'error');
      this.composer.setText(raw);
    }
    this.scrollToBottom(true);
  }

  sendWithContext(instruction, contexts) {
    for (const c of contexts) this.composer.addChip({ kind: 'selection', path: c.path, startLine: c.startLine, endLine: c.endLine, text: c.text });
    this.composer.setText(instruction);
    this.wb.showChat();
    this.submit('steer');
  }

  async addSelectionContext(ctx, { newChat = false } = {}) {
    if (newChat) await this.newChat();
    this.composer.addChip({ kind: 'selection', path: ctx.path, startLine: ctx.startLine, endLine: ctx.endLine, text: ctx.text });
    this.wb.showChat();
    this.composer.focus();
  }

  addFileContext(p) {
    this.composer.addFiles([p]);
    this.wb.showChat();
    this.composer.focus();
  }

  async stop() {
    const s = this.current;
    if (!s) return;
    try {
      const q = await s.clearQueue();
      const restored = [...(q.steering || []), ...(q.followUp || [])];
      await s.abort();
      if (restored.length && !this.composer.ta.value.trim()) this.composer.setText(restored.join('\n\n'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async restoreQueue() {
    const s = this.current;
    if (!s) return;
    const q = await s.clearQueue().catch(() => null);
    if (!q) return;
    const restored = [...(q.steering || []), ...(q.followUp || [])];
    if (restored.length) this.composer.setText([this.composer.ta.value, ...restored].filter(Boolean).join('\n\n'));
  }

  // ------------------------------------------------------------------ pickers
  async modelPicker(filter = '') {
    const s = this.current;
    if (!s || s.status !== 'ready') return;
    let models;
    try {
      models = await s.getModels(true);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const cur = s.state.model;
    const enabled = (await api.invoke('pi:settings:read', 'global').catch(() => ({ data: {} }))).data.enabledModels;
    const items = models.map((m) => ({
      label: m.name || m.id,
      description: `${m.provider}/${m.id}`,
      detail: [m.contextWindow ? `${fmtTokens(m.contextWindow)} 上下文` : '', m.reasoning ? '推理' : '', (m.input || []).includes('image') ? '图像' : '', m.cost ? `$${m.cost.input}/$${m.cost.output} 每百万` : ''].filter(Boolean).join(' · '),
      iconEl: cur && cur.id === m.id && cur.provider === m.provider ? icon('check') : icon('blank'),
      value: m,
    }));
    if (!items.length) {
      const go = await confirm('没有可用模型', '未找到任何已配置凭据的模型。是否现在登录一个提供商或配置 API Key？', { okLabel: '去配置' });
      if (go) this.wb.openSettings('auth');
      return;
    }
    const m = await quickPick({ items, placeholder: '选择模型（搜索名称或 provider/id）', title: enabled && enabled.length ? `已配置循环范围: ${enabled.join(', ')}` : '', value: filter, matchOn: ['label', 'description'] });
    if (!m || !m.provider) return;
    try {
      await s.setModel(m.provider, m.id);
      toast(`模型: ${m.name || m.id}`, 'info', { timeout: 1500 });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  thinkingMenu(anchor) {
    const s = this.current;
    if (!s) return;
    const r = anchor.getBoundingClientRect();
    const desc = { off: '关闭', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
    contextMenu(r.left, r.top - 8 - s.thinkingLevels.length * 26, s.thinkingLevels.map((l) => ({
      label: `${l}  ${desc[l] || ''}`, checked: s.state.thinkingLevel === l, run: () => s.setThinking(l).catch((err) => toast(err.message, 'error')),
    })));
  }

  async cycleThinking() {
    const s = this.current;
    if (!s) return;
    const r = await s.cycleThinking().catch((err) => toast(err.message, 'error'));
    if (r && r.level) toast(`思考强度: ${r.level}`, 'info', { timeout: 1200 });
  }

  modeMenu(anchor) {
    const s = this.current;
    if (!s) return;
    const r = anchor.getBoundingClientRect();
    contextMenu(r.left, r.top - 150, [
      { label: 'Agent — 可读写文件、运行命令', checked: s.mode === 'agent', run: () => this.setMode('agent') },
      { label: 'Ask — 只读工具，不修改文件', checked: s.mode === 'ask', run: () => this.setMode('ask') },
      { separator: true },
      { label: '运行工具前询问（编辑/命令）', checked: s.approval === 'ask', run: () => this.setApproval(s.approval === 'ask' ? 'auto' : 'ask') },
      { label: '管理工具…', icon: 'tools', run: () => this.toolsDialog() },
    ]);
  }

  async setMode(mode) {
    const s = this.current;
    if (!s) return;
    try {
      await s.setMode(mode);
      this.wb.patchConfig({ defaultMode: mode });
      this.composer.renderBar();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  toggleMode() {
    if (this.current) this.setMode(this.current.mode === 'ask' ? 'agent' : 'ask');
  }

  async setApproval(mode) {
    const s = this.current;
    if (!s) return;
    try {
      await s.setApproval(mode);
      this.wb.patchConfig({ approval: mode });
      toast(mode === 'ask' ? '运行编辑/命令类工具前将请求确认' : '工具将自动运行', 'info', { timeout: 2000 });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async toolsDialog() {
    const s = this.current;
    if (!s) return;
    await s.refreshInfo();
    const active = new Set(s.activeTools);
    const rows = s.tools.filter((t) => t.exposure !== 'hidden').map((t) => {
      const cb = h('input', { type: 'checkbox', checked: active.has(t.name) });
      return { t, cb, el: h('label.checkbox', { style: { display: 'flex', padding: '4px 0', alignItems: 'flex-start' } }, cb, h('div', h('div', h('b', t.name), h('span.faint', `  ${t.source || ''}${t.exposure && t.exposure !== 'direct' ? ' · ' + t.exposure : ''}`)), h('div.muted', { style: { fontSize: '12px' } }, truncate(t.description || '', 180)))) };
    });
    const ok = await modal({
      title: '工具', wide: true,
      body: h('div', h('div.muted', { style: { marginBottom: '8px' } }, '选择声明给模型的工具（仅影响当前会话）。永久默认值请在设置 → defaultTools 中修改。'), rows.map((r) => r.el)),
      buttons: [{ label: '取消', value: false }, { label: '应用', value: true, primary: true }],
    });
    if (!ok) return;
    try {
      await s.bridge('set-tools', { tools: rows.filter((r) => r.cb.checked).map((r) => r.t.name) });
      await s.refreshInfo();
      toast('已更新工具', 'info', { timeout: 1500 });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async historyPicker(all = false) {
    const list = await api.invoke('pi:sessions:list', all).catch(() => []);
    const items = list.map((it) => ({
      label: it.name || truncate(stripFileBlocks(it.firstMessage).replace(/\s+/g, ' '), 90) || '(空会话)',
      description: fmtTime(it.modified),
      detail: `${it.messages} 条消息${all ? ' · ' + it.cwd : ''}`,
      iconEl: this.sessions.some((s) => s.sessionFile && samePath(s.sessionFile, it.file)) ? icon('circle-filled') : icon('comment-discussion'),
      value: it,
      buttons: [{ icon: 'trash', title: '删除会话', run: (item) => { this.deleteSession(item.value); } }],
    }));
    items.unshift({ label: all ? '仅显示当前项目的会话' : '显示所有项目的会话…', iconEl: icon('filter'), value: { toggle: true }, alwaysShow: true });
    const it = await quickPick({ items, placeholder: '搜索历史会话', matchOn: ['label', 'detail'] });
    if (!it) return;
    if (it.toggle) return this.historyPicker(!all);
    this.openSessionFile(it.file, it.cwd);
  }

  async openSessionFile(file, cwd) {
    if (cwd && this.wb.folder && !samePath(cwd, this.wb.folder)) {
      const r = await modal({ title: '会话属于其他项目', body: h('div', `该会话的工作目录是:\n${cwd}`), buttons: [{ label: '取消', value: null }, { label: '在当前项目中打开', value: 'here' }, { label: '在新窗口打开该项目', value: 'window', primary: true }] });
      if (!r) return;
      if (r === 'window') {
        await api.invoke('window:open', cwd, { newWindow: true });
        return;
      }
    }
    await this.newChat({ sessionFile: file });
  }

  async deleteSession(info) {
    if (!(await confirm('删除会话', `永久删除此会话文件？\n${info.file}`, { okLabel: '删除', danger: true }))) return;
    const open = this.sessions.find((s) => s.sessionFile && samePath(s.sessionFile, info.file));
    if (open) await this.closeChat(open);
    await api.invoke('pi:sessions:remove', info.file).catch((err) => toast(err.message, 'error'));
    this.wb.sidebar.refreshHistory();
  }

  moreMenu(x, y) {
    const s = this.current;
    const ready = s && s.status === 'ready';
    contextMenu(x, y, [
      { label: '会话树 (/tree)', icon: 'type-hierarchy', disabled: !ready, run: () => this.runCommand('/tree') },
      { label: '分叉 (/fork)…', icon: 'repo-forked', disabled: !ready, run: () => this.runCommand('/fork') },
      { label: '克隆 (/clone)', icon: 'copy', disabled: !ready, run: () => this.runCommand('/clone') },
      { label: '压缩上下文 (/compact)', icon: 'fold', disabled: !ready, run: () => this.runCommand('/compact') },
      { label: '重命名 (/name)', icon: 'edit', disabled: !ready, run: () => this.runCommand('/name') },
      { label: '会话信息 (/session)', icon: 'info', disabled: !ready, run: () => this.runCommand('/session') },
      { separator: true },
      { label: '导出 HTML / JSONL', icon: 'export', disabled: !ready, run: () => this.runCommand('/export') },
      { label: '分享为 Gist (/share)', icon: 'cloud-upload', disabled: !ready, run: () => this.runCommand('/share') },
      { label: '复制最后的回复', icon: 'copy', disabled: !ready, run: () => this.runCommand('/copy') },
      { separator: true },
      { label: '工具…', icon: 'tools', disabled: !ready, run: () => this.toolsDialog() },
      { label: '系统提示词', icon: 'note', disabled: !ready, run: () => this.runCommand('/system-prompt') },
      { label: '重新加载资源 (/reload)', icon: 'refresh', disabled: !ready, run: () => this.runCommand('/reload') },
      { label: '在终端中用 Pi TUI 打开', icon: 'terminal', disabled: !s, run: () => this.openInTui(s) },
      { label: '显示 pi 日志', icon: 'output', disabled: !s, run: () => this.showLog(s) },
      { separator: true },
      { label: '显示思考过程', checked: this.wb.config.showThinking !== false, run: () => { this.wb.patchConfig({ showThinking: this.wb.config.showThinking === false }); this.nodes.clear(); clear(this.list); this.refresh(); } },
      { label: '默认展开工具输出 (Ctrl+O)', checked: !!this.wb.config.expandTools, run: () => this.toggleExpandTools() },
    ]);
  }

  toggleExpandTools() {
    this.wb.patchConfig({ expandTools: !this.wb.config.expandTools });
    if (this.current) this.current.view.toolExpand.clear();
    this.refresh();
  }

  showLog(s) {
    this.wb.terminal.showOutput(s);
  }

  async openInTui(s) {
    const args = s && s.sessionFile ? ['--session', s.sessionFile] : [];
    if (s && s.running) toast('注意：该会话正在桌面端运行，同时在 TUI 中操作可能产生冲突。', 'warning');
    await this.wb.terminal.openPiTui(args);
  }

  // ------------------------------------------------------------------ extension dialogs
  async handleDialog(s, rec) {
    if (s !== this.current) { s.unread = true; this.renderTabs(); }
    api.invoke('window:flash');
    let closeFn = null;
    let timer = null;
    const onOpen = ({ close }) => {
      closeFn = close;
      if (rec.timeout) timer = setTimeout(() => close('__timeout__'), rec.timeout);
    };
    const finish = (resp) => {
      clearTimeout(timer);
      if (resp === '__timeout__') return; // pi already resolved it
      s.respondUi(rec.id, resp);
    };
    const title = `${rec.title || ''}`;
    if (rec.method === 'confirm') {
      const r = await modal({ title: title || '确认', body: h('div', { style: { whiteSpace: 'pre-wrap' } }, rec.message || ''), buttons: [{ label: '否', value: false }, { label: '是', value: true, primary: true }], onOpen });
      finish(r === '__timeout__' ? r : r === undefined ? { cancelled: true } : { confirmed: !!r });
    } else if (rec.method === 'select') {
      const opts = rec.options || [];
      if (opts.length <= 4 && title.length < 400) {
        const r = await modal({ title: '扩展请求选择', body: h('div', { style: { whiteSpace: 'pre-wrap' } }, title), buttons: opts.map((o, i) => ({ label: o, value: o, primary: i === 0 })), onOpen });
        finish(r === '__timeout__' ? r : r === undefined ? { cancelled: true } : { value: r });
      } else {
        const p = quickPick({ items: opts.map((o) => ({ label: o, value: o })), placeholder: title });
        if (rec.timeout) timer = setTimeout(() => { document.querySelector('.quickpick input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }, rec.timeout);
        const r = await p;
        finish(r === undefined ? { cancelled: true } : { value: typeof r === 'string' ? r : r.label });
      }
    } else if (rec.method === 'input') {
      const input = h('input.input', { placeholder: rec.placeholder || '', style: { width: '100%' } });
      const r = await modal({ title: title || '输入', body: h('div', { style: { minWidth: '420px' } }, input), buttons: [{ label: '取消', value: undefined }, { label: '确定', value: () => input.value, primary: true }], onOpen });
      finish(r === '__timeout__' ? r : r === undefined ? { cancelled: true } : { value: r });
    } else if (rec.method === 'editor') {
      const r = await editorPrompt(title || '编辑', rec.prefill || '');
      finish(r === undefined ? { cancelled: true } : { value: r });
    }
    void closeFn;
  }

  // ------------------------------------------------------------------ slash commands
  /** Returns true when the command was handled by the desktop. */
  async runCommand(text) {
    const s = this.current;
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
    if (!m) return false;
    const name = m[1];
    const arg = m[2].trim();
    const known = BUILTIN_COMMANDS.some((c) => c.name === name);
    if (!known) return false;
    const need = () => {
      if (!s || s.status !== 'ready') { toast('会话未运行', 'warning'); return false; }
      return true;
    };
    try {
      switch (name) {
        case 'model':
          if (!need()) return true;
          if (arg) {
            const models = await s.getModels();
            const [prov, ...rest] = arg.split('/');
            const id = rest.join('/');
            const hit = models.find((x) => x.provider === prov && x.id === id) || models.find((x) => x.id === arg) || models.find((x) => (x.name || '').toLowerCase() === arg.toLowerCase());
            if (hit) await s.setModel(hit.provider, hit.id);
            else await this.modelPicker(arg);
          } else await this.modelPicker();
          return true;
        case 'thinking':
          if (!need()) return true;
          if (arg) await s.setThinking(arg);
          else this.thinkingMenu(this.composer.bar);
          return true;
        case 'new':
          if (!need()) return true;
          await s.newSession();
          return true;
        case 'resume':
          await this.historyPicker();
          return true;
        case 'name': {
          if (!need()) return true;
          const v = arg || (await promptBox('会话名称', { value: s.state.sessionName || '' }));
          if (v) await s.setName(v.trim());
          return true;
        }
        case 'session':
          if (!need()) return true;
          await this.sessionInfo(s);
          return true;
        case 'tree':
          if (!need()) return true;
          await this.treeDialog(s);
          return true;
        case 'fork': {
          if (!need()) return true;
          const r = await s.request({ type: 'get_fork_messages' });
          const msgs = (r.messages || []).slice().reverse();
          if (!msgs.length) { toast('没有可分叉的用户消息', 'info'); return true; }
          const pick = await quickPick({ items: msgs.map((x) => ({ label: truncate(stripFileBlocks(x.text).replace(/\s+/g, ' '), 120), value: x })), placeholder: '选择要从哪条用户消息分叉（新会话将在新标签中打开）' });
          if (pick && pick.entryId) await this.forkAt(s, pick.entryId);
          return true;
        }
        case 'clone': {
          if (!need()) return true;
          const r = await s.clone();
          if (r && r.cancelled) toast('克隆被扩展取消', 'warning');
          else toast('已克隆为新会话（当前标签现在指向副本）', 'info');
          return true;
        }
        case 'compact': {
          if (!need()) return true;
          const r = await s.compact(arg || undefined);
          if (r) toast(`压缩完成: ${fmtTokens(r.tokensBefore)} → ~${fmtTokens(r.estimatedTokensAfter)} tokens`, 'info');
          return true;
        }
        case 'import': {
          if (!need()) return true;
          let p = arg;
          if (!p) {
            const files = await api.invoke('dialog:open', { properties: ['openFile'], filters: [{ name: 'Pi session', extensions: ['jsonl'] }] });
            p = files && files[0];
          }
          if (!p) return true;
          if (!(await confirm('导入会话', `用 ${p} 替换当前标签中的会话？`))) return true;
          const r = await s.switchSession(resolveIn(this.wb.folder, p));
          if (r && r.cancelled) toast('导入被扩展取消', 'warning');
          return true;
        }
        case 'copy': {
          if (!need()) return true;
          const r = await s.request({ type: 'get_last_assistant_text' });
          if (r && r.text) copyText(r.text, '已复制最后一条回复');
          else toast('没有可复制的回复', 'info');
          return true;
        }
        case 'export':
          if (!need()) return true;
          await this.exportSession(s, arg);
          return true;
        case 'share':
          if (!need()) return true;
          await this.shareSession(s);
          return true;
        case 'settings':
          this.wb.openSettings();
          return true;
        case 'scoped-models':
          this.wb.openSettings('models');
          return true;
        case 'login':
          await this.wb.loginDialog(arg);
          return true;
        case 'logout':
          await this.wb.logoutDialog();
          return true;
        case 'trust':
          await this.wb.trustDialog();
          return true;
        case 'reload':
          if (!need()) return true;
          await s.reload();
          toast('已重新加载扩展、技能、提示模板与上下文文件', 'info', { timeout: 2000 });
          return true;
        case 'tools':
          if (!need()) return true;
          await this.toolsDialog();
          return true;
        case 'system-prompt': {
          if (!need()) return true;
          const r = await s.bridge('system-prompt');
          await alertBox('系统提示词', r.text || '(空)', { pre: true });
          return true;
        }
        case 'hotkeys':
          this.wb.showHotkeys();
          return true;
        case 'changelog':
          this.wb.openDoc('changelog');
          return true;
        case 'debug':
          this.showLog(s);
          return true;
        case 'bug':
          toast('/bug 需要终端界面，正在 Pi TUI 中打开当前会话，请在其中运行 /bug。', 'info');
          await this.openInTui(s);
          return true;
        case 'tui':
          await this.openInTui(s);
          return true;
        case 'quit':
          if (s) await this.closeChat(s);
          return true;
        default:
          return false;
      }
    } catch (err) {
      toast(err.message, 'error');
      return true;
    }
  }

  async sessionInfo(s) {
    await s.refreshStats();
    const st = s.stats || {};
    const state = s.state || {};
    const tk = st.tokens || {};
    const rows = [
      ['名称', state.sessionName || '-'],
      ['会话 ID', state.sessionId || '-'],
      ['文件', state.sessionFile || '(未持久化)'],
      ['模型', state.model ? `${state.model.provider}/${state.model.id}` : '-'],
      ['思考强度', state.thinkingLevel || '-'],
      ['消息', `${st.userMessages || 0} 用户 · ${st.assistantMessages || 0} 助手 · ${st.toolCalls || 0} 工具调用 · 共 ${st.totalMessages || 0}`],
      ['Tokens', `输入 ${fmtTokens(tk.input)} · 输出 ${fmtTokens(tk.output)} · 缓存读 ${fmtTokens(tk.cacheRead)} · 缓存写 ${fmtTokens(tk.cacheWrite)} · 合计 ${fmtTokens(tk.total)}`],
      ['费用', fmtCost(st.cost || 0)],
      ['上下文', st.contextUsage ? `${st.contextUsage.tokens === null ? '?' : fmtTokens(st.contextUsage.tokens)} / ${fmtTokens(st.contextUsage.contextWindow)}${st.contextUsage.percent !== null ? ` (${st.contextUsage.percent.toFixed(1)}%)` : ''}` : '-'],
      ['自动压缩', state.autoCompactionEnabled ? '开启' : '关闭'],
      ['Steering / Follow-up', `${state.steeringMode || '-'} / ${state.followUpMode || '-'}`],
      ['项目信任', s.trusted === undefined ? '-' : s.trusted ? '已信任' : '未信任'],
    ];
    const autoCompact = h('input', { type: 'checkbox', checked: !!state.autoCompactionEnabled });
    const autoRetry = h('input', { type: 'checkbox', checked: true });
    const steer = h('select.select', ['one-at-a-time', 'all'].map((v) => h('option', { value: v, selected: state.steeringMode === v }, v)));
    const follow = h('select.select', ['one-at-a-time', 'all'].map((v) => h('option', { value: v, selected: state.followUpMode === v }, v)));
    const r = await modal({
      title: '会话信息', wide: true,
      body: h('div',
        h('table.kv-table', rows.map(([k, v]) => h('tr', h('th', k), h('td.selectable', v)))),
        h('div.form-grid', { style: { marginTop: '14px' } },
          h('span.field-label', '自动压缩'), h('label.checkbox', autoCompact, '上下文接近上限时自动压缩'),
          h('span.field-label', '自动重试'), h('label.checkbox', autoRetry, '遇到过载/限流/5xx 时自动重试'),
          h('span.field-label', 'Steering 模式'), steer,
          h('span.field-label', 'Follow-up 模式'), follow)),
      buttons: [{ label: '关闭', value: false }, { label: '应用', value: true, primary: true }],
    });
    if (!r) return;
    await s.request({ type: 'set_auto_compaction', enabled: autoCompact.checked });
    await s.request({ type: 'set_auto_retry', enabled: autoRetry.checked });
    await s.request({ type: 'set_steering_mode', mode: steer.value });
    await s.request({ type: 'set_follow_up_mode', mode: follow.value });
    await s.fullSyncState();
  }

  async exportSession(s, arg) {
    let target = arg ? resolveIn(this.wb.folder, arg) : null;
    if (!target) {
      const name = (s.state.sessionName || 'session').replace(/[\\/:*?"<>|]/g, '_');
      target = await api.invoke('dialog:save', { defaultPath: `${this.wb.folder}/${name}.html`, filters: [{ name: 'HTML', extensions: ['html'] }, { name: 'JSONL', extensions: ['jsonl'] }] });
    }
    if (!target) return;
    if (/\.jsonl$/i.test(target)) {
      if (!s.sessionFile) { toast('会话未持久化，无法导出 JSONL', 'warning'); return; }
      await api.invoke('fs:copyFile', s.sessionFile, target);
    } else {
      await s.request({ type: 'export_html', outputPath: target });
    }
    toast(`已导出: ${target}`, 'info', { actions: [{ label: '打开', primary: true, run: () => api.invoke('shell:openPath', target) }, { label: '在文件夹中显示', run: () => api.invoke('shell:reveal', target) }] });
  }

  async shareSession(s) {
    if (!(await confirm('分享会话', '将把会话导出为 HTML 并上传为你 GitHub 账号下的私有 Gist（需要已安装并登录 gh）。\n会话中可能包含提示词、文件内容、命令输出及凭据，请先确认内容可以分享。', { okLabel: '上传' }))) return;
    const tmp = await api.invoke('os:tmpfile', 'session.html');
    await s.request({ type: 'export_html', outputPath: tmp });
    const t = toast('正在创建 Gist…', 'info', { timeout: 0 });
    try {
      const r = await api.invoke('share:gist', tmp);
      t.remove();
      toast(`分享链接: ${r.previewUrl}\nGist: ${r.gistUrl}`, 'info', { timeout: 0, actions: [{ label: '打开', primary: true, run: () => api.invoke('shell:openExternal', r.previewUrl) }, { label: '复制链接', run: () => api.invoke('clipboard:write', r.previewUrl) }] });
    } catch (err) {
      t.remove();
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------------------ /tree
  async treeDialog(s) {
    let data;
    try {
      data = await s.request({ type: 'get_tree' });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const leaf = data.leafId;
    const onPath = new Set();
    {
      const byId = new Map();
      const walk = (nodes) => { for (const n of nodes) { byId.set(n.entry.id, n); walk(n.children || []); } };
      walk(data.tree || []);
      let id = leaf;
      while (id && byId.has(id)) { onPath.add(id); id = byId.get(id).entry.parentId; }
    }
    const rows = [];
    const visible = (e) => e.type === 'message' ? ['user', 'assistant', 'bashExecution', 'custom'].includes(e.message.role) : ['branch_summary', 'compaction', 'custom_message'].includes(e.type);
    const describe = (e) => {
      if (e.type === 'message') {
        const m = e.message;
        if (m.role === 'user') return { role: 'user', text: stripFileBlocks(textOfContent(m.content)).replace(/\s+/g, ' ') };
        if (m.role === 'assistant') {
          const t = textOfContent(m.content).replace(/\s+/g, ' ');
          const tools = (m.content || []).filter((c) => c.type === 'toolCall').map((c) => c.name);
          return { role: 'assistant', text: t || (tools.length ? `[${tools.join(', ')}]` : m.stopReason === 'error' ? `[错误] ${m.errorMessage || ''}` : '') };
        }
        if (m.role === 'bashExecution') return { role: 'bash', text: `$ ${m.command}` };
        return { role: m.role, text: textOfContent(m.content) };
      }
      if (e.type === 'branch_summary') return { role: 'summary', text: e.summary };
      if (e.type === 'compaction') return { role: 'compact', text: e.summary };
      return { role: e.type, text: textOfContent(e.content) };
    };
    const walk = (nodes, prefix, depth) => {
      nodes.forEach((n, i) => {
        const e = n.entry;
        const last = i === nodes.length - 1;
        const branching = nodes.length > 1;
        if (visible(e)) {
          const d = describe(e);
          rows.push({ id: e.id, gutter: prefix + (branching ? (last ? '└─' : '├─') : ''), ...d, label: n.label, entry: e });
          walk(n.children || [], prefix + (branching ? (last ? '  ' : '│ ') : ''), depth + 1);
        } else {
          walk(n.children || [], prefix, depth);
        }
      });
    };
    walk(data.tree || [], '', 0);
    if (!rows.length) { toast('会话为空', 'info'); return; }
    let filter = 'default';
    let sel = Math.max(0, rows.findIndex((r) => r.id === leaf || onPath.has(r.id) && r === rows.filter((x) => onPath.has(x.id)).pop()));
    const listEl = h('div.tree-modal-list', { tabindex: 0 });
    const filterSel = h('select.select', { onchange: () => { filter = filterSel.value; renderList(); } },
      h('option', { value: 'default' }, '全部'), h('option', { value: 'user' }, '仅用户消息'), h('option', { value: 'labeled' }, '仅带标签'));
    const shown = () => rows.filter((r) => filter === 'default' || (filter === 'user' && r.role === 'user') || (filter === 'labeled' && r.label));
    const renderList = () => {
      clear(listEl);
      const list = shown();
      sel = Math.min(sel, list.length - 1);
      list.forEach((r, i) => {
        listEl.appendChild(h(`div.tm-row${i === sel ? '.selected' : ''}${onPath.has(r.id) ? '.on-path' : ''}${r.id === leaf ? '.leaf' : ''}`, {
          onclick: () => { sel = i; renderList(); },
          ondblclick: () => { sel = i; go(); },
        }, h('span.tm-gutter', r.gutter), h(`span.tm-role.${r.role}`, r.role), r.label ? h('span.tm-label', `[${r.label}] `) : null, h('span.tm-text', truncate(r.text, 200))));
      });
      const el = listEl.querySelector('.selected');
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    let closeModal;
    const go = async () => {
      const r = shown()[sel];
      if (!r) return;
      closeModal(r);
    };
    listEl.addEventListener('keydown', (e) => {
      const n = shown().length;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(n - 1, sel + 1); renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); renderList(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); }
      else if (e.key.toLowerCase() === 'l' && !e.ctrlKey) {
        e.preventDefault();
        const r = shown()[sel];
        if (r) promptBox('设置标签', { value: r.label || '' }).then(async (v) => { if (v !== undefined) { await s.setLabel(r.id, v.trim() || undefined); r.label = v.trim(); renderList(); } });
      }
    });
    renderList();
    const target = await modal({
      title: '会话树', wide: true,
      body: h('div', h('div.row', { style: { marginBottom: '8px' } }, h('span.muted.grow', '选择一个节点以切换到该位置。选择用户消息会把其内容放回输入框以便修改后重新发送。L 设置标签。'), filterSel), listEl),
      buttons: [{ label: '取消', value: undefined }, { label: '切换到此处', value: () => shown()[sel], primary: true }],
      onOpen: ({ close }) => { closeModal = close; setTimeout(() => listEl.focus(), 0); },
    });
    if (!target || target.id === leaf) return;
    // Ask about summarizing the branch being left.
    const settings = (await api.invoke('pi:settings:read', 'global').catch(() => ({ data: {} }))).data;
    let summarize = false;
    let customInstructions;
    if (!(settings.branchSummary && settings.branchSummary.skipPrompt)) {
      const choice = await modal({
        title: '为离开的分支生成摘要？',
        body: h('div', '摘要会附加到新位置，保留被放弃分支中的相关信息。'),
        buttons: [{ label: '不需要摘要', value: 'no' }, { label: '自定义摘要指令…', value: 'custom' }, { label: '生成摘要', value: 'yes', primary: true }],
      });
      if (!choice) return;
      if (choice === 'custom') {
        customInstructions = await promptBox('摘要指令', { placeholder: '例如：重点记录已尝试过的方案和失败原因' });
        if (customInstructions === undefined) return;
        summarize = true;
      } else summarize = choice === 'yes';
    }
    try {
      if (s.running) await s.abort();
      const r = await s.navigate(target.id, { summarize, customInstructions });
      if (r && r.cancelled) { toast('切换被取消', 'warning'); return; }
      if (target.role === 'user') this.composer.setText(stripFileBlocks(textOfContent(target.entry.message.content)).trim());
      toast('已切换分支', 'info', { timeout: 1500 });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------------------ persistence
  serialize() {
    return {
      sessions: this.sessions.filter((s) => s.sessionFile).map((s) => ({ file: s.sessionFile, title: s.title })),
      active: this.current && this.current.sessionFile ? this.current.sessionFile : null,
    };
  }

  async restore(state) {
    if (!state || !state.sessions || !state.sessions.length) return false;
    let activeSession = null;
    for (const it of state.sessions) {
      const st = await api.invoke('fs:stat', it.file).catch(() => ({ exists: false }));
      if (!st.exists) continue;
      const s = await this.newChat({ sessionFile: it.file, activate: false, lazy: true, title: it.title });
      if (!s) return false;
      if (state.active && samePath(state.active, it.file)) activeSession = s;
    }
    if (!this.sessions.length) return false;
    this.activate(activeSession || this.sessions[this.sessions.length - 1]);
    return true;
  }

  async disposeAll() {
    for (const s of this.sessions) await s.stop();
  }

  focus() {
    this.composer.focus();
  }
}

export { uid };
