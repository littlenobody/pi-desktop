# Pi Desktop

把 pi coding agent（`@earendil-works/pi-coding-agent`）封装成 Cursor 风格的桌面客户端：左边文件树 / 搜索 / Git，中间 Monaco 编辑器 + 集成终端，右边是 AI 聊天面板，**每个聊天标签都是一个独立的 `pi` 进程**，可以同时跑多个会话。

- 直接使用：双击本目录下的 **`Pi Desktop.exe`**
- 从源码重新打包：见 [第二节](#二从源码打包成-exe)
- 使用说明：见 [第三节](#三怎么用)

---

## 一、目录结构

```
D:\tools\Pi-desktop\
├─ Pi Desktop.exe            ← 双击启动（Electron 41.10.7 · Chromium 146 · Node 24.18）
├─ *.dll, locales\, *.pak …  ← Electron 运行时，别删
├─ resources\app\            ← 应用本体（源码 + 依赖）
│  ├─ package.json
│  ├─ main\                  ← Electron 主进程（Node 侧）
│  │  ├─ main.js             窗口、菜单、IPC、pidesk:// 协议、自测钩子
│  │  ├─ preload.js          contextBridge 暴露给渲染进程的 API
│  │  ├─ config.js           桌面端配置（%APPDATA%\Pi Desktop\config.json）
│  │  ├─ pi-env.js           定位 pi CLI / Node / Git / agent 目录 / 信任状态
│  │  ├─ pi-session.js       一个聊天标签 = 一个 `pi --mode rpc` 子进程 + JSONL 协议 + 文件改动追踪
│  │  ├─ desktop-extension.js 注入 pi 的桥接扩展（/tree 跳转、标签、工具开关、工具调用确认）
│  │  ├─ workspace.js        文件树/读写/搜索(ripgrep)/文件监听
│  │  ├─ git.js              源代码管理（status/stage/commit/diff/分支）
│  │  ├─ sessions.js         历史会话（读 ~/.pi/agent/sessions/**/*.jsonl）
│  │  └─ terminal.js         集成终端（node-pty + ConPTY，失败时降级为管道）
│  ├─ renderer\              ← 界面（原生 ES Module，无构建步骤）
│  │  ├─ index.html
│  │  ├─ styles\             base.css / workbench.css / chat.css
│  │  ├─ js\                 app / workbench / editor / chat / chat-render / composer
│  │  │                      sidebar / terminal / settings / session / markdown / ui / util
│  │  └─ assets\logo.svg, icon.ico, icon.png
│  └─ node_modules\          仅运行期依赖：monaco-editor、xterm、node-pty、marked、dompurify、codicons
├─ build.ps1                 ← Windows 一键重新打包
├─ build.sh                  ← WSL/Linux/macOS 侧重新打包
├─ package.json               ← 只放打包工具依赖（resedit）
├─ node_modules\             ← 打包工具依赖（可删，重新打包时会自动装）
├─ .build\                   ← Electron 运行时下载缓存（可删，删了下次重新下载）
└─ scripts\brand.js          ← 给 exe 写图标与版本信息（resedit）
```

用户数据：`%APPDATA%\Pi Desktop\config.json`（窗口位置、主题、最近打开的文件夹、布局）。
pi 自己的数据仍在 `%USERPROFILE%\.pi\agent\`（`settings.json`、`models.json`、`auth.json`、`sessions\`、`trust.json`），**和命令行版 pi 完全共用**。

---

## 二、从源码打包成 exe

原理：Electron 应用 = 「Electron 运行时」+「resources\app 目录」。本目录就是这么组装出来的，所以打包脚本做的事很朴素 —— **下载 Electron → 把 app 目录放进去 → 改名 + 写图标/版本号**。

### 0. 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22.19**（当前机器 22.20 ✔） | pi 本身要求；桌面端会自动选用系统 Node，找不到才回退到 Electron 内置 Node |
| pi CLI | `npm install -g @earendil-works/pi-coding-agent` | 桌面端通过 `%APPDATA%\npm\node_modules\...` 或 `npm root -g` 自动定位 |
| Git（可选） | `git.exe` 在 PATH 上 | 源代码管理功能需要；Windows 下 pi 的 `bash` 工具还需要 `bash.exe`（脚本会自动把 `D:\tools\Git\bin` 之类目录补进子进程 PATH） |

### 1. 一键打包（Windows，推荐）

在 `D:\tools\Pi-desktop` 下执行：

```powershell
# 就地打包（覆盖当前目录里的运行时与 resources\app，产出仍是双击即用的 Pi Desktop.exe）
powershell -ExecutionPolicy Bypass -File .\build.ps1

# 打到别的目录
powershell -ExecutionPolicy Bypass -File .\build.ps1 -OutDir D:\PiDesktop

# 依赖目录损坏时，先删 node_modules 重装
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Clean

# 换 Electron 版本 / 换镜像
powershell -ExecutionPolicy Bypass -File .\build.ps1 -ElectronVersion 41.10.7 -Mirror https://cdn.npmmirror.com/binaries/electron
```

脚本步骤（`build.ps1`）：

1. 检查 Node；
2. `resources\app` 缺依赖时执行 `npm install --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com`（`--ignore-scripts` 避免 node-pty 触发 node-gyp 编译，官方 tarball 自带 Windows 预编译产物）；
3. 下载 `electron-v41.10.7-win32-x64.zip` 到 `.build\` 并解压（国内走 npmmirror CDN，约 137 MB，只下一次）；
4. 把运行时复制到输出目录 → `electron.exe` 改名 `Pi Desktop.exe` → 删除 `resources\default_app.asar` → 放入 `resources\app`；
5. 用 `resedit` 往 exe 里写图标（16/24/32/48/64/128/256）和版本信息（产品名 `Pi Desktop`、版本号），这样任务管理器 / 文件属性里显示正常，而不是 “Electron”。

### 2. 一键打包（WSL / Linux / macOS 侧）

```bash
cd /mnt/d/tools/Pi-desktop
chmod +x build.sh

./build.sh                      # 就地打包 Windows x64（默认），产出 Pi Desktop.exe
./build.sh win32 /mnt/d/PiDesk  # 指定平台与输出目录
PLATFORM=linux ./build.sh       # 产出 Linux 版（方便在 WSL 里自测界面）
```

> 说明：`build.sh` 只清理**输出副本**里 node-pty 的多余平台预编译文件，不会动源码目录。
> 若做非 Windows 目标的包，node-pty 需要对应平台预编译文件（`npm rebuild node-pty`），脚本会给出提示。

### 3. 手工打包（不用脚本）

```powershell
# 1) 装 app 依赖
cd D:\tools\Pi-desktop\resources\app
npm install --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com

# 2) 下 Electron 运行时
curl.exe -L -o D:\tmp\electron.zip https://cdn.npmmirror.com/binaries/electron/41.10.7/electron-v41.10.7-win32-x64.zip
Expand-Archive D:\tmp\electron.zip -DestinationPath D:\tmp\electron -Force

# 3) 组装
Copy-Item D:\tmp\electron\* D:\tools\Pi-desktop\ -Recurse -Force
Rename-Item D:\tools\Pi-desktop\electron.exe "Pi Desktop.exe"
Remove-Item D:\tools\Pi-desktop\resources\default_app.asar

# 4) 图标 + 版本号（可选）
cd D:\tools\Pi-desktop
npm install --no-save resedit
node scripts\brand.js "D:\tools\Pi-desktop\Pi Desktop.exe"
```

### 4. 改了源码之后怎么生效

`resources\app` 是**未打包的明文目录**，改完直接重启客户端即可（`Ctrl+Shift+R` 也能重载窗口，主进程改动需退出重开）：

| 改了什么 | 操作 |
|---|---|
| `renderer\**`（界面、样式） | 重启客户端，或按 `Ctrl+Shift+R` 重载窗口 |
| `main\**`（主进程、IPC、pi 通信） | 退出客户端再打开 |
| 新增 npm 依赖 | 在 `resources\app` 里 `npm install`，然后按需重跑 `build.ps1` |

调试：设置环境变量 `PI_DESKTOP_DEVTOOLS=1` 后启动，会打开开发者工具；`Ctrl+Shift+I` 也可手动打开。

### 5. 如果用 electron-builder 之类工具想做成安装包

本项目**没有**引入打包工具链（保持零构建、可直接改源码）。若你需要 `.exe` 安装器或单文件绿色版，可在现有目录基础上：

```powershell
# 目录即绿色版：直接压缩分发
Compress-Archive -Path "D:\tools\Pi-desktop\*" -DestinationPath D:\PiDesktop-1.0.0-win-x64.zip
```

或按 electron-builder 文档把 `resources\app` 作为 `files` 输入、把 `build.ps1` 的步骤 3~5 交给它完成。

---

## 三、怎么用

首次启动后：

1. 点 **打开文件夹**（`Ctrl+O`）选择项目目录（也可以用 `Pi Desktop.exe D:\your\project` 直接带目录启动，或把文件夹拖进窗口）；
2. 右边聊天面板会自动起一个 `pi` 进程，输入需求回车即可；
3. 右下角显示当前模型、上下文占用、累计 token/费用。

### 3.1 界面布局

```
┌───────────────── 标题栏：文件 编辑 查看 Agent 终端 帮助 ────────────────┐
│ 活动栏 │ 侧边栏        │ 编辑器区（标签页）            │ AI 聊天面板   │
│ 文件   │ 资源管理器    │ 面包屑 / Monaco / 差异对比    │ 会话标签      │
│ 搜索   │ 搜索          │                              │ 消息流        │
│ Git    │ 源代码管理    │                              │ 改动审阅条    │
│ 会话   │ 会话历史      │                              │ 输入框        │
│ 聊天   │               ├──── 终端面板（Ctrl+J）────────┤               │
└────────┴───────────────┴──────────────────────────────┴───────────────┘
   状态栏：分支 / 模型 / 思考强度 / 上下文 / 用量 / 光标位置 / 语言 / 换行符
```

拖动分隔线可调宽窄；双击分隔线复位；`Ctrl+B` 收起侧边栏，`Ctrl+Alt+B` 收起聊天，`Ctrl+Alt+M` 让聊天占满窗口。

### 3.2 聊天面板（核心）

**多会话 / 多开**

- 聊天面板顶部 `+` 新建聊天标签，每个标签 = 一个独立 `pi` 进程、独立会话文件、独立模型/思考强度；
- 标签上的小圆点：蓝=运行中，黄=等待你确认，绿=结束时你有未读，红=进程出错；
- 多个标签可同时跑任务，切走继续跑，结束时系统通知；
- 需要彻底并行（不同项目）时：`Ctrl+Shift+N` 新窗口，同一项目重复打开会聚焦已有窗口。

**输入框**

| 操作 | 效果 |
|---|---|
| `Enter` | 发送；Agent 正在运行时为「插入引导（steer）」，在当前回合工具执行完后生效 |
| `Alt+Enter` | follow-up：等 Agent 完全做完再执行 |
| `Shift+Enter` | 换行 |
| `Esc` | 中止当前任务（会把你排队的消息取回输入框） |
| `Alt+↑` | 把排队中的消息取回输入框 |
| `@` | 选文件/文件夹作为上下文（文件内容以 `<file>` 块内联，文件夹以 `@路径/` 提及） |
| `/` | 命令、提示模板、技能 |
| `!cmd` / `!!cmd` | 运行 shell，`!` 把输出加入模型上下文，`!!` 不加入 |
| `↑` / `↓` | 浏览历史输入 |
| 拖拽文件 / 粘贴截图 | 变成上下文（图片作为附件发给模型） |

输入框左下三个胶囊：**模式**（Agent / Ask）、**模型**、**思考强度**；右侧圆环是上下文占用（点它等于 `/compact`）。顶部会显示「添加上下文」chip，可单个删除。

**Agent / Ask 模式**

- `Agent`：完整工具（read/bash/edit/write…），可改文件、跑命令；
- `Ask`：只挂只读工具（read/grep/find/ls），只回答问题不改代码；
- 切换：点模式胶囊或 `Ctrl+.`；「运行编辑/命令类工具前询问」也在同一个菜单里 —— 打开后 edit/write/bash 调用会先在聊天里出现「运行 / 拒绝」按钮（Cursor 的 approve 体验）。

**消息操作**

- 用户消息悬停：复制、**编辑并重新发送**（从该点开新分支，原对话保留）、**恢复检查点**、分叉为新会话、打标签；
- 助手消息悬停：复制、重新生成（同样走分支）；
- 思考块可折叠；工具调用卡片可展开，`edit`/`write` 直接显示带行号的红绿 diff，`bash` 显示命令与输出，点击文件路径可跳到编辑器对应行；
- 顶部的「已处理」类提示：模型切换、上下文压缩摘要、分支摘要、扩展消息都可展开查看。

**改动审阅（Cursor 式 Review）**

Agent 每次修改文件都会在输入框上方累出一条 **“N 个文件已更改 +x −y”**：

- 点文件名 → 打开「修改前 ↔ 当前」的 Monaco 差异视图（可并排/内联切换）；
- 单文件“撤销”或“全部撤销” → 恢复到 Agent 修改前的原文（新建的文件会被删除）；
- “全部保留” → 清空审阅列表（不回滚内容）；
- 每条用户消息上的 **恢复检查点** 可以撤销“这条消息之后 Agent 做过的所有文件修改”，再配合“编辑并重新发送”就等于 Cursor 的「回滚并改写」。

**会话级操作**（聊天面板右上 `…`，或斜杠命令）

| 命令 | 说明 |
|---|---|
| `/tree` | 会话树面板：查看所有分支，跳到任意节点（离开的分支可选择生成摘要），`L` 给节点打标签 |
| `/fork` | 从某条历史用户消息分叉出**新会话**（新标签） |
| `/clone` | 复制当前会话 |
| `/compact [指令]` | 压缩上下文，可附加“重点保留什么” |
| `/name` | 重命名会话（历史列表里显示） |
| `/session` | 会话信息：文件、ID、消息数、token、费用、自动压缩/重试开关 |
| `/export` | 导出 HTML 或 JSONL |
| `/share` | 导出并上传为私有 GitHub Gist（需要 `gh` 已登录），给出 pi.dev 预览链接 |
| `/import` | 导入 JSONL 会话 |
| `/copy` | 复制最后一条回复 |
| `/tools` | 勾选暴露给模型的工具（会话级） |
| `/system-prompt` | 查看当前系统提示词 |
| `/reload` | 重载扩展、技能、提示模板、上下文文件 |
| `/model`、`/thinking` | 选模型 / 设思考强度（`Ctrl+L`、`Shift+Tab` 也能） |
| `/login`、`/logout` | 配置 / 移除提供商凭据 |
| `/trust` | 项目信任决策 |
| `/tui` | 在集成终端里用 pi 自带 TUI 打开当前会话（需要 TUI 专属功能时用，如 `/bug`） |
| `/hotkeys`、`/changelog`、`/settings`、`/debug` | 快捷键、更新日志、设置、pi 进程日志 |

> 扩展 / 提示模板 / 技能注册的命令（`get_commands` 返回的）会原样发给 pi 执行，`/` 补全里也能看到。

**会话历史**：活动栏「会话」图标 → 当前项目的历史会话（可切到全部项目），支持搜索、重命名、删除、在 TUI 中打开、导出。

### 3.3 编辑器

- Monaco（VS Code 同款）：多标签、预览标签（单击预览，双击固定）、拖拽排序、`Ctrl+P` 按名搜索、`Ctrl+Shift+F` 全项目搜索（ripgrep）、保存时自动处理 BOM/行尾，磁盘被外部修改会提示冲突/自动重载；
- 图片（png/jpg/gif/webp…）直接在标签里预览，点一下放大；Markdown 有源码/预览切换；二进制/超大文件提示用系统程序打开；
- **`Ctrl+L`**：把当前选区（或当前行）加入聊天上下文；
- **`Ctrl+K`**：对选区发起内联编辑请求（会生成“只改这段代码”的提示并带上行号范围）；
- 右键菜单还有「将选区添加到聊天」「在新聊天中讨论」「解释选中代码」「修复选中问题」「与 Git HEAD 比较」；
- Agent 改文件时，已打开的标签会自动同步（未保存的改动不会被覆盖）。

### 3.4 终端 / 源代码管理 / 设置

- **终端**（`Ctrl+J`，`Ctrl+Shift+`` 新建）：PowerShell 7 / Windows PowerShell / cmd / Git Bash / WSL 任选（右上角下拉，可设默认）；支持 `Ctrl+C/V`（有选区时复制）、右键菜单、多终端列表。终端面板的「输出 (pi)」页签显示每个 pi 进程的 stderr 日志，排查启动问题用。
- **源代码管理**（`Ctrl+Shift+G`）：提交信息框（`Ctrl+Enter` 提交，旁边 ✨ 让 Agent 生成提交信息）、暂存/取消暂存/放弃更改、点击文件看 HEAD ↔ 工作区 diff、分支切换、同步（pull & push）。
- **设置**（`Ctrl+,`）：
  - *Pi Desktop*：主题、字号、发送快捷键、默认模式与工具确认、通知、自动保存、小地图、默认终端；
  - *Pi 设置*：图形化编辑 `settings.json`（用户 / 项目两栏，带默认值提示），覆盖模型默认值、压缩、重试、代理、默认工具、资源路径、信任策略等；
  - *提供商与登录*：管理 `auth.json` 里的 API Key（支持 `!命令` 形式从密码管理器读取）；OAuth/订阅登录给了一个“在 Pi TUI 里跑 `/login`”的入口；
  - *模型*：列出可用模型，勾选进入循环范围，一键设为默认；
  - *配置文件*：一键打开 `settings.json` / `models.json` / `mcp.json` / `AGENTS.md` / 扩展与技能目录，MCP 与 Pi 包管理也给了 `pi mcp list` / `pi install` 的终端入口；
  - *运行环境*：显示并允许指定 pi CLI 与 Node 路径（找不到 pi 时会自动弹出这个引导）。

### 3.5 快捷键

| 快捷键 | 功能 | 快捷键 | 功能 |
|---|---|---|---|
| `Ctrl+I` | 聚焦聊天 | `Ctrl+N` | 新建聊天 |
| `Ctrl+Alt+B` | 显示/隐藏聊天 | `Ctrl+Alt+M` | 聊天最大化 |
| `Ctrl+Shift+N` | 新窗口 | `Ctrl+O` | 打开文件夹 |
| `Ctrl+R` | 最近文件夹 | `Ctrl+P` | 按名打开文件（`>` 命令，`:` 行号，`#` 文本搜索） |
| `Ctrl+Shift+P` | 命令面板 | `Ctrl+Shift+F` | 全项目搜索 |
| `Ctrl+Shift+E` | 资源管理器 | `Ctrl+Shift+G` | 源代码管理 |
| `Ctrl+B` | 侧边栏 | `Ctrl+J` | 终端面板 |
| `Ctrl+S` / `Ctrl+Alt+S` | 保存 / 全部保存 | `Ctrl+W` | 关闭编辑器 |
| `Ctrl+Tab` | 切换编辑器 | `Ctrl+Alt+]` / `[` | 切换聊天标签 |
| `Ctrl+K` | 内联编辑选区 | `Ctrl+L` | 选区加入聊天（编辑器）/ 选模型（聊天框） |
| `Ctrl+.` | 切换 Agent/Ask 模式 | `Shift+Tab` | 循环思考强度 |
| `Enter` / `Alt+Enter` | 发送 / follow-up | `Esc` | 中止 |
| `Ctrl+Shift+R` | 重载窗口 | `Ctrl+Shift+Backspace` | 中止 Agent |
| `Ctrl+O` | 打开文件夹（焦点在聊天框内时= 展开/折叠工具输出） | `Ctrl+,` | 设置 |

### 3.6 项目信任

如果项目里有 `.pi/settings.json`、`.pi/extensions`、`.pi/skills`、`.pi/mcp.json` 等资源，首次打开会弹「信任此项目？」（因为 RPC 模式无法显示 pi 自己的信任提示，桌面端代替它询问）。选择「始终信任」会写入 `~/.pi/agent/trust.json`，与命令行 pi 共享；也可随时用 `/trust` 修改。不信任时项目资源不会加载，聊天里会有一条黄色提示。

---

## 四、常见问题

| 现象 | 处理 |
|---|---|
| 启动提示“未找到 pi” | `npm install -g @earendil-works/pi-coding-agent`；或设置 → 运行环境 → 指定 `pi CLI 路径`（可指向 `...\pi-coding-agent` 包目录或 `dist\bundle\cli.js`） |
| 模型列表为空 | 设置 → 提供商与登录 添加 API Key，或设置环境变量（如 `ANTHROPIC_API_KEY`），或在 `~/.pi/agent/models.json` 配自定义端点；也可在聊天里 `/login` |
| `bash` 工具报找不到 shell | 装 Git for Windows；桌面端会自动把 Git 的 `bin` 目录补进 pi 子进程 PATH，也可以在 `settings.json` 里设 `shellPath` |
| 终端里中文/颜色异常 | 终端右上角换成 PowerShell 7 或 Git Bash；`TERM=xterm-256color` 已自动设置 |
| 会话没出现在历史里 | 历史列表默认只看当前项目；点地球图标切到“所有项目” |
| 想回到某次改动之前 | 该用户消息 →「恢复检查点」（撤销文件改动）；或 `/tree` 跳回该节点 |
| 界面显示异常 | `Ctrl+Shift+R` 重载窗口；仍异常时设 `PI_DESKTOP_DEVTOOLS=1` 启动看控制台 |
| 想彻底重置桌面端 | 关闭客户端，删除 `%APPDATA%\Pi Desktop\`（不影响 pi 的 `~/.pi`） |

## 五、实现要点（给二次开发）

- **通信**：主进程为每个聊天标签 `spawn` 一个 `pi --mode rpc -e main/desktop-extension.js`，用严格 LF 分帧的 JSONL 收发；`pi-session.js` 负责请求/响应关联、事件转发、按需 `get_entries` 增量同步、崩溃重连。
- **状态重建**：渲染层 `session.js` 只用「持久化 entries + 实时事件」重建对话视图（流式 delta、工具调用、队列、压缩/重试状态都来自事件），因此可以和 TUI 同时读写同一会话文件。
- **协议未覆盖的能力**：`/tree` 跳转、打标签、工具开关、`/reload`、系统提示词读取、工具调用确认，都通过注入的 `desktop-extension.js` 暴露成 `/__desktop <op> <json>` 命令，结果用带标记的 `notify` 回传。
- **安全**：渲染进程 `contextIsolation: true`、`sandbox: true`、无 `nodeIntegration`；所有能力经 `preload.js` 白名单暴露；Markdown 渲染走 DOMPurify；`pidesk://` 协议只允许读应用目录与显式传入的绝对路径文件。

## 六、许可

本项目代码为 MIT。随附的第三方组件：Electron（MIT）、Monaco Editor（MIT）、xterm.js（MIT）、node-pty（MIT）、marked（MIT）、DOMPurify（Apache-2.0 / MPL-2.0）、@vscode/codicons（CC BY 4.0）；pi 本身（`@earendil-works/pi-coding-agent`）按其自身许可使用，本客户端不重新分发 pi。
