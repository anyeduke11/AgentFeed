#!/usr/bin/env bash
# ============================================================
# AgentFeed 服务管理脚本
# 用法: ./service.sh {start|stop|restart|status|logs|build}
#   start   启动服务（缺构建产物时自动构建）
#   stop    停止服务（别名 pause；清理端口占用者）
#   restart 重启服务（先重新构建前后端，确保新代码生效）
#   status  查看运行状态
#   logs    跟踪查看日志（tail -f）
#   build   强制重新构建前后端
# 说明: 端口固定 5188（与 server/src/index.ts、web/vite.config.ts 代理一致）；
#       服务身份以「监听 $PORT 的进程」为准，不依赖 pidfile。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
WEB_DIR="$ROOT/web"
LOG_FILE="$ROOT/.service.log"
PORT=5188
HEALTH="http://127.0.0.1:$PORT/api/health"

info()  { printf '\033[32m[服务]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[服务]\033[0m %s\n' "$*"; }
error() { printf '\033[31m[服务]\033[0m %s\n' "$*" >&2; }

# 当前监听端口的进程 PID 列表（可能为空）
port_pids() { lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }

build_server() { info '构建后端…'; (cd "$SERVER_DIR" && npm run build >/dev/null); }
build_web()    { info '构建前端…'; (cd "$WEB_DIR" && npm run build >/dev/null); }

ensure_build() {
  [ -f "$SERVER_DIR/dist/index.js" ] || build_server
  [ -f "$SERVER_DIR/public/index.html" ] || build_web
}

health_ok() { curl -sf "$HEALTH" >/dev/null 2>&1; }

start() {
  local busy; busy="$(port_pids)"
  if [ -n "$busy" ]; then
    if health_ok; then
      info "服务已在运行 (PID: $(echo "$busy" | tr '\n' ' '))，无需重复启动"
      exit 0
    fi
    error "端口 $PORT 被占用 (PID: $(echo "$busy" | tr '\n' ' ')) 但健康检查未通过"
    error "先执行 ./service.sh stop 清理占用进程"
    exit 1
  fi
  ensure_build
  info "启动服务 (端口 $PORT)…"
  # exec 让 node 直接替换子 shell 进程（PID 即监听进程）；disown 移出 job 表，
  # 避免同实例内 stop/restart 时 bash 打印 "Terminated" 通知
  (cd "$SERVER_DIR" && exec node dist/index.js >>"$LOG_FILE" 2>&1 </dev/null) &
  disown
  # 健康检查就绪轮询（最多 15 秒）
  for _ in $(seq 1 30); do
    if health_ok; then
      info "启动成功 (PID: $(port_pids | tr '\n' ' ')) · http://127.0.0.1:$PORT"
      info "日志: $LOG_FILE · 停止: ./service.sh stop"
      return 0
    fi
    sleep 0.5
  done
  error '启动失败（健康检查 15 秒超时），最近日志：'
  tail -n 20 "$LOG_FILE" >&2 || true
  exit 1
}

stop() {
  local pids; pids="$(port_pids)"
  if [ -z "$pids" ]; then
    info '服务未在运行'
    return 0
  fi
  info "停止服务 (PID: $(echo "$pids" | tr '\n' ' '))…"
  kill $pids 2>/dev/null || true
  # 优雅退出等待（最多 5 秒），超时强杀
  for _ in $(seq 1 10); do
    [ -z "$(port_pids)" ] && break
    sleep 0.5
  done
  pids="$(port_pids)"
  if [ -n "$pids" ]; then
    warn "进程未响应 SIGTERM，强制结束…"
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
  info '已停止'
}

status() {
  local pids; pids="$(port_pids)"
  if [ -n "$pids" ]; then
    if health_ok; then
      info "运行中 · PID: $(echo "$pids" | tr '\n' ' ') · 端口 $PORT · 健康检查通过"
      return 0
    fi
    warn "端口 $PORT 有监听进程 (PID: $(echo "$pids" | tr '\n' ' ')) 但健康检查未通过，可能仍在启动或已异常"
    warn "查看日志: ./service.sh logs"
    return 1
  fi
  warn '未运行'
  return 1
}

logs() {
  [ -f "$LOG_FILE" ] || { warn '暂无日志'; exit 0; }
  tail -n 100 -f "$LOG_FILE"
}

case "${1:-}" in
  start)        start ;;
  stop|pause)   stop ;;
  restart)      stop; build_server; build_web; start ;;
  status)       status ;;
  logs)         logs ;;
  build)        build_server; build_web; info '构建完成' ;;
  *)            sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
