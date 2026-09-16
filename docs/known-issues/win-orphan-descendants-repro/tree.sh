#!/usr/bin/env bash
# 严格解析版：收集「根 + 全部 MSYS 后代」。
#
#   用法 A（已知根 PID）      : bash tree.sh --pid <msys_pid>
#   用法 B（按 argv 指纹找根）: bash tree.sh --match <pattern>
#
# stdout: 空格分隔的 MSYS PID 列表
# stderr: 逐行诊断（PID + PPID + 截断命令行），便于人工核对
#
# 目标集的定义是「**祖先链能上溯到 root** 的进程」，不是「父节点是成员」的传递闭包。
# 后者实测会把无关 shell 卷进来（MSYS 的 PID 会复用、父链会断），
# 前者自带向上验证，卷不进来。
#
# 五条硬规则（每条都是实测踩出来的，少一条就会收进不该杀的东西）：
#   1. 只接受「UID/PID/PPID 均为纯数字 且 第 5 列是 HH:MM[:SS]」的行 —— 挡掉多行命令产生续行；
#   2. 指纹只在「命令部分」里匹配，不匹配整行 —— 否则续行碎片里的偶然子串也算命中；
#   3. 排除收集器自己这条链（本脚本 / guard.sh / ps / awk）；
#   4. 向上验证：p 的祖先链必须能在 32 步内走到 root；
#   5. 保护条款：**收集器自己的祖先链一律不进列表**（除非它就是 root）。
#      这条是防止「回收动作把调用方自己杀掉」——实测发生过。
set -u
mode="${1:-}"; arg="${2:-}"
self="$$"

ps -ef | awk -v mode="$mode" -v arg="$arg" -v self="$self" '
  function is_collector(s) {
    return (index(s, "tree.sh") > 0) || (index(s, "guard.sh") > 0) ||
           (s ~ /^[[:space:]]*(ps|awk)([[:space:]]|$)/)
  }
  $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $5 ~ /^[0-9][0-9]:[0-9][0-9]/ {
    pid = $2 + 0; pp[$2] = $3 + 0; cmd[$2] = substr($0, index($0, $6))
    if (pid == self) me = 1
    if (mode == "--pid" && pid == arg + 0) { root = pid }
    else if (mode == "--match" && root == "" && !is_collector(cmd[$2]) && index(cmd[$2], arg) > 0) { root = pid }
  }
  END {
    if (me) { delete pp[self]; delete cmd[self] }
    if (root == "") { print "NOROOT" > "/dev/stderr"; exit 0 }

    # 规则 5：先把自己（收集器）的祖先链标成受保护
    x = self + 0
    for (i = 0; i < 32; i++) { prot[x] = 1; if (!(x in pp)) break; x = pp[x] + 0 }

    n = 0
    for (p in pp) {
      if (is_collector(cmd[p])) continue
      ok = (p + 0 == root + 0)
      if (!ok) {                                  # 规则 4：向上验证
        y = p + 0
        for (i = 0; i < 32; i++) { if (!(y in pp)) break; y = pp[y] + 0; if (y == root + 0) { ok = 1; break } }
      }
      if (!ok) continue
      if (p + 0 != root + 0 && prot[p + 0]) continue          # 保护条款
      n++
      printf "PID %s ppid=%s :: %s\n", p, (pp[p] == "" ? "?" : pp[p]), substr(cmd[p], 1, 100) > "/dev/stderr"
      printf "%s ", p
    }
    printf "\n" > "/dev/stderr"
    if (n == 0) print "EMPTY" > "/dev/stderr"
  }'
