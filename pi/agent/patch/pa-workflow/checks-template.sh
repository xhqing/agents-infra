#!/usr/bin/env bash
# checks.sh —— 私有仓库的合并门禁（由全局 pa-merge.sh 在合并后的临时工作树里执行）
#
# 用法：复制本文件到仓库根为 `checks.sh`，项目自有检查写在文件末尾的「项目自有检查」段。
# 模板来源：~/.pi/agent/patch/pa-workflow/checks-template.sh（2026-11-26 建立）
#
# 检查五类，与公开仓库统一的 .github/scripts/validate.py 对齐：
#   1. 必备文件（README.md / CHANGELOG.md）
#   2. 敏感文件未被跟踪（.env / 私钥 / 密码库 / 凭据；示例模板类豁免）
#   3. 被跟踪文件不超过 10 MB
#   4. README 相对链接有效
#   5. Python / Shell 语法
#
# 设计原则：只做确定性、低误报的检查——门禁一旦误报就会卡住正常合并。
# 环境变量（pa-merge.sh 提供）：PA_MERGE_BASE=origin/main、PA_MERGE_BRANCH=<分支>、PA_SHARED=0|1
# 可调：CHECK_MAX_MB（默认 10）、CHECK_REQUIRED_FILES（空格分隔）、CHECK_LINK_DOCS
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "── 通用卫生检查（必备文件 / 敏感文件 / 大文件 / 链接 / 语法）──"
CHECK_MAX_MB="${CHECK_MAX_MB:-10}" \
CHECK_REQUIRED_FILES="${CHECK_REQUIRED_FILES:-README.md CHANGELOG.md}" \
CHECK_LINK_DOCS="${CHECK_LINK_DOCS:-README.md README_cn.md}" \
python3 - <<'PY'
import os, re, subprocess, sys

MAX_MB = int(os.environ.get("CHECK_MAX_MB", "10"))
MAX_BYTES = MAX_MB * 1024 * 1024
REQUIRED = os.environ.get("CHECK_REQUIRED_FILES", "README.md CHANGELOG.md").split()
LINK_DOCS = os.environ.get("CHECK_LINK_DOCS", "README.md README_cn.md").split()

SENSITIVE_PATTERNS = [
    (re.compile(r"^\.env$"), "环境变量文件"),
    (re.compile(r"^\.env\.[^/]+$"), "环境变量文件"),
    (re.compile(r".+\.(pem|p12|pfx|jks|kdbx)$", re.I), "证书 / 密钥 / 密码库"),
    (re.compile(r".+\.(key|keystore)$", re.I), "密钥文件"),
    (re.compile(r"^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$"), "SSH 私钥"),
    (re.compile(r"^\.npmrc$"), "可能含 token 的 npm 配置"),
    (re.compile(r"^\.netrc$"), "可能含凭据的 netrc"),
    (re.compile(r"^credentials\.json$"), "凭据文件"),
]
SENSITIVE_EXEMPT_SUFFIXES = (".example", ".sample", ".template", ".dist", ".defaults")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
SKIP_DIRS = {".git", "node_modules", "tmp", "venv", ".venv", "__pycache__",
             "data_cache", "build", ".build", "dist", "artifacts"}

failures = []

def note(msg):
    print(f"  ✅ {msg}")

def fail(msg):
    print(f"  ❌ {msg}")
    failures.append(msg)

def tracked():
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True, check=True).stdout
    return [f for f in out.split("\0") if f]

files = tracked()

# 1) 必备文件
for name in REQUIRED:
    if os.path.isfile(name):
        note(f"{name} 存在")
    else:
        fail(f"缺少 {name}（团队统一标配）")

# 2) 敏感文件未被跟踪
bad = []
for f in files:
    base = os.path.basename(f)
    if base.endswith(SENSITIVE_EXEMPT_SUFFIXES):
        continue
    for pattern, kind in SENSITIVE_PATTERNS:
        if pattern.match(base):
            bad.append(f"{f}（{kind}）")
            break
if bad:
    for b in bad:
        fail(f"疑似敏感文件被跟踪：{b}")
else:
    note(f"{len(files)} 个被跟踪文件，无敏感文件")

# 3) 大文件
big = []
for f in files:
    try:
        size = os.path.getsize(f)
    except OSError:
        continue
    if size > MAX_BYTES:
        big.append(f"{f}（{size / 1024 / 1024:.1f} MB）")
if big:
    for b in big:
        fail(f"超大文件（>{MAX_MB} MB）：{b}")
else:
    note(f"无超过 {MAX_MB} MB 的被跟踪文件")

# 4) README 相对链接
bad_links = []
checked = 0
for doc in LINK_DOCS:
    if doc not in files:
        continue
    try:
        text = open(doc, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError):
        continue
    for target in LINK_RE.findall(text):
        t = target.strip()
        if t.startswith(("http://", "https://", "mailto:", "#", "/")) or "://" in t:
            continue
        path = t.split("#", 1)[0].split("?", 1)[0]
        if not path or "<" in path or "{" in path:
            continue
        full = os.path.normpath(os.path.join(os.path.dirname(doc), path))
        checked += 1
        if not os.path.exists(full):
            bad_links.append(f"{doc} → {t}")
if bad_links:
    for b in bad_links:
        fail(f"链接指向的文件不存在：{b}")
else:
    note(f"检查 {checked} 个相对链接，全部有效")

# 5) 语法：Python 用 AST（不产生字节码），Shell 用 bash -n
py = [f for f in files if f.endswith(".py") and not any(p in f.split("/") for p in SKIP_DIRS)]
py_bad = []
for f in py:
    try:
        import ast
        ast.parse(open(f, encoding="utf-8").read(), filename=f)
    except SyntaxError as e:
        py_bad.append(f"{f}:{e.lineno}: {e.msg}")
    except (OSError, UnicodeDecodeError) as e:
        py_bad.append(f"{f}: {e}")
if py_bad:
    for b in py_bad:
        fail(f"Python 语法错误：{b}")
elif py:
    note(f"{len(py)} 个 Python 文件语法通过")

sh = [f for f in files if f.endswith(".sh")]
for f in files:
    if f in sh or any(p in f.split("/") for p in SKIP_DIRS):
        continue
    try:
        with open(f, "rb") as fh:
            first = fh.readline(64)
    except OSError:
        continue
    if first.startswith(b"#!") and b"sh" in first:
        sh.append(f)
sh_bad = []
for f in sh:
    r = subprocess.run(["bash", "-n", f], capture_output=True, text=True)
    if r.returncode != 0:
        sh_bad.append(f"{f}: {r.stderr.strip()}")
if sh_bad:
    for b in sh_bad:
        fail(f"Shell 语法错误：{b}")
elif sh:
    note(f"{len(sh)} 个 Shell 脚本语法通过")

if failures:
    print(f"\n❌ 通用卫生检查未通过（{len(failures)} 项）")
    sys.exit(1)
print("\n✅ 通用卫生检查通过")
PY

# ── 项目自有检查（写在这里；本模板段不要删）──
# 例：python3 src/selftest.py
# 例：git diff --name-only "$PA_MERGE_BASE" HEAD -- data/raw | grep -q . && exit 1

echo "✅ 门禁全过"
