#!/usr/bin/env bash
# 重新打包 Pi Desktop（Linux / WSL / macOS 侧执行，可产出 Windows 包）
#
# 用法:
#   ./build.sh                      # 就地打包 Windows x64 版本（默认输出到脚本所在目录）
#   ./build.sh win32 /mnt/d/PiDesk  # 指定平台与输出目录
#   PLATFORM=linux ./build.sh       # 产出 Linux 版本（便于在 WSL 中自测）
set -euo pipefail

PLATFORM="${1:-${PLATFORM:-win32}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${2:-${OUT:-$ROOT}}"
ELECTRON_VERSION="${ELECTRON_VERSION:-41.10.7}"
MIRROR="${MIRROR:-https://cdn.npmmirror.com/binaries/electron}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
ARCH="x64"
CACHE="$ROOT/.build"
APP="$ROOT/resources/app"

case "$PLATFORM" in
  win32) PLAT="win32" ; EXE_NAME="Pi Desktop.exe" ;;
  linux) PLAT="linux" ; EXE_NAME="" ;;
  darwin) PLAT="darwin" ; EXE_NAME="" ;;
  *) echo "未知平台: $PLATFORM"; exit 1 ;;
esac

echo "==> 1/5 检查 Node.js"
command -v node >/dev/null || { echo "未找到 node，请安装 Node.js 22 LTS"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<19)){console.error("Node 版本需 >= 22.19，当前 "+process.versions.node);process.exit(1)}'
echo "    node $(node -v)"

echo "==> 2/5 安装/校验前端依赖 (resources/app)"
if [ ! -d "$APP/node_modules/monaco-editor" ]; then
  ( cd "$APP" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --registry="$NPM_REGISTRY" )
fi

prune_node_modules() {
  # 只清理输出副本：node-pty 的 tarball 自带全平台预编译产物
  local target="$1"
  local pty="$target/node_modules/node-pty"
  if [ -d "$pty/prebuilds" ]; then
    for d in "$pty"/prebuilds/*; do
      [ "$(basename "$d")" = "$PLAT-$ARCH" ] || rm -rf "$d"
    done
    find "$pty" -name '*.pdb' -delete 2>/dev/null || true
    find "$pty" -name '*.test.js' -delete 2>/dev/null || true
  fi
  find "$target/node_modules" -name '*.map' -delete 2>/dev/null || true
}

echo "==> 3/5 准备 Electron $ELECTRON_VERSION ($PLAT-$ARCH)"
mkdir -p "$CACHE"
ZIP="$CACHE/electron-v$ELECTRON_VERSION-$PLAT-$ARCH.zip"
[ -f "$ZIP" ] || curl -L --fail -o "$ZIP" "$MIRROR/$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-$PLAT-$ARCH.zip"
EXTRACT="$CACHE/electron-$PLAT-$ARCH"
if [ ! -d "$EXTRACT" ]; then
  mkdir -p "$EXTRACT"
  python3 - "$ZIP" "$EXTRACT" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  chmod +x "$EXTRACT"/electron "$EXTRACT"/chrome-sandbox 2>/dev/null || true
fi

echo "==> 4/5 组装到 $OUT"
mkdir -p "$OUT"
cp -a "$EXTRACT"/. "$OUT"/
if [ "$PLAT" = "win32" ] && [ -f "$OUT/electron.exe" ]; then mv -f "$OUT/electron.exe" "$OUT/$EXE_NAME"; fi
rm -f "$OUT/resources/default_app.asar"
mkdir -p "$OUT/resources"
if [ "$(cd "$APP" && pwd)" = "$(cd "$OUT/resources/app" 2>/dev/null && pwd || echo '')" ]; then
  # 就地打包：直接整理当前 app 目录
  echo "    (就地打包，跳过复制)"
  prune_node_modules "$APP"
else
  rm -rf "$OUT/resources/app"
  cp -a "$APP" "$OUT/resources/app"
  prune_node_modules "$OUT/resources/app"
fi

if [ "$PLAT" = "win32" ]; then
  echo "==> 5/5 写入图标与版本信息"
  ( cd "$ROOT" && [ -d node_modules/resedit ] || npm install --no-save --no-audit --no-fund --registry="$NPM_REGISTRY" resedit ) >/dev/null
  ( cd "$ROOT" && node scripts/brand.js "$OUT/$EXE_NAME" )
else
  echo "==> 5/5 跳过 PE 资源写入（非 Windows 目标）"
fi

echo
if [ "$PLAT" = "win32" ]; then
  echo "完成! Windows 包可直接双击: $OUT/Pi Desktop.exe"
else
  echo "完成! 目标平台 $PLAT 的包已输出到: $OUT"
  if [ -z "$(ls -A "$OUT/resources/app/node_modules/node-pty/prebuilds" 2>/dev/null)" ]; then
    echo "注意: 输出里没有 $PLAT 的 node-pty 预编译文件，终端功能不可用。"
    echo "      可执行: ( cd \"$OUT/resources/app\" && npm rebuild node-pty )"
  fi
fi
echo "提示: 运行前请确认已安装 pi -> npm install -g @earendil-works/pi-coding-agent"
