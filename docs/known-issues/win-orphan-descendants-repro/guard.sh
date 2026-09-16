#!/usr/bin/env bash
# 归属安全校验（第二道闸）：拿到 PID 列表后，确认没有「越界项」才允许杀。
#
#   bash guard.sh "<pid list>"
#   退出码 0 = 通过，可以 kill
#   退出码 1 = 有越界项，调用方**必须放弃 kill 并退回 taskkill 兜底**
#
# 这道闸检查四件事：
#   1. 每一项都是纯数字（挡掉解析碎片）；
#   2. 没有 PID <= 4 的系统进程；
#   3. 每一项都能在「严格解析的进程表」里查到；
#   4. **没有一项是 guard 自己（或调用链）的祖先** —— 防止回收动作把调用方杀掉。
#
# 注意它只管「可追溯 + 不伤自己」，管不了「归属」——归属由 tree.sh 的向上验证负责。
# 两者缺一不可：tree.sh 决定杀谁，guard.sh 决定能不能动手。
set -u
pids="${1:-}"
if [ -z "$pids" ]; then echo "GUARD: 空列表，无需动作"; exit 1; fi

# 自己的祖先链（保护名单）
prot=""
x="$$"
for _ in $(seq 1 32); do
  prot="$prot $x"
  parent=$(ps -ef | awk -v P="$x" '$1 ~ /^[0-9]+$/ && $2 == P && $3 ~ /^[0-9]+$/ && $5 ~ /^[0-9][0-9]:[0-9][0-9]/ {print $3; exit}')
  [ -z "$parent" ] && break
  [ "$parent" -le 1 ] && break
  x="$parent"
done

bad=0
for p in $pids; do
  case "$p" in
    ''|*[!0-9]*) echo "GUARD: 非法 PID '$p' → 拒绝"; bad=1; continue ;;
  esac
  if [ "$p" -le 4 ]; then echo "GUARD: PID $p <= 4（系统进程）→ 拒绝"; bad=1; continue; fi
  for q in $prot; do
    if [ "$p" = "$q" ]; then echo "GUARD: PID $p 是调用链的祖先 → 拒绝"; bad=1; fi
  done
  line=$(ps -ef | awk -v P="$p" '$1 ~ /^[0-9]+$/ && $2 == P && $3 ~ /^[0-9]+$/ && $5 ~ /^[0-9][0-9]:[0-9][0-9]/ {print; exit}')
  if [ -z "$line" ]; then echo "GUARD: PID $p 不在严格进程表里 → 拒绝"; bad=1; fi
done

if [ "$bad" = 1 ]; then echo "GUARD: 判定=拒绝（不会执行 kill）"; exit 1; fi
echo "GUARD: 判定=通过（$(echo $pids | wc -w) 个 PID 全部可追溯、且不含调用链）"
exit 0
