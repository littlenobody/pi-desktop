// Settings page: Pi Desktop preferences, pi settings.json (global + project), providers/auth,
// models, resources, MCP and raw JSON config files.
import { api, h, icon, iconBtn, clear, basename, fmtTokens, append } from './util.js';
import { toast, confirm, prompt as promptBox } from './ui.js';
import { loadMonaco } from './editor.js';

const PI_SETTINGS = [
  { group: '模型', items: [
    { key: 'defaultProvider', type: 'string', title: '默认提供商', desc: '新会话使用的默认 provider。' },
    { key: 'defaultModel', type: 'string', title: '默认模型', desc: '新会话使用的默认模型 ID。' },
    { key: 'defaultThinkingLevel', type: 'enum', options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], title: '默认思考强度' },
    { key: 'enabledModels', type: 'list', title: '循环切换的模型范围', desc: '与 --models 格式相同，例如 claude-*、openai/gpt-5*:high。' },
    { key: 'transport', type: 'enum', options: ['auto', 'sse', 'websocket', 'websocket-cached'], title: '传输方式' },
    { key: 'cacheWarming', type: 'enum', options: ['off', 'streaming', 'idle'], title: '缓存预热', desc: 'idle 会在两次运行之间也预热，会产生额外费用。（仅全局）' },
  ] },
  { group: '会话与上下文', items: [
    { key: 'steeringMode', type: 'enum', options: ['one-at-a-time', 'all'], title: 'Steering 投递方式' },
    { key: 'followUpMode', type: 'enum', options: ['one-at-a-time', 'all'], title: 'Follow-up 投递方式' },
    { key: 'compaction.enabled', type: 'bool', title: '自动压缩', desc: '上下文接近上限时自动压缩历史。' },
    { key: 'compaction.reserveTokens', type: 'number', title: '压缩保留 tokens', placeholder: '16384' },
    { key: 'compaction.keepRecentTokens', type: 'number', title: '保留最近 tokens', placeholder: '20000' },
    { key: 'branchSummary.skipPrompt', type: 'bool', title: '切换分支时不询问是否生成摘要' },
    { key: 'branchSummary.reserveTokens', type: 'number', title: '分支摘要保留 tokens', placeholder: '16384' },
    { key: 'sessionDir', type: 'string', title: '会话存储目录', desc: '默认 ~/.pi/agent/sessions，按工作目录分组。' },
    { key: 'sessionShareDestination', type: 'enum', options: ['auto', 'gist', 'radius'], title: '/share 目标' },
  ] },
  { group: '重试与网络', items: [
    { key: 'retry.enabled', type: 'bool', title: '自动重试' },
    { key: 'retry.maxRetries', type: 'number', title: '最大重试次数', placeholder: '3' },
    { key: 'retry.baseDelayMs', type: 'number', title: '基础退避 (ms)', placeholder: '2000' },
    { key: 'httpProxy', type: 'string', title: 'HTTP 代理', desc: '设置为 HTTP_PROXY / HTTPS_PROXY。' },
    { key: 'httpIdleTimeoutMs', type: 'number', title: 'HTTP 空闲超时 (ms)' },
  ] },
  { group: '工具与 Shell', items: [
    { key: 'defaultTools', type: 'list', title: '默认工具', desc: '纯名称为替换；+name / -name 为增减，例如 +codemode, -write, +powershell。' },
    { key: 'shellPath', type: 'string', title: 'Bash 路径', desc: 'Windows 默认使用 Git Bash。' },
    { key: 'shellCommandPrefix', type: 'string', title: 'Shell 命令前缀' },
    { key: 'images.autoResize', type: 'bool', title: '自动缩放图片到 2000×2000' },
    { key: 'images.blockImages', type: 'bool', title: '禁止向模型发送图片' },
    { key: 'codemode.mode', type: 'enum', options: ['on', 'only'], title: 'Codemode 模式' },
  ] },
  { group: '资源', items: [
    { key: 'extensions', type: 'list', title: '扩展路径' },
    { key: 'skills', type: 'list', title: '技能路径' },
    { key: 'prompts', type: 'list', title: '提示模板路径' },
    { key: 'packages', type: 'list', title: 'Pi 包', desc: 'npm: 或 git 源，等同于 pi install。' },
    { key: 'enableSkillCommands', type: 'bool', title: '将技能注册为 /skill:name 命令' },
  ] },
  { group: '安全', items: [
    { key: 'defaultProjectTrust', type: 'enum', options: ['ask', 'always', 'never'], title: '默认项目信任', desc: '（仅全局）ask 时桌面端会在打开含 .pi 资源的项目时询问。' },
    { key: 'enableAnalytics', type: 'bool', title: '分享匿名分析数据' },
    { key: 'enableInstallTelemetry', type: 'bool', title: '更新时发送匿名版本 ping' },
  ] },
];

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete o[last];
  else o[last] = value;
  // prune empty parents
  if (parts.length > 1 && !Object.keys(o).length) setPath(obj, parts.slice(0, -1).join('.'), undefined);
}

export function openSettings(wb, section = 'desktop') {
  wb.editors.openCustom({
    id: 'settings',
    title: '设置',
    iconName: 'settings-gear',
    render: (container, tab) => {
      tab.page = new SettingsPage(wb, container);
      tab.page.show(section);
    },
  });
  const tab = wb.editors.findTab((t) => t.id === 'settings');
  if (tab && tab.page && section) tab.page.show(section);
}

class SettingsPage {
  constructor(wb, container) {
    this.wb = wb;
    this.nav = h('div.settings-nav');
    this.content = h('div.settings-content');
    container.appendChild(h('div.settings-page', this.nav, this.content));
    this.section = 'desktop';
    this.scope = 'global';
    this.jsonEditor = null;
  }

  show(section) {
    this.section = section || this.section;
    if (this.jsonEditor) { this.jsonEditor.dispose(); this.jsonEditor = null; }
    this.renderNav();
    clear(this.content);
    const fn = {
      desktop: () => this.desktop(), pi: () => this.piEnv(), settings: () => this.piSettings(), auth: () => this.auth(),
      models: () => this.models(), files: () => this.files(), about: () => this.about(),
    }[this.section];
    if (fn) fn().catch((err) => this.content.appendChild(h('div.err', err.message)));
  }

  renderNav() {
    clear(this.nav);
    const items = [
      ['desktop', 'window', 'Pi Desktop'], ['settings', 'settings', 'Pi 设置'], ['auth', 'key', '提供商与登录'], ['models', 'sparkle', '模型'],
      ['files', 'json', '配置文件'], ['pi', 'tools', '运行环境'], ['about', 'info', '关于'],
    ];
    for (const [id, ic, label] of items) {
      this.nav.appendChild(h(`div.nav-item${this.section === id ? '.active' : ''}`, { onclick: () => this.show(id) }, icon(ic), label));
    }
  }

  setting(title, desc, control, key) {
    return h('div.setting', h('div.s-title', title, key ? h('span.s-key', key) : null), desc ? h('div.s-desc', desc) : null, control);
  }

  // ---------------------------------------------------------------- desktop
  async desktop() {
    const c = this.wb.config;
    const patch = (p) => this.wb.patchConfig(p);
    const sel = (key, opts, labels) => h('select.select', { onchange: (e) => patch({ [key]: e.target.value }) }, opts.map((o, i) => h('option', { value: o, selected: c[key] === o }, labels ? labels[i] : o)));
    const num = (key, min, max) => h('input.input', { type: 'number', min, max, value: c[key], onchange: (e) => patch({ [key]: Number(e.target.value) }) });
    const bool = (key, label, def = false) => h('label.checkbox', h('input', { type: 'checkbox', checked: c[key] === undefined ? def : !!c[key], onchange: (e) => patch({ [key]: e.target.checked }) }), label);
    append(this.content, 
      h('h2', 'Pi Desktop'), h('div.sub', '桌面客户端自身的偏好设置，保存在应用数据目录中。'),
      this.setting('主题', null, sel('theme', ['dark', 'light'], ['深色', '浅色'])),
      this.setting('界面字号', null, num('uiFontSize', 10, 20)),
      this.setting('聊天字号', null, num('chatFontSize', 10, 22)),
      this.setting('编辑器字号', null, num('editorFontSize', 9, 30)),
      this.setting('发送快捷键', 'Enter 发送时 Shift+Enter 换行；Ctrl+Enter 发送时 Enter 换行。Alt+Enter 始终为 follow-up。', sel('sendKey', ['enter', 'ctrl-enter'], ['Enter', 'Ctrl+Enter'])),
      this.setting('新聊天默认模式', 'Ask 模式只启用只读工具 (read/grep/find/ls)。', sel('defaultMode', ['agent', 'ask'], ['Agent', 'Ask'])),
      this.setting('工具调用确认', '“询问”时，edit/write/bash 等工具运行前需要在聊天中确认。', sel('approval', ['auto', 'ask'], ['自动运行', '运行前询问'])),
      this.setting('通知', null, bool('notifyOnDone', 'Agent 在后台完成时显示系统通知', true)),
      this.setting('思考过程', null, bool('showThinking', '在聊天中显示模型的思考块', true)),
      this.setting('工具输出', null, bool('expandTools', '默认展开所有工具调用的输出')),
      this.setting('自动保存', null, bool('autoSave', '编辑后自动保存文件')),
      this.setting('小地图', null, bool('minimap', '在编辑器中显示小地图', true)),
      this.setting('自动换行', null, sel('wordWrap', ['off', 'on', 'bounded'], ['关闭', '开启', '按视口'])),
      this.setting('默认终端', null, h('select.select', { onchange: (e) => patch({ shell: e.target.value }) }, (this.wb.info.shells || []).map((s) => h('option', { value: s.id, selected: c.shell === s.id }, s.name)))),
    );
  }

  // ---------------------------------------------------------------- environment
  async piEnv() {
    const info = await api.invoke('app:info');
    const cliIn = h('input.input', { value: this.wb.config.piCliPath || '', placeholder: info.pi.cli || '自动检测', style: { width: '520px' } });
    const nodeIn = h('input.input', { value: this.wb.config.nodePath || '', placeholder: info.node.command, style: { width: '520px' } });
    append(this.content, 
      h('h2', '运行环境'), h('div.sub', 'Pi Desktop 通过 `pi --mode rpc` 子进程驱动 pi，每个聊天标签一个独立进程。'),
      h('table.kv-table',
        h('tr', h('th', 'pi CLI'), h('td.selectable', info.pi.cli || h('span.err', '未找到'))),
        h('tr', h('th', 'pi 版本'), h('td', info.pi.version || '-')),
        h('tr', h('th', 'Node'), h('td.selectable', `${info.node.command} (${info.node.version})${info.node.embedded ? ' — 使用 Electron 内置 Node' : ''}`)),
        h('tr', h('th', 'Agent 目录'), h('td.selectable', info.agentDir)),
        h('tr', h('th', 'Electron'), h('td', `${info.versions.electron} / Chromium ${info.versions.chrome}`))),
      this.setting('pi CLI 路径', '指向 cli.js、pi-coding-agent 包目录或 npm 全局目录。留空自动检测。', h('div.row', cliIn, h('button.btn.secondary', { onclick: async () => {
        const f = await api.invoke('dialog:open', { properties: ['openFile', 'openDirectory'] });
        if (f) cliIn.value = f[0];
      } }, '浏览…'))),
      this.setting('Node 路径', 'pi 需要 Node ≥ 22.19。留空则优先使用 PATH 中的 node，否则使用内置 Node。', nodeIn),
      h('div.row', { style: { marginTop: '12px' } },
        h('button.btn', { onclick: async () => {
          await this.wb.patchConfig({ piCliPath: cliIn.value.trim(), nodePath: nodeIn.value.trim() });
          const r = await api.invoke('app:redetect');
          toast(r.cli ? `已找到 pi ${r.version || ''}\n${r.cli}` : '仍未找到 pi CLI', r.cli ? 'info' : 'error');
          this.show('pi');
        } }, '保存并重新检测'),
        h('button.btn.secondary', { onclick: () => this.wb.terminal.sendText('npm install -g @earendil-works/pi-coding-agent\r') }, '在终端中安装/更新 pi'),
        h('button.btn.secondary', { onclick: () => this.wb.terminal.newTerminal({ command: 'pi', args: ['update', '--all'], title: 'pi update' }) }, 'pi update --all')),
    );
  }

  // ---------------------------------------------------------------- pi settings
  async piSettings() {
    const { data, file } = await api.invoke('pi:settings:read', this.scope);
    const other = (await api.invoke('pi:settings:read', this.scope === 'global' ? 'project' : 'global')).data;
    const draft = JSON.parse(JSON.stringify(data));
    let dirty = false;
    const saveBtn = h('button.btn', { disabled: true, onclick: async () => {
      try {
        await api.invoke('pi:settings:write', this.scope, draft);
        toast('已保存。运行中的会话需要 /reload 或重新打开才能生效。', 'info', { actions: [{ label: '重新加载所有会话', primary: true, run: () => this.wb.chat.sessions.forEach((s) => s.status === 'ready' && s.reload().catch(() => {})) }] });
        dirty = false;
        saveBtn.disabled = true;
      } catch (err) { toast(err.message, 'error'); }
    } }, '保存');
    const mark = () => { dirty = true; saveBtn.disabled = false; };
    const scopeBar = h('div.settings-scope',
      h(`span.tab-pill${this.scope === 'global' ? '.active' : ''}`, { onclick: () => { this.scope = 'global'; this.show('settings'); } }, '用户（全局）'),
      this.wb.folder ? h(`span.tab-pill${this.scope === 'project' ? '.active' : ''}`, { onclick: () => { this.scope = 'project'; this.show('settings'); } }, '项目') : null,
      h('span.spacer'), h('span.faint.selectable', file), iconBtn('go-to-file', '打开 JSON', () => this.wb.editors.openFile(file).catch(() => toast('文件尚不存在，保存后会创建。', 'info'))));
    append(this.content, h('h2', 'Pi 设置'), h('div.sub', '编辑 pi 的 settings.json。项目设置会覆盖用户设置，且仅在项目被信任时加载。'), scopeBar);
    for (const g of PI_SETTINGS) {
      this.content.appendChild(h('h3', { style: { margin: '18px 0 4px', fontWeight: 600 } }, g.group));
      for (const s of g.items) {
        const v = getPath(draft, s.key);
        const inherited = getPath(other, s.key);
        let control;
        if (s.type === 'bool') {
          control = h('select.select', { onchange: (e) => { setPath(draft, s.key, e.target.value === '' ? undefined : e.target.value === 'true'); mark(); } },
            h('option', { value: '', selected: v === undefined }, '（默认）'), h('option', { value: 'true', selected: v === true }, '开启'), h('option', { value: 'false', selected: v === false }, '关闭'));
        } else if (s.type === 'enum') {
          control = h('select.select', { onchange: (e) => { setPath(draft, s.key, e.target.value || undefined); mark(); } },
            h('option', { value: '', selected: v === undefined }, '（默认）'), s.options.map((o) => h('option', { value: o, selected: v === o }, o)));
        } else if (s.type === 'number') {
          control = h('input.input', { type: 'number', value: v ?? '', placeholder: s.placeholder || '（默认）', onchange: (e) => { setPath(draft, s.key, e.target.value === '' ? undefined : Number(e.target.value)); mark(); } });
        } else if (s.type === 'list') {
          control = h('input.input', { value: Array.isArray(v) ? v.join(', ') : '', placeholder: '逗号分隔', style: { width: '520px' }, onchange: (e) => { setPath(draft, s.key, e.target.value.split(',').map((x) => x.trim()).filter(Boolean)); mark(); } });
        } else {
          control = h('input.input', { value: v ?? '', placeholder: s.placeholder || '', style: { width: '420px' }, onchange: (e) => { setPath(draft, s.key, e.target.value.trim() || undefined); mark(); } });
        }
        const note = inherited !== undefined && this.scope === 'project' ? h('div.s-desc', `用户设置: ${JSON.stringify(inherited)}`) : null;
        this.content.appendChild(h('div.setting', h('div.s-title', s.title, h('span.s-key', s.key), v !== undefined ? h('span.scope-dot', { title: '已设置' }) : null), s.desc ? h('div.s-desc', s.desc) : null, control, note));
      }
    }
    this.content.appendChild(h('div.row', { style: { marginTop: '16px', position: 'sticky', bottom: '0', background: 'var(--bg-editor)', padding: '10px 0' } }, saveBtn, h('span.faint', '未列出的设置可在 JSON 文件中直接编辑。')));
    void dirty;
  }

  // ---------------------------------------------------------------- auth
  async auth() {
    const list = await api.invoke('pi:auth:list');
    const providers = new Map();
    const s = this.wb.chat.current;
    let models = [];
    if (s && s.status === 'ready') models = await s.getModels(true).catch(() => []);
    for (const m of models) providers.set(m.provider, (providers.get(m.provider) || 0) + 1);
    append(this.content, 
      h('h2', '提供商与登录'),
      h('div.sub', 'API Key 保存在 ~/.pi/agent/auth.json。也可以使用环境变量（如 ANTHROPIC_API_KEY、OPENAI_API_KEY）或以 ! 开头的命令（从密码管理器读取）。OAuth / 订阅登录请使用 Pi TUI 中的 /login。'),
      h('div.row', { style: { margin: '6px 0 14px' } },
        h('button.btn', { onclick: () => this.wb.loginDialog().then(() => this.show('auth')) }, icon('add'), '添加 API Key'),
        h('button.btn.secondary', { onclick: () => this.wb.terminal.openPiTui([]).then(() => toast('在 Pi TUI 中输入 /login 进行 OAuth 登录，完成后在桌面端执行 /reload 或新建聊天。', 'info', { timeout: 15000 })) }, icon('terminal'), 'OAuth 登录（Pi TUI）')),
      h('table.kv-table', h('tr', h('th', 'Provider'), h('th', '类型'), h('th', '凭据'), h('th', '')),
        list.length ? list.map((a) => h('tr', h('td', a.provider), h('td', a.type), h('td.faint', a.hint || ''), h('td', h('button.btn.small.secondary', { onclick: async () => {
          if (!(await confirm('移除凭据', `从 auth.json 中移除 ${a.provider} 的凭据？`, { danger: true, okLabel: '移除' }))) return;
          await api.invoke('pi:auth:remove', a.provider);
          this.show('auth');
        } }, '移除')))) : h('tr', h('td', { colspan: 4 }, h('span.muted', 'auth.json 中没有保存的凭据。')))),
      providers.size ? h('div', { style: { marginTop: '18px' } }, h('div.s-title', '当前可用的提供商'), h('div.muted', [...providers.entries()].map(([p, n]) => `${p} (${n} 个模型)`).join(' · '))) : null,
    );
  }

  // ---------------------------------------------------------------- models
  async models() {
    const s = this.wb.chat.current;
    append(this.content, h('h2', '模型'), h('div.sub', '已配置凭据、可以使用的模型。自定义提供商与模型可在 models.json 中配置（见“配置文件”）。'));
    if (!s || s.status !== 'ready') { this.content.appendChild(h('div.muted', '需要一个运行中的聊天会话来读取模型列表。')); return; }
    const models = await s.getModels(true);
    const { data } = await api.invoke('pi:settings:read', 'global');
    const enabled = new Set(data.enabledModels || []);
    const table = h('table.kv-table', h('tr', h('th', '循环'), h('th', '模型'), h('th', 'Provider / ID'), h('th', '上下文'), h('th', '能力'), h('th', '价格 ($/M in/out)'), h('th', '')));
    for (const m of models) {
      const ref = `${m.provider}/${m.id}`;
      const cb = h('input', { type: 'checkbox', checked: enabled.has(ref) || enabled.has(m.id), onchange: async (e) => {
        const d = (await api.invoke('pi:settings:read', 'global')).data;
        const set = new Set(d.enabledModels || []);
        if (e.target.checked) set.add(ref); else { set.delete(ref); set.delete(m.id); }
        d.enabledModels = [...set];
        if (!d.enabledModels.length) delete d.enabledModels;
        await api.invoke('pi:settings:write', 'global', d);
      } });
      table.appendChild(h('tr', h('td', cb), h('td', m.name || m.id), h('td.faint.selectable', ref), h('td', fmtTokens(m.contextWindow)),
        h('td', [m.reasoning ? '推理' : '', (m.input || []).includes('image') ? '图像' : ''].filter(Boolean).join(' · ')),
        h('td', m.cost ? `${m.cost.input} / ${m.cost.output}` : '-'),
        h('td', h('button.btn.small.secondary', { onclick: async () => {
          const d = (await api.invoke('pi:settings:read', 'global')).data;
          d.defaultProvider = m.provider;
          d.defaultModel = m.id;
          await api.invoke('pi:settings:write', 'global', d);
          await s.setModel(m.provider, m.id).catch(() => {});
          toast(`默认模型已设为 ${ref}`, 'info');
        } }, '设为默认'))));
    }
    this.content.appendChild(table);
  }

  // ---------------------------------------------------------------- files
  async files() {
    const p = await api.invoke('pi:paths');
    const entries = [
      ['settings.json', p.settings, '用户设置'], ['models.json', p.models, '自定义提供商与模型'], ['keybindings.json', p.keybindings, 'TUI 快捷键'],
      ['mcp.json', p.mcp, 'MCP 服务器（用户）'], ['AGENTS.md', p.agents, '全局 Agent 指令'],
      p.projectSettings ? ['.pi/settings.json', p.projectSettings, '项目设置'] : null,
      p.projectMcp ? ['.pi/mcp.json', p.projectMcp, 'MCP 服务器（项目）'] : null,
      p.projectAgents ? ['AGENTS.md (项目)', p.projectAgents, '项目 Agent 指令'] : null,
    ].filter(Boolean);
    const dirs = [['扩展', p.extensions], ['技能', p.skills], ['提示模板', p.prompts], ['Agent 目录', p.agentDir]];
    append(this.content, h('h2', '配置文件'), h('div.sub', '在编辑器中直接打开 pi 的配置文件。修改后在聊天中执行 /reload（扩展/技能/模板）或新建聊天生效。'));
    const table = h('table.kv-table');
    for (const [name, file, desc] of entries) {
      table.appendChild(h('tr', h('td', h('b', name)), h('td.muted', desc), h('td.faint.selectable', file), h('td', h('button.btn.small.secondary', { onclick: async () => {
        const st = await api.invoke('fs:stat', file);
        if (!st.exists) {
          if (!(await confirm('创建文件', `${file} 不存在，是否创建？`))) return;
          await api.invoke('fs:write', file, name.endsWith('.json') ? '{\n}\n' : '');
        }
        this.wb.editors.openFile(file, { pinned: true });
      } }, '打开'))));
    }
    this.content.appendChild(table);
    this.content.appendChild(h('h3', { style: { margin: '20px 0 6px' } }, '资源目录'));
    const t2 = h('table.kv-table');
    for (const [name, dir] of dirs) t2.appendChild(h('tr', h('td', name), h('td.faint.selectable', dir), h('td', h('button.btn.small.secondary', { onclick: () => api.invoke('shell:openPath', dir) }, '打开文件夹'))));
    this.content.appendChild(t2);
    this.content.appendChild(h('h3', { style: { margin: '20px 0 6px' } }, 'MCP'));
    this.content.appendChild(h('div.muted', 'MCP 服务器在每个会话中由 pi 的内置 MCP 扩展管理。可在聊天中输入 /mcp 管理登录与开关，或在终端运行 pi mcp list。'));
    this.content.appendChild(h('div.row', { style: { marginTop: '8px' } },
      h('button.btn.secondary', { onclick: () => this.wb.terminal.newTerminal({ command: 'pi', args: ['mcp', 'list'], title: 'pi mcp list' }) }, 'pi mcp list'),
      h('button.btn.secondary', { onclick: () => this.wb.terminal.newTerminal({ command: 'pi', args: ['list'], title: 'pi list' }) }, 'pi list（已安装的包）'),
      h('button.btn.secondary', { onclick: async () => {
        const src = await promptBox('安装 Pi 包', { placeholder: 'npm:@scope/package 或 git 地址' });
        if (src) this.wb.terminal.newTerminal({ command: 'pi', args: ['install', src.trim()], title: 'pi install' });
      } }, '安装 Pi 包…')));
  }

  // ---------------------------------------------------------------- about
  async about() {
    const info = this.wb.info;
    append(this.content, 
      h('div.row', { style: { gap: '16px', marginBottom: '16px' } }, h('img', { src: 'assets/logo.svg', style: { width: '64px', height: '64px' } }), h('div', h('h2', 'Pi Desktop'), h('div.muted', `版本 ${info.versions.app}`))),
      h('div.muted', { style: { lineHeight: 1.8 } },
        h('div', `pi: ${info.pi.version || '未找到'}`),
        h('div', `Electron ${info.versions.electron} · Chromium ${info.versions.chrome} · Node ${info.versions.node}`),
        h('div', '编辑器: Monaco Editor · 终端: xterm.js + node-pty')),
      h('div.row', { style: { marginTop: '16px' } },
        h('button.btn.secondary', { onclick: () => this.wb.openDoc('readme') }, 'Pi README'),
        h('button.btn.secondary', { onclick: () => this.wb.openDoc('changelog') }, '更新日志'),
        h('button.btn.secondary', { onclick: () => api.invoke('shell:openPath', info.agentDir) }, '打开 Pi 配置目录')));
  }
}

export { loadMonaco, basename };
