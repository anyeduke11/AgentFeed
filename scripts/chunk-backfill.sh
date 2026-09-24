#!/usr/bin/env bash
# ============================================================
# 词条分块向量批量补嵌脚本（chunks backfill batch runner）
#
# 背景：file 级向量链路已收敛（方案 B），向量主路 = 词条分块（entry_chunks）。
# 启动期全量补嵌已移除（本地 GPU compute-bound，54 万块串行 ~53h 不适合常驻满载），
# 看板词条页每批 50 手动点。本脚本把「补嵌一批」自动化为连续批次，用于存量收敛
# （当前待嵌 ~28k 词条）。
#
# 用法:
#   ./scripts/chunk-backfill.sh                     # 默认：每批 100，跑到无待嵌
#   BATCH=50 ./scripts/chunk-backfill.sh            # 每批 50
#   MAX_BATCHES=10 ./scripts/chunk-backfill.sh      # 只跑 10 批（试跑/限流）
#   BATCH=50 BATCH_GAP=30 ./scripts/chunk-backfill.sh   # 批间休息 30s（性能限速，机器喘息）
#   PORT=5188 HOST=127.0.0.1 ./scripts/chunk-backfill.sh
#
# 行为:
#   - 逐批 POST /api/wiki/chunks/backfill/start，轮询 status 等批次完成再发下一批
#   - Ctrl-C 软停止（发 stop 端点，当前词条完成后收尾；再按一次强退）
#   - 中止条件：无待嵌 / 配置类降级（reason != ok）/ 连续 3 批零进展 / 达 MAX_BATCHES
#   - 进度：每批报告 indexed/failed/deadSkipped + 剩余待嵌 + 速率与 ETA
# 依赖: bash + curl + python3（JSON 解析，避免依赖 jq）
# ============================================================
set -euo pipefail

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-5188}"
BATCH="${BATCH:-100}"
BATCH_GAP="${BATCH_GAP:-0}"          # 批间休息秒数（性能限速：嵌入 ~36s + 休息 30s ≈ 半速 duty cycle）
MAX_BATCHES="${MAX_BATCHES:-100000}"   # 默认不设限（中止条件兜底）
BASE="http://${HOST}:${PORT}"

info()  { printf '\033[32m[补嵌]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[补嵌]\033[0m %s\n' "$*"; }
die()   { printf '\033[31m[补嵌]\033[0m %s\n' "$*" >&2; exit 1; }

# JSON 字段提取（stdin → 参数路径），python3 标准库
jget() { python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  for k in '$1'.split('.'):
    d=d.get(k) if isinstance(d,dict) else None
  print(json.dumps(d,ensure_ascii=False) if isinstance(d,(dict,list)) else ('' if d is None else d))
except Exception:
  print('')"; }

# Ctrl-C：第一次发软停止（当前词条完成后收尾），第二次强退
SOFT_STOP_SENT=0
on_int() {
  if [ "$SOFT_STOP_SENT" = 1 ]; then warn '第二次中断，强退'; exit 130; fi
  SOFT_STOP_SENT=1
  warn '收到中断：已请求软停止（当前词条完成后收尾），再按一次强退'
  curl -s -X POST "$BASE/api/wiki/chunks/backfill/stop" >/dev/null 2>&1 || true
}
trap on_int INT TERM

# ---- 前置检查 ----
curl -sf "$BASE/api/health" >/dev/null 2>&1 || die "服务不可达 ${BASE}（先 ./service.sh start）"

status_json="$(curl -sf "$BASE/api/wiki/chunks/backfill/status")"
pending0="$(echo "$status_json" | jget pending)"
[ "$pending0" != "0" ] || { info "无待嵌词条（已收敛）"; exit 0; }

info "待嵌 $pending0 词条 · 每批 $BATCH · 上限 $MAX_BATCHES 批"
echo "----------------------------------------"

TOTAL_INDEXED=0; TOTAL_FAILED=0; BATCH_NO=0; ZERO_STREAK=0; T0=$(date +%s)

while :; do
  BATCH_NO=$((BATCH_NO + 1))
  if [ "$BATCH_NO" -gt "$MAX_BATCHES" ]; then info "达到批次上限 ${MAX_BATCHES}，收工"; break; fi
  if [ "$SOFT_STOP_SENT" = 1 ]; then info '软停止已请求，收工'; break; fi

  # ---- 发起一批 ----
  start_json="$(curl -s -X POST "$BASE/api/wiki/chunks/backfill/start" \
    -H 'Content-Type: application/json' -d "{\"limit\":$BATCH}")"
  started="$(echo "$start_json" | jget started)"
  if [ "$started" != "True" ] && [ "$started" != "true" ]; then
    # started:false = 无待嵌 / 全死链 / 配置缺失 / 进行中（脚本不会发并发，前三种为主）
    msg="$(echo "$start_json" | jget message)"
    [ -z "$msg" ] && msg="$start_json"
    info "批次未启动：$msg"
    break
  fi
  batch_n="$(echo "$start_json" | jget batch)"
  dead="$(echo "$start_json" | jget deadSkipped)"
  [ "$dead" != "0" ] && warn "  本批快照跳过死链 $dead 条（源文件缺失，不消费名额）"

  # ---- 轮询等批次完成（批次内逐词条串行嵌入，~2.8 块/秒，长批次可达数十分钟） ----
  while :; do
    sleep 10
    s="$(curl -sf "$BASE/api/wiki/chunks/backfill/status")"
    running="$(echo "$s" | jget running)"
    [ "$running" = "True" ] || [ "$running" = "true" ] || break
    # 运行中顺带报进度（lastRun 还是上一批的，pending 是实时的）
    pend_now="$(echo "$s" | jget pending)"
    printf '\r  批 #%d 运行中 · 剩余待嵌 %s ...' "$BATCH_NO" "$pend_now"
  done
  [ "$SOFT_STOP_SENT" = 1 ] && { echo; info '软停止已生效，收工'; break; }
  echo

  # ---- 结算本批 ----
  last="$(echo "$s" | jget lastRun)"
  indexed="$(echo "$last" | jget indexed)"
  failed="$(echo "$last" | jget failed)"
  reason="$(echo "$last" | jget reason)"
  TOTAL_INDEXED=$((TOTAL_INDEXED + ${indexed:-0}))
  TOTAL_FAILED=$((TOTAL_FAILED + ${failed:-0}))
  pend_now="$(echo "$s" | jget pending)"

  ELAPSED=$(( $(date +%s) - T0 ))
  RATE=$(python3 -c "print(f'{($TOTAL_INDEXED)/max($ELAPSED,1)*60:.1f}')" 2>/dev/null || echo '?')
  ETA=$(python3 -c "
p=int('$pend_now'); r=($TOTAL_INDEXED)/max($ELAPSED,1)
print(f'{p/r/3600:.1f}h' if r>0 else '?')" 2>/dev/null || echo '?')

  info "批 #${BATCH_NO}/${MAX_BATCHES}: +${indexed:-0} 嵌入 · ${failed:-0} 失败 · 剩余 ${pend_now} · 累计 ${TOTAL_INDEXED} · ${RATE} 词条/分 · ETA ${ETA}"

  # 配置类降级（开关关闭/provider 缺失/嵌入失败风暴）：后端已整批中止，重试无意义
  if [ "$reason" != "ok" ] && [ -n "$reason" ]; then
    die "批次中止（reason=${reason}）：修复配置（AI 设置 → 向量化开关/模型/Ollama）后重跑"
  fi
  # 零进展防护：连续 3 批零嵌入（全失败或全空转）视为系统性故障
  if [ "${indexed:-0}" -eq 0 ]; then
    ZERO_STREAK=$((ZERO_STREAK + 1))
    [ "$ZERO_STREAK" -ge 3 ] && die "连续 ${ZERO_STREAK} 批零进展（累计失败 ${TOTAL_FAILED}），中止——检查 Ollama 服务与模型"
  else
    ZERO_STREAK=0
  fi
  if [ -z "$pend_now" ] || [ "$pend_now" = "0" ]; then info "全部待嵌词条收敛完成"; break; fi
  # 批间休息（性能限速）：睡眠期 Ollama 空闲、机器获得喘息窗口；SIGINT 可打断并软停止
  if [ "$BATCH_GAP" -gt 0 ]; then
    info "休息 ${BATCH_GAP}s（限速，Ctrl-C 软停止）"
    sleep "$BATCH_GAP"
  fi
done

echo "----------------------------------------"
info "收工：累计嵌入 $TOTAL_INDEXED 词条 · 失败 $TOTAL_FAILED · 用时 $(( $(date +%s) - T0 ))s"
[ "$TOTAL_FAILED" -gt 0 ] && warn "失败词条可重跑本脚本收敛（content_hash 幂等，已成功条目零重复嵌入）"
exit 0
