# Arch Linux 打包（PKGBUILD）

将 dsh-desktop 打包为 Arch 原生包（`.pkg.tar.zst`），可用 `pacman -U` 安装。

## 构建

```bash
cd dsh-desktop/packaging
./build.sh          # 复制应用源文件 + makepkg（跳过依赖检查）
```

产物：`dsh-desktop-0.1.3-1-x86_64.pkg.tar.zst`

## 安装

```bash
sudo pacman -U dsh-desktop-0.1.3-1-x86_64.pkg.tar.zst
```

依赖（`pacman` 会自动安装，需要联网）：

| 包 | 用途 |
|---|---|
| `electron` | 应用运行时（Arch 官方仓库） |
| `curl` | 首次启动下载便携 Node / dsh |
| `tar` | 解压便携 Node |

安装后：
- 可执行入口：`/opt/dsh-desktop/main.js`（由 `/usr/bin/electron` 运行）
- 应用菜单：`DeepSeek Harness`（含图标）
- 首次启动自动下载 Node.js 运行时与 dsh 到 `~/.config/Electron/dsh-runtime/`

## 卸载

```bash
sudo pacman -R dsh-desktop
```

## 发布到 AUR（可选）

把本目录的 `PKGBUILD` 与资源文件（`deepseek-harness.desktop`、`dsh-desktop.svg`）连同应用源文件上传到 AUR 即可（AUR 构建时用 `source` 从上游 URL 获取应用文件，`sha256sums` 填真实校验和，勿用 `SKIP`）。

## 说明

- 应用依赖系统 `electron` 包（Arch 滚动更新）。`main.js` 只使用稳定的 Electron API（BrowserWindow / ipcMain / Menu / dialog / contextBridge），跨版本兼容。
- 如需完全自包含（不依赖系统 electron），可改用 electron-builder 产出 AppImage：`npx electron-builder --linux AppImage`。
