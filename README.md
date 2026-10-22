# Pi Desktop

`pi coding agent` 的桌面客户端（Electron）：把 pi 的 RPC 会话、代码编辑器（Monaco）、文件资源管理器、终端（xterm + node-pty）和 Git 集成放进一个类 VS Code 的工作台里。

- 应用标识：`Pi Desktop`（AppUserModelID `dev.pi.desktop`）
- 应用版本：`1.0.0`
- Electron 运行时：`41.10.7`（见根目录 `version` 文件）
- 许可证：MIT

---

## 1. 本仓库包含什么

本仓库入库的是**已打包产物中的源码部分**，即 `resources/app`，以及许可证文件：

```
LICENSE                     # MIT
LICENSES.chromium.html      # Chromium/Electron 附带许可证
resources/app/              # ★ 应用源码（打包时被放进 Electron 的 resources/app）
├── package.json            # name: pi-desktop, productName: Pi Desktop, version: 1.0.0
├── package-lock.json
├── main/                   # 主进程
│   ├── main.js             # 窗口/协议/菜单/IPC 入口
│   ├── config.js           # 用户配置（存于 Electron userData/config.json）
│   ├── pi-env.js           # 定位 pi CLI 与 Node 运行时、读写 ~/.pi/agent
│   ├── pi-session.js       # 每个会话 = 一个 `pi --mode rpc` 子进程
│   ├── desktop-extension.js# 以 `-e` 注入 pi 的桥接扩展（/__desktop 命令）
│   ├── terminal.js         # node-pty 终端管理
│   ├── workspace.js        # 文件读写/监听
│   ├── sessions.js         # 会话文件索引
│   ├── git.js              # git status/diff/stage/commit 等
│   └── preload.js          # 渲染进程安全桥
├── renderer/               # 渲染进程（无打包器，原生 ESM + CSS）
│   ├── index.html
│   ├── js/{app,chat,composer,editor,sidebar,terminal,workbench,settings,markdown,session,ui,util,chat-render}.js
│   └── styles/{base,chat,workbench}.css
└── assets/{icon.ico,icon.png}
```

**未入库**（见 `.gitignore`）：Electron 运行时本体（`Pi Desktop.exe` 214MB、`*.dll`、`*.pak`、`locales/` …）、`Pi-desktop.zip`、`resources/app/node_modules/`、`log/`。这些都可由下面的打包步骤重新生成。

---

## 2. 直接运行（使用已打包版本）

1. 解压 `Pi-desktop.zip`（或整个目录）到任意位置，保持目录结构不变。
2. 双击 `Pi Desktop.exe`。
   - 也可以把文件夹拖到 exe 上，或用命令行 `Pi Desktop.exe D:\my\project` 直接打开某个工作目录。
   - 单实例运行：再次启动只会在已有进程中打开新窗口。
3. 前置依赖：本机需要 **pi CLI** ——
   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```
   应用会按以下顺序查找 pi（找不到会提示）：
   `设置里的 pi 路径` → 环境变量 `PI_DESKTOP_PI_CLI` → `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent` → `npm root -g`。
4. 需要 **Node ≥ 22.19**（pi 的要求）。若系统没有合格 Node，应用会退回 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1`）；建议在「设置 → 运行时」里指定系统 Node，以免 Agent 派生的子进程继承该环境变量。
5. 首次使用在 AI 面板里执行 `/login`（或菜单 **Pi → 登录提供商**）完成提供商认证。

---

## 3. 使用说明

### 3.1 工作台布局

| 区域 | 内容 |
| --- | --- |
| 左侧栏 | 资源管理器、搜索、源代码管理（Git）、会话历史 |
| 中间 | Monaco 编辑器（多标签、diff 视图） |
| 下方面板 | 终端（PowerShell / cmd / Git Bash / WSL 等） |
| 右侧 AI 面板 | pi 会话；会话与文件夹绑定，可多标签并行 |

- **打开文件夹**：`Ctrl+O`，或欢迎页「打开文件夹」。最近打开的文件夹会在下次启动时自动恢复（多窗口）。
- **AI 会话**：`Ctrl+N` 新建聊天（在同一工作目录下新建 pi 会话），可在会话树里切换分支、查看工具调用、审阅/回退文件改动。
- **文件改动审阅**：Agent 修改文件时会记录基线，可在面板里逐文件查看 diff 并回退。
- **终端**：`Ctrl+J` 切换面板，`Ctrl+Shift+反引号(\`)` 新建终端；可多终端切换。
- **Git**：状态栏/侧栏显示变更，支持暂存、取消暂存、丢弃、提交、切换/新建分支、查看 staged diff。

### 3.2 快捷键（Windows / Linux 用 `Ctrl`，macOS 用 `Cmd`）

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+N` / `Ctrl+Shift+N` | 新建聊天 / 新建窗口 |
| `Ctrl+O` | 打开文件夹 |
| `Ctrl+S` | 保存（`文件 → 全部保存` 保存全部） |
| `Ctrl+,` | 设置 |
| `Ctrl+W` | 关闭当前编辑器 |
| `Ctrl+P` / `Ctrl+Shift+P` | 转到文件 / 命令面板 |
| `Ctrl+Shift+F` | 在文件中查找 |
| `Ctrl+Shift+E` / `Ctrl+Shift+G` | 资源管理器 / 源代码管理 |
| `Ctrl+B` | 切换侧边栏 |
| `Ctrl+Alt+B` | 切换 AI 面板 |
| `Ctrl+J` | 切换终端面板 |
| `Ctrl+Shift+反引号(\`)` | 新建终端 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 重置缩放 |
| `F2` / `Delete` / `Ctrl+C` `Ctrl+X` `Ctrl+V` | 资源管理器内：重命名 / 删除 / 复制 剪切 粘贴路径 |

输入框内：

| 快捷键 | 功能 |
| --- | --- |
| `Enter` | 发送（`设置 → 发送快捷键` 可改为 `Ctrl+Enter` 发送） |
| `Shift+Enter` | 换行 |
| `Alt+Enter` | 作为 follow-up 追加发送 |
| `Ctrl+L` | 选择模型 |
| `Ctrl+.` | 切换模式 |
| `Shift+Tab` | 循环思考强度 |
| `Alt+↑` | 恢复队列中的消息 |
| `↑` / `↓` | 历史输入 |
| `Esc` | 取消当前生成 / 关闭弹层 |

### 3.3 AI 面板常用命令

`/tree`（会话树）、`/fork`（分叉）、`/clone`、`/compact`（压缩上下文）、`/session`（会话信息）、`/reload`（重载扩展/技能/模板）、`/login`，以及「导出 HTML / JSONL」、「导入会话 (JSONL)」。

### 3.4 设置项

「设置」中可调：主题（深/浅）、界面/编辑器/对话字号、发送快捷键、自动保存、完成通知、显示思考过程、自动换行、minimap、默认 shell，以及 `pi CLI 路径` / `Node 路径`。

配置文件位置：`%APPDATA%\Pi Desktop\config.json`（macOS/Linux 对应 Electron 的 userData 目录）。

---

## 4. 如何编译打包出 `Pi Desktop.exe`

### 4.1 产物结构（当前分发包的实际形态）

这是 **Electron 的「未压缩目录」式分发**，而不是安装包：

```
Pi Desktop.exe          # Electron 主程序，改名为产品名 + 自定义图标 + 改写版本资源
chrome_*.pak
d3dcompiler_47.dll dxcompiler.dll dxil.dll ffmpeg.dll icudtl.dat
libEGL.dll libGLESv2.dll resources.pak snapshot_blob.bin v8_context_snapshot.bin
vk_swiftshader.dll vk_swiftshader_icd.json vulkan-1.dll
locales/                # Chromium 语言包
version                 # "41.10.7" —— Electron 版本
resources/app/          # ★ 应用源码目录（注意：不是 app.asar）
LICENSE LICENSES.chromium.html
```

已确认的关键事实（决定了打包参数）：

1. `resources/app` 是**目录**而非 `app.asar` → 打包时关闭了 asar。
2. `Pi Desktop.exe` 的 PE 版本资源已被改写为：
   `CompanyName / ProductName / FileDescription / InternalName = "Pi Desktop"`，
   `FileVersion / ProductVersion = 1.0.0.0`，
   `OriginalFilename = "Pi Desktop.exe"`，`LegalCopyright = "MIT"`。
   即打包后额外用 rcedit 一类工具写入了产品名、版本、版权和 `assets/icon.ico` 图标（Electron 默认的 Electron 元数据已被替换）。
3. `resources/app/node_modules` 只保留**生产依赖**：`@vscode/codicons`、`@xterm/xterm`、`@xterm/addon-fit`、`dompurify`、`marked`、`monaco-editor`、`node-pty`。
4. `node-pty@1.1.0` 用的是 `prebuilds/win32-x64/`（`conpty.node`、`pty.node`、`winpty-agent.exe` 等），**目录下没有 `build/Release`** → 打包时没有执行 `electron-rebuild` / 本地编译，直接使用随包预编译二进制（因此打包机无需 MSVC / Python）。
5. 渲染进程通过自定义协议 `pidesk://app/` 直接从 `resources/app` 目录读取 `renderer/` 与 `node_modules` 静态资源 —— 这也是必须保持目录结构、不能把整个 app 压成单文件的原因之一。
6. `Pi-desktop.zip` 就是上述目录树的压缩包，用于分发。

> 说明：仓库里没有提交打包脚本/构建配置（`package.json` 中也没有 devDependencies 与打包器配置），上面的事实是从产物反推的。下面给出两条可完全复现该目录结构的做法。

### 4.2 方式一：electron-packager（最贴近当前产物，推荐）

```bash
# 0) 准备源码目录（把仓库里的 resources/app 拷出来当项目根）
mkdir pi-desktop-src && cd pi-desktop-src
cp -r ../Pi-desktop/resources/app/* .        # Windows: xcopy /E /I ..\Pi-desktop\resources\app .

# 1) 安装生产依赖（在源码目录，node_modules 会被打进包里）
npm install --omit=dev

# 2) 打包：Electron 41.10.7 + win32-x64 + 关闭 asar + 自定义图标/元数据
npx --yes electron-packager@19 . "Pi Desktop" \
  --platform=win32 --arch=x64 \
  --electron-version=41.10.7 \
  --icon=assets/icon.ico \
  --app-version=1.0.0 \
  --app-copyright=MIT \
  --win32metadata.CompanyName="Pi Desktop" \
  --win32metadata.ProductName="Pi Desktop" \
  --win32metadata.FileDescription="Pi Desktop" \
  --win32metadata.InternalName="Pi Desktop" \
  --asar=false \
  --prune=true \
  --overwrite \
  --out=dist

# 产物：dist/Pi Desktop-win32-x64/
#   Pi Desktop.exe + *.dll + locales/ + resources/app/ …（正好是当前目录结构）
```

要点：
- `--asar=false`：必须。否则会生成 `resources/app.asar`，与当前产物不一致（且 `pidesk://` 协议按目录读取，node-pty 的 `.node` 也得 unpack）。
- `--electron-version=41.10.7`：与根目录 `version` 文件一致。
- `--icon=assets/icon.ico` + `--win32metadata.*` / `--app-version` / `--app-copyright`：对应 4.1 第 2 点里被改写的 PE 资源。
- `--prune=true`：剔除 devDependencies，保证 `node_modules` 只有那 7 个生产包。
- 无需 `electron-rebuild`：node-pty 走 `prebuilds/win32-x64`。
- 若要跨架构：`--arch=arm64` 同样可用（node-pty 需自带对应 prebuild）。

### 4.3 方式二：electron-builder（也可，注意 asar）

在源码目录加 `package.json` 的 `build` 段：

```json
{
  "build": {
    "appId": "dev.pi.desktop",
    "productName": "Pi Desktop",
    "asar": false,
    "directories": { "output": "dist" },
    "win": {
      "target": ["dir"],
      "icon": "assets/icon.ico"
    },
    "copyright": "MIT"
  }
}
```

```bash
npm install --omit=dev
npx --yes electron-builder@25 --win --x64
# 产物：dist/win-unpacked/（Pi Desktop.exe + resources/app/…）
```

- `"target": ["dir"]` 出未压缩目录；要安装包可换成 `nsis`/`portable`（此时产物结构与仓库里的 zip 不同）。
- 必须 `"asar": false` 才能得到 `resources/app` 目录；若要开 asar，则需 `"asarUnpack": ["**/node_modules/node-pty/**"]`。
- electron-builder 会自行写入 exe 版本资源（`LegalCopyright` 取 `copyright`）。

### 4.4 方式三：纯手工组装（不依赖打包器）

```bash
# 1) 下载 Electron 41.10.7 的 win32-x64 发行包并解压
#    https://github.com/electron/electron/releases/tag/v41.10.7 → electron-v41.10.7-win32-x64.zip

# 2) 放进应用：electron.exe 同级创建 resources/app，把源码拷进去
#    并安装生产依赖（也可直接把已构建好的 node_modules 一起拷入）
npm install --omit=dev --prefix resources/app

# 3) 改名 + 改图标 + 改版本资源（rcedit）
npm i -g rcedit
rcedit electron.exe --set-icon assets/icon.ico
rcedit electron.exe \
  --set-version-string "ProductName" "Pi Desktop" \
  --set-version-string "CompanyName" "Pi Desktop" \
  --set-version-string "FileDescription" "Pi Desktop" \
  --set-version-string "InternalName" "Pi Desktop" \
  --set-version-string "OriginalFilename" "Pi Desktop.exe" \
  --set-version-string "LegalCopyright" "MIT" \
  --set-file-version "1.0.0.0" --set-product-version "1.0.0.0"
mv electron.exe "Pi Desktop.exe"
```

这种方式与 electron-packager 的结果基本等价（差别仅在 `version` 文件与 locales 的裁剪）。

### 4.5 发布 zip

```powershell
# PowerShell：进入 dist\Pi Desktop-win32-x64 的上级目录
Compress-Archive -Path "dist\Pi Desktop-win32-x64\*" -DestinationPath "Pi-desktop.zip" -CompressionLevel Optimal
```

（macOS/Linux 交叉打包可用 `zip -r -9 Pi-desktop.zip "Pi Desktop-win32-x64"`。注意 GitHub Releases 单文件上限 2GB，仓库本身不入库 exe。）

### 4.6 改版本号 / 图标 / 名称时要动的地方

| 想改什么 | 位置 |
| --- | --- |
| 应用版本 / 名称 / 描述 | `resources/app/package.json`（`version`、`productName`、`description`），打包时同步 `--app-version` |
| 窗口标题、任务栏分组 | `main/main.js`：`app.setName('Pi Desktop')`、`app.setAppUserModelId('dev.pi.desktop')` |
| 图标 | `assets/icon.ico`（Windows）、`assets/icon.png` |
| Electron 版本 | 根目录 `version` 文件 + 打包参数 `--electron-version` |
| 版权信息 | 打包参数 `--app-copyright` / `copyright` |

---

## 5. 故障排查

| 现象 | 处理 |
| --- | --- |
| 提示「未找到 pi CLI」 | `npm install -g @earendil-works/pi-coding-agent`，或在「设置 → 运行时」里填 pi 路径 |
| 提示 Node 版本过低 / 子进程行为异常 | 安装 Node ≥ 22.19 并在设置里指定 `node.exe` |
| 终端空白 / 报 conpty 错误 | 需要 Windows 10 1809+；确认 `resources/app/node_modules/node-pty/prebuilds/win32-x64/` 完整 |
| 打包后白屏 | 检查是否误开了 asar（`resources/app` 应为目录）、`resources/app/renderer` 与 `node_modules` 是否存在 |
| 打包后 exe 图标/名称没变 | rcedit 步骤未执行，或图标不是多尺寸 `.ico` |
| 首次运行未保存布局 | 布局/窗口状态存在 `%APPDATA%\Pi Desktop\config.json`，删除该文件可重置 |
