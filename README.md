# dsh-desktop

把 DeepSeek Harness Web GUI 打包成桌面应用的 Electron 壳：**点击图标启动（自动拉起 `dsh web` 服务并打开界面窗口），关闭窗口即停止服务**。

## 工作原理

```
双击图标 / npm start
  └─ Electron (main.js)          ← 注意用 `electron main.js` 启动（见"已知限制"）
       ├─ 探测 127.0.0.1:3080 是否已被占用
       │    ├─ 已占用 → 直接附着已有实例（不接管其生命周期，退出时不杀它）
       │    └─ 未占用 → 确保 Node 运行时
       │         ├─ 本机有 node → 用之
       │         └─ 本机无 node → 下载便携版 Node.js（约 30MB，官方或国内镜像）
       │    → 定位 dsh
       │         ├─ 本机已装（DSH_BIN / dsh-path.txt / which/where / npx 缓存）→ 用之
       │         └─ 未安装 → 询问后自动下载（npm install @deepseek-ai/dsh
       │                      到应用数据目录，含全部插件，首次约 100~200 MB）
       ├─ spawn `dsh web --port 3080`（工作目录 = $HOME 或 $DSH_APP_WORKSPACE；
       │   无系统 node 时用便携 node 运行）
       ├─ 轮询 HTTP 端点就绪后，BrowserWindow 加载 http://127.0.0.1:3080
       └─ 窗口关闭 / 应用退出 → 向 dsh 进程发 SIGTERM（优雅关闭，5s 后强制 SIGKILL）
```

`dsh web` 本身内置了 SIGTERM/SIGINT 优雅关闭（dispose 整个 Cordis 插件树），所以"退出即停服务"在机制上是原生支持的，无需额外清理。端到端测试已验证：窗口关闭后 50ms 内 dsh 进程干净退出（code=0），端口释放、无残留进程。

**完全自包含，连 Node 都不用装**：目标机器只需联网；Linux/macOS 使用系统的 `curl`/`tar`，Windows 使用 Electron 网络能力和 PowerShell `Expand-Archive`，首次启动会自动补齐全部运行时：
- **首次启动（需要下载时）先显示配置页**，选择下载源（官方/国内镜像/自定义）、工作目录、端口；提交后显示当前步骤、百分比、下载量和 npm 实时输出
- 无 `node` → 下载对应平台和 CPU 架构的**便携版 Node.js**（LTS v22，官方源或国内镜像）到应用数据目录（Linux 默认 `~/.config/Electron/dsh-runtime/node/`，Windows 默认 `%APPDATA%\Electron\dsh-runtime\node`）
- 无 `dsh` → 用便携 node 自带的 npm 下载 `@deepseek-ai/dsh`（含全部插件）
- npm 安装、原生模块编译、dsh 运行全部使用便携 node，与系统环境完全隔离
- 之后再次启动不再询问（配置已保存；下载内容复用）

自动下载流程：`npm install @deepseek-ai/dsh` → 读取已装原生包的版本并写入 `allowScripts`（npm ≥12 默认阻止安装脚本）→ `npm rebuild` 编译原生模块。**Linux 需要编译工具链**（`make`/`g++`/`python3`，多数发行版自带 build-essential）；若机器没有工具链，node-pty 等原生模块无法编译，dsh 的终端能力将不可用。

**国内网络加速**：首次下载的弹窗可直接选择「国内镜像源」（npmmirror）；也可预先设置 `DSH_APP_NPM_REGISTRY=cn`（或完整镜像 URL）与 `DSH_APP_NODE_MIRROR=cn`，下载全程走国内源，速度与稳定性明显更好。

## 使用

### 方式1 使用安装包

下载地址：<https://github.com/liaoxianfu/dsh-desktop/releases>


### 方式2 下载代码本地运行

```bash
npm install          # 安装 electron
./setup.sh           # 固定 dsh 路径到 dsh-path.txt
npm start            # 启动应用（等价于 node_modules/.bin/electron main.js）
```

把应用装进系统菜单（生成 .desktop 图标，之后可在应用列表点击启动）：

```bash
./setup.sh --desktop
```

## 配置

配置文件在 `~/.config/Electron/settings.json`，重启后生效。设置项包括：服务端口、工作目录、npm 下载源、Node.js 下载源、便携 Node 版本、运行时安装目录、dsh 包版本。

配置优先级：**环境变量 > 设置文件 > 默认值**。下表为环境变量（优先级最高，适合脚本化/自动化部署）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_APP_PORT` | 服务端口 | `3080` |
| `DSH_APP_WORKSPACE` | dsh 的工作目录（workspace 根） | `$HOME` |
| `DSH_BIN` | 显式指定 dsh 可执行文件路径 | 自动探测 |
| `DSH_APP_RUNTIME_DIR` | 自动下载的 dsh 安装目录 | `~/.config/Electron/dsh-runtime` |
| `DSH_APP_DSH_SPEC` | 自动下载的 npm 包说明符 | `@deepseek-ai/dsh@latest` |
| `DSH_APP_NPM_REGISTRY` | 自动下载用的 npm 源：完整 URL，或别名 `cn`/`npmmirror`（国内镜像）、`npmjs`/`default`（官方源） | 官方源（首次下载弹窗可选国内镜像） |
| `DSH_APP_NODE_MIRROR` | 便携 Node 的下载源：完整 URL，或别名 `cn`/`npmmirror`（国内镜像）、`official`/`nodejs`（官方源） | 官方源 |
| `DSH_APP_NODE_MAJOR` | 便携 Node 的大版本线（LTS） | `22` |
| `DSH_APP_NODE_BIN` | 显式指定 node 可执行文件路径（跳过探测/下载） | 自动探测 |
| `DSH_APP_NPM_CACHE` | 下载时 npm 缓存目录（自包含部署用） | 系统默认 |
| `DSH_APP_SKIP_LOCK` | `1` 时跳过单实例锁（测试钩子） | 未设置 |
| `DSH_APP_FORCE_DOWNLOAD` | `1` 时跳过"是否下载"询问直接下载（测试钩子） | 未设置 |
| `DSH_APP_AUTOCLOSE_MS` | 就绪后 N 毫秒自动关窗（测试钩子） | 未设置 |

dsh 可执行文件的探测顺序：`DSH_BIN` → `dsh-path.txt` → Linux 的 `which dsh` / Windows 的 `where dsh.cmd` → npm/npx 缓存。自动下载的可执行文件在 Linux 为 `.bin/dsh`，Windows 为 `.bin/dsh.cmd`。

## 日志

- 应用日志：`~/.config/Electron/logs/dsh-desktop.log`
- dsh 服务输出：`~/.config/Electron/logs/web.out.log`

## 测试

```bash
npm run test:lifecycle    # 无 GUI：起 dsh 服务 → 等就绪 → SIGTERM → 断言进程退出
npm run test:e2e          # 有显示环境：完整链路（启动 → 服务 → 窗口 → 自动关窗 → 服务停止）
npm run test:download     # 有显示环境+网络：模拟无 dsh 机器，验证自动下载 → 启动 → 关闭 → 停止
npm run test:portable     # 模拟无 Node 机器：下载便携 Node → npm install → rebuild → dsh 全链路
npm run test:settings     # 设置读写：预写 settings.json 生效 + 保存路径写回
npm run test:onboarding   # 首次引导：无 dsh 且未配置时显示配置页，提交后按配置下载启动
```

## 已知限制

- **用 `electron main.js` 启动**（`npm start` 已这样配置）：`electron .`（目录形式）在部分受限环境（如只读 HOME 的沙箱）会 SIGTRAP 崩溃，指定脚本文件形式则稳定。
- **不要调用 `app.setName()`**：它会重定向 Chromium 内部目录到新路径，在只读 HOME 下同样 SIGTRAP。
- 日志目录名是 `Electron`（未 setName 时 Electron 默认值），不影响功能。

## 打包分发

### GitHub Releases（自动 CI 构建）

项目托管在 GitHub，CI（GitHub Actions）在打 tag（`v*`）时自动构建并发布全平台安装包：

| 平台 | 安装包 | 说明 |
|---|---|---|
| Windows | `DeepSeek.Harness.Setup.0.1.0.exe` | NSIS 安装器 |
| Windows | `DeepSeek.Harness.0.1.0.exe` | 便携版（免安装） |
| macOS | `DeepSeek.Harness-0.1.0.dmg` | DMG 安装镜像（未签名） |
| macOS | `DeepSeek.Harness-0.1.0-mac.zip` | ZIP 便携包（未签名） |
| Debian/Ubuntu | `dsh-desktop_0.1.0_amd64.deb` | `sudo dpkg -i` 或 `apt install ./` |
| Fedora/RHEL | `dsh-desktop-0.1.0.x86_64.rpm` | `sudo rpm -i` |
| Arch Linux | `dsh-desktop-0.1.0-1-x86_64.pkg.tar.zst` | `sudo pacman -U` |
| Linux 通用 | `DeepSeek.Harness-0.1.0.AppImage` | `chmod +x` 后直接运行 |
| Linux 通用 | `dsh-desktop-0.1.0.tar.gz` | 解压后运行 `./dsh-desktop`，无需安装 |



### Arch Linux（本地构建 PKGBUILD）

```bash
cd packaging
./build.sh                                    # 生成 dsh-desktop-*.pkg.tar.zst
sudo pacman -U dsh-desktop-0.1.0-1-x86_64.pkg.tar.zst
```

依赖 Arch 官方仓库的 `electron`（当前为 43 大版本，与应用测试版本一致）、`curl`、`tar`。安装后应用菜单出现「DeepSeek Harness」。
