#!/usr/bin/env bash
# 从 GitHub Release 拉取 linux-amd64 产物，安装或更新到 /opt/pansou，并用 systemd 管理 pansou 服务。
set -euo pipefail

REPO="rijianyunxi/pansou"
INSTALL_DIR="${PANSOU_INSTALL_DIR:-/opt/pansou}"
SERVICE_NAME="pansou"
GH_PROXY="${GH_PROXY:-}"
ARCH="linux-amd64"

info() { printf '\033[32m[安装]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[警告]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }
have_systemd() { have systemctl && [ -d /run/systemd/system ]; }

usage() {
  cat <<'USAGE'
用法: sudo bash install-release.sh [选项] [版本]
  版本   要安装的 release 标签（如 v2.1.0 或 2.1.0），省略则安装最新版本
选项:
  -f  版本相同时仍强制重装
  -y  跳过升级前确认（用于自动化脚本）
  -h  显示本帮助
环境变量:
  GH_PROXY             GitHub 加速前缀（如 https://ghproxy.net），可选
  PANSOU_INSTALL_DIR   安装目录，默认 /opt/pansou
USAGE
}

# 部分网络环境访问 GitHub 受限，给 API 与下载地址统一套加速前缀。
fetch() {
  local url="$1"
  [ -n "$GH_PROXY" ] && url="${GH_PROXY%/}/$url"
  if have curl; then curl -fsSL --retry 3 "$url"
  elif have wget; then wget -qO- --tries=3 "$url"
  else die "缺少 curl 或 wget，请先安装"
  fi
}

download() {
  local url="$1" out="$2"
  [ -n "$GH_PROXY" ] && url="${GH_PROXY%/}/$url"
  if have curl; then curl -fSL --retry 3 -o "$out" "$url"
  elif have wget; then wget -qO "$out" --tries=3 "$url"
  else die "缺少 curl 或 wget，请先安装"
  fi
}

resolve_latest() {
  local resp tag
  if ! resp=$(fetch "https://api.github.com/repos/$REPO/releases/latest"); then
    die "查询最新版本失败（网络不通或 GitHub API 限流）。可显式传入版本号，或设置 GH_PROXY 后重试。"
  fi
  tag=$(printf '%s' "$resp" | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*: *"\([^"]*\)".*/\1/')
  [ -n "$tag" ] || die "解析最新版本号失败，可显式传入版本号，如：install-release.sh v2.1.0"
  printf '%s' "$tag"
}

# $1=版本 $2=工作目录；下载压缩包与 sha256 并校验，解压后输出包目录路径。
prepare_pkg() {
  local tag="$1" workdir="$2"
  local archive="pansou-$tag-$ARCH.tar.gz"
  mkdir -p "$workdir"
  info "下载 $archive ..." >&2
  download "https://github.com/$REPO/releases/download/$tag/$archive" "$workdir/$archive"
  download "https://github.com/$REPO/releases/download/$tag/$archive.sha256" "$workdir/$archive.sha256"
  (cd "$workdir" && if have sha256sum; then sha256sum -c "$archive.sha256"; else shasum -a 256 -c "$archive.sha256"; fi) >&2 \
    || die "SHA256 校验失败，下载产物不完整"
  mkdir -p "$workdir/pkg"
  tar -xzf "$workdir/$archive" -C "$workdir/pkg"
  printf '%s' "$workdir/pkg"
}

# $1=包目录 $2=版本 $3=旧版本（可能为空）。
install_pkg() {
  local pkg="$1" tag="$2" oldver="$3"
  info "安装到 $INSTALL_DIR ..."
  mkdir -p "$INSTALL_DIR"
  if [ -f "$INSTALL_DIR/pansou-api" ]; then
    mkdir -p "$INSTALL_DIR/backup"
    cp -a "$INSTALL_DIR/pansou-api" "$INSTALL_DIR/backup/pansou-api-${oldver:-unknown}"
    info "旧二进制已备份到 backup/pansou-api-${oldver:-unknown}"
  fi
  install -m 0755 "$pkg/pansou-api" "$INSTALL_DIR/pansou-api"
  rm -rf "$INSTALL_DIR/frontend"
  mkdir -p "$INSTALL_DIR/frontend"
  cp -a "$pkg/frontend/dist" "$INSTALL_DIR/frontend/dist"
  if [ -f "$INSTALL_DIR/.env" ]; then
    info "保留现有 .env 配置"
  else
    cp "$pkg/.env" "$INSTALL_DIR/.env"
    warn "已写入默认 .env，请修改数据库/Redis 连接与管理员初始密码后再启动"
  fi
  printf '%s\n' "$tag" > "$INSTALL_DIR/VERSION"
}

ensure_user() {
  have_systemd || return 0
  id pansou >/dev/null 2>&1 && return 0
  have useradd || die "缺少 useradd，无法创建系统用户 pansou"
  local nologin=/usr/sbin/nologin
  [ -x "$nologin" ] || nologin=/sbin/nologin
  useradd -r -s "$nologin" pansou
  info "已创建系统用户 pansou"
}

# $1=服务文件输出路径。
write_service() {
  cat > "$1" <<EOF
[Unit]
Description=pansou API (Rust + static frontend)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=pansou
Group=pansou
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$INSTALL_DIR/pansou-api
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
}

apply_service() {
  have_systemd || { warn "未检测到 systemd，请手动启动：cd $INSTALL_DIR && ./pansou-api"; return 0; }
  local unit="/etc/systemd/system/$SERVICE_NAME.service"
  if [ ! -f "$unit" ]; then
    write_service "$unit"
    info "已写入 $unit"
  fi
  systemctl daemon-reload
  if systemctl -q is-enabled "$SERVICE_NAME" 2>/dev/null; then
    systemctl restart "$SERVICE_NAME"
  else
    systemctl enable --now "$SERVICE_NAME"
  fi
  sleep 2
  if systemctl -q is-active "$SERVICE_NAME"; then
    info "服务 $SERVICE_NAME 已启动"
  else
    warn "服务未能启动，最近日志："
    journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
    warn "若日志显示数据库迁移取锁失败，稍后执行 systemctl restart $SERVICE_NAME 重试即可"
    die "服务启动失败"
  fi
}

check_health() {
  local port="3666"
  if [ -f "$INSTALL_DIR/.env" ]; then
    port=$(grep -E '^PANSOU_API_PORT=' "$INSTALL_DIR/.env" | tail -n1 | cut -d= -f2 || true)
    port=${port//[^0-9]/}
    port=${port:-3666}
  fi
  if have curl && curl -fsS --max-time 5 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    info "健康检查通过：http://127.0.0.1:$port"
  else
    warn "健康检查未通过（服务可能仍在启动迁移），稍后访问 http://127.0.0.1:$port 验证"
  fi
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  if ! [ -t 0 ] && [ -e /dev/tty ]; then exec 0</dev/tty || true; fi
  local ans
  printf '%s [y/N] ' "$1"
  read -r ans || die "已取消"
  case "$ans" in y|Y|yes|YES) return 0 ;; *) die "已取消" ;; esac
}

main() {
  local force=0 ASSUME_YES=0 version tag oldver is_update=0
  while getopts ":fyh" opt; do
    case "$opt" in
      f) force=1 ;;
      y) ASSUME_YES=1 ;;
      h) usage; exit 0 ;;
      *) usage >&2; exit 1 ;;
    esac
  done
  shift $((OPTIND - 1))
  version="${1:-latest}"

  if [ "$(id -u)" -ne 0 ]; then
    if have sudo && [ -f "$0" ]; then
      info "需要 root 权限，使用 sudo 重新执行..."
      exec sudo env GH_PROXY="$GH_PROXY" PANSOU_INSTALL_DIR="$INSTALL_DIR" bash "$0" "$@"
    fi
    die "请使用 sudo 运行本脚本"
  fi

  have tar || die "缺少 tar"
  case "$(uname -m)" in
    x86_64) : ;;
    *) die "本脚本只支持 x86_64（linux-amd64）产物，当前架构 $(uname -m)，请手动下载 arm64 产物" ;;
  esac

  case "$version" in
    latest) tag=$(resolve_latest) ;;
    v*) tag="$version" ;;
    *) tag="v$version" ;;
  esac

  oldver=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || true)
  if [ -f "$INSTALL_DIR/pansou-api" ] || [ -f "$INSTALL_DIR/.env" ]; then is_update=1; fi
  if [ "$oldver" = "$tag" ] && [ "$force" = 0 ]; then
    info "当前已是 $tag，如需重装请加 -f"
    exit 0
  fi

  if [ "$is_update" = 1 ]; then
    info "升级 $oldver → $tag"
    warn "新版本启动时会自动执行数据库迁移，且部分迁移不可回滚，建议先备份数据库（pg_dump）"
    confirm "继续升级？"
  else
    info "全新安装 $tag"
    warn "请确保 PostgreSQL 与 Redis 已就绪，安装后需修改 $INSTALL_DIR/.env"
  fi

  local workdir pkg
  workdir=$(mktemp -d /tmp/pansou-install.XXXXXX)
  trap 'rm -rf "$workdir"' EXIT
  pkg=$(prepare_pkg "$tag" "$workdir")

  ensure_user
  install_pkg "$pkg" "$tag" "$oldver"
  # 只改本脚本写入的文件。不能 chown -R 整个安装目录：若 docker-compose 的
  # data/ 也放在这里，会破坏 PostgreSQL/Redis 数据文件属主导致数据库无法启动。
  if id pansou >/dev/null 2>&1; then
    chown pansou:pansou "$INSTALL_DIR/pansou-api" "$INSTALL_DIR/VERSION"
    if [ -f "$INSTALL_DIR/.env" ]; then chown pansou:pansou "$INSTALL_DIR/.env"; fi
    if [ -d "$INSTALL_DIR/frontend" ]; then chown -R pansou:pansou "$INSTALL_DIR/frontend"; fi
    if [ -d "$INSTALL_DIR/backup" ]; then chown -R pansou:pansou "$INSTALL_DIR/backup"; fi
  fi
  apply_service
  check_health

  info "pansou $tag 安装完成：$INSTALL_DIR"
  [ "$is_update" = 1 ] || warn "首次部署请检查 $INSTALL_DIR/.env 中的数据库、Redis 与管理员初始密码配置"
}

# 测试时置 PANSOU_INSTALLER_NO_MAIN=1 可只加载函数不执行。
if [ "${PANSOU_INSTALLER_NO_MAIN:-}" != 1 ]; then
  main "$@"
fi
