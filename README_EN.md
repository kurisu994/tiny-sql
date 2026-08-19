# tiny-sql

[简体中文](./README.md) · English

> A bastion-host-friendly MySQL desktop client — turning the SSH jump chain from "a pipe in the fog" into an observable router.

[![CI](https://github.com/kurisu994/tiny-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/kurisu994/tiny-sql/actions/workflows/ci.yml)

**Status: v0.1.0 was officially released on 2026-08-18.** GitHub Actions publishes installers for macOS (Apple Silicon / Intel), Windows x64, and Linux x64, along with signed update packages and `latest.json` manifests for all four platforms. For known limitations and future plans, see [docs/PLAN.md](./docs/PLAN.md) and [docs/ROADMAP.md](./docs/ROADMAP.md).

## Why another SQL client

Mainstream SQL desktop clients (DBeaver / TablePlus / Navicat / DataGrip) almost all treat SSH tunneling as a pipe in the fog — **a single hop, a black box, and when something breaks you have no idea which hop failed**. Yet in production, multi-level bastion hosts (bastion → internal bastion → business jump host → MySQL) are the norm.

tiny-sql makes every hop a first-class citizen in the UI:

- **Native multi-hop SSH** — no hand-rolled `ssh -L` chains or `~/.ssh/config` hacking
- **Visualized jump-host topology** — the failing hop is highlighted when a connection breaks
- **Keepalive-aware disconnects** — if any hop of the tunnel dies, the UI is notified within 180s
- Pure Rust async SSH (russh), cross-platform with no dependency on system `ssh` / `sshpass`

Built for personal use, usable by colleagues, and open source. Free of charge, no telemetry, business data stays local; auto-update only fetches the stable release manifest from GitHub Releases.

## Current capabilities (v0.1)

- N-hop SSH configuration and connection: password / private-key authentication, per-session passphrase caching, TOFU host key verification, and hard rejection on fingerprint changes.
- MySQL SSL/TLS configuration: disabled by default; you can explicitly choose Preferred / Required / Verify CA / Verify Identity and provide CA, client certificate, and private key paths. Acceptance against a real TLS server is not complete yet.
- MySQL data browsing: list databases / tables, click a table to browse its first 1000 rows. (The `db_list_columns` backend is implemented; the column-list UI is deferred to v0.2.)
- SQL execution: a CodeMirror SQL editor with syntax highlighting, line numbers, basic schema/table completion, and quick execution. The backend rejects empty SQL / multiple statements, automatically appends `LIMIT` when a top-level `SELECT` / `WITH` is safe, and caps results at 100,000 rows.
- SQL cancellation: records the MySQL `CONNECTION_ID()` at execution time and issues `KILL QUERY` through an independent control pool on cancel.
- Topology status: a read-only topology graph from local machine → N hops → MySQL, supporting `pending` / `connected` / `failed` / `lost`.
- Cross-platform packaging: a GitHub Release workflow triggered by `v*` tags produces macOS Apple Silicon + Intel `.dmg`, Windows x64 `.exe`, and Linux x64 `.AppImage`; stable releases also publish the Tauri auto-update manifest.
- Auto-update: the desktop app checks for stable updates once a day after launch and can also check manually from the macOS app menu; RC / beta / alpha builds are never used as update sources.

## Coming in v0.2 (unreleased)

- PostgreSQL support: browse schemas, tables, and columns of the connected database; execute, rate-limit, and cancel SQL, with per-connection MySQL/PostgreSQL dialect completion in the editor.
- Master-password encryption for stored connection credentials.
- SQL history and multiple query tabs.
- CSV / Excel export for query results.
- Resizable result columns (drag to adjust width).
- Per-hop SSH topology with low-frequency protocol RTT sampling and timeout status.

See [CHANGELOG.md](./CHANGELOG.md) (`[Unreleased]`) for the full list.

## Tech stack

| Layer | Choice |
|---|---|
| Desktop framework | Tauri 2.x |
| Frontend | Next.js 16 (Turbopack) + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui |
| Backend | Rust (Edition 2021, MSRV 1.77.2) + Tokio |
| SSH tunneling | russh 0.54 (N hops, pure Rust async) |
| Database | sqlx 0.8 (MySQL; PostgreSQL added in v0.2) |

> PostgreSQL, real-world MySQL TLS acceptance and certificate UX polish, SQL history, export, and schema-aware smart completion are all planned for v0.2 and beyond. See the [ROADMAP](./docs/ROADMAP.md) for details.

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
| `just test-integration` | Integration tests (against a local MySQL; requires `TINY_SQL_TEST_MYSQL_URL` in `.env`, see `.env.example`) |
| `just version <ver>` | Sync the version number across config files (e.g. `just version 0.2.0`) |
| `just release <tag>` | 🚀 One-command release: bump version + commit + tag + push to trigger the cloud build (e.g. `just release v0.1.0`) |
| `just clean` | Clean build artifacts |

## Project structure

```
crates/                     # Rust workspace members (decoupled from Tauri, publishable independently in the future)
├── ssh-multihop/           # N-hop SSH tunneling (russh, Tauri-free)
└── db-driver/              # MySQL driver (concrete struct in v0.1, extract trait in v0.2)

src-tauri/                  # Tauri shell
├── src/
│   ├── lib.rs              # Tauri entry + commands
│   └── main.rs
├── capabilities/           # permission configuration
└── tauri.conf.json

src/                        # frontend source (Next.js App Router)
├── app/                    # layout / page / globals.css
├── components/             # business components (connection form / schema tree / SQL editor / topology graph, etc.)
├── lib/                    # utilities (tauri-api / sql-guard / sql-editor)
├── stores/                 # zustand stores (connection / session / confirm)
└── hooks/                  # React hooks (use-update-checker)

docs/                       # project documentation
├── REQUIREMENTS.md         # requirements
├── PLAN.md                 # development plan (weekly)
├── ARCHITECTURE.md         # architecture (data flow / state machines / error model)
└── ROADMAP.md              # roadmap (v0.1 / v0.2 / v0.3-v0.5+)

CHANGELOG.md                # changelog
justfile                    # project command entry point
```

## Installation

> Download the current stable release from [v0.1.0 Release](https://github.com/kurisu994/tiny-sql/releases/tag/v0.1.0).

v0.1.0 provides `.dmg` for **macOS (Apple Silicon + Intel)**, `.exe` for **Windows x64**, and `.AppImage` for **Linux x64**.

Stable releases ship with `latest.json` and signed update packages on GitHub Releases; in-app auto-update only follows the latest stable release on GitHub. `v*-rc*`, beta, and alpha pre-releases still require manual download and verification.

### First launch on macOS

v0.1 is not yet signed or notarized with an Apple Developer certificate. After installing the `.dmg`, right-click `tiny-sql.app` in Finder and choose "Open", then confirm in the system dialog.

If you still see **"damaged and can't be opened"**, run in a terminal:

```bash
xattr -cr /Applications/tiny-sql.app
```

Then open the app again.

## v0.1 acceptance scope

The following scenarios continuously regress v0.1's everyday multi-hop MySQL query capabilities.

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

- [Requirements](./docs/REQUIREMENTS.md)
- [Development plan](./docs/PLAN.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Roadmap](./docs/ROADMAP.md)
- [v0.1 release checklist](./docs/RELEASE_CHECKLIST.md)

## FAQ

**Does tiny-sql collect any telemetry?**
No. There is no telemetry at all; business data stays local. The app only contacts GitHub Releases to check for stable updates.

**Do I need the system `ssh` binary for multi-hop tunnels?**
No. SSH is implemented in pure Rust with russh, so no system `ssh` / `sshpass` is required on any platform.

**Where are my connection credentials stored?**
Connection profiles are stored locally, with sensitive fields encrypted at rest. A master password for credential encryption is being added in v0.2.

## License

MIT
