<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE.md)
[![Type](https://img.shields.io/badge/Type-App%20Configs-4B8BBE.svg)](#)

[简体中文](README_cn.md)

</div>

# apps — configs of the terminals every agent runs in

The apps that host agent sessions are infrastructure in their own right: if the terminal is
misconfigured, every agent running inside it is misconfigured too. Their configs are versioned
here, one directory per app.

**The live file in your home directory is the source of truth; the copy in this repository is
a mirror.** `~/.config/ghostty/config` and `~/.config/cmux/*` are plain files the apps read and
write directly — nothing is symlinked, so no app can silently break the link with an atomic
write. `apps/` in this repository is a snapshot you take after changing a setting, and the copy
you deploy from on a new machine.

Two apps today: **ghostty** (the terminal) and **cmux** (the terminal that runs agent panes).

## Where this lives

This directory is part of [agents-infra](../README.md), which has two halves with two
different maintenance models:

| Path | Source of truth | How the mirror is produced |
|---|---|---|
| `pi/agent/` | `~/.pi/agent/` | `patch/agents-infra-publish/publish.py`, on the authoring MacBook only |
| `apps/` | `~/.config/…` (this machine) | `apps/publish.sh`, run by hand after changing a setting |

Neither half is edited in place: you change the live thing, then publish the mirror.

## Three scripts, three directions

| Command | Direction | When |
|---|---|---|
| `./install.sh` | mirror → system | On a **new machine**: copy every file from `mappings.conf` into place, write back the UserDefaults snapshot, reload cmux |
| `./publish.sh` | system → mirror | After **changing a setting**: collect the live files into the repo, refresh the snapshot, run the secret gate |
| `./check.sh` | compares both | Any time: report missing files, leftover symlinks, and configs changed on disk but not yet published |

## Layout

```
apps/
├── mappings.conf           # mirror path → system path map (install / publish / check share it)
├── ghostty/                # App: the Ghostty terminal
│   ├── README.md           #   this directory's config is read by Ghostty only, see below
│   └── config              #   mirror of ~/.config/ghostty/config
├── cmux/                   # App: the cmux terminal
│   ├── README.md           #   ⚠️ since r21 cmux reads only its own terminal config, see below
│   ├── cmux.json           #   mirror of ~/.config/cmux/cmux.json
│   ├── config.ghostty      #   mirror of ~/.config/cmux/config.ghostty
│   └── defaults.plist      #   whitelisted UserDefaults snapshot (not a live file)
├── install.sh              # new machine: deploy the mirror
├── publish.sh              # after a change: collect the live files into the mirror
├── check.sh                # compare mirror ↔ system
└── scripts/                # export / apply helpers for the UserDefaults snapshot, secret gate
```

## Who reads which file (important)

Each config exists once as a live file on the machine; this table records who reads it —
**whenever that changes, update this table and the directory README in the same change**.

| System file (authoritative) | Mirror in this repo | Read by | Notes |
|---|---|---|---|
| `~/.config/ghostty/config` | `ghostty/config` | **Ghostty only** | Terminal settings for Ghostty (theme, fonts, size, cursor, window geometry, Quick Terminal hotkey) |
| `~/.config/cmux/config.ghostty` | `cmux/config.ghostty` | **cmux only** | cmux's own terminal config in Ghostty syntax — "Ghostty format" does not mean "Ghostty reads it". Since cmux v0.65.2.2-r21 cmux no longer reads `ghostty/config`; this file alone drives its look |
| `~/.config/cmux/cmux.json` | `cmux/cmux.json` | **cmux only** | App-level settings; the settings UI reads and writes it |
| the `com.cmuxterm.app` UserDefaults domain | `cmux/defaults.plist` | **cmux only** | Whitelisted preference snapshot; written back by `install.sh` |

In one line: **no config file is shared between apps today.** cmux and Ghostty were fully
decoupled in cmux v0.65.2.2-r21 (upstream Issue #70), so a look shared by both terminals has to
be written twice, once per file.

## Restoring on a new machine

```bash
git clone https://github.com/xhqing/agents-infra.git ~/Developer/agents-infra
cd ~/Developer/agents-infra/apps
./install.sh          # copy configs into place + UserDefaults write-back + cmux reload-config
```

Notes:

- `install.sh` renames any existing file that differs from the mirror to `xxx.bak.<timestamp>`,
  so nothing is lost; files that already match are left alone.
- It does not create symlinks. If it finds one (an older setup left it behind), it replaces it
  with a regular file.
- Ghostty does not need to be installed first: since cmux v0.65.2.2-r21 cmux reads only its own
  `~/.config/cmux/config.ghostty` and no longer depends on `~/.config/ghostty/config`.
- If cmux is already running afterwards, run `cmux reload-config` once.

## Day-to-day maintenance

| What changed | How it reaches the repo |
|---|---|
| Ghostty terminal settings (font, theme, cursor…) | Edit `~/.config/ghostty/config` → `./publish.sh` → commit |
| cmux terminal settings (font, theme, cursor…) | Edit `~/.config/cmux/config.ghostty` → `cmux reload-config` → `./publish.sh` → commit. To keep both terminals identical, write the same value in both files |
| Terminal options touched in the cmux settings UI | They land in `~/.config/cmux/config.ghostty` → `./publish.sh` |
| Preferences in cmux.json / the UI | `./publish.sh` → commit |

When unsure, run `./check.sh`: a file that differs from the mirror means the machine was
changed and the repo has not been updated yet.

## Adding a new app

1. Create a directory named after the app (short, lowercase);
2. Put the mirror copy of its config in it;
3. Add a line to `mappings.conf`: `mirror path <TAB> system path <TAB> mode or - <TAB> note`;
4. Write a `README.md` in that directory: what the config is, who reads it, **and whether any other app reads it too**;
5. If several apps really do share one file, update the "Who reads which file" table above;
6. `./publish.sh` → `./check.sh` all green → `./install.sh` on the next machine, then commit.

## Why a mirror instead of symlinks

An earlier version of this setup symlinked `~/.config/...` into the repository, so there was
exactly one copy. That works until an app writes atomically — many electron/Swift apps write a
temp file and rename it over the target, which silently replaces the symlink with a regular
file; the repository then stops tracking anything, and `git status` says nothing.

Keeping the live file as a plain file in its native location removes that failure mode
entirely: apps see exactly what they expect, and the repo holds a snapshot plus a one-command
way to publish or redeploy it. The cost is a manual `./publish.sh` after each change — and
`./check.sh` tells you when you forgot.

## What is and isn't backed up

**Mirrored (configuration)**: `ghostty/config`, `cmux/cmux.json`, `cmux/config.ghostty`, and
the whitelisted `cmux/defaults.plist` entries (appearance mode, sidebar style, right panel
mode, file explorer width, and so on).

**Deliberately excluded**: login credentials and keychain tokens, telemetry / install IDs,
session and workspace snapshots, scrollback, agent journals, browser history, window positions,
and configs of other tools (add a directory when needed).

`publish.sh` runs `scripts/check-secrets.py` **before** copying anything into the repo: any
non-empty `password` / `token` / `secret` / `apiKey` field (including `cmux.json`'s
`socketPassword`) aborts the publish. Placeholders and empty values pass.

## Known gotchas

- **Chinese text weight**: both `ghostty/config` and `cmux/config.ghostty` declare
  `font-family = Menlo` followed by `font-family = PingFang SC`; neither line may be removed.
  Without an explicit font-family fallback chain, cmux injects a CJK codepoint map that pins
  Chinese to `PingFang SC Regular` — one weight lighter than Ghostty. Declaring the chain
  suppresses the injection. See `ghostty/README.md` and `cmux/README.md`.
- **Permissions**: `cmux.json` may hold the control socket password, so `mappings.conf` keeps it
  at 600 — `install.sh` applies that mode to the live file, and the mirror copy inherits it.
- **Don't write from two machines at once**: run git write operations on one machine at a
  time, or commits and branches will drift apart.
- **cmux upgrades** may migrate the `cmux.json` `schemaVersion`, and may change which config
  paths cmux reads. After an upgrade, run `./check.sh` to confirm nothing drifted, and
  `cmux config paths` — the line "Related (cmux's own Ghostty-format terminal config)" must
  still be `~/.config/cmux/config.ghostty`.

## License & Attribution

Part of [agents-infra](https://github.com/xhqing/agents-infra), released under the
[MIT License](../LICENSE.md).

Copyright (c) 2026 xhqing and contributors.
