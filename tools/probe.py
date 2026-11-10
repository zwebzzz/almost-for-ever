# -*- coding: utf-8 -*-
"""Almost For Ever 诊断工具 —— 一条命令看清插件现在什么状态。

用法（写成 .py 跑，别内联）：
    python tools/probe.py

它会依次检查：
    ① 状态目录（queue.json / debug.log 在不在）
    ② HTTP 接口活不活（pending / accept / reject / dismiss 四个端点）
    ③ 队列里有什么候选
    ④ debug.log 最近发生了什么

为什么要有这个：
    插件的失败模式大多是「静默」的 —— 收集通道没通、异常被 try/catch 吞掉、
    接口没注册，界面上都看不出来。这个脚本把四个环节逐个点亮，
    省得每次再写一遍临时探针。

改什么不会坏：这里只读，不写队列、不动记忆库。要清队列用 --clear。
"""

import json
import os
import sys
import urllib.error
import urllib.request

STATE_DIR = os.path.join(os.environ.get("USERPROFILE", os.path.expanduser("~")),
                         ".dsh", "almost-for-ever")
QUEUE = os.path.join(STATE_DIR, "queue.json")
LOG = os.path.join(STATE_DIR, "debug.log")
BASE = os.environ.get("AFE_BASE", "http://127.0.0.1:53528")

OK = "[ok]"
BAD = "[!!]"
DIM = "[..]"


def http(path, method="GET", payload=None, timeout=5):
    url = BASE + path
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(body)
            except json.JSONDecodeError:
                return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:200]
    except Exception as e:  # 连接被拒 / 超时
        return None, str(e)


def check_state():
    print("① 状态目录")
    if not os.path.isdir(STATE_DIR):
        print(f"   {BAD} 目录不存在：{STATE_DIR}")
        print("        说明插件从未成功加载过（collect 与 HTTP 都会写这个目录）")
        return
    print(f"   {OK} {STATE_DIR}")

    has_queue = os.path.exists(QUEUE)
    has_log = os.path.exists(LOG)
    print(f"   {'[ok]' if has_queue else DIM} queue.json  "
          f"{'（空队列也算正常）' if crit_is_empty() else ''}")
    print(f"   {'[ok]' if has_log else DIM} debug.log   "
          f"{'(debug 开关关闭时不生成)' if not has_log else ''}")


def crit_is_empty():
    try:
        return json.load(open(QUEUE, encoding="utf-8")) == []
    except Exception:
        return False


def check_http():
    print()
    print("② HTTP 接口（便利贴靠它拉数据）")
    code, body = http("/almost-for-ever/pending")
    if code == 200 and isinstance(body, dict):
        items = body.get("items", [])
        targets = body.get("targets", [])
        print(f"   {OK} GET  /pending  → {len(items)} 条待确认，{len(targets)} 个可选目标")
        if not targets:
            print(f"   {BAD} targets 为空 —— labels.js 可能没加载")
        return items
    print(f"   {BAD} GET  /pending  → {code} {str(body)[:120]}")
    print("        插件没加载 / 没注册 webServer / GUI 换了端口（用 AFE_BASE 覆盖）")
    return None


def check_queue(items=None):
    print()
    print("③ 队列内容")
    if items is None:
        try:
            items = json.load(open(QUEUE, encoding="utf-8"))
        except Exception:
            items = []
    if not items:
        print(f"   {DIM} 空（没有待确认的候选）")
        return
    for it in items:
        print(f"   · [{it.get('kind', '?')}] {it.get('text', '')[:70]}")
        guess = it.get("stem") or "（未指定）"
        print(f"       落点 {guess}   原因 {it.get('why', '')[:40]}")


def check_log(tail=14):
    print()
    print("④ debug.log")
    if not os.path.exists(LOG):
        print(f"   {DIM} 不存在")
        return
    lines = [l for l in open(LOG, encoding="utf-8").read().strip().split("\n") if l]
    print(f"   {len(lines)} 行，最近 {tail} 行：")
    for line in lines[-tail:]:
        try:
            ts, rest = line.split(" ", 1)
            obj = json.loads(rest)
            ev = obj.get("ev", "?")
            detail = ", ".join(
                f"{k}={v}" for k, v in obj.items() if k != "ev" and not isinstance(v, (list, dict))
            )
            print(f"   {ts[11:19]}  {ev:18} {detail[:90]}")
        except Exception:
            print("   " + line[:110])


def explain():
    """把常见症状对到原因上 —— 比让人猜好。"""
    print()
    print("⑤ 常见症状对照")
    print("   · 说了「记一下」但没弹窗")
    print("       看 debug.log 有没有 nudge-cue → 有则看 propose 有没有出现")
    print("       没有 propose = 模型没调工具；有 propose 无 accept = 弹窗没渲染")
    print("   · 便利贴不出现但 queue 有内容")
    print("       查 shell.overlay 座位：cordis_inspect_query Slots.listSubTree root=shell.overlay")
    print("   · /pending 返回非 200")
    print("       webServer 服务没起来，或 GUI 端口变了（AFE_BASE=http://127.0.0.1:<端口>）")


def main(argv):
    if "--clear" in argv:
        if os.path.exists(QUEUE):
            open(QUEUE, "w", encoding="utf-8").write("[]")
            print("队列已清空")
        else:
            print("队列本来就不存在")
        return 0

    print(f"Almost For Ever 诊断    base={BASE}")
    print("=" * 62)
    check_state()
    items = check_http()
    check_queue(items)
    check_log()
    explain()
    print()
    print("=" * 62)
    print("清空队列：python tools\\probe.py --clear")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
