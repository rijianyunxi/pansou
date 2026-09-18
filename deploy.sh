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

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "未找到 pnpm，正在安装..."
  npm install --global pnpm
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "未找到 pm2，正在安装..."
  npm install --global pm2
fi

mkdir -p "$DEPLOY_DIR"

backup_dir="$(mktemp -d /tmp/panhub-deploy.XXXXXX)"
chmod 700 "$backup_dir"
cleanup() {
  rm -rf "$backup_dir"
}
trap cleanup EXIT

# 优先保留运行目录中的生产配置，其次才使用源码目录里的配置。
for config_file in .env.production ecosystem.config.cjs; do
  if [[ -f "$DEPLOY_DIR/$config_file" ]]; then
    cp -a "$DEPLOY_DIR/$config_file" "$backup_dir/$config_file"
  elif [[ -f "$APP_DIR/$config_file" ]]; then
    cp -a "$APP_DIR/$config_file" "$backup_dir/$config_file"
  fi
done

if [[ -d "$APP_DIR/.git" ]]; then
  echo "更新已有源码：$APP_DIR"
  cd "$APP_DIR"

  # 除生产配置外，不自动覆盖服务器上的其他本地代码修改。
  while IFS= read -r status_line; do
    [[ -z "$status_line" ]] && continue
    changed_path="${status_line:3}"
    case "$changed_path" in
      .env.production|ecosystem.config.cjs)
        ;;
      *)
        echo "检测到未提交的源码修改：$changed_path" >&2
        echo "请先处理该修改，再重新执行部署。" >&2
        exit 1
        ;;
    esac
  done < <(git status --porcelain)

  # 先恢复被本地环境文件占用的跟踪文件，避免 git pull 被阻止。
  git restore --source=HEAD -- .env.production ecosystem.config.cjs 2>/dev/null || true
  git pull --ff-only origin "$BRANCH"
else
  if [[ -e "$APP_DIR" ]] && [[ -n "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "$APP_DIR 已存在但不是 Git 仓库，且目录不为空，已停止部署。" >&2
    exit 1
  fi

  mkdir -p "$APP_DIR"
  echo "首次拉取源码：$REPO_URL"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

# 把服务器上的生产环境文件放回源码目录，构建和运行均使用同一份配置。
if [[ -f "$backup_dir/.env.production" ]]; then
  install -m 600 "$backup_dir/.env.production" "$APP_DIR/.env.production"
elif [[ -f "$APP_DIR/.env.production" ]]; then
  cp -a "$APP_DIR/.env.production" "$backup_dir/.env.production"
else
  echo "未找到 .env.production，请先创建：$APP_DIR/.env.production 或 $DEPLOY_DIR/.env.production" >&2
  exit 1
fi

echo "安装依赖..."
pnpm install --frozen-lockfile

echo "构建 Nuxt..."
pnpm build

if [[ ! -f "$APP_DIR/.output/server/index.mjs" ]]; then
  echo "构建完成但未找到 .output/server/index.mjs，已停止部署。" >&2
  exit 1
fi

release_stamp="$(date +%Y%m%d%H%M%S)"
old_output="$DEPLOY_DIR/.output.previous.$release_stamp"

if [[ -e "$DEPLOY_DIR/.output" ]]; then
  echo "备份旧运行产物：$old_output"
  mv "$DEPLOY_DIR/.output" "$old_output"
fi

echo "移动新的运行产物到：$DEPLOY_DIR/.output"
mv "$APP_DIR/.output" "$DEPLOY_DIR/.output"

install -m 600 "$backup_dir/.env.production" "$DEPLOY_DIR/.env.production"
install -m 644 "$APP_DIR/ecosystem.config.cjs" "$DEPLOY_DIR/ecosystem.config.cjs"

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
echo "旧产物备份：$old_output"
pm2 status "$PM2_APP_NAME"
