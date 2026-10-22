// Renderer entry: shows the welcome screen when no folder is open, otherwise mounts the workbench.
import { api, h, icon, iconBtn, basename, IS_MAC } from './util.js';
import { Workbench, applyAppearance } from './workbench.js';
import { toast, quickPick } from './ui.js';

async function main() {
  document.body.classList.add(`platform-${api.platform}`);
  const info = await api.invoke('app:info');
  applyAppearance(info.config);
  const root = document.getElementById('app');
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    if (e.reason && e.reason.message && !/Canceled|会话未运行/.test(e.reason.message)) toast(e.reason.message, 'error');
  });
  if (!info.folder) {
    renderWelcome(root, info);
    return;
  }
  const wb = new Workbench(info);
  window.wb = wb; // handy for debugging from devtools
  await wb.mount(root);
}

function renderWelcome(root, info) {
  const open = (folder, newWindow) => api.invoke('window:open', folder || null, { newWindow }).catch((err) => toast(err.message, 'error'));
  const mod = IS_MAC ? '⌘' : 'Ctrl';
  const card = (ic, title, desc, onclick) => h('div.welcome-card', { onclick, tabindex: 0, onkeydown: (e) => { if (e.key === 'Enter') onclick(); } }, icon(ic), h('div', h('div', { style: { fontWeight: 600, color: 'var(--fg-strong)' } }, title), h('div.muted', { style: { fontSize: '12px', marginTop: '2px' } }, desc)));
  const recent = h('div');
  const renderRecent = (list) => {
    recent.replaceChildren();
    if (!list.length) { recent.appendChild(h('div.muted', { style: { padding: '6px 8px' } }, '暂无最近打开的文件夹')); return; }
    for (const f of list.slice(0, 10)) {
      recent.appendChild(h('div.recent-item', { onclick: () => open(f), title: f }, icon('folder'), h('div', { style: { minWidth: 0 } }, h('div', basename(f)), h('div.p', f)),
        iconBtn('close', '从列表移除', async () => { await api.invoke('recent:remove', f); renderRecent(list.filter((x) => x !== f)); })));
    }
  };
  renderRecent(info.recent);
  const env = h('div.env-check',
    h('div', info.pi.cli ? h('span.ok', icon('pass-filled'), ` pi ${info.pi.version || ''}`) : h('span.err', icon('error'), ' 未找到 pi CLI'), h('span.faint', `  ${info.pi.cli || ''}`)),
    h('div', h('span.muted', `Node ${info.node.version}${info.node.embedded ? '（Electron 内置）' : ''} · 配置目录 `), h('code', info.agentDir)),
    info.pi.cli ? null : h('div', { style: { marginTop: '6px' } }, '安装: ', h('code', 'npm install -g @earendil-works/pi-coding-agent'), '，然后重新打开 Pi Desktop。'));
  const titlebar = h('div.titlebar', h('img.tb-logo', { src: 'assets/logo.svg' }), h('div.tb-center', h('div.command-center', { onclick: () => open() }, icon('folder-opened'), h('span', '打开文件夹以开始'))));
  root.appendChild(h('div.workbench', titlebar,
    h('div.welcome', h('div.welcome-inner',
      h('div.welcome-brand', h('img', { src: 'assets/logo.svg' }), h('div', h('h1', 'Pi Desktop'), h('p', '基于 pi coding agent 的 AI 编程桌面客户端'))),
      h('div.welcome-cards',
        card('folder-opened', '打开项目', `${mod}+O`, () => open()),
        card('repo-clone', '克隆仓库', 'git clone 到本地', async () => {
          const url = await quickPick({ items: [], placeholder: '输入 Git 仓库地址后回车', emptyText: '例如 https://github.com/user/repo.git' });
          const repo = url && url.custom;
          if (!repo) return;
          const dirs = await api.invoke('dialog:open', { properties: ['openDirectory', 'createDirectory'], title: '选择克隆到的父目录' });
          if (!dirs) return;
          const t = toast(`正在克隆 ${repo}…`, 'info', { timeout: 0 });
          try {
            const name = repo.replace(/\.git$/, '').split(/[\\/:]/).pop();
            const target = `${dirs[0]}${api.platform === 'win32' ? '\\' : '/'}${name}`;
            const r = await api.invoke('git:run', ['clone', repo, target]);
            t.remove();
            if (r.code !== 0) throw new Error(r.stderr || r.stdout);
            open(target);
          } catch (err) { t.remove(); toast(err.message, 'error'); }
        }),
        card('window', '新窗口', '同时打开多个项目', () => api.invoke('window:new'))),
      h('div.welcome-section', h('h3', '最近打开'), recent),
      env))));
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); open(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); api.invoke('window:new'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...e.dataTransfer.files].map((x) => api.pathForFile(x)).find(Boolean);
    if (f) open(f);
  });
}

main().catch((err) => {
  console.error(err);
  document.body.appendChild(h('pre', { style: { color: 'var(--err)', padding: '20px', whiteSpace: 'pre-wrap', userSelect: 'text' } }, `启动失败:\n${err.stack || err.message}`));
});
