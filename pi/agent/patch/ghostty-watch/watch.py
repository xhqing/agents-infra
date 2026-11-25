#!/usr/bin/env python3
"""ghostty-watch —— 监控本机 ghostty 进程的生命周期。

解决的问题：ghostty 会被 macOS 内核的 memorystatus 高水位（high watermark）机制
SIGKILL 掉，既不崩溃、也没有任何提示，窗口凭空消失。光靠 tmux 只能保证工作不丢，
却不知道「什么时候被杀过、丢了哪几个会话」。

做法（纯标准库，不依赖第三方包）：
  * LaunchAgent 常驻，每 5 秒扫一次 ghostty 进程与它的子会话；
  * 某个 PID 消失时归因：查 unified log 的 memorystatus 记录 / 崩溃报告 / shell 心跳的 clean 标记；
  * 事件写 ~/.local/state/ghostty-watch/events.log，并留一份 pending，等下次开终端时在
    shell 里打印横幅（这才是「一定知道」的保证——你总会再开终端）；
  * 同时尽力发一条系统通知（失败不影响主流程）。

用法：
  watch.py daemon        # LaunchAgent 常驻入口
  watch.py once          # 跑一轮扫描（调试）
  watch.py status        # 当前 ghostty 与各会话（只读）
  watch.py log [-n 20]   # 最近事件
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path(os.environ.get("GHOSTTY_WATCH_STATE", str(Path.home() / ".local/state/ghostty-watch")))
STATE_FILE = STATE_DIR / "state.json"
EVENT_LOG = STATE_DIR / "events.log"
PENDING_FILE = STATE_DIR / "pending.json"
SHELLS_DIR = STATE_DIR / "shells"
MAX_LOG_BYTES = 1024 * 1024
MAX_PENDING = 10

GHOSTTY_RE = re.compile(r"(/Applications/Ghostty\.app/Contents/MacOS/ghostty|/zig-out/bin/ghostty|/MacOS/ghostty)$")
JETSAM_DIR = Path("/Library/Logs/DiagnosticReports")
CRASH_DIRS = [Path.home() / "Library/Logs/DiagnosticReports", Path("/Library/Logs/DiagnosticReports")]


# ---------- 基础工具 ----------

def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def run(cmd: list[str], timeout: float = 20.0) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout
    except Exception:
        return ""


def ensure_dirs() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    SHELLS_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def save_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    tmp.replace(path)


def rotate_log() -> None:
    try:
        if EVENT_LOG.exists() and EVENT_LOG.stat().st_size > MAX_LOG_BYTES:
            EVENT_LOG.replace(EVENT_LOG.with_suffix(".log.1"))
    except Exception:
        pass


# ---------- 进程扫描 ----------

def scan_processes_checked() -> tuple[dict[int, dict], bool]:
    """返回 ({pid: {ppid, rss_kb, etime, cmd}}, 本轮扫描是否可信)，只含 ghostty 主进程。

    为什么要把「扫描失败」和「没有进程」分开：ps 偶发超时 / 失败 / 输出异常时，旧实现
    把它当成「没有 ghostty」，于是好端端跑着的进程被判「退出」并写下 pending。
    2026-11-25 实测两次：pid 32530 在 15:31:14 被判 DIED、15:31:36 又以**同一个 pid**
    重新 START —— 同一次启动不可能先死后生，这两条都是扫描失败造成的误报。
    """
    try:
        r = subprocess.run(["ps", "-eo", "pid=,ppid=,rss=,etime=,command="],
                           capture_output=True, text=True, timeout=20)
    except Exception:
        return {}, False
    out = r.stdout or ""
    if r.returncode != 0 or not out.strip():
        return {}, False
    procs: dict[int, dict] = {}
    parsed = 0
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid_s, ppid_s, rss_s, etime, cmd = parts
        try:
            pid, ppid, rss = int(pid_s), int(ppid_s), int(rss_s)
        except ValueError:
            continue
        parsed += 1
        head = cmd.split(" ", 1)[0]
        if GHOSTTY_RE.search(head) or head.endswith("/ghostty"):
            procs[pid] = {"ppid": ppid, "rss_kb": rss, "etime": etime, "cmd": head}
    # 一行都解析不出来 = ps 输出形态异常，同样不能当作「没有进程」
    if parsed == 0:
        return {}, False
    return procs, True


def scan_processes() -> dict[int, dict]:
    return scan_processes_checked()[0]


def pid_alive(pid: int) -> bool:
    """单独复核一个 pid 是否还在跑（不依赖 ps 的批量输出）。

    os.kill(pid, 0) 只做存在性检查、不发信号；查不动时一律按「还活着」处理——
    宁可漏报一次被杀，也不要因为在世进程被误判死亡而写 pending / 推飞书。
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except Exception:
        return True
    return True


def pid_start(pid: int) -> str:
    """该 pid 的启动时刻（pid 被系统复用时这个值会变）；查不到返回空串。"""
    out = run(["ps", "-p", str(pid), "-o", "lstart="], timeout=10).strip()
    return " ".join(out.split())


def tty_of_pid() -> dict[int, str]:
    """{pid: tty} 映射，用于把 ghostty 的直接子进程对回 shell 心跳。"""
    out = run(["ps", "-eo", "pid=,tty="])
    mapping: dict[int, str] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            mapping[int(parts[0])] = parts[1]
        except ValueError:
            continue
    return mapping


PI_SESSIONS = Path.home() / ".pi/agent/sessions"
_pi_session_cache: dict[int, tuple[str, str]] = {}


def _session_slug(cwd: str) -> str:
    return "--" + cwd.strip("/").replace("/", "-") + "--"


def _proc_start_utc(pid: int) -> datetime | None:
    out = run(["ps", "-o", "lstart=", "-p", str(pid)]).strip()
    if not out:
        return None
    try:
        local = datetime.strptime(" ".join(out.split()), "%a %b %d %H:%M:%S %Y")
    except ValueError:
        return None
    return datetime.fromtimestamp(local.timestamp(), tz=timezone.utc).replace(tzinfo=None)


def _proc_cwd(pid: int) -> str:
    out = run(["lsof", "-p", str(pid), "-a", "-d", "cwd", "-Fn"], timeout=10)
    for line in out.splitlines():
        if line.startswith("n/"):
            return line[1:]
    return ""


def pi_session_of(pid: int) -> dict:
    """认出一个 pi 进程跑的是哪个会话。

    为什么不能靠 `pi -c`：同一个项目常同时开好几个会话（还有人开在 cmux 里），
    “最近一次的”并不等于“这个窗口里的那一次”（2026-11-19 用户指出）。而且 pi 进程
    不一直持着会话文件的句柄（lsof 看不到），所以改成用启动时间对齐：进程启动的那一秒，
    正好就是会话文件名里的启动时间。
    """
    cached = _pi_session_cache.get(pid)
    if cached:
        return {"session": cached[0], "cwd": cached[1]}
    started = _proc_start_utc(pid)
    cwd = _proc_cwd(pid)
    sid = ""
    if started and cwd:
        d = PI_SESSIONS / _session_slug(cwd)
        if d.is_dir():
            for f in d.glob("*.jsonl"):
                stamp = f.name.split("_", 1)[0]
                try:
                    when = datetime.strptime(stamp, "%Y-%m-%dT%H-%M-%S-%fZ")
                except ValueError:
                    continue
                if abs((when - started).total_seconds()) <= 10:
                    parts = f.stem.split("_", 1)
                    sid = parts[1] if len(parts) > 1 else ""
                    break
    if len(_pi_session_cache) > 200:
        _pi_session_cache.clear()
    _pi_session_cache[pid] = (sid, cwd)
    return {"session": sid, "cwd": cwd}


def _find_pi(pid: int, children_of: dict[int, list[int]], rows: dict[int, dict],
             max_depth: int = 8) -> int:
    """在这个会话的子孙进程里找 pi 进程（shell → pi，也可能隔着 tmux 之类的层）。"""
    frontier = [pid]
    for _ in range(max_depth):
        nxt: list[int] = []
        for p in frontier:
            for kid in children_of.get(p, []):
                if os.path.basename(rows[kid]["cmd"].split(" ", 1)[0]) == "pi":
                    return kid
                nxt.append(kid)
        if not nxt:
            break
        frontier = nxt
    return 0


def scan_children(ghostty_pid: int) -> list[dict]:
    """ghostty 的子进程 = 一个个终端会话（surface）。"""
    out = run(["ps", "-eo", "pid=,ppid=,rss=,etime=,command="])
    ttys = tty_of_pid()
    rows: dict[int, dict] = {}
    children_of: dict[int, list[int]] = {}
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        try:
            pid, ppid, rss = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            continue
        rows[pid] = {"ppid": ppid, "rss_kb": rss, "etime": parts[3], "cmd": parts[4]}
        children_of.setdefault(ppid, []).append(pid)
    kids: list[dict] = []
    for pid, row in rows.items():
        if row["ppid"] != ghostty_pid:
            continue
        kid = {"pid": pid, "rss_kb": row["rss_kb"], "etime": row["etime"],
               "cmd": row["cmd"], "tty": ttys.get(pid, "")}
        pi_pid = _find_pi(pid, children_of, rows)
        if pi_pid:
            info = pi_session_of(pi_pid)
            kid["pi_pid"] = pi_pid
            kid["pi_session"] = info["session"]
            kid["pi_cwd"] = info["cwd"]
        kids.append(kid)
    return kids


def shell_heartbeats() -> dict[int, dict]:
    """读 shell-hook 写的心跳：{pid: {...}}。"""
    out: dict[int, dict] = {}
    if not SHELLS_DIR.exists():
        return out
    for f in SHELLS_DIR.glob("*.json"):
        data = load_json(f, None)
        if isinstance(data, dict) and isinstance(data.get("pid"), int):
            data["_file"] = str(f)
            out[data["pid"]] = data
    return out


def match_beat(kid: dict, beats: dict[int, dict]) -> dict | None:
    """把 ghostty 的直接子进程对回 shell 心跳。

    心跳记的是真正在跑的那个 shell 的 pid；ghostty 的直接子进程往往是一层 login
    包装（/usr/bin/login … exec -l /bin/zsh），两者 pid 不同。只按 pid 匹配会把有
    记录的会话也报成「cwd 未知」（2026-11-19 实测踩到），所以退一步按「父 pid =
    子进程 pid」或 tty 相同来对上。

    **归因判定（exit 记录）必须走同一个匹配**：只修展示、不修判定时，用户关窗口
    留下的 exit 记录被漏掉，正常退出被误报成「很可能是被系统杀掉」并推了飞书
    （2026-11-19 用户实测纠正）。
    """
    beat = beats.get(kid["pid"])
    if beat:
        return beat
    for b in beats.values():
        if b.get("ppid") == kid["pid"] or (kid.get("tty") and b.get("tty") == kid.get("tty")):
            return b
    return None


def describe_session(kid: dict, beats: dict[int, dict]) -> str:
    beat = match_beat(kid, beats)
    cmd = kid["cmd"]
    # login -q -flp xhq /bin/bash ... -c exec -l /bin/zsh 只是登录壳的包装，展示真正含义
    short = "zsh"
    if " exec -l /bin/" in cmd:
        short = cmd.rsplit("/bin/", 1)[-1]
    elif cmd.startswith("/usr/bin/login"):
        short = "shell"
    if beat:
        cwd = beat.get("cwd") or kid.get("pi_cwd") or "?"
        last = (beat.get("last") or "").strip()
        extra = f" [最近: {last}]" if last else ""
        return f"{cwd} ({short}){extra}{_pi_tag(kid)}"
    return f"(cwd 未知) ({short}){_pi_tag(kid)}"


def _pi_tag(kid: dict) -> str:
    """窗口里的 pi 会话 id（有就带上，恢复时直接 `pi --session <id>` 就对了）。"""
    if kid.get("pi_session"):
        return f" [pi 会话 {kid['pi_session'][:8]}]"
    if kid.get("pi_pid"):
        return " [pi 运行中]"
    return ""


# ---------- 归因 ----------

def find_memory_kill(pid: int, window_s: int = 600) -> bool:
    """unified log 里是否有该 PID 的内存高水位记录。"""
    pred = 'process == "ReportCrash" AND eventMessage CONTAINS "memory high watermark"'
    out = run(["log", "show", "--last", f"{window_s}s", "--predicate", pred, "--style", "compact"], timeout=25)
    return bool(re.search(rf"PID {pid} exceeded", out))


def find_jetsam_kill(pid: int, window_s: int = 180) -> str:
    """查最近是不是有 JetsamEvent 把该 PID 列入（全局内存回收也会杀进程）。"""
    cutoff = time.time() - window_s
    try:
        names = sorted(JETSAM_DIR.glob("JetsamEvent-*.ips"))
    except Exception:
        return ""
    for f in names:
        try:
            if f.stat().st_mtime < cutoff:
                continue
            text = f.read_text(errors="replace")
        except Exception:
            continue
        head, _, rest = text.partition("\n")
        try:
            body = json.loads(rest)
        except Exception:
            continue
        for pr in body.get("processes", []):
            if pr.get("pid") == pid:
                reason = pr.get("killReason") or ""
                return f"{f.name}{('（' + reason + '）') if reason else ''}"
    return ""


def pressure_level() -> int:
    """内核当前内存压力等级：1=正常 2=警告 4=危急。"""
    out = run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], timeout=5).strip()
    try:
        return int(out)
    except ValueError:
        return 0


def find_crash_report(pid: int, cmd: str, window_s: int = 180) -> str:
    """找「这个被监控进程」自己的崩溃报告。

    不能只看文件名 + 时间窗：同一目录里可能躺着别的 ghostty 进程（比如开发版、
    ad-hoc 签名的测试二进制）的崩溃报告，时间窗内有它就会被误判。这里按报告里的
    pid / procPath 精确匹配。
    """
    cutoff = time.time() - window_s
    for d in CRASH_DIRS:
        try:
            for f in d.glob("*.ips"):
                try:
                    if f.stat().st_mtime < cutoff:
                        continue
                except Exception:
                    continue
                if "ghostty" not in f.name.lower():
                    continue
                if _ips_matches(f, pid, cmd):
                    return str(f)
        except Exception:
            continue
    return ""


def _ips_matches(path: Path, pid: int, cmd: str) -> bool:
    try:
        text = path.read_text(errors="replace")
    except Exception:
        return False
    head, _, rest = text.partition("\n")
    try:
        body = json.loads(rest) if rest else {}
    except Exception:
        body = {}
    try:
        if int(body.get("pid", -1)) == pid:
            return True
    except Exception:
        pass
    proc_path = body.get("procPath") or ""
    if proc_path and cmd and proc_path.rstrip("/") == cmd.rstrip("/"):
        return True
    return False


def classify(pid: int, rec: dict) -> tuple[str, list[str], str]:
    """归因，返回 (原因, 注记, 处置)。

    处置三档（2026-11-19 用户纠正误报后定的口径）：
      manual     —— 所有会话都有 exit 记录 = 用户自己关的，只记日志；
      suspicious —— 无系统终止证据、也不确定（缺 exit 记录），只记日志 + 终端横幅；
      alert      —— 有硬证据（memorystatus / 崩溃报告 / jetsam）或内存危急，立即通知。
    """
    notes: list[str] = []
    beats = shell_heartbeats()
    kids = rec.get("children") or []

    # 1) 所有会话都是「自己 exit 掉的」-> 用户主动关的（关掉最后一个窗口也走这条）
    if kids:
        exited = [k for k in kids if (match_beat(k, beats) or {}).get("exit_kind") == "exit"]
        if len(exited) == len(kids):
            return "手动退出（所有会话都正常 exit）", notes, "manual"

    # 2) 内核内存高水位（这是实测见过的那条路）
    if find_memory_kill(pid):
        return "被系统杀掉（内核内存高水位 memorystatus / SIGKILL）", notes, "alert"

    # 3) 崩溃报告（按 pid / procPath 精确匹配，避免误认别的 ghostty 进程的报告）
    crash = find_crash_report(pid, rec.get("cmd", ""))
    if crash:
        notes.append(f"崩溃报告: {crash}")
        return "崩溃（生成了崩溃报告）", notes, "alert"

    # 4) 全局 jetsam 内存回收
    jetsam = find_jetsam_kill(pid)
    if jetsam:
        notes.append(f"JetsamEvent: {jetsam}")
        return "被系统杀掉（jetsam 内存回收）", notes, "alert"

    # 5) 无硬证据时看当时的内存压力。
    #    只有危急（4）才算「很可能是被杀」；警告（2）在 8GB 机器上几乎是常态，拿它
    #    当证据会把「手动关窗口」系统性误报成被杀（2026-11-19 实测：关掉最后一个
    #    窗口正常退出，被判成「很可能是被系统杀掉」并推了飞书）。
    lvl = pressure_level()
    if lvl >= 4:
        notes.append(f"进程消失时内核内存压力等级={lvl}（1=正常 2=警告 4=危急）")
        return "消失（进程消失时内存压力危急，很可能是被系统杀掉）", notes, "alert"
    if lvl >= 2:
        notes.append(f"进程消失时内核内存压力等级={lvl}（仅警告，不作为被杀证据）")

    if kids:
        missing = sum(1 for k in kids if (match_beat(k, beats) or {}).get("exit_kind") != "exit")
        notes.append(f"{missing}/{len(kids)} 个会话没有 exit 记录（可能是关窗口，也可能是被强制终止）")
    return "消失（无系统终止证据：多半是你手动关闭）", notes, "suspicious"


# ---------- 事件 ----------

def append_event(lines: list[str]) -> None:
    rotate_log()
    with EVENT_LOG.open("a") as f:
        f.write("\n".join(lines) + "\n")


def add_pending(ev: dict) -> None:
    items = load_json(PENDING_FILE, [])
    if not isinstance(items, list):
        items = []
    items.append(ev)
    save_json(PENDING_FILE, items[-MAX_PENDING:])


TN_PATH = "/opt/homebrew/bin/terminal-notifier"


def _notify_terminal_notifier(title: str, body: str) -> tuple[bool, str]:
    """terminal-notifier 是带 bundle 的 app，能真正走通知中心（需用户授权一次）。"""
    if not os.path.exists(TN_PATH):
        return False, "未安装 terminal-notifier"
    try:
        r = subprocess.run(
            [TN_PATH, "-title", title, "-message", body, "-group", "ghostty-watch", "-sound", "Basso"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception as e:
        return False, f"terminal-notifier 调用失败: {e}"
    if r.returncode == 0:
        return True, "terminal-notifier"
    err = (r.stderr or r.stdout).strip().splitlines()
    return False, (err[0] if err else f"terminal-notifier exit={r.returncode}")


# osascript 的 display notification 需要一个 __CFBundleIdentifier 才能被 usernoted 投递。
# 实测（2026-11-15）：LaunchAgent 里没有这个变量时，osascript 返回 0 但通知被静默丢弃；
# 注入一个已存在的 app 的 bundle id 后，通知能正常 Delivering / Presenting。
NOTIFY_BUNDLE_ID = "com.mitchellh.ghostty"
LARK_CLI = str(Path.home() / ".local/bin/lark-cli")
FEISHU_NO_PROXY = "feishu.cn,.feishu.cn,larksuite.com,.larksuite.com,127.0.0.1,localhost"
CONFIG_FILE = STATE_DIR / "config.json"

# 发送方是谁（2026-11-15 用户立）：用 Nancy（Kit 的助手），**不要用 Linda**（Linda 是
# Victor 的专属助手、描述写着 Victor's Assistant）。
#
# 为什么只写 profile 名、不写 open_id（2026-11-15）：飞书 open_id 是**应用维度**的个人标识，
# 本目录会随全局能力层镜像到公开仓库，不该把个人标识写进代码。所以落在本机
# `~/.local/state/ghostty-watch/config.json`（不进仓库，字段 feishu_profile / feishu_open_id）。
# 换应用必须同时换 open_id（只换 profile 不换 open_id，飞书会报 99992361）。
LARK_PROFILE = "nancy"


def _notify_feishu(title: str, body: str) -> tuple[bool, str]:
    """飞书推送（主渠道）：手机、桌面都能收到。走 lark-cli 的 bot 身份，不受 user token 过期影响。

    profile 默认 `nancy`，open_id 取本机配置；两者都可在 config.json 里覆盖（成对改）。
    """
    if not os.path.exists(LARK_CLI):
        return False, "未安装 lark-cli"
    cfg = load_json(CONFIG_FILE, {}) or {}
    if cfg.get("feishu_disabled"):
        return False, "飞书通知已在配置里关闭"
    profile = cfg.get("feishu_profile") or LARK_PROFILE
    uid = cfg.get("feishu_open_id") or ""
    if not uid:
        out = run([LARK_CLI, "auth", "status", "--profile", profile], timeout=40)
        m = re.search(r'"openId"\s*:\s*"([^"]+)"', out)
        if m:
            uid = m.group(1)
        else:
            return False, (f"飞书发送配置缺失：profile {profile} 没有用户 open_id（在"
                           f" {CONFIG_FILE} 里填 feishu_open_id，或给该 profile 做一次 "
                           f"`lark-cli auth login --profile {profile}`）")
    if cfg.get("feishu_open_id") != uid or cfg.get("feishu_profile") != profile:
        cfg["feishu_profile"] = profile
        cfg["feishu_open_id"] = uid
        save_json(CONFIG_FILE, cfg)

    env = dict(os.environ)
    env["NO_PROXY"] = FEISHU_NO_PROXY
    env["no_proxy"] = FEISHU_NO_PROXY
    text = f"【{title}】\n{body}"
    key = f"gw-{os.getpid()}-{int(time.time())}"
    try:
        r = subprocess.run(
            [LARK_CLI, "--profile", profile, "im", "+messages-send", "--as", "bot",
             "--user-id", uid, "--text", text, "--idempotency-key", key],
            capture_output=True, text=True, timeout=60, env=env,
        )
    except subprocess.TimeoutExpired:
        return False, "飞书发送超时（60s）"
    except Exception as e:
        return False, f"飞书调用失败: {e}"
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode == 0 and '"ok": true' in out:
        mid = ""
        m = re.search(r'"message_id"\s*:\s*"([^"]+)"', out)
        if m:
            mid = f" id={m.group(1)}"
        return True, f"飞书（{profile}）已送达（手机可收）{mid}"
    if "not found" in out.lower() or "scope" in out.lower():
        return False, "飞书发送失败：应用权限不足（需 im:message）"
    if "99992361" in out:
        return False, "飞书发送失败：open_id 与应用不匹配（open_id 是应用维度的，换应用要同时换 open_id）"
    reason = ""
    m = re.search(r'"msg"\s*:\s*"([^"]+)"', out)
    if m:
        reason = m.group(1)
    return False, f"飞书发送失败{('：' + reason) if reason else '（退出码 ' + str(r.returncode) + '）'}"


def _as_applescript_str(s: str) -> str:
    """AppleScript 字符串字面量：json.dumps 的默认 ensure_ascii=True 会写出 \\u4f60 这种转义，
    AppleScript 不认（实测报 -2741 语法错误），所以逐字符自己转义。换行用空格代替
    （AppleScript 字符串里不能出现裸 \\n 转义）。"""
    s = (s or "").replace("\r", " ").replace("\n", " ")
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _notify_osascript(title: str, body: str) -> tuple[bool, str]:
    script = f"display notification {_as_applescript_str(body)} with title {_as_applescript_str(title)}"
    env = dict(os.environ)
    if not env.get("__CFBundleIdentifier"):
        env["__CFBundleIdentifier"] = NOTIFY_BUNDLE_ID
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10, env=env)
    except Exception as e:
        return False, f"osascript 调用失败: {e}"
    if r.returncode != 0:
        err = (r.stderr or r.stdout).strip().splitlines()
        return False, (err[0] if err else f"osascript exit={r.returncode}")
    return True, "osascript（显示为「脚本编辑器」）"


def _notify_sound() -> tuple[bool, str]:
    for snd in ("/System/Library/Sounds/Basso.aiff", "/System/Library/Sounds/Sosumi.aiff"):
        if not os.path.exists(snd):
            continue
        try:
            r = subprocess.run(["/usr/bin/afplay", snd], capture_output=True, timeout=10)
            if r.returncode == 0:
                return True, f"提示音 {os.path.basename(snd)}（系统音量低时可能听不见）"
        except Exception:
            continue
    return False, "提示音播放失败"


def notify(title: str, body: str) -> str:
    """按可靠性依次尝试，返回实际结果描述（会写进事件日志，便于查「为什么没弹通知」）。"""
    attempts: list[str] = []

    # 主渠道：飞书（手机也能收到，用户指定的通知方式）
    ok, how = _notify_feishu(title, body)
    if ok:
        return how
    attempts.append(how)

    # 备用：桌面通知
    ok, how = _notify_terminal_notifier(title, body)
    if ok:
        attempts.append(how)
        return "飞书失败，已弹桌面通知（" + "；".join(attempts) + "）"
    attempts.append(how)

    ok, how = _notify_osascript(title, body)
    if ok:
        attempts.append(how)
        return "飞书失败，已弹桌面通知（" + "；".join(attempts) + "）"
    attempts.append(how)

    ok, how = _notify_sound()
    attempts.append(how)
    return "即时通知未送达（尝试: " + "；".join(attempts) + "）；下次开终端一定会看到横幅"

def notify_legacy(title: str, body: str) -> None:
    script = f"display notification {_as_applescript_str(body)} with title {_as_applescript_str(title)}"
    run(["osascript", "-e", script], timeout=8)


def handle_disappear(pid: int, rec: dict) -> None:
    reason, notes, verdict = classify(pid, rec)
    kids = rec.get("children") or []
    rss_mb = round(rec.get("peak_rss_kb", 0) / 1024)
    beats = shell_heartbeats()
    sessions = [describe_session(k, beats) for k in kids]
    for k in kids:
        if k.get("pi_session"):
            notes.append(f"恢复：cd {k.get('pi_cwd') or '?'} && pi --session {k['pi_session'][:8]}")

    body_lines = [reason, f"峰值 {rss_mb}MB｜丢失 {len(sessions)} 个会话"]
    for s in sessions[:8]:
        body_lines.append(f"· {s}")
    if len(sessions) > 8:
        body_lines.append(f"· …还有 {len(sessions) - 8} 个")
    body_lines.append("本机查看详情：ghostty-watch log")

    head = f"{now_str()}  DIED   ghostty pid={pid}  原因={reason}  峰值≈{rss_mb}MB  会话={len(kids)}个"
    lines = [head]
    for s in sessions:
        lines.append(f"          └─ {s}")
    for n in notes:
        lines.append(f"          · {n}")

    # 用户自己关的（关掉最后一个窗口 = 所有会话都 exit）不该弹任何通知
    if verdict == "manual":
        lines.append("          · 未通知（所有会话都有 exit 记录 = 你主动关的）")
        append_event(lines)
        return

    # 先把 pending 落盘（通知可能卡在网络上，不能让它拖住“一定知道”的那条路）
    add_pending({
        "time": now_str(),
        "pid": pid,
        "reason": reason,
        "peak_mb": rss_mb,
        "sessions": sessions,
        "notes": notes,
    })

    if verdict == "suspicious":
        lines.append("          · 未即时通知（无系统终止证据；下次开终端时看横幅）")
        append_event(lines)
        return

    channel = notify("ghostty 被终止", "\n".join(body_lines))
    if isinstance(channel, tuple):
        channel = "；".join(str(c) for c in channel)
    lines.append(f"          · 通知：{channel}")
    append_event(lines)


def handle_new(pid: int, info: dict) -> None:
    append_event([f"{now_str()}  START  ghostty pid={pid}  ({info.get('cmd', '').split('/')[-1]})"])


def prune_shell_beats(max_age_s: int = 86400) -> None:
    """清掉一天前的 shell 心跳（正常退出也会留一条 exit 记录，不清会一直堆）。"""
    cutoff = time.time() - max_age_s
    try:
        for f in SHELLS_DIR.glob("*.json"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
            except Exception:
                continue
    except Exception:
        pass


# ---------- 主循环 ----------

# 判「消失」前必须连续这么多轮都看不到（每轮 5 秒，3 轮 ≈ 15 秒）。
# 单轮抖动不再算数：2026-11-25 的两次误报都只出现在一轮里。
DISAPPEAR_CONFIRM_TICKS = 3


def rollback_false_death(pid: int, prev: dict) -> None:
    """撤销一次误判的「退出」：删掉对应的 pending，日志留一条更正。"""
    items = load_json(PENDING_FILE, [])
    if isinstance(items, list):
        kept = [ev for ev in items if ev.get("pid") != pid]
        if len(kept) != len(items):
            save_json(PENDING_FILE, kept)
    append_event([
        f"{now_str()}  WARN   误报更正：ghostty pid={pid} 仍在运行（启动时刻未变），"
        f"{prev.get('time', '?')} 那条 DIED 是进程扫描失败造成的误判，已撤销对应 pending"
    ])


def tick() -> None:
    ensure_dirs()
    prune_shell_beats()
    procs, scan_ok = scan_processes_checked()
    state = load_json(STATE_FILE, {})
    known: dict[str, dict] = state.get("pids") or {}
    baseline = bool(state.get("baseline"))
    misses: dict[str, int] = state.get("misses") or {}
    died: dict[str, dict] = state.get("died") or {}
    scan_broken = bool(state.get("scan_broken"))

    # 扫描这一轮不可信：既不判生也不判死，原样保留 state。只在状态翻转时记一条，
    # 不每 5 秒刷屏。
    if not scan_ok:
        if not scan_broken:
            append_event([f"{now_str()}  WARN   进程扫描失败（ps 无有效输出），本轮跳过判定"])
        state["scan_broken"] = True
        save_json(STATE_FILE, state)
        return
    if scan_broken:
        append_event([f"{now_str()}  META   进程扫描已恢复"])

    cur_pids = {str(p) for p in procs}

    # 消失的：连续多轮看不到 + 单独复核 + 判死后同 pid 复活即撤销
    for pid_s in list(known.keys()):
        if pid_s in cur_pids:
            misses.pop(pid_s, None)
            continue
        # 批量输出里没有它，再用 os.kill 单独确认一次（防止 ps 输出被截断）
        if pid_alive(int(pid_s)):
            misses.pop(pid_s, None)
            continue
        n = int(misses.get(pid_s) or 0) + 1
        if n < DISAPPEAR_CONFIRM_TICKS:
            misses[pid_s] = n
            continue
        misses.pop(pid_s, None)
        rec = known.pop(pid_s)
        died[pid_s] = {"lstart": rec.get("lstart") or "", "time": now_str()}
        try:
            handle_disappear(int(pid_s), rec)
        except Exception as e:
            append_event([f"{now_str()}  ERROR  处理 pid={pid_s} 失败: {e}"])

    # 新出现的（首轮只记基线，不造 START 噪声）
    for pid_s, info in procs.items():
        key = str(pid_s)
        started = pid_start(pid_s)
        prev_death = died.get(key)
        if prev_death is not None:
            died.pop(key, None)
            if prev_death.get("lstart") and started and prev_death["lstart"] == started:
                # 同一个进程（启动时刻一模一样）又出现了 = 刚才那条 DIED 是误报
                rollback_false_death(int(pid_s), prev_death)
                if key not in known:
                    known[key] = {
                        "first_seen": now_str(),
                        "peak_rss_kb": info["rss_kb"],
                        "children": scan_children(pid_s),
                        "cmd": info["cmd"],
                        "lstart": started,
                    }
                continue
        if key not in known:
            known[key] = {
                "first_seen": now_str(),
                "peak_rss_kb": info["rss_kb"],
                "children": scan_children(pid_s),
                "cmd": info["cmd"],
                "lstart": started,
            }
            if baseline:
                handle_new(int(pid_s), info)
        else:
            rec = known[key]
            rec["peak_rss_kb"] = max(rec.get("peak_rss_kb", 0), info["rss_kb"])
            rec["children"] = scan_children(pid_s)
            if started:
                rec["lstart"] = started

    state = {"pids": known, "baseline": True, "misses": misses, "died": died,
             "updated": now_str()}
    save_json(STATE_FILE, state)


def cmd_daemon() -> None:
    append_event([f"{now_str()}  META   ghostty-watch 启动"])
    while True:
        try:
            tick()
        except Exception as e:
            append_event([f"{now_str()}  ERROR  {e}"])
        time.sleep(5)


def cmd_status() -> None:
    procs = scan_processes()
    beats = shell_heartbeats()
    if not procs:
        print("没有在跑的 ghostty 进程。")
        return
    for pid, info in procs.items():
        print(f"ghostty pid={pid}  内存={round(info['rss_kb']/1024)}MB  运行={info['etime']}  {info['cmd']}")
        kids = scan_children(pid)
        print(f"  会话 {len(kids)} 个:")
        for k in kids:
            print(f"    pid={k['pid']:<7} {describe_session(k, beats)}")
    pending = load_json(PENDING_FILE, [])
    if pending:
        print(f"\n⚠️  有 {len(pending)} 条还没看过的终止事件：")
        for ev in pending:
            print(f"    {ev.get('time')}  {ev.get('reason')}")


def cmd_log(n: int = 20) -> None:
    if not EVENT_LOG.exists():
        print("(还没有事件)")
        return
    lines = EVENT_LOG.read_text(errors="replace").splitlines()
    print("\n".join(lines[-n:]))


def cmd_once() -> None:
    tick()
    cmd_status()


def main() -> None:
    args = sys.argv[1:]
    cmd = args[0] if args else "status"
    if cmd == "daemon":
        cmd_daemon()
    elif cmd == "once":
        cmd_once()
    elif cmd == "status":
        cmd_status()
    elif cmd == "log":
        n = 20
        if "-n" in args:
            try:
                n = int(args[args.index("-n") + 1])
            except Exception:
                pass
        cmd_log(n)
    elif cmd == "notify-test":
        print(notify("ghostty-watch 通知自检", "如果你看到这条，说明通知通路正常"))
    elif cmd == "feishu-test":
        print(_notify_feishu("ghostty-watch 飞书自检", "这条走飞书，手机应该能收到"))
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
