#!/usr/bin/env python3
"""列出当前屏幕上的窗口，供 record.sh --window <ID> 使用。

用法：
    python3 win.sh              # 表格
    python3 win.sh --json       # JSON
    python3 win.sh 关键字        # 按 App 名 / 窗口标题过滤

说明：窗口标题需要屏幕录制权限才拿得到；没有权限时标题会是空的，
但窗口 ID 与 App 名仍然可用，录单个窗口照样能录。
"""

import json
import sys

try:
    from Quartz import (
        CGWindowListCopyWindowInfo,
        kCGWindowListOptionOnScreenOnly,
        kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    )
except ImportError:
    sys.exit(
        "缺少 pyobjc（Quartz）。装：brew install python3 通常自带；"
        "或改用 record.sh --area x,y,w,h 直接录一块矩形区域。"
    )


def fetch():
    opts = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
    raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) or []
    out = []
    for w in raw:
        bounds = w.get("kCGWindowBounds") or {}
        out.append(
            {
                "id": int(w.get("kCGWindowNumber", 0)),
                "app": str(w.get("kCGWindowOwnerName", "") or ""),
                "title": str(w.get("kCGWindowName", "") or ""),
                "layer": int(w.get("kCGWindowLayer", 0)),
                "x": int(bounds.get("X", 0)),
                "y": int(bounds.get("Y", 0)),
                "w": int(bounds.get("Width", 0)),
                "h": int(bounds.get("Height", 0)),
            }
        )
    # 只留普通应用窗口（layer 0），排除菜单栏 / 悬浮窗 / 状态栏
    return [w for w in out if w["layer"] == 0 and w["w"] > 40 and w["h"] > 40]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    wins = fetch()
    if args:
        kw = args[0].lower()
        wins = [w for w in wins if kw in w["app"].lower() or kw in w["title"].lower()]

    if as_json:
        print(json.dumps(wins, ensure_ascii=False, indent=2))
        return

    if not wins:
        print("没匹配到窗口。无屏幕录制权限时窗口标题会是空的，可先用 App 名过滤。")
        return

    print(f"{'窗口ID':>8}  {'尺寸':>11}  {'位置':>11}  App / 标题")
    print("-" * 78)
    for w in wins:
        size = f'{w["w"]}x{w["h"]}'
        pos = f'{w["x"]},{w["y"]}'
        label = w["app"] + (f' — {w["title"]}' if w["title"] else "")
        print(f'{w["id"]:>8}  {size:>11}  {pos:>11}  {label}')
    print()
    print("录这个窗口：bash record.sh start --window <窗口ID>")


if __name__ == "__main__":
    main()
