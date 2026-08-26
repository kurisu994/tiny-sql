# tiny-sql

[简体中文](./README.md) · English

> A bastion-host-friendly MySQL / PostgreSQL / SQLite desktop client — turning the SSH jump chain from "a pipe in the fog" into an observable router.

[![CI](https://github.com/kurisu994/tiny-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/kurisu994/tiny-sql/actions/workflows/ci.yml)

**Status: the latest stable GitHub Release is v0.7.0; `main` has cut `v0.8.0-rc1` (incl. the SQLite driver), pending GUI/RC acceptance before the stable cut.** GitHub Actions publishes installers for macOS (Apple Silicon / Intel), Windows x64, and Linux x64, plus signed update packages; stable releases also ship four-platform `latest.json`. See [CHANGELOG.md](./CHANGELOG.md) and [docs/ROADMAP.md](./docs/ROADMAP.md).

## Why another SQL client

Mainstream SQL desktop clients (DBeaver / TablePlus / Navicat / DataGrip) almost all treat SSH tunneling as a pipe in the fog — **a single hop, a black box, and when something breaks you have no idea which hop failed**. Yet in production, multi-level bastion hosts (bastion → internal bastion → business jump host → MySQL) are the norm.

tiny-sql makes every hop a first-class citizen in the UI:

- **Native multi-hop SSH** — no hand-rolled `ssh -L` chains or `~/.ssh/config` hacking
- **Visualized jump-host topology** — the failing hop is highlighted when a connection breaks
- **Keepalive-aware disconnects** — if any hop of the tunnel dies, the UI is notified within 180s
- Pure Rust async SSH (russh), cross-platform with no dependency on system `ssh` / `sshpass`

Built for personal use, usable by colleagues, and open source. Free of charge, no telemetry, business data stays local; auto-update only fetches the stable release manifest from GitHub Releases.

## Current capabilities

**Connection & SSH**

- N-hop SSH: password / private-key authentication, per-session passphrase caching (optional encrypted persistence), TOFU host key verification, and hard rejection on fingerprint changes.
- Visualized topology: local machine → N hops → database, showing per-hop `pending / connected / failed / lost` status and cumulative protocol RTT; keepalive detects disconnects within ~180s by default, with manual idempotent reconnect.

**Database**

- Three drivers: MySQL (5.7 / 8.0 / 8.4), PostgreSQL and SQLite, with per-connection dialect switching in the editor.
- SQLite opens a local `.db` file directly: no host, no account, and no SSH tunnel involved.
- Metadata tree: databases / schemas / tables / columns / indexes / constraints loaded on demand, plus object search.
- Data browsing: server-side filtering / sorting / pagination (no full-table pulls), capped at 100,000 rows.

**SQL editor**

- CodeMirror with per-driver dialect highlighting (MySQL / PostgreSQL / SQLite), schema-aware completion, multi-statement execution and formatting; write-operation confirmation; cancellation via an independent control pool for network drivers (SQLite uses its native progress handler).
- Reliable transactions: `BEGIN` / `COMMIT` / `ROLLBACK` on an exclusive session.
- SQL file open / save / recent files; SQL history (last 100 entries, encrypted at rest).

**Data workflows**

- Query result export to CSV / Excel (streamed server-side, distinguishing SQL NULL from empty strings).
- Safe table editing: primary-key single tables only, dirty staging + single-transaction batch commit.
- Structure view / DDL preview / create and alter table / index designer.
- CSV import + SQL dump import/export; official mysqldump/pg_dump/sqlite3 backup (local tools required).
- Encrypted connection sharing; two-connection schema diff and reviewable sync SQL; read-only ER diagram.
- Same-dialect table copy (append or truncate-then-insert; target name must be typed); MySQL privilege preview (PostgreSQL roles are read-only); EXPLAIN plan tree (ANALYZE requires confirmation).
- Per-connection app-level read-only switch and env tags; clone table in the same database; cell inspector with FK jump; previewable RENAME COLUMN for non-PK columns.

**Security & distribution**

- Connection profiles encrypted at rest (AES-GCM); optional master password (Argon2id) with lock / reset.
- Cross-platform packaging + stable auto-update (RC / beta / alpha are never update sources).

## Tech stack

| Layer | Choice |
|---|---|
| Desktop framework | Tauri 2.x |
| Frontend | Next.js 16 (Turbopack) + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui |
| Backend | Rust (Edition 2021, MSRV 1.77.2) + Tokio |
| SSH tunneling | russh 0.54 (N hops, pure Rust async) |
| Database | sqlx 0.8 (MySQL + PostgreSQL + SQLite, SQLite statically bundled) |

See [CHANGELOG.md](./CHANGELOG.md) for the full change history.

## Development setup

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [pnpm](https://pnpm.io/) 11+
- [Rust](https://rustup.rs/) (MSRV 1.77.2)
- [just](https://github.com/casey/just) (command runner)
- Tauri 2 system dependencies (see the [official Tauri docs](https://v2.tauri.app/start/prerequisites/))

### Install & develop

```bash
just install      # pnpm install + cargo fetch
just dev          # start the full Tauri dev environment (frontend + backend hot reload)
just dev-web      # start only the Next.js frontend (localhost:3000)
```

### Build

```bash
just build        # production build (desktop app, produces .dmg / .app)
just build-web    # build only the frontend (static export to out/)
```

## Common commands

| Command | Description |
|---|---|
| `just dev` | Start Tauri dev mode (frontend + backend hot reload) |
| `just dev-web` | Start only the Next.js frontend |
| `just build` | Production build of the desktop app |
| `just build-web` | Build only the frontend assets |
| `just build-debug` | Build a Debug version (with debug symbols) |
| `just check` | One-shot pre-commit self-check (fmt check + clippy + tests + frontend build, aligned with CI) |
| `just lint` | Full code checks (tsc + Clippy) |
| `just lint-rust` | Rust checks only (Clippy) |
| `just lint-web` | Frontend type check only (tsc) |
| `just fmt` | Format Rust code |
| `just fmt-check` | Check formatting without modifying files (used by CI) |
| `just test` | Rust workspace + frontend Vitest unit tests |
| `just test-integration` | Integration tests (against a local MySQL / PostgreSQL; requires `TINY_SQL_TEST_MYSQL_URL` and `TINY_SQL_TEST_POSTGRES_URL` in `.env`, see `.env.example`). SQLite runs on throwaway temp files and is already part of `just test`. |
| `just version <ver>` | Sync the version number across config files (e.g. `just version 0.4.0`) |
| `just release <tag>` | 🚀 One-command release: bump version + commit + tag + push to trigger the cloud build (e.g. `just release v0.4.0`) |
| `just clean` | Clean build artifacts |

## Project structure

```
crates/                     # Rust workspace members (decoupled from Tauri, publishable independently in the future)
├── ssh-multihop/           # N-hop SSH tunneling (russh, Tauri-free)
└── db-driver/              # database driver (object-safe Driver contract + MySQL/PostgreSQL/SQLite impls)

src-tauri/                  # Tauri shell
├── src/
│   ├── lib.rs              # Tauri entry + commands
│   └── main.rs
├── capabilities/           # permission configuration
└── tauri.conf.json

src/                        # frontend source (Next.js App Router)
├── app/                    # layout / page / globals.css
├── components/             # business components (connection form / schema tree / SQL editor / topology graph, etc.)
├── lib/                    # tauri-api / ddl / connection-meta / clone-table / cell-inspect / explain
├── stores/                 # zustand (connection / security / session / confirm)
└── hooks/                  # use-update-checker / use-column-widths

docs/                       # project documentation
├── REQUIREMENTS.md         # requirements
├── PLAN.md                 # remaining work only
├── ARCHITECTURE.md         # architecture
└── ROADMAP.md              # roadmap

CHANGELOG.md                # changelog
justfile                    # project command entry point
```

## Installation

> Download the current stable release from [v0.7.0 Release](https://github.com/kurisu994/tiny-sql/releases/tag/v0.7.0) (assets appear after the cloud build finishes).

v0.7.0 provides `.dmg` for **macOS (Apple Silicon + Intel)**, `.exe` for **Windows x64**, and `.AppImage` for **Linux x64**.

`v0.8.0-rc1` has been published as a prerelease (incl. SQLite support); it requires manual download until the stable cut.

Stable releases ship with `latest.json` and signed update packages on GitHub Releases; in-app auto-update only follows the latest stable release on GitHub. `v*-rc*`, beta, and alpha pre-releases still require manual download and verification.

### First launch on macOS

The app is not yet signed or notarized with an Apple Developer certificate. After installing the `.dmg`, right-click `tiny-sql.app` in Finder and choose "Open", then confirm in the system dialog.

If you still see **"damaged and can't be opened"**, run in a terminal:

```bash
xattr -cr /Applications/tiny-sql.app
```

Then open the app again.

## v0.1 acceptance scope (historical)

The following scenarios document v0.1's everyday multi-hop MySQL query regression checks (accepted with the v0.1 release).

### Must-verify scenarios

- Real 3-hop SSH + MySQL connection: databases / tables can be listed after connecting.
- TOFU: prompt on first unknown host; silent for trusted hosts; hard rejection on fingerprint changes.
- Passphrase: after entering it once for a private key, it is reused within the same session and required again after quitting the app.
- Table browsing: clicking a table shows its first 1000 rows with smooth scrolling.
- SQL execution: covers SELECT / JOIN / aggregation / truncation hints for large tables without LIMIT.
- SQL cancellation: cancel a running `SELECT SLEEP(60)`; the UI stops waiting and the query disappears from `SHOW PROCESSLIST`.
- Topology status: after deliberately killing an intermediate hop, the corresponding hop turns `lost` within 180s.
- MySQL 5.7: at least one colleague verifies connection and SELECT on a 5.7 environment.

Do not commit trial records to the public repository. The repo provides a [dogfooding log template](./docs/dogfooding-log.template.md); the actual log file `docs/dogfooding-log.md` is ignored via `.gitignore`.

## Documentation

- [简体中文 README](./README.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Requirements](./docs/REQUIREMENTS.md)
- [Development plan](./docs/PLAN.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Roadmap](./docs/ROADMAP.md)
- [Release checklist](./docs/RELEASE_CHECKLIST.md)

## FAQ

**Does tiny-sql collect any telemetry?**
No. There is no telemetry at all; business data stays local. The app only contacts GitHub Releases to check for stable updates.

**Do I need the system `ssh` binary for multi-hop tunnels?**
No. SSH is implemented in pure Rust with russh, so no system `ssh` / `sshpass` is required on any platform.

**Where are my connection credentials stored?**
Connection profiles are stored locally, with sensitive fields encrypted at rest (AES-256-GCM). An optional master password (Argon2id-derived key) can additionally protect credentials.

## License

MIT
