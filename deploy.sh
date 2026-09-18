#!/usr/bin/env bash

set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/rijianyunxi/pansou.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/pansou}"
DEPLOY_DIR="${DEPLOY_DIR:-$(dirname "$APP_DIR")}"
PM2_APP_NAME="${PM2_APP_NAME:-panhub}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 root 运行：sudo bash deploy.sh" >&2
  exit 1
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令：$1" >&2
    exit 1
  }
}

require_command git
require_command node
require_command npm

if ! command -v pm2 >/dev/null 2>&1; then
  echo "未找到 pm2，正在安装..."
  npm install --global pm2
fi

mkdir -p "$DEPLOY_DIR"

case "$APP_DIR" in
  ""|"/"|"$DEPLOY_DIR"|"$DEPLOY_DIR/")
    echo "源码目录路径不安全，拒绝继续：$APP_DIR" >&2
    exit 1
    ;;
esac

# 生产配置不做备份；如果它还在旧源码目录中，先直接移动到运行目录。
if [[ -f "$APP_DIR/.env.production" && ! -f "$DEPLOY_DIR/.env.production" ]]; then
  echo "移动旧源码中的生产环境配置到：$DEPLOY_DIR/.env.production"
  mv -- "$APP_DIR/.env.production" "$DEPLOY_DIR/.env.production"
  chmod 600 "$DEPLOY_DIR/.env.production"
fi

if [[ -e "$APP_DIR/.git" ]]; then
  echo "检测到已有源码克隆，先删除：$APP_DIR"
  rm -rf -- "$APP_DIR"
elif [[ -e "$APP_DIR" ]] && [[ -n "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "$APP_DIR 已存在但不是 Git 仓库，且目录不为空，已停止部署。" >&2
  exit 1
fi

mkdir -p "$APP_DIR"
echo "重新拉取源码：$REPO_URL"
git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"

cd "$APP_DIR"

# 使用运行目录中的生产环境文件参与构建；如果没有，则使用仓库自带文件。
if [[ -f "$DEPLOY_DIR/.env.production" ]]; then
  cp -a "$DEPLOY_DIR/.env.production" "$APP_DIR/.env.production"
elif [[ ! -f "$APP_DIR/.env.production" ]]; then
  echo "未找到 .env.production，请先创建：$APP_DIR/.env.production 或 $DEPLOY_DIR/.env.production" >&2
  exit 1
fi

echo "安装依赖..."
npm install

echo "构建 Nuxt..."
npm run build

if [[ ! -f "$APP_DIR/.output/server/index.mjs" ]]; then
  echo "构建完成但未找到 .output/server/index.mjs，已停止部署。" >&2
  exit 1
fi

if [[ -e "$DEPLOY_DIR/.output" ]]; then
  echo "删除旧运行产物：$DEPLOY_DIR/.output"
  rm -rf -- "$DEPLOY_DIR/.output"
fi

echo "移动新的运行产物到：$DEPLOY_DIR/.output"
mv "$APP_DIR/.output" "$DEPLOY_DIR/.output"

echo "移动生产环境配置到：$DEPLOY_DIR/.env.production"
mv -f -- "$APP_DIR/.env.production" "$DEPLOY_DIR/.env.production"
chmod 600 "$DEPLOY_DIR/.env.production"

echo "移动 PM2 配置到：$DEPLOY_DIR/ecosystem.config.cjs"
mv -f -- "$APP_DIR/ecosystem.config.cjs" "$DEPLOY_DIR/ecosystem.config.cjs"

cd "$DEPLOY_DIR"
echo "启动或重启 PM2：$PM2_APP_NAME"
pm2 startOrRestart "$DEPLOY_DIR/ecosystem.config.cjs" --update-env
pm2 save

if [[ "$APP_DIR" == "/" || "$APP_DIR" == "$DEPLOY_DIR" || -z "$APP_DIR" ]]; then
  echo "源码目录路径不安全，拒绝删除：$APP_DIR" >&2
  exit 1
fi

if [[ -d "$APP_DIR/.git" ]]; then
  echo "删除源码克隆目录：$APP_DIR"
  rm -rf -- "$APP_DIR"
fi

echo
echo "部署完成"
echo "源码目录已删除：$APP_DIR"
echo "运行目录：$DEPLOY_DIR"
echo "PM2 应用：$PM2_APP_NAME"
pm2 status "$PM2_APP_NAME"
