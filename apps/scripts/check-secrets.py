#!/usr/bin/env python3
"""发布闸门：把 App 配置收进公开镜像前，检查里面有没有不该公开的东西。

为什么需要：`cmux.json` 可以被设置界面写回，里面有一个 `socketPassword` 字段；
一旦某个版本把它写成真实密码，整体复制进公开仓库就等于把本机控制权限公开出去。
`defaults.plist` 走白名单导出、风险低，但同一道闸门一并覆盖。

用法：python3 scripts/check-secrets.py <文件…>
  退出码 0 = 干净；1 = 命中敏感内容（不要提交）。
"""

import json
import re
import subprocess
import sys
from pathlib import Path

# 这些 key 非空即视为敏感（大小写不敏感，允许 socketPassword / apiToken 这类拼法）
SENSITIVE_KEYS = re.compile(
    r'"(?:[^"]*)(?:password|passwd|token|secret|apikey|api_key|credential)(?:[^"]*)"\s*:\s*"([^"]*)"',
    re.IGNORECASE,
)

# 明显的凭证形状（不依赖 key 名）
VALUE_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
]


def check_file(path: Path) -> list[str]:
    problems: list[str] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        problems.append(f"{path}: 读不出内容（{exc}）")
        return problems

    for m in SENSITIVE_KEYS.finditer(text):
        value = m.group(1).strip()
        # 空的、占位符、明显不是凭证的短值放行
        if not value or value.startswith("<") or value.lower() in {"", "null", "none", "false"}:
            continue
        snippet = m.group(0)[:120]
        problems.append(f"{path}: 敏感字段有非空值 —— {snippet}")

    for pat in VALUE_PATTERNS:
        for m in pat.finditer(text):
            problems.append(f"{path}: 疑似凭证 —— {m.group(0)[:40]}…")

    return problems


def gitleaks_scan(paths: list[Path]) -> list[str]:
    """装了 gitleaks 就跑一遍确定性扫描；没装就跳过（本脚本不是唯一防线）。"""
    if not subprocess.run(["which", "gitleaks"], capture_output=True).returncode == 0:
        return []
    problems: list[str] = []
    for p in paths:
        r = subprocess.run(
            ["gitleaks", "dir", str(p.parent), "--no-banner", "--report-format", "json",
             "--report-path", "/dev/stdout"],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            continue
        try:
            hits = json.loads(r.stdout or "[]")
        except json.JSONDecodeError:
            problems.append(f"gitleaks 在 {p} 上报错（输出无法解析），请人工确认")
            continue
        for h in hits:
            problems.append(f"gitleaks 命中 {h.get('RuleID')} @ {h.get('File')}:{h.get('StartLine')}")
    return problems


def main(argv: list[str]) -> int:
    if not argv:
        print("用法：python3 scripts/check-secrets.py <文件…>")
        return 2

    paths = [Path(a).expanduser() for a in argv]
    problems: list[str] = []
    for p in paths:
        if p.exists():
            problems += check_file(p)

    existing = [p for p in paths if p.exists()]
    if existing:
        problems += gitleaks_scan(existing)

    if problems:
        print("[ERR] 敏感内容检查未通过，拒绝把内容收进公开镜像：")
        for p in problems:
            print("  -", p)
        print("  处理：把真实值留在本机（用占位符或空值），再重新 publish。")
        return 1

    print(f"[OK] 敏感检查通过（{len(existing)} 个文件）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
