// ChatSession: client-side model of one pi RPC process (one chat tab).
// Reconstructs the transcript from persisted session entries plus live streaming events.
import { api, Emitter, uid, textOfContent } from './util.js';

const MARKER = '__pidesktop__:';
let bridgeSeq = 0;

export class ChatSession extends Emitter {
  constructor({ sessionFile = null, title = '', mode = 'agent', approval = 'auto', approve } = {}) {
    super();
    this.key = uid('chat');
    this.rpcId = null;
    this.sessionFile = sessionFile;
    this.titleHint = title;
    this.status = 'idle'; // idle | starting | ready | exited | error
    this.startError = null;
    this.exitInfo = null;
    this.approve = approve; // true/false/undefined -> --approve / --no-approve
    this.state = {};
    this.entries = new Map();
    this.order = []; // entry ids in append order
    this.leafId = null;
    this.lastEntryId = null;
    this.liveTail = []; // messages ended but not yet seen in entries
    this.streaming = null; // partial assistant message
    this.toolLive = new Map(); // toolCallId -> {status, args, partial, result, isError, durationMs, toolName}
    this.bashLive = new Map(); // request id -> {command, output, running, exclude}
    this.approvals = new Map(); // toolCallId -> ui request id
    this.queue = { steering: [], followUp: [] };
    this.running = false;
    this.compacting = null;
    this.retry = null;
    this.stats = null;
    this.contextUsage = null;
    this.commands = [];
    this.models = null;
    this.thinkingLevels = ['off'];
    this.statuses = new Map();
    this.widgets = new Map();
    this.extTitle = null;
    this.changes = [];
    this.mode = mode;
    this.approval = approval;
    this.tools = [];
    this.activeTools = [];
    this.unread = false;
    this.stderr = '';
    this.pendingBridge = new Map();
    this.syncing = null;
    this.syncAgain = false;
    this.lastUsage = null;
    this.promptHistory = [];
    this.editorTextRequest = null;
    this._unsubs = [];
  }

  get title() {
    return this.state.sessionName || this.extTitle || this.titleHint || this.firstUserText() || '新聊天';
  }

  firstUserText() {
    for (const e of this.branch()) {
      if (e && e.type === 'message' && e.message.role === 'user') {
        const t = stripFileBlocks(textOfContent(e.message.content)).trim();
        if (t) return t.slice(0, 60);
      }
    }
    for (const m of this.liveTail) if (m.role === 'user') return stripFileBlocks(textOfContent(m.content)).slice(0, 60);
    return '';
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    if (this.status === 'starting' || this.status === 'ready') return;
    this.status = 'starting';
    this.startError = null;
    this.exitInfo = null;
    this.emit('change');
    this._bindIpc();
    try {
      const r = await api.invoke('session:create', { sessionFile: this.sessionFile || undefined, approve: this.approve });
      this.rpcId = r.id;
      this.state = r.state || {};
      this.sessionFile = this.state.sessionFile || this.sessionFile;
      this.status = 'ready';
      this.emit('change');
      await Promise.all([this.fullSync(), this.refreshCommands(), this.refreshStats(), this.refreshThinkingLevels()]);
      await this.refreshInfo();
      if (this.mode === 'ask') await this.setMode('ask', true);
      if (this.approval === 'ask') await this.setApproval('ask', true);
      this.emit('ready');
    } catch (err) {
      this.status = 'error';
      this.startError = err.message;
      this.emit('change');
    }
  }

  _bindIpc() {
    if (this._unsubs.length) return;
    this._unsubs.push(api.on('session:event', ({ id, rec }) => { if (id === this.rpcId) this.onEvent(rec); }));
    this._unsubs.push(api.on('session:desktop', ({ id, msg }) => { if (id === this.rpcId) this.onDesktop(msg); }));
    this._unsubs.push(api.on('session:stderr', ({ id, text }) => {
      if (id !== this.rpcId) return;
      this.stderr = (this.stderr + text).slice(-200000);
      this.emit('stderr', text);
    }));
    this._unsubs.push(api.on('session:changes', ({ id, changes }) => {
      if (id !== this.rpcId) return;
      this.changes = changes;
      this.emit('changes');
    }));
    this._unsubs.push(api.on('session:exit', ({ id, code, signal, stderr }) => {
      if (id !== this.rpcId) return;
      this.status = 'exited';
      this.running = false;
      this.streaming = null;
      this.exitInfo = { code, signal, stderr };
      for (const [, p] of this.pendingBridge) p.reject(new Error('pi 进程已退出'));
      this.pendingBridge.clear();
      this.emit('change');
      this.emit('exit');
    }));
  }

  async stop() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this.rpcId && this.status === 'ready') await api.invoke('session:stop', this.rpcId).catch(() => {});
    this.status = 'idle';
  }

  async restart() {
    await this.stop();
    this.rpcId = null;
    this.entries.clear();
    this.order = [];
    this.liveTail = [];
    this.streaming = null;
    this.toolLive.clear();
    this.running = false;
    await this.start();
  }

  // ------------------------------------------------------------------ RPC helpers
  request(command, timeoutMs = 0) {
    if (!this.rpcId || this.status !== 'ready') return Promise.reject(new Error('会话未运行'));
    return api.invoke('session:request', this.rpcId, command, timeoutMs);
  }

  send(record) {
    if (this.rpcId) api.invoke('session:send', this.rpcId, record);
  }

  bridge(op, payload = {}, timeoutMs = 600000) {
    const reqId = `b${++bridgeSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBridge.delete(reqId);
        reject(new Error(`bridge ${op} 超时`));
      }, timeoutMs);
      this.pendingBridge.set(reqId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.request({ type: 'prompt', message: `/__desktop ${op} ${JSON.stringify({ ...payload, reqId })}` }).catch((err) => {
        const p = this.pendingBridge.get(reqId);
        if (p) {
          this.pendingBridge.delete(reqId);
          p.reject(err);
        }
      });
    });
  }

  onDesktop(msg) {
    if (msg.kind === 'reply') {
      const p = this.pendingBridge.get(msg.reqId);
      if (!p) return;
      this.pendingBridge.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || 'bridge error'));
    }
  }

  // ------------------------------------------------------------------ sync
  async fullSync() {
    const st = await this.request({ type: 'get_state' });
    this.state = st || {};
    this.sessionFile = this.state.sessionFile || this.sessionFile;
    this.running = !!this.state.isStreaming;
    const r = await this.request({ type: 'get_entries' });
    this.entries.clear();
    this.order = [];
    this._ingest(r.entries || []);
    this.leafId = r.leafId;
    this._dedupeTail();
    this.emit('change');
  }

  scheduleSync() {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this._incrementalSync();
        } while (this.syncAgain);
      } catch (err) {
        console.warn('sync failed', err);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async _incrementalSync() {
    if (this.status !== 'ready') return;
    const st = await this.request({ type: 'get_state' });
    const fileChanged = (st && st.sessionId) !== this.state.sessionId;
    this.state = st || {};
    this.sessionFile = this.state.sessionFile || this.sessionFile;
    if (fileChanged || !this.lastEntryId) {
      const r = await this.request({ type: 'get_entries' });
      this.entries.clear();
      this.order = [];
      this._ingest(r.entries || []);
      this.leafId = r.leafId;
    } else {
      let r;
      try {
        r = await this.request({ type: 'get_entries', since: this.lastEntryId });
      } catch {
        r = await this.request({ type: 'get_entries' });
        this.entries.clear();
        this.order = [];
      }
      this._ingest(r.entries || []);
      this.leafId = r.leafId;
    }
    this._dedupeTail();
    this.emit('change');
  }

  _ingest(list) {
    for (const e of list) {
      if (!e || !e.id) continue;
      if (!this.entries.has(e.id)) this.order.push(e.id);
      this.entries.set(e.id, e);
      this.lastEntryId = e.id;
    }
  }

  _dedupeTail() {
    if (!this.liveTail.length) return;
    const seen = new Set();
    for (const id of this.order) {
      const e = this.entries.get(id);
      if (e && e.type === 'message' && e.message) seen.add(`${e.message.role}:${e.message.timestamp}`);
    }
    this.liveTail = this.liveTail.filter((m) => !seen.has(`${m.role}:${m.timestamp}`));
  }

  /** Entries on the active branch, root -> leaf. */
  branch() {
    const out = [];
    let id = this.leafId;
    const guard = new Set();
    while (id && this.entries.has(id) && !guard.has(id)) {
      guard.add(id);
      const e = this.entries.get(id);
      out.push(e);
      id = e.parentId;
    }
    return out.reverse();
  }

  labels() {
    const map = new Map();
    for (const id of this.order) {
      const e = this.entries.get(id);
      if (e.type === 'label') {
        if (e.label) map.set(e.targetId, e.label);
        else map.delete(e.targetId);
      }
    }
    return map;
  }

  async refreshCommands() {
    try {
      const r = await this.request({ type: 'get_commands' });
      this.commands = (r.commands || []).filter((c) => c.name !== '__desktop');
      this.emit('commands');
    } catch { /* ignore */ }
  }

  async refreshStats() {
    try {
      this.stats = await this.request({ type: 'get_session_stats' });
      if (this.stats && this.stats.contextUsage) this.contextUsage = this.stats.contextUsage;
      this.emit('stats');
    } catch { /* ignore */ }
  }

  async refreshThinkingLevels() {
    try {
      const r = await this.request({ type: 'get_available_thinking_levels' });
      this.thinkingLevels = r.levels || ['off'];
    } catch { /* ignore */ }
  }

  async refreshInfo() {
    try {
      const info = await this.bridge('info', {}, 20000);
      this.tools = info.tools || [];
      this.activeTools = info.activeTools || [];
      if (info.contextUsage) this.contextUsage = info.contextUsage;
      this.trusted = info.trusted;
      this.emit('stats');
    } catch { /* ignore */ }
  }

  async getModels(force = false) {
    if (!this.models || force) {
      const r = await this.request({ type: 'get_available_models' });
      this.models = r.models || [];
    }
    return this.models;
  }

  // ------------------------------------------------------------------ events
  onEvent(rec) {
    switch (rec.type) {
      case 'agent_start':
        this.running = true;
        this.emit('running');
        break;
      case 'agent_end':
        break;
      case 'agent_settled':
        this.running = false;
        this.streaming = null;
        this.retry = null;
        this.scheduleSync().then(() => this.refreshStats());
        this.emit('settled', rec);
        this.emit('running');
        break;
      case 'turn_end':
        this.refreshStats();
        break;
      case 'message_start':
        if (rec.message && rec.message.role === 'assistant') {
          this.streaming = { ...rec.message, content: [] };
          this.streamVersion = 0;
        } else if (rec.message) {
          this._pushTail(rec.message);
        }
        this.emit('stream');
        break;
      case 'message_update':
        this._applyDelta(rec.assistantMessageEvent);
        if (rec.usage) this.lastUsage = rec.usage;
        this.emit('stream');
        break;
      case 'message_end':
        if (rec.message) {
          if (rec.message.role === 'assistant') this.streaming = null;
          this._pushTail(rec.message);
        }
        this.emit('change');
        this.scheduleSync();
        break;
      case 'tool_execution_start':
        this.toolLive.set(rec.toolCallId, { status: 'running', toolName: rec.toolName, args: rec.args, parent: rec.parentToolCallId, started: Date.now() });
        this.emit('tool', rec.toolCallId);
        break;
      case 'tool_execution_update': {
        const t = this.toolLive.get(rec.toolCallId) || { toolName: rec.toolName, args: rec.args };
        t.partial = rec.partialResult;
        t.status = 'running';
        this.toolLive.set(rec.toolCallId, t);
        this.emit('tool', rec.toolCallId);
        break;
      }
      case 'tool_execution_end': {
        const t = this.toolLive.get(rec.toolCallId) || { toolName: rec.toolName };
        t.status = rec.isError ? 'error' : 'done';
        t.result = rec.result;
        t.isError = rec.isError;
        t.durationMs = rec.durationMs;
        this.toolLive.set(rec.toolCallId, t);
        this.approvals.delete(rec.toolCallId);
        this.emit('tool', rec.toolCallId);
        break;
      }
      case 'queue_update':
        this.queue = { steering: rec.steering || [], followUp: rec.followUp || [] };
        this.emit('queue');
        break;
      case 'compaction_start':
        this.compacting = rec.reason || 'manual';
        this.emit('status');
        break;
      case 'compaction_end':
        this.compacting = null;
        if (rec.errorMessage) this.emit('notify', { message: `压缩失败: ${rec.errorMessage}`, type: 'error' });
        else if (rec.aborted) this.emit('notify', { message: '压缩已取消', type: 'info' });
        this.scheduleSync().then(() => this.refreshStats());
        this.emit('status');
        break;
      case 'auto_retry_start':
        this.retry = { attempt: rec.attempt, maxAttempts: rec.maxAttempts, delayMs: rec.delayMs, errorMessage: rec.errorMessage, at: Date.now() };
        this.emit('status');
        break;
      case 'auto_retry_end':
        this.retry = null;
        if (!rec.success && rec.finalError) this.emit('notify', { message: `重试失败: ${rec.finalError}`, type: 'error' });
        this.emit('status');
        break;
      case 'summarization_retry_scheduled':
        this.retry = { attempt: rec.attempt, maxAttempts: rec.maxAttempts, delayMs: rec.delayMs, errorMessage: rec.errorMessage, at: Date.now(), summary: true };
        this.emit('status');
        break;
      case 'summarization_retry_finished':
        this.retry = null;
        this.emit('status');
        break;
      case 'session_info_changed':
        this.state.sessionName = rec.name;
        this.emit('change');
        this.emit('title');
        break;
      case 'thinking_level_changed':
        this.state.thinkingLevel = rec.level;
        this.emit('stats');
        break;
      case 'entry_appended':
        this.scheduleSync();
        break;
      case 'bash_execution_update': {
        const b = this.bashLive.get(rec.id);
        if (b) {
          b.output += rec.delta || '';
          this.emit('bash', rec.id);
        }
        break;
      }
      case 'extension_error':
        this.emit('notify', { message: `扩展错误 (${shortPath(rec.extensionPath)} · ${rec.event}):\n${rec.error}`, type: 'error' });
        break;
      case 'extension_ui_request':
        this._onUiRequest(rec);
        break;
      default:
        break;
    }
  }

  _pushTail(message) {
    const key = `${message.role}:${message.timestamp}`;
    const idx = this.liveTail.findIndex((m) => `${m.role}:${m.timestamp}` === key);
    if (idx === -1) this.liveTail.push(message);
    else this.liveTail[idx] = message;
  }

  _applyDelta(ev) {
    if (!ev || !this.streaming) return;
    const c = this.streaming.content;
    const i = ev.contentIndex;
    switch (ev.type) {
      case 'text_start': c[i] = { type: 'text', text: '' }; break;
      case 'text_delta': if (!c[i]) c[i] = { type: 'text', text: '' }; c[i].text += ev.delta || ''; break;
      case 'text_end': c[i] = { type: 'text', ...(c[i] || {}), text: typeof ev.content === 'string' ? ev.content : (c[i] && c[i].text) || '' }; break;
      case 'thinking_start': c[i] = { type: 'thinking', thinking: '' }; break;
      case 'thinking_delta': if (!c[i]) c[i] = { type: 'thinking', thinking: '' }; c[i].thinking += ev.delta || ''; break;
      case 'thinking_end': c[i] = { type: 'thinking', ...(c[i] || {}), thinking: typeof ev.content === 'string' ? ev.content : (c[i] && c[i].thinking) || '' }; break;
      case 'toolcall_start': c[i] = { type: 'toolCall', id: ev.id, name: ev.toolName, arguments: {}, _argsText: '', _streaming: true }; break;
      case 'toolcall_delta':
        if (c[i]) {
          c[i]._argsText = (c[i]._argsText || '') + (ev.delta || '');
          const partial = parsePartialJson(c[i]._argsText);
          if (partial) c[i].arguments = partial;
        }
        break;
      case 'toolcall_end': c[i] = { ...(ev.toolCall || c[i]), type: 'toolCall' }; break;
      default: break;
    }
    this.streamVersion = (this.streamVersion || 0) + 1;
  }

  _onUiRequest(rec) {
    switch (rec.method) {
      case 'notify':
        this.emit('notify', { message: rec.message, type: rec.notifyType || 'info' });
        break;
      case 'setStatus':
        if (rec.statusText === undefined || rec.statusText === null || rec.statusText === '') this.statuses.delete(rec.statusKey);
        else this.statuses.set(rec.statusKey, rec.statusText);
        this.emit('status');
        break;
      case 'setWidget':
        if (!rec.widgetLines) this.widgets.delete(rec.widgetKey);
        else this.widgets.set(rec.widgetKey, { lines: rec.widgetLines, placement: rec.widgetPlacement || 'aboveEditor' });
        this.emit('status');
        break;
      case 'setTitle':
        this.extTitle = rec.title;
        this.emit('title');
        break;
      case 'set_editor_text':
        this.emit('editorText', rec.text);
        break;
      case 'select':
        if (typeof rec.title === 'string' && rec.title.startsWith(MARKER)) {
          try {
            const info = JSON.parse(rec.title.slice(MARKER.length));
            if (info.kind === 'approve') {
              this.approvals.set(info.toolCallId, rec.id);
              this.emit('tool', info.toolCallId);
              this.emit('approval', info);
              return;
            }
          } catch { /* fallthrough */ }
        }
        this.emit('dialog', rec);
        break;
      case 'confirm':
      case 'input':
      case 'editor':
        this.emit('dialog', rec);
        break;
      default:
        break;
    }
  }

  respondUi(id, response) {
    this.send({ type: 'extension_ui_response', id, ...response });
  }

  approveTool(toolCallId, allow) {
    const reqId = this.approvals.get(toolCallId);
    if (!reqId) return;
    this.approvals.delete(toolCallId);
    this.respondUi(reqId, { value: allow ? 'Run' : 'Reject' });
    this.emit('tool', toolCallId);
  }

  // ------------------------------------------------------------------ actions
  async prompt(text, images, behavior) {
    const cmd = { type: 'prompt', message: text };
    if (images && images.length) cmd.images = images;
    if (this.running && !text.startsWith('/')) cmd.streamingBehavior = behavior || 'steer';
    if (text.trim()) this.promptHistory.push(text);
    return this.request(cmd);
  }

  async steer(text, images) {
    return this.request({ type: 'steer', message: text, images: images && images.length ? images : undefined });
  }

  async followUp(text, images) {
    return this.request({ type: 'follow_up', message: text, images: images && images.length ? images : undefined });
  }

  async abort() {
    return this.request({ type: 'abort' });
  }

  async clearQueue() {
    return this.request({ type: 'clear_queue' });
  }

  async bash(command, excludeFromContext) {
    const id = uid('bash');
    this.bashLive.set(id, { command, output: '', running: true, exclude: excludeFromContext, started: Date.now() });
    this.emit('change');
    try {
      const r = await this.request({ type: 'bash', id, command, excludeFromContext: !!excludeFromContext });
      const b = this.bashLive.get(id);
      if (b) { b.running = false; b.result = r; }
      await this.scheduleSync();
      return r;
    } finally {
      this.bashLive.delete(id);
      this.emit('change');
    }
  }

  async abortBash() {
    return this.request({ type: 'abort_bash' });
  }

  async setModel(provider, modelId) {
    const m = await this.request({ type: 'set_model', provider, modelId });
    this.state.model = m;
    await this.refreshThinkingLevels();
    await this.fullSyncState();
    this.emit('stats');
    return m;
  }

  async fullSyncState() {
    try {
      this.state = await this.request({ type: 'get_state' });
    } catch { /* ignore */ }
  }

  async setThinking(level) {
    await this.request({ type: 'set_thinking_level', level });
    this.state.thinkingLevel = level;
    this.emit('stats');
  }

  async cycleThinking() {
    const r = await this.request({ type: 'cycle_thinking_level' });
    if (r && r.level) this.state.thinkingLevel = r.level;
    this.emit('stats');
    return r;
  }

  async setMode(mode, silent) {
    const r = await this.bridge('mode', { mode });
    this.mode = mode;
    this.activeTools = r.activeTools || this.activeTools;
    if (!silent) this.emit('stats');
    return r;
  }

  async setApproval(mode, silent) {
    await this.bridge('approval', { mode });
    this.approval = mode;
    if (!silent) this.emit('stats');
  }

  async navigate(targetId, opts = {}) {
    const r = await this.bridge('navigate', { targetId, ...opts }, 900000);
    await this.scheduleSync();
    this.liveTail = [];
    this.emit('change');
    return r;
  }

  async setLabel(entryId, label) {
    await this.bridge('label', { entryId, label });
    await this.scheduleSync();
  }

  async reload() {
    await this.bridge('reload', {});
    // Runtime got replaced: wait a moment and refresh everything.
    await new Promise((r) => setTimeout(r, 400));
    await Promise.all([this.refreshCommands(), this.fullSync()]);
    await this.refreshInfo();
    if (this.mode === 'ask') await this.setMode('ask', true).catch(() => {});
    if (this.approval === 'ask') await this.setApproval('ask', true).catch(() => {});
  }

  async newSession() {
    const r = await this.request({ type: 'new_session' });
    this.liveTail = [];
    this.toolLive.clear();
    await this.fullSync();
    await this.refreshStats();
    this.emit('title');
    return r;
  }

  async switchSession(file) {
    const r = await this.request({ type: 'switch_session', sessionPath: file });
    this.liveTail = [];
    this.toolLive.clear();
    await this.fullSync();
    await this.refreshStats();
    this.emit('title');
    return r;
  }

  async fork(entryId) {
    const r = await this.request({ type: 'fork', entryId });
    this.liveTail = [];
    await this.fullSync();
    this.emit('title');
    return r;
  }

  async clone() {
    const r = await this.request({ type: 'clone' });
    this.liveTail = [];
    await this.fullSync();
    this.emit('title');
    return r;
  }

  async compact(customInstructions) {
    const cmd = { type: 'compact' };
    if (customInstructions) cmd.customInstructions = customInstructions;
    this.compacting = 'manual';
    this.emit('status');
    try {
      return await this.request(cmd);
    } finally {
      this.compacting = null;
      this.emit('status');
      await this.scheduleSync();
      await this.refreshStats();
    }
  }

  async setName(name) {
    await this.request({ type: 'set_session_name', name });
    this.state.sessionName = name;
    this.emit('title');
    this.emit('change');
  }
}

export function stripFileBlocks(text) {
  return String(text || '').replace(/<file name="[^"]*">[\s\S]*?<\/file>\n?/g, '').replace(/<selection [^>]*>[\s\S]*?<\/selection>\n?/g, '');
}

export function parseFileBlocks(text) {
  const files = [];
  const re = /<(file|selection) ([^>]*)>([\s\S]*?)<\/\1>\n?/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const attrs = {};
    m[2].replace(/(\w+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v; });
    files.push({ kind: m[1], name: attrs.name || attrs.path || '', lines: attrs.lines, size: m[3].length });
  }
  return files;
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts.slice(-2).join('/');
}

/** Best-effort parse of an incomplete JSON object (for streaming tool arguments). */
export function parsePartialJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* continue */ }
  let s = text;
  let inStr = false;
  let esc = false;
  const stack = [];
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (esc) s = s.slice(0, -1);
  if (inStr) s += '"';
  s = s.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
  s += stack.reverse().join('');
  try { return JSON.parse(s); } catch { return null; }
}
