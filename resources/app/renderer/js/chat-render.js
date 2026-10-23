// Transcript rendering: turns session entries + live events into keyed items and DOM nodes.
import { h, icon, iconBtn, basename, dirname, relative, resolveIn, textOfContent, fmtTokens, fmtCost, fmtDuration, truncate } from './util.js';
import { renderMarkdown } from './markdown.js';
import { stripFileBlocks, parseFileBlocks } from './session.js';
import { lightbox } from './ui.js';

const MAX_BODY_CHARS = 60000;

// ---------------------------------------------------------------------------------------------
// Item model
// ---------------------------------------------------------------------------------------------

function msgKey(m) {
  return `m:${m.role}:${m.timestamp}`;
}

export function buildItems(s, view) {
  const items = [];
  const branch = s.branch();
  const labels = s.labels();
  const results = new Map();
  const seen = new Set();
  const flat = []; // {kind:'msg', message, entryId} | {kind:'entry', entry}
  let sawMessage = false;
  for (const e of branch) {
    if (e.type === 'message' && e.message) {
      flat.push({ kind: 'msg', message: e.message, entryId: e.id });
      seen.add(msgKey(e.message));
    } else if (e.type === 'custom_message') {
      if (e.display) flat.push({ kind: 'entry', entry: e });
    } else if (['compaction', 'branch_summary', 'model_change'].includes(e.type)) {
      flat.push({ kind: 'entry', entry: e });
    }
  }
  for (const m of s.liveTail) {
    if (!seen.has(msgKey(m))) {
      flat.push({ kind: 'msg', message: m, entryId: null });
      seen.add(msgKey(m));
    }
  }
  if (s.streaming && !seen.has(msgKey(s.streaming))) flat.push({ kind: 'msg', message: s.streaming, entryId: null, streaming: true });
  for (const f of flat) {
    if (f.kind === 'msg' && f.message.role === 'toolResult') results.set(f.message.toolCallId, f.message);
  }

  for (let idx = 0; idx < flat.length; idx++) {
    const f = flat[idx];
    if (f.kind === 'entry') {
      const e = f.entry;
      if (e.type === 'model_change') {
        if (sawMessage) items.push({ key: `e:${e.id}`, kind: 'divider', text: `模型切换为 ${e.provider}/${e.modelId}`, sig: 'f' });
        continue;
      }
      if (e.type === 'compaction') items.push({ key: `e:${e.id}`, kind: 'compaction', entry: e, sig: 'f' });
      else if (e.type === 'branch_summary') items.push({ key: `e:${e.id}`, kind: 'branchSummary', entry: e, sig: 'f' + (view.noteOpen.has(e.id) ? 'o' : '') });
      else if (e.type === 'custom_message') items.push({ key: `e:${e.id}`, kind: 'custom', entry: e, sig: 'f' + (view.noteOpen.has(e.id) ? 'o' : '') });
      continue;
    }
    const m = f.message;
    const k = msgKey(m);
    if (m.role === 'user') {
      sawMessage = true;
      const label = f.entryId ? labels.get(f.entryId) || '' : '';
      const editing = view.editingKey === k;
      items.push({ key: k, kind: 'user', message: m, entryId: f.entryId, label, sig: `u${f.entryId || ''}|${label}|${editing ? 'e' : ''}|${view.userOpen.has(k) ? 'o' : ''}` });
    } else if (m.role === 'assistant') {
      sawMessage = true;
      const content = Array.isArray(m.content) ? m.content : [];
      content.forEach((c, i) => {
        if (!c) return;
        if (c.type === 'text') {
          if (!c.text && !f.streaming) return;
          items.push({ key: `${k}:t${i}`, kind: 'text', text: c.text || '', streaming: !!f.streaming, sig: f.streaming ? `s${(c.text || '').length}` : 'f' });
        } else if (c.type === 'thinking') {
          if (!view.showThinking) return;
          if (!c.thinking && !c.redacted && !f.streaming) return;
          const open = view.thinkingOpen.has(`${k}:${i}`);
          const isLast = f.streaming && i === content.length - 1;
          items.push({ key: `${k}:th${i}`, kind: 'thinking', block: c, streaming: isLast, openKey: `${k}:${i}`, sig: `${isLast ? 's' + (c.thinking || '').length : 'f'}|${open ? 'o' : ''}` });
        } else if (c.type === 'toolCall') {
          const live = s.toolLive.get(c.id);
          const result = results.get(c.id);
          const approval = s.approvals.has(c.id);
          const expanded = isToolExpanded(view, c, live, result);
          const status = approval ? 'approval' : result ? (result.isError ? 'error' : 'done') : live ? live.status : f.streaming && c._streaming ? 'streaming' : (s.running ? 'pending' : 'unknown');
          const partialLen = live && live.partial ? JSON.stringify(live.partial).length : 0;
          items.push({
            key: `tool:${c.id}`, kind: 'tool', call: c, live, result, status, expanded, entryId: f.entryId,
            sig: `${status}|${expanded ? 1 : 0}|${c._argsText ? c._argsText.length : 'f'}|${partialLen}|${result ? 1 : 0}`,
          });
        }
      });
      const terminal = m.stopReason && m.stopReason !== 'pending' && !f.streaming;
      const next = flat[idx + 1];
      const lastOfTurn = !next || (next.kind === 'msg' && next.message.role === 'user') || next.kind === 'entry';
      if (terminal && (m.stopReason === 'error' || m.stopReason === 'aborted' || m.stopReason === 'length' || (lastOfTurn && m.stopReason !== 'toolUse'))) {
        items.push({ key: `${k}:foot`, kind: 'afoot', message: m, sig: `${m.stopReason}|${lastOfTurn ? 1 : 0}` });
      }
    } else if (m.role === 'bashExecution') {
      sawMessage = true;
      items.push({ key: k, kind: 'bashExec', message: m, sig: `f|${view.toolExpand.get(k) ? 1 : 0}` });
    } else if (m.role === 'custom') {
      if (m.display === false) continue;
      items.push({ key: k, kind: 'customMsg', message: m, sig: 'f' + (view.noteOpen.has(k) ? 'o' : '') });
    }
  }
  for (const [id, b] of s.bashLive) {
    items.push({ key: `bash:${id}`, kind: 'bashLive', bash: b, sig: `${b.output.length}|${b.running ? 1 : 0}` });
  }
  return items;
}

function isToolExpanded(view, call, live, result) {
  const user = view.toolExpand.get(`tool:${call.id}`);
  if (user !== undefined) return user;
  if (view.expandAll) return true;
  const name = call.name;
  if (name === 'edit') return true;
  if (name === 'bash' || name === 'powershell') return !result && !!live; // show while running
  return false;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export function renderItem(item, view) {
  switch (item.kind) {
    case 'user': return renderUser(item, view);
    case 'text': return renderText(item);
    case 'thinking': return renderThinking(item, view);
    case 'tool': return renderTool(item, view);
    case 'afoot': return renderAssistantFoot(item, view);
    case 'bashExec': return renderBashExec(item, view);
    case 'bashLive': return renderBashLive(item, view);
    case 'customMsg': return renderNote(item.key, `扩展消息 · ${item.message.customType}`, textOfContent(item.message.content), view, 'extensions');
    case 'custom': return renderNote(item.entry.id, `扩展消息 · ${item.entry.customType}`, textOfContent(item.entry.content), view, 'extensions');
    case 'branchSummary': return renderNote(item.entry.id, '分支摘要', item.entry.summary, view, 'repo-forked');
    case 'compaction': return renderCompaction(item, view);
    case 'divider': return h('div.divider', item.text);
    default: return h('div');
  }
}

function renderUser(item, view) {
  const m = item.message;
  const raw = typeof m.content === 'string' ? m.content : textOfContent(m.content);
  const files = parseFileBlocks(raw);
  const text = stripFileBlocks(raw).trim();
  const images = Array.isArray(m.content) ? m.content.filter((c) => c.type === 'image') : [];
  if (view.editingKey === item.key) return view.renderEditor(item, text);
  const long = text.length > 1500 && !view.userOpen.has(item.key);
  const wrap = h('div.msg');
  const bubble = h('div.msg-user', { title: item.entryId ? '' : '' },
    long ? text.slice(0, 1500) + '…' : text,
    long ? h('div', h('a', { onclick: () => { view.userOpen.add(item.key); view.refresh(); } }, '展开全部')) : null,
    files.length || images.length ? h('div.attach-row',
      files.map((f) => h('span.chip', { title: f.name, onclick: () => view.hooks.openFile(f.name) }, icon(f.kind === 'selection' ? 'list-selection' : 'file'), h('span.chip-label', basename(f.name) + (f.lines ? `:${f.lines}` : '')))),
      images.map((img) => {
        const src = `data:${img.mimeType};base64,${img.data}`;
        return h('img.thumb', { src, onclick: () => lightbox(src) });
      })) : null,
    h('div.msg-actions',
      iconBtn('copy', '复制', () => view.actions.copy(text)),
      item.entryId ? iconBtn('edit', '编辑并重新发送（创建分支）', () => view.actions.editUser(item)) : null,
      item.entryId ? iconBtn('discard', '恢复检查点：撤销此消息之后 Agent 对文件的修改', () => view.actions.restoreCheckpoint(item)) : null,
      item.entryId ? iconBtn('repo-forked', '从此处分叉为新会话 (/fork)', () => view.actions.fork(item)) : null,
      item.entryId ? iconBtn('tag', '设置标签', () => view.actions.label(item)) : null));
  bubble.addEventListener('dblclick', () => item.entryId && view.actions.editUser(item));
  wrap.appendChild(bubble);
  if (item.label) wrap.appendChild(h('div.msg-meta', h('span.msg-label', icon('tag'), ' ', item.label)));
  return wrap;
}

function renderText(item) {
  const el = h('div.msg.msg-assistant', h('div.md.selectable'));
  renderMarkdown(el.firstChild, item.text, { streaming: item.streaming });
  if (item.streaming) el.firstChild.classList.add('streaming-cursor');
  return el;
}

function renderThinking(item, view) {
  const b = item.block;
  const open = item.streaming || view.thinkingOpen.has(item.openKey);
  const words = (b.thinking || '').length;
  const el = h(`div.msg.thinking${open ? '' : '.collapsed'}`,
    h('div.th-head', { onclick: () => {
      if (view.thinkingOpen.has(item.openKey)) view.thinkingOpen.delete(item.openKey);
      else view.thinkingOpen.add(item.openKey);
      view.refresh();
    } }, icon(open ? 'chevron-down' : 'chevron-right'), item.streaming ? h('span.pulse', '思考中…') : h('span', b.redacted && !b.thinking ? '思考（已加密）' : `已思考 · ${words} 字`)),
    h('div.th-body.selectable', b.thinking || ''));
  const body = el.querySelector('.th-body');
  // 记录用户是否停留在思考框底部：向上翻阅时不再被强制拉到底
  body.addEventListener('scroll', () => { body._pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 8; });
  return el;
}

// 流式思考块的原地更新：只改文字，不重建节点，避免滚动位置归零与动画重置造成闪烁
export function updateThinking(el, item) {
  const body = el.querySelector('.th-body');
  if (!body) return;
  const text = item.block.thinking || '';
  if (body.firstChild && body.firstChild.nodeType === 3) {
    if (body.firstChild.data !== text) body.firstChild.data = text;
  } else if (body.textContent !== text) {
    body.textContent = text;
  }
}

// 节点已挂载后同步滚到思考框底部（用户手动上翻时不打扰）
export function pinThinking(el) {
  const body = el.querySelector('.th-body');
  if (body && body._pinned !== false) body.scrollTop = body.scrollHeight;
}

function renderAssistantFoot(item, view) {
  const m = item.message;
  const u = m.usage || {};
  const parts = [];
  if (m.model) parts.push(m.responseModel || m.model);
  if (u.input || u.output) parts.push(`↑${fmtTokens((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0))} ↓${fmtTokens(u.output || 0)}`);
  if (u.cost && u.cost.total) parts.push(fmtCost(u.cost.total));
  const el = h('div.msg.msg-assistant',
    m.stopReason === 'error' ? h('div.error-box.selectable', m.errorMessage || '请求失败') : null,
    m.stopReason === 'aborted' ? h('div.aborted', '已中止') : null,
    m.stopReason === 'length' ? h('div.aborted', '输出达到长度上限，已截断') : null,
    h(`div.msg-foot${m.stopReason === 'error' ? '.visible' : ''}`,
      iconBtn('copy', '复制回复', () => view.actions.copyAssistant(m)),
      iconBtn('refresh', '重新生成（创建分支）', () => view.actions.retry(m)),
      h('span.ellipsis', parts.join(' · '))));
  return el;
}

function renderNote(id, title, body, view, iconName) {
  const open = view.noteOpen.has(id);
  return h(`div.msg-note${open ? '' : '.collapsed'}`,
    h('div.note-head', { onclick: () => { if (open) view.noteOpen.delete(id); else view.noteOpen.add(id); view.refresh(); } }, icon(open ? 'chevron-down' : 'chevron-right'), icon(iconName), h('span', title)),
    h('div.note-body.selectable', open ? renderMarkdown(h('div.md'), body) : null));
}

function renderCompaction(item, view) {
  const e = item.entry;
  return h('div.divider', h('a', { title: '查看摘要', onclick: () => view.actions.showSummary('上下文压缩摘要', e.summary) }, icon('fold'), ` 上下文已压缩 · 之前 ${fmtTokens(e.tokensBefore)} tokens`));
}

// ---------------------------------------------------------------- tools

const TOOL_ICONS = { read: 'file', bash: 'terminal', powershell: 'terminal-powershell', edit: 'edit', write: 'new-file', grep: 'search', find: 'search', ls: 'list-tree', codemode: 'code', tool_search: 'search' };
const TOOL_NAMES = { read: '读取', bash: '运行', powershell: 'PowerShell', edit: '编辑', write: '写入', grep: '搜索', find: '查找文件', ls: '列目录' };

function statusIcon(status) {
  switch (status) {
    case 'running': case 'streaming': case 'pending': return icon('loading', 'spin status');
    case 'done': return icon('check', 'status');
    case 'error': return icon('error', 'status');
    case 'approval': return icon('shield', 'status warn');
    default: return icon('circle-small', 'status');
  }
}

function resultText(result) {
  if (!result) return '';
  const content = result.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}

function resultImages(result) {
  if (!result || !Array.isArray(result.content)) return [];
  return result.content.filter((c) => c && c.type === 'image');
}

function clip(s) {
  s = String(s || '');
  return s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) + `\n… (已截断，共 ${s.length} 字符)` : s;
}

function toolSummary(call, view) {
  const a = call.arguments || {};
  const folder = view.folder;
  switch (call.name) {
    case 'read': {
      const range = a.offset ? ` L${a.offset}${a.limit ? '-' + (a.offset + a.limit - 1) : ''}` : a.limit ? ` L1-${a.limit}` : '';
      return { text: (a.path ? relative(folder, resolveIn(folder, a.path)) : '') + range, path: a.path, line: a.offset };
    }
    case 'edit': case 'write':
      return { text: a.path ? relative(folder, resolveIn(folder, a.path)) : '', path: a.path };
    case 'bash': case 'powershell':
      return { text: String(a.command || '').split('\n')[0] };
    case 'grep':
      return { text: `${a.pattern || ''}${a.path ? '  in ' + a.path : ''}${a.glob ? '  ' + a.glob : ''}` };
    case 'find':
      return { text: `${a.pattern || ''}${a.path ? '  in ' + a.path : ''}` };
    case 'ls':
      return { text: a.path || '.' };
    default: {
      const first = Object.entries(a).find(([, v]) => typeof v === 'string');
      return { text: first ? truncate(first[1].split('\n')[0], 120) : '' };
    }
  }
}

function editStats(call, result) {
  const diff = result && result.details && result.details.diff;
  if (diff) {
    let add = 0;
    let del = 0;
    for (const l of diff.split('\n')) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
    return { add, del };
  }
  const edits = (call.arguments && call.arguments.edits) || [];
  let add = 0;
  let del = 0;
  for (const e of edits) {
    add += String(e.newText || '').split('\n').length;
    del += String(e.oldText || '').split('\n').length;
  }
  if (call.name === 'write') add = String((call.arguments && call.arguments.content) || '').split('\n').length;
  return { add, del };
}

function renderTool(item, view) {
  const { call, result, live, status, expanded } = item;
  const name = call.name;
  const sum = toolSummary(call, view);
  const isFileTool = ['read', 'edit', 'write'].includes(name) && sum.path;
  const stats = name === 'edit' || name === 'write' ? editStats(call, result) : null;
  const duration = live && live.durationMs !== undefined ? fmtDuration(live.durationMs) : '';
  const cls = status === 'error' ? '.error' : status === 'done' ? '.ok' : status === 'approval' ? '.pending-approval' : '.running';
  const head = h('div.tool-head', { onclick: () => { view.toolExpand.set(item.key, !expanded); view.refresh(); } },
    statusIcon(status),
    h('span.tname', TOOL_NAMES[name] || name),
    h(`span.targ${isFileTool ? '.link' : ''}`, {
      title: sum.text,
      onclick: isFileTool ? (e) => { e.stopPropagation(); view.hooks.openFile(resolveIn(view.folder, sum.path), sum.line); } : null,
    }, sum.text),
    stats ? h('span.stat', h('span', { style: { color: 'var(--add)' } }, `+${stats.add}`), stats.del ? h('span', { style: { color: 'var(--del)', marginLeft: '4px' } }, `-${stats.del}`) : null) : null,
    (name === 'edit' || name === 'write') && sum.path && status === 'done' ? iconBtn('diff', '在编辑器中查看更改', () => view.hooks.openChangeDiff(resolveIn(view.folder, sum.path))) : null,
    duration ? h('span.dur', duration) : null,
    icon(expanded ? 'chevron-down' : 'chevron-right', 'chev'));
  const el = h(`div.msg.tool${cls}${expanded ? '' : '.collapsed'}`, head);
  if (expanded) el.appendChild(h('div.tool-body.selectable', renderToolBody(call, result, live, view)));
  if (status === 'approval') {
    el.appendChild(h('div.approval-bar', icon('shield'), h('span.grow', '需要确认是否执行此工具调用'),
      h('button.btn.small.secondary', { onclick: () => view.session.approveTool(call.id, false) }, '拒绝'),
      h('button.btn.small', { onclick: () => view.session.approveTool(call.id, true) }, '运行')));
  }
  if (result && result.nestedCalls && result.nestedCalls.calls && result.nestedCalls.calls.length) {
    el.appendChild(h('div.nested-calls', `嵌套调用: ${result.nestedCalls.calls.map((c) => `${c.name}${c.status !== 'ok' ? '(' + c.status + ')' : ''}`).join(', ')}`));
  }
  return el;
}

function renderToolBody(call, result, live, view) {
  const a = call.arguments || {};
  const out = [];
  const text = result ? resultText(result) : live && live.partial ? resultText(live.partial) : '';
  switch (call.name) {
    case 'bash': case 'powershell':
      out.push(h('div.cmd', a.command || ''));
      if (a.timeout) out.push(h('div.cmd.faint', `timeout ${a.timeout}s`));
      out.push(h('pre', clip(text) || (result ? '(无输出)' : '')));
      break;
    case 'edit': {
      const diff = result && result.details && result.details.diff;
      if (diff) out.push(renderPiDiff(diff));
      else if (Array.isArray(a.edits)) {
        for (const e of a.edits) out.push(renderEditPreview(e));
      }
      if (result && result.isError) out.push(h('pre.err', clip(text)));
      break;
    }
    case 'write': {
      const content = String(a.content || '');
      const lines = content.split('\n');
      out.push(h('div.diff', lines.slice(0, 400).map((l, i) => h('div.dl.add', h('span.no', String(i + 1)), h('span.sg', '+'), h('span.tx', l))),
        lines.length > 400 ? h('div.dl.gap', h('span.no', ''), h('span.sg', ''), h('span.tx', `… 还有 ${lines.length - 400} 行`)) : null));
      if (result && result.isError) out.push(h('pre.err', clip(text)));
      break;
    }
    default:
      if (!['read', 'grep', 'find', 'ls'].includes(call.name)) {
        out.push(h('pre.faint', clip(JSON.stringify(a, null, 2))));
      }
      if (text) out.push(h('pre', clip(text)));
      else if (!result) out.push(h('pre.faint', '运行中…'));
      break;
  }
  for (const img of resultImages(result || (live && live.partial))) {
    const src = `data:${img.mimeType};base64,${img.data}`;
    out.push(h('img', { src, onclick: () => lightbox(src), style: { cursor: 'zoom-in', maxHeight: '240px' } }));
  }
  return out;
}

/** Parses pi's edit diff format: "+NN text", "-NN text", " NN text", "   ..." */
export function renderPiDiff(diff) {
  const box = h('div.diff');
  const lines = String(diff).split('\n');
  for (const l of lines.slice(0, 1500)) {
    const sign = l[0];
    const rest = l.slice(1);
    const m = /^(\s*)(\d+|\.\.\.)(?: (.*))?$/.exec(rest);
    if (m && m[2] === '...') {
      box.appendChild(h('div.dl.gap', h('span.no', ''), h('span.sg', ''), h('span.tx', '⋯')));
      continue;
    }
    const no = m ? m[2] : '';
    const tx = m ? m[3] || '' : rest;
    const cls = sign === '+' ? '.add' : sign === '-' ? '.del' : '';
    box.appendChild(h(`div.dl${cls}`, h('span.no', no), h('span.sg', sign === '+' || sign === '-' ? sign : ' '), h('span.tx', tx)));
  }
  if (lines.length > 1500) box.appendChild(h('div.dl.gap', h('span.no', ''), h('span.sg', ''), h('span.tx', `… 还有 ${lines.length - 1500} 行`)));
  return box;
}

function renderEditPreview(e) {
  const box = h('div.diff');
  for (const l of String(e.oldText || '').split('\n').slice(0, 300)) box.appendChild(h('div.dl.del', h('span.no', ''), h('span.sg', '-'), h('span.tx', l)));
  for (const l of String(e.newText || '').split('\n').slice(0, 300)) box.appendChild(h('div.dl.add', h('span.no', ''), h('span.sg', '+'), h('span.tx', l)));
  return box;
}

function renderBashExec(item, view) {
  const m = item.message;
  const expanded = view.toolExpand.get(item.key) !== false;
  const ok = m.exitCode === 0 && !m.cancelled;
  const el = h(`div.msg.tool${ok ? '.ok' : '.error'}${expanded ? '' : '.collapsed'}`,
    h('div.tool-head', { onclick: () => { view.toolExpand.set(item.key, !expanded); view.refresh(); } },
      icon(ok ? 'terminal' : 'error', 'status'),
      h('span.tname', m.excludeFromContext ? '!!' : '!'),
      h('span.targ', { title: m.command }, m.command),
      h('span.dur', m.cancelled ? '已取消' : `exit ${m.exitCode ?? '?'}`),
      m.excludeFromContext ? h('span.tag', '未加入上下文') : null,
      icon(expanded ? 'chevron-down' : 'chevron-right', 'chev')),
    expanded ? h('div.tool-body.selectable', h('pre', clip(m.output) || '(无输出)'), m.truncated && m.fullOutputPath ? h('div.cmd.faint', `完整输出: ${m.fullOutputPath}`) : null) : null);
  return el;
}

function renderBashLive(item, view) {
  const b = item.bash;
  return h('div.msg.tool.running',
    h('div.tool-head', icon('loading', 'spin status'), h('span.tname', b.exclude ? '!!' : '!'), h('span.targ', b.command),
      iconBtn('debug-stop', '中止', () => view.session.abortBash())),
    h('div.tool-body.selectable', h('pre', clip(b.output))));
}

export { dirname };
