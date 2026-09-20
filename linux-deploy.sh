#!/usr/bin/env bash

set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/rijianyunxi/pansou.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/pansou}"
TMP_DIR="${TMP_DIR:-$APP_DIR/tmp}"
PM2_APP_NAME="${PM2_APP_NAME:-pansou}"
LEGACY_PM2_APP_NAME="${LEGACY_PM2_APP_NAME:-pansou}"

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

case "$APP_DIR" in
  ""|"/")
    echo "运行目录路径不安全，拒绝继续：$APP_DIR" >&2
    exit 1
    ;;
esac

case "$TMP_DIR" in
  ""|"/"|"$APP_DIR"|"$APP_DIR/")
    echo "临时目录路径不安全，拒绝继续：$TMP_DIR" >&2
    exit 1
    ;;
esac

mkdir -p "$APP_DIR"

# 只清理临时构建目录，不碰运行目录中的 .env.production、.output、data。
if [[ -e "$TMP_DIR" ]]; then
  echo "清理上次的临时构建目录：$TMP_DIR"
  rm -rf -- "$TMP_DIR"
fi

echo "重新拉取源码：$REPO_URL"
git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$TMP_DIR"

cd "$TMP_DIR"



echo "安装依赖..."
npm install

echo "构建 Nuxt..."
npm run build

if [[ ! -f "$TMP_DIR/.output/server/index.mjs" ]]; then
  echo "构建完成但未找到 .output/server/index.mjs，已停止部署。" >&2
  exit 1
fi

if [[ ! -f "$TMP_DIR/ecosystem.config.cjs" ]]; then
  echo "源码中未找到 ecosystem.config.cjs，已停止部署。" >&2
  exit 1
fi

remove_pm2_app() {
  local name="$1"
  [[ -n "$name" ]] || return 0
  if pm2 describe "$name" >/dev/null 2>&1; then
    echo "停止旧 PM2 应用：$name"
    pm2 stop "$name" >/dev/null 2>&1 || true
    pm2 delete "$name" >/dev/null 2>&1 || true
  fi
}

wait_for_pm2_online() {
  local name="$1"
  local status
  for _ in {1..20}; do
    status="$(pm2 jlist 2>/dev/null | node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        try {
          const apps = JSON.parse(input);
          const app = apps.find(item => item.name === process.argv[1]);
          process.stdout.write(app?.pm2_env?.status || "");
        } catch {}
      });
    ' "$name")"
    if [[ "$status" == "online" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# 构建成功后才停止旧进程，尽量缩短停机时间。
remove_pm2_app "$PM2_APP_NAME"


if [[ -e "$APP_DIR/.output" ]]; then
  echo "删除旧运行产物：$APP_DIR/.output"
  rm -rf -- "$APP_DIR/.output"
fi

echo "移动新的运行产物到：$APP_DIR/.output"
mv -- "$TMP_DIR/.output" "$APP_DIR/.output"

echo "移动生产环境配置到：$APP_DIR/.env.production"
mv -f -- "$TMP_DIR/.env.production" "$APP_DIR/.env.production"
chmod 600 "$APP_DIR/.env.production"

echo "移动 PM2 配置到：$APP_DIR/ecosystem.config.cjs"
mv -f -- "$TMP_DIR/ecosystem.config.cjs" "$APP_DIR/ecosystem.config.cjs"

#echo "移动数据库配置到：$APP_DIR/data"
#mv -f -- "$TMP_DIR/data" "$APP_DIR/data"

cd "$APP_DIR"
echo "启动 PM2：$PM2_APP_NAME"
pm2 start "$APP_DIR/ecosystem.config.cjs" --update-env

if ! wait_for_pm2_online "$PM2_APP_NAME"; then
  echo "PM2 应用未能进入 online 状态，保留临时目录便于排查。" >&2
  pm2 logs "$PM2_APP_NAME" --lines 50 --nostream >&2 || true
  exit 1
fi

pm2 save

echo "删除临时构建目录：$TMP_DIR"
rm -rf -- "$TMP_DIR"

echo
echo "部署完成"
echo "临时源码目录已删除：$TMP_DIR"
echo "运行目录：$APP_DIR"
echo "PM2 应用：$PM2_APP_NAME"
pm2 status "$PM2_APP_NAME"
