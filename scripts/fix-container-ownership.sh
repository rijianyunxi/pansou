#!/usr/bin/env bash
# 一次性修复:恢复被误 chown 的容器数据目录属主。
# 自动找出所有把 bind mount 挂在数据根目录下的容器,从容器或镜像内查出真实
# 服务用户 uid 后修复属主,重启对应容器,最后重启 pansou 服务。
# 用法: sudo bash fix-container-ownership.sh [数据根目录,默认 /opt/pansou]
set -euo pipefail

ROOT="${1:-/opt/pansou}"
APP_SERVICE="${APP_SERVICE:-pansou}"

[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行" >&2; exit 1; }
command -v docker >/dev/null || { echo "未找到 docker 命令" >&2; exit 1; }
[ -d "$ROOT" ] || { echo "目录不存在:$ROOT" >&2; exit 1; }

# 依次尝试这些常见服务用户名,命中即视为该容器的数据属主。
SERVICE_USERS="${SERVICE_USERS:-postgres redis mysql mongo}"

# 从运行中的容器读取用户 uid:gid。
uid_in_container() {
  local c="$1" u="$2" out
  out=$(docker exec "$c" sh -c "id -u $u 2>/dev/null; id -g $u 2>/dev/null" 2>/dev/null | grep . || true)
  [ "$(printf '%s\n' "$out" | wc -l)" = 2 ] || return 1
  printf '%s:%s' "$(printf '%s' "$out" | sed -n 1p)" "$(printf '%s' "$out" | sed -n 2p)"
}

# 容器跑不起来时,用镜像起一个一次性容器(不挂数据卷)读取用户表。
uid_in_image() {
  local image="$1" u="$2" out
  out=$(docker run --rm --entrypoint sh "$image" -c "id -u $u 2>/dev/null; id -g $u 2>/dev/null" 2>/dev/null | grep . || true)
  [ "$(printf '%s\n' "$out" | wc -l)" = 2 ] || return 1
  printf '%s:%s' "$(printf '%s' "$out" | sed -n 1p)" "$(printf '%s' "$out" | sed -n 2p)"
}

for c in $(docker ps -a --format '{{.Names}}'); do
  # 收集该容器挂在 ROOT 下的数据目录
  targets=""
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    case "$src" in "$ROOT"/*) targets="$targets $src" ;; esac
  done <<EOF
$(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}
{{end}}{{end}}' "$c")
EOF
  [ -n "$targets" ] || continue

  echo "== 容器 $c,涉及数据目录:$targets"
  if [ "$(docker inspect -f '{{.State.Running}}' "$c")" != "true" ]; then
    echo "   容器未运行,先尝试启动(便于读取容器内用户)"
    docker start "$c" >/dev/null 2>&1 || echo "   启动失败,稍后改用镜像默认用户兜底"
    sleep 2
  fi

  image=$(docker inspect -f '{{.Config.Image}}' "$c")
  owner=""
  for u in $SERVICE_USERS; do
    if owner=$(uid_in_container "$c" "$u"); then break; fi
    owner=""
  done

  if [ -z "$owner" ]; then
    # 镜像 USER 指令(数字 id 或用户名)
    cu=$(docker inspect -f '{{.Config.User}}' "$c")
    case "$cu" in
      "") ;;
      *:*) owner="$cu" ;;
      *[^0-9]*)
        owner=$(uid_in_container "$c" "$cu" || true)
        [ -n "$owner" ] || owner=$(uid_in_image "$image" "$cu" || true)
        ;;
      *) owner="$cu:$cu" ;;
    esac
  fi

  if [ -z "$owner" ]; then
    # 兜底:从镜像本身查服务用户(容器可能因权限问题起不来)
    for u in $SERVICE_USERS; do
      if owner=$(uid_in_image "$image" "$u"); then break; fi
      owner=""
    done
  fi

  [ -n "$owner" ] || owner="0:0"
  echo "   目标属主:$owner"
  for src in $targets; do
    chown -R "$owner" "$src"
    echo "   已修复属主:$src"
  done
  docker restart "$c" >/dev/null && echo "   已重启 $c"
done

sleep 3
if systemctl cat "$APP_SERVICE" >/dev/null 2>&1; then
  systemctl restart "$APP_SERVICE"
  echo "== 已重启 $APP_SERVICE"
  systemctl --no-pager status "$APP_SERVICE" | head -n 5 || true
fi
echo "== 完成:稍等半分钟刷新监控页,确认 Redis、TG 采集、链接任务恢复在线"
