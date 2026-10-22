'use strict';
// Pi Desktop — Electron main process.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, clipboard, Notification, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const config = require('./config');
const piEnv = require('./pi-env');
const { PiSession } = require('./pi-session');
const workspace = require('./workspace');
const git = require('./git');
const sessions = require('./sessions');
const { TerminalManager, shells } = require('./terminal');

const APP_ROOT = path.resolve(__dirname, '..');
const SCHEME = 'pidesk';

app.setName('Pi Desktop');
if (process.platform === 'win32') app.setAppUserModelId('dev.pi.desktop');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// ---------------------------------------------------------------------------
// Window registry: each window owns a folder, its pi sessions, terminals and watcher.
// ---------------------------------------------------------------------------

/** @type {Map<number, {win: BrowserWindow, folder: string|null, sessions: Map<string, PiSession>, terms: TerminalManager, unwatch: Function|null}>} */
const windows = new Map();
let sessionSeq = 0;
let quitting = false;

function ctxOf(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? windows.get(win.id) : null;
}

function send(ctx, channel, payload) {
  if (ctx && !ctx.win.isDestroyed()) ctx.win.webContents.send(channel, payload);
}

function samePath(a, b) {
  if (!a || !b) return false;
  return piEnv.IS_WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

function createWindow(folder) {
  if (folder) {
    for (const ctx of windows.values()) {
      if (samePath(ctx.folder, folder)) {
        if (ctx.win.isMinimized()) ctx.win.restore();
        ctx.win.focus();
        return ctx.win;
      }
    }
  }
  const saved = folder ? config.windowState(folder) : null;
  const bounds = (saved && saved.bounds) || {};
  const dark = (config.load().theme || 'dark') !== 'light';
  const win = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: dark ? '#181818' : '#f8f8f8',
    title: folder ? `${path.basename(folder)} - Pi Desktop` : 'Pi Desktop',
    icon: path.join(APP_ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#1f1f1f' : '#f3f3f3', symbolColor: dark ? '#cccccc' : '#333333', height: 35 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (saved && saved.maximized) win.maximize();
  const ctx = { win, folder: folder || null, sessions: new Map(), terms: null, unwatch: null };
  ctx.terms = new TerminalManager((ch, payload) => send(ctx, ch, payload));
  windows.set(win.id, ctx);
  if (folder) {
    config.addRecent(folder);
    ctx.unwatch = workspace.watch(folder, (items) => send(ctx, 'fs:changed', items));
  }

  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    if (ctx.folder) {
      config.saveWindowState(ctx.folder, {
        ...(config.windowState(ctx.folder) || {}),
        bounds: win.isMaximized() ? (config.windowState(ctx.folder) || {}).bounds : win.getBounds(),
        maximized: win.isMaximized(),
      });
    }
  });
  win.on('closed', () => disposeWindow(win.id));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${SCHEME}://`)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  const q = folder ? `?folder=${encodeURIComponent(folder)}` : '';
  win.loadURL(`${SCHEME}://app/renderer/index.html${q}`);
  if (process.env.PI_DESKTOP_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  if (process.env.PI_DESKTOP_SELFTEST) attachSelfTest(win);
  return win;
}

// Developer self-test hook (only active when PI_DESKTOP_SELFTEST points to a script).
function attachSelfTest(win) {
  const script = fs.readFileSync(process.env.PI_DESKTOP_SELFTEST, 'utf8');
  const outDir = process.env.PI_DESKTOP_SELFTEST_OUT || require('os').tmpdir();
  win.webContents.on('console-message', (e) => {
    process.stdout.write(`[renderer:${e.level}] ${e.message}\n`);
  });
  win.webContents.on('render-process-gone', (e, d) => process.stdout.write(`[renderer gone] ${JSON.stringify(d)}\n`));
  ipcMain.removeHandler('selftest:shot');
  ipcMain.handle('selftest:shot', async (event, name) => {
    const img = await win.webContents.capturePage();
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  });
  ipcMain.removeHandler('selftest:done');
  ipcMain.handle('selftest:done', async (event, code) => {
    process.stdout.write(`[selftest] done ${code}\n`);
    setTimeout(() => app.exit(code || 0), 300);
  });
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => win.webContents.executeJavaScript(script).catch((err) => process.stdout.write(`[selftest] error ${err.message}\n`)), 1500);
  });
}

function disposeWindow(id) {
  const ctx = windows.get(id);
  if (!ctx) return;
  windows.delete(id);
  if (ctx.unwatch) ctx.unwatch();
  ctx.terms.disposeAll();
  for (const s of ctx.sessions.values()) s.stop();
  ctx.sessions.clear();
  if (!quitting) saveOpenFolders();
}

function saveOpenFolders() {
  const c = config.load();
  c.lastOpened = [...windows.values()].map((w) => w.folder).filter(Boolean);
  config.flush();
}

// ---------------------------------------------------------------------------
// Application menu (rendered as a custom title-bar menu; the native menu is used for popups
// and accelerators-free roles like copy/paste).
// ---------------------------------------------------------------------------

function cmd(id) {
  return (item, win) => {
    if (win) win.webContents.send('menu:command', id);
  };
}

function buildMenus() {
  const isMac = process.platform === 'darwin';
  return {
    file: [
      { label: '新建聊天', accelerator: 'CmdOrCtrl+N', click: cmd('chat.new') },
      { label: '新建文件', click: cmd('file.newUntitled') },
      { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow(null) },
      { type: 'separator' },
      { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: cmd('folder.open') },
      { label: '打开文件…', click: cmd('file.open') },
      { label: '最近打开', click: cmd('folder.recent') },
      { type: 'separator' },
      { label: '保存', accelerator: 'CmdOrCtrl+S', click: cmd('file.save') },
      { label: '全部保存', click: cmd('file.saveAll') },
      { label: '自动保存', type: 'checkbox', checked: !!config.load().autoSave, click: (i) => { config.patch({ autoSave: i.checked }); broadcast('config:changed', config.get()); } },
      { type: 'separator' },
      { label: '设置', accelerator: 'CmdOrCtrl+,', click: cmd('settings.open') },
      { type: 'separator' },
      { label: '关闭编辑器', accelerator: 'CmdOrCtrl+W', click: cmd('editor.close') },
      { label: '关闭文件夹', click: cmd('folder.close') },
      { label: '关闭窗口', click: (i, win) => win && win.close() },
      { type: 'separator' },
      isMac ? { role: 'quit', label: '退出' } : { label: '退出', click: () => app.quit() },
    ],
    edit: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
      { type: 'separator' },
      { label: '查找', click: cmd('editor.find') },
      { label: '替换', click: cmd('editor.replace') },
      { label: '在文件中查找', accelerator: 'CmdOrCtrl+Shift+F', click: cmd('view.search') },
    ],
    view: [
      { label: '命令面板…', accelerator: 'CmdOrCtrl+Shift+P', click: cmd('palette.commands') },
      { label: '转到文件…', accelerator: 'CmdOrCtrl+P', click: cmd('palette.files') },
      { type: 'separator' },
      { label: '资源管理器', accelerator: 'CmdOrCtrl+Shift+E', click: cmd('view.explorer') },
      { label: '搜索', click: cmd('view.search') },
      { label: '源代码管理', accelerator: 'CmdOrCtrl+Shift+G', click: cmd('view.scm') },
      { label: '会话历史', click: cmd('view.history') },
      { type: 'separator' },
      { label: '切换侧边栏', accelerator: 'CmdOrCtrl+B', click: cmd('view.toggleSidebar') },
      { label: '切换 AI 面板', accelerator: 'CmdOrCtrl+Alt+B', click: cmd('view.toggleChat') },
      { label: '切换终端面板', accelerator: 'CmdOrCtrl+J', click: cmd('view.togglePanel') },
      { type: 'separator' },
      { label: '放大', accelerator: 'CmdOrCtrl+=', click: cmd('view.zoomIn') },
      { label: '缩小', accelerator: 'CmdOrCtrl+-', click: cmd('view.zoomOut') },
      { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: cmd('view.zoomReset') },
      { role: 'togglefullscreen', label: '全屏' },
      { type: 'separator' },
      { label: '切换主题（深色/浅色）', click: cmd('view.toggleTheme') },
      { role: 'toggleDevTools', label: '开发者工具' },
      { role: 'reload', label: '重新加载窗口' },
    ],
    agent: [
      { label: '新建聊天', click: cmd('chat.new') },
      { label: '打开会话历史…', click: cmd('chat.history') },
      { label: '导入会话 (JSONL)…', click: cmd('chat.import') },
      { type: 'separator' },
      { label: '选择模型…', click: cmd('chat.model') },
      { label: '思考强度…', click: cmd('chat.thinking') },
      { label: '会话树 (/tree)', click: cmd('chat.tree') },
      { label: '分叉 (/fork)…', click: cmd('chat.fork') },
      { label: '克隆 (/clone)', click: cmd('chat.clone') },
      { label: '压缩上下文 (/compact)', click: cmd('chat.compact') },
      { label: '会话信息 (/session)', click: cmd('chat.session') },
      { label: '导出 HTML / JSONL…', click: cmd('chat.export') },
      { type: 'separator' },
      { label: '重新加载扩展/技能/模板 (/reload)', click: cmd('chat.reload') },
      { label: '登录提供商 (/login)…', click: cmd('auth.login') },
      { label: '在终端中运行 Pi TUI', click: cmd('pi.tui') },
    ],
    terminal: [
      { label: '新建终端', accelerator: 'CmdOrCtrl+Shift+`', click: cmd('terminal.new') },
      { label: '切换终端', click: cmd('view.togglePanel') },
      { label: '在终端中运行 Pi TUI', click: cmd('pi.tui') },
    ],
    help: [
      { label: '键盘快捷键', click: cmd('help.hotkeys') },
      { label: 'Pi 文档 (README)', click: cmd('help.readme') },
      { label: 'Pi 更新日志', click: cmd('help.changelog') },
      { type: 'separator' },
      { label: '打开 Pi 配置目录', click: () => shell.openPath(piEnv.agentDir()) },
      { label: '关于', click: cmd('help.about') },
    ],
  };
}

const MENU_TITLES = { file: '文件', edit: '编辑', view: '查看', agent: 'Agent', terminal: '终端', help: '帮助' };

function installAppMenu() {
  if (process.platform !== 'darwin') {
    // The renderer draws its own title-bar menu and handles all shortcuts.
    Menu.setApplicationMenu(null);
    return;
  }
  const menus = buildMenus();
  const template = Object.keys(menus).map((k) => ({ label: MENU_TITLES[k], submenu: menus[k] }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function broadcast(channel, payload) {
  for (const ctx of windows.values()) send(ctx, channel, payload);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(ctxOf(event), ...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  // ---- app / config -------------------------------------------------------
  handle('app:info', async (ctx) => {
    const cli = await piEnv.findPiCli();
    const node = await piEnv.findNode();
    return {
      folder: ctx ? ctx.folder : null,
      platform: process.platform,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, app: app.getVersion() },
      pi: { cli, version: cli ? piEnv.piVersion(cli) : null, packageDir: cli ? piEnv.piPackageDir(cli) : null },
      node: { command: node.command, version: node.version, embedded: node.embedded },
      agentDir: piEnv.agentDir(),
      home: require('os').homedir(),
      sep: path.sep,
      recent: config.load().recent.filter((f) => fs.existsSync(f)),
      config: config.get(),
      windowState: ctx && ctx.folder ? config.windowState(ctx.folder) : null,
      shells: shells().map((s) => ({ id: s.id, name: s.name })),
    };
  });
  handle('app:redetect', async () => {
    const cli = await piEnv.findPiCli(true);
    const node = await piEnv.findNode(true);
    return { cli, version: cli ? piEnv.piVersion(cli) : null, node };
  });
  handle('config:patch', async (ctx, p) => {
    const next = config.patch(p);
    if ('theme' in p) {
      for (const w of windows.values()) {
        const dark = p.theme !== 'light';
        try { w.win.setTitleBarOverlay({ color: dark ? '#1f1f1f' : '#f3f3f3', symbolColor: dark ? '#cccccc' : '#333333' }); } catch { /* unsupported */ }
        w.win.setBackgroundColor(dark ? '#181818' : '#f8f8f8');
      }
    }
    broadcast('config:changed', next);
    return next;
  });
  handle('state:save', async (ctx, state) => {
    if (ctx && ctx.folder) config.saveWindowState(ctx.folder, { ...(config.windowState(ctx.folder) || {}), ui: state });
  });
  handle('recent:remove', async (ctx, folder) => config.removeRecent(folder));
  handle('menu:popup', async (ctx, name, x, y) => {
    const menus = buildMenus();
    if (!menus[name]) return;
    const strip = (items) => items.map((it) => ({ ...it, registerAccelerator: false, submenu: it.submenu ? strip(it.submenu) : undefined }));
    Menu.buildFromTemplate(strip(menus[name])).popup({ window: ctx.win, x: Math.round(x), y: Math.round(y) });
  });
  handle('window:open', async (ctx, folder, opts = {}) => {
    if (!folder) {
      const r = await dialog.showOpenDialog(ctx.win, { properties: ['openDirectory', 'createDirectory'], title: '打开文件夹' });
      if (r.canceled || !r.filePaths[0]) return null;
      folder = r.filePaths[0];
    }
    folder = path.resolve(folder);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('文件夹不存在: ' + folder);
    if (opts.newWindow || (ctx && ctx.folder && !samePath(ctx.folder, folder))) {
      if (opts.newWindow || ctx.sessions.size > 0) {
        createWindow(folder);
        return folder;
      }
    }
    // Reuse current window
    for (const other of windows.values()) {
      if (other !== ctx && samePath(other.folder, folder)) {
        other.win.focus();
        return folder;
      }
    }
    if (ctx.unwatch) ctx.unwatch();
    for (const s of ctx.sessions.values()) s.stop();
    ctx.sessions.clear();
    ctx.terms.disposeAll();
    ctx.folder = folder;
    config.addRecent(folder);
    ctx.unwatch = workspace.watch(folder, (items) => send(ctx, 'fs:changed', items));
    ctx.win.setTitle(`${path.basename(folder)} - Pi Desktop`);
    ctx.win.loadURL(`${SCHEME}://app/renderer/index.html?folder=${encodeURIComponent(folder)}`);
    saveOpenFolders();
    return folder;
  });
  handle('window:close-folder', async (ctx) => {
    if (ctx.unwatch) ctx.unwatch();
    for (const s of ctx.sessions.values()) s.stop();
    ctx.sessions.clear();
    ctx.terms.disposeAll();
    ctx.folder = null;
    ctx.win.setTitle('Pi Desktop');
    ctx.win.loadURL(`${SCHEME}://app/renderer/index.html`);
    saveOpenFolders();
  });
  handle('window:new', async () => { createWindow(null); });
  handle('window:title', async (ctx, title) => { ctx.win.setTitle(title); });
  handle('window:zoom', async (ctx, delta) => {
    const wc = ctx.win.webContents;
    wc.setZoomLevel(delta === 0 ? 0 : wc.getZoomLevel() + delta);
  });
  handle('window:flash', async (ctx) => {
    if (!ctx.win.isFocused()) ctx.win.flashFrame(true);
  });

  // ---- dialogs / shell ----------------------------------------------------
  handle('dialog:open', async (ctx, opts) => {
    const r = await dialog.showOpenDialog(ctx.win, opts || {});
    return r.canceled ? null : r.filePaths;
  });
  handle('dialog:save', async (ctx, opts) => {
    const r = await dialog.showSaveDialog(ctx.win, opts || {});
    return r.canceled ? null : r.filePath;
  });
  handle('dialog:message', async (ctx, opts) => (await dialog.showMessageBox(ctx.win, opts)).response);
  handle('shell:openExternal', async (ctx, url) => {
    if (!/^(https?|mailto):/i.test(url)) throw new Error('只允许打开 http(s) 链接');
    await shell.openExternal(url);
  });
  handle('shell:openPath', async (ctx, p) => shell.openPath(p));
  handle('shell:reveal', async (ctx, p) => shell.showItemInFolder(p));
  handle('shell:trash', async (ctx, p) => shell.trashItem(p));
  handle('clipboard:write', async (ctx, text) => clipboard.writeText(String(text)));
  handle('clipboard:read', async () => clipboard.readText());
  handle('notify', async (ctx, title, body) => {
    if (ctx.win.isFocused() || !Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { ctx.win.show(); ctx.win.focus(); });
    n.show();
  });

  // ---- file system --------------------------------------------------------
  handle('fs:list', async (ctx, dir) => workspace.list(dir));
  handle('fs:read', async (ctx, file) => workspace.read(file));
  handle('fs:write', async (ctx, file, text, opts) => workspace.write(file, text, opts));
  handle('fs:create', async (ctx, file, isDir) => workspace.create(file, isDir));
  handle('fs:rename', async (ctx, from, to) => workspace.rename(from, to));
  handle('fs:stat', async (ctx, file) => workspace.stat(file));
  handle('fs:files', async (ctx, folder) => workspace.files(folder || ctx.folder));
  handle('fs:search', async (ctx, query, opts) => workspace.search(ctx.folder, query, opts));
  handle('fs:replace', async (ctx, file, query, replacement, opts) => workspace.replaceInFile(file, query, replacement, opts));
  handle('fs:copyFile', async (ctx, from, to) => fs.promises.copyFile(from, to));

  // ---- git ----------------------------------------------------------------
  handle('git:status', async (ctx) => (ctx.folder ? git.status(ctx.folder) : { repo: false }));
  handle('git:show', async (ctx, file, ref) => git.show(ctx.folder, file, ref));
  handle('git:stage', async (ctx, files) => git.stage(ctx.folder, files));
  handle('git:unstage', async (ctx, files) => git.unstage(ctx.folder, files));
  handle('git:discard', async (ctx, files) => git.discard(ctx.folder, files));
  handle('git:commit', async (ctx, message, opts) => git.commit(ctx.folder, message, opts));
  handle('git:run', async (ctx, args) => git.run(ctx.folder, args));
  handle('git:branches', async (ctx) => git.branches(ctx.folder));
  handle('git:checkout', async (ctx, branch, create) => git.checkout(ctx.folder, branch, create));
  handle('git:init', async (ctx) => git.run(ctx.folder, ['init']));
  handle('git:diffStaged', async (ctx) => git.diffStaged(ctx.folder));

  // ---- pi state on disk ---------------------------------------------------
  handle('pi:settings:read', async (ctx, scope) => ({ data: piEnv.readSettings(scope, ctx.folder), file: piEnv.settingsFile(scope, ctx.folder || '') }));
  handle('pi:settings:write', async (ctx, scope, data) => piEnv.writeSettings(scope, ctx.folder, data));
  handle('pi:auth:list', async () => piEnv.listAuth());
  handle('pi:auth:set', async (ctx, provider, key) => piEnv.setApiKey(provider, key));
  handle('pi:auth:remove', async (ctx, provider) => piEnv.removeAuth(provider));
  handle('pi:trust:status', async (ctx, folder) => piEnv.trustStatus(folder || ctx.folder));
  handle('pi:trust:set', async (ctx, folder, decision) => piEnv.setTrust(folder || ctx.folder, decision));
  handle('pi:paths', async (ctx) => {
    const agent = piEnv.agentDir();
    const cli = await piEnv.findPiCli();
    const pkg = cli ? piEnv.piPackageDir(cli) : null;
    return {
      agentDir: agent,
      settings: path.join(agent, 'settings.json'),
      models: path.join(agent, 'models.json'),
      auth: path.join(agent, 'auth.json'),
      keybindings: path.join(agent, 'keybindings.json'),
      mcp: path.join(agent, 'mcp.json'),
      agents: path.join(agent, 'AGENTS.md'),
      extensions: path.join(agent, 'extensions'),
      skills: path.join(agent, 'skills'),
      prompts: path.join(agent, 'prompts'),
      projectSettings: ctx.folder ? path.join(ctx.folder, '.pi', 'settings.json') : null,
      projectAgents: ctx.folder ? path.join(ctx.folder, 'AGENTS.md') : null,
      projectMcp: ctx.folder ? path.join(ctx.folder, '.pi', 'mcp.json') : null,
      readme: pkg ? path.join(pkg, 'README.md') : null,
      changelog: pkg ? path.join(pkg, 'CHANGELOG.md') : null,
      docs: pkg ? path.join(pkg, 'docs') : null,
    };
  });
  handle('pi:sessions:list', async (ctx, all) => sessions.list(ctx.folder, !!all));
  handle('pi:sessions:remove', async (ctx, file) => sessions.remove(file));
  handle('pi:sessions:rename', async (ctx, file, name) => sessions.rename(file, name));

  // ---- pi RPC sessions ----------------------------------------------------
  handle('session:create', async (ctx, opts = {}) => {
    if (!ctx.folder) throw new Error('请先打开一个文件夹');
    const id = `s${++sessionSeq}`;
    const s = new PiSession({ id, cwd: ctx.folder, sessionFile: opts.sessionFile, forkFrom: opts.forkFrom, approve: opts.approve, extraArgs: opts.extraArgs });
    ctx.sessions.set(id, s);
    s.on('event', (rec) => send(ctx, 'session:event', { id, rec }));
    s.on('desktop', (msg) => send(ctx, 'session:desktop', { id, msg }));
    s.on('stderr', (text) => send(ctx, 'session:stderr', { id, text }));
    s.on('changes', (changes) => send(ctx, 'session:changes', { id, changes }));
    s.on('exit', (info) => {
      ctx.sessions.delete(id);
      send(ctx, 'session:exit', { id, ...info });
    });
    try {
      const state = await s.start();
      return { id, state };
    } catch (err) {
      s.kill();
      ctx.sessions.delete(id);
      throw err;
    }
  });
  handle('session:request', async (ctx, id, command, timeoutMs) => {
    const s = ctx.sessions.get(id);
    if (!s) throw new Error('会话进程不存在或已退出');
    return s.request(command, timeoutMs || 0);
  });
  handle('session:send', async (ctx, id, record) => {
    const s = ctx.sessions.get(id);
    if (s) s.send(record);
  });
  handle('session:stop', async (ctx, id) => {
    const s = ctx.sessions.get(id);
    if (s) {
      ctx.sessions.delete(id);
      await s.stop();
    }
  });
  handle('session:changes', async (ctx, id) => {
    const s = ctx.sessions.get(id);
    return s ? s.listChanges() : [];
  });
  handle('session:baseline', async (ctx, id, file) => {
    const s = ctx.sessions.get(id);
    const b = s ? s.getBaseline(file) : undefined;
    return b === undefined ? { tracked: false } : { tracked: true, text: b };
  });
  handle('session:revert', async (ctx, id, file) => {
    const s = ctx.sessions.get(id);
    return s ? s.revert(file) : false;
  });
  handle('session:keep', async (ctx, id, file) => {
    const s = ctx.sessions.get(id);
    if (s) s.keep(file);
  });
  handle('session:checkpoint-files', async (ctx, id, userTs) => {
    const s = ctx.sessions.get(id);
    return s ? s.checkpointFiles(userTs) : [];
  });
  handle('session:restore-checkpoint', async (ctx, id, userTs) => {
    const s = ctx.sessions.get(id);
    return s ? s.restoreCheckpoint(userTs) : [];
  });
  handle('share:gist', async (ctx, htmlFile) => {
    const { execFile } = require('child_process');
    const run = (args) => new Promise((resolve) => {
      execFile('gh', args, { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
    const auth = await run(['auth', 'status']);
    if (auth.err) throw new Error(auth.err.code === 'ENOENT' ? '未安装 GitHub CLI (gh)。请从 https://cli.github.com/ 安装。' : 'GitHub CLI 未登录，请先运行 `gh auth login`。');
    const r = await run(['gist', 'create', '--public=false', htmlFile]);
    if (r.err) throw new Error(r.stderr.trim() || r.err.message);
    const gistUrl = r.stdout.trim().split(/\s+/).pop();
    const gistId = gistUrl.split('/').pop();
    const base = process.env.PI_SHARE_VIEWER_URL || 'https://pi.dev/session/';
    return { gistUrl, previewUrl: `${base}#${gistId}` };
  });
  handle('os:tmpfile', async (ctx, name) => path.join(require('os').tmpdir(), `pi-desktop-${Date.now()}-${name}`));
  handle('devtools', async (ctx) => ctx.win.webContents.toggleDevTools());

  // ---- terminals ----------------------------------------------------------
  handle('term:create', async (ctx, opts = {}) => ctx.terms.create({ cwd: opts.cwd || ctx.folder, ...opts }));
  handle('term:pi', async (ctx, opts = {}) => {
    const cli = await piEnv.findPiCli();
    if (!cli) throw new Error('未找到 pi CLI');
    const node = await piEnv.findNode();
    return ctx.terms.create({ cwd: ctx.folder, command: node.command, args: [cli, ...(opts.args || [])], env: node.env, cols: opts.cols, rows: opts.rows });
  });
  ipcMain.on('term:write', (event, id, data) => {
    const ctx = ctxOf(event);
    if (ctx) ctx.terms.write(id, data);
  });
  ipcMain.on('term:resize', (event, id, cols, rows) => {
    const ctx = ctxOf(event);
    if (ctx) ctx.terms.resize(id, cols, rows);
  });
  handle('term:kill', async (ctx, id) => ctx.terms.kill(id));
}

// ---------------------------------------------------------------------------
// Protocol: serve the app directory (renderer + node_modules assets) over pidesk://app/
// ---------------------------------------------------------------------------

function registerProtocol() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host === 'app') {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const target = path.normalize(path.join(APP_ROOT, rel));
      if (!target.startsWith(APP_ROOT)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    }
    if (url.host === 'file') {
      // Local file preview (images in the editor / chat). Read-only.
      const p = decodeURIComponent(url.searchParams.get('p') || '');
      if (!p || !path.isAbsolute(p)) return new Response('bad request', { status: 400 });
      return net.fetch(pathToFileURL(p).toString());
    }
    return new Response('not found', { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function folderFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
  for (const a of args) {
    try {
      const p = path.resolve(a);
      if (fs.statSync(p).isDirectory() && !samePath(p, APP_ROOT)) return p;
    } catch { /* not a folder */ }
  }
  return null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, argv, workingDirectory) => {
    const folder = folderFromArgv(argv);
    if (folder) createWindow(folder);
    else {
      const any = [...windows.values()][0];
      if (any) {
        if (any.win.isMinimized()) any.win.restore();
        any.win.focus();
      } else createWindow(null);
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = (config.load().theme || 'dark') === 'light' ? 'light' : 'dark';
    registerProtocol();
    registerIpc();
    installAppMenu();
    const fromArgv = folderFromArgv(process.argv);
    if (fromArgv) createWindow(fromArgv);
    else {
      const last = (config.load().lastOpened || []).filter((f) => {
        try { return fs.statSync(f).isDirectory(); } catch { return false; }
      });
      if (last.length) last.forEach((f) => createWindow(f));
      else createWindow(null);
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(null);
    });
  });

  app.on('before-quit', () => {
    saveOpenFolders();
    quitting = true;
  });
  app.on('window-all-closed', () => {
    config.flush();
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => {
    for (const ctx of windows.values()) {
      for (const s of ctx.sessions.values()) s.kill();
      ctx.terms.disposeAll();
    }
    config.flush();
  });
}

process.on('uncaughtException', (err) => {
  console.error('uncaught', err);
});
