# Paper Matrix

PiDeck hosts a **Matrix Agent** literature layer on top of the existing coding
runtime. Paper Matrix is the remote collection store; the Host keeps a local
Markdown library and never puts JWT material into the Agent context.

## Ownership

| Concern | Owner |
|---|---|
| Login, token file, sync, catalog | Host `packages/pi-host/src/matrix/` |
| OS keychain for optional remembered password | Rust `secrets_*` commands + Desktop |
| Account / sync UI | Desktop Settings → Paper Matrix |
| Academic workflows | Seeded `SYSTEM.md`, `AGENTS.md`, bundled skills, and prompts |

Selecting a Workspace still does not load `<workspace>/.pi` packages.

Host copies bundled skills from `packages/pi-host/resources/skills` into
`~/.MatrixAgent/skills` on first run. Existing skill folders are left alone.
Skills are rewritten to use the local catalog; downloaders, cron/Feishu pipelines,
and image-to-PPT tools are not seeded.

## Protocol

Host-scoped methods:

- `matrix.getStatus` / `matrix.login` / `matrix.logout`
- `matrix.syncNow`
- `matrix.getSettings` / `matrix.patchSettings`

Events: `matrix.statusChanged` (latest-wins) and `matrix.progress` (latest-wins).
`system.rehydrate` includes a `matrix` snapshot. Scheduled syncs default to
every 3 hours, never faster than hourly and never slower than once a day.

Sync is unidirectional (server → client) using
`GET /api/collections/sync/manifest?with_abstract=1&with_bibtex=1&with_images=1`,
`GET /api/collections/assets/{id}/md`, and
`GET /api/collections/sync/images/{id}` (ZIP of MinerU `images/`). The Agent does
not call Paper Matrix.

## Local library

On Windows release installs the default agent directory is `<installDir>\agent`,
next to the installed executable (the installer is per-user, so the directory is
writable without elevation). Development builds and installs whose directory is
not writable fall back to `~/.MatrixAgent`; an existing `~/.MatrixAgent` is
moved into the install-directory agent dir once on first launch, and recorded
workspaces follow the move. The same adoption covers the `agent\` directory an
uninstalled previous install left behind: when the active workspace still names
`<oldInstall>\agent\library`, that agent dir (sessions, credentials, library)
is moved into the current install's agent dir. If the target agent dir already
exists, it is only taken over when it is a contentless stub (freshly-seeded
library, no sessions, no credentials) left by a brief trial install that was
uninstalled; when both sides hold real data nothing is moved. Recorded
workspaces that name a previous default library which no longer exists on disk
are dropped at startup so reinstalling to a new directory never accumulates
duplicate `library` entries in the workspace list. The agent directory stays
isolated from the Pi CLI's `~/.pi/agent`. Leftover Desktop settings that still
point at the CLI directory are rewritten silently: Matrix Agent forgets that
agent dir and any workspaces recorded while sharing it, then first-run uses the
Matrix library instead of a Pi CLI project. The Host child does not inherit
`PI_*` environment variables (they are scrubbed, then `PI_CODING_AGENT_DIR` is
pinned to the agent dir). The default library root is `<agentDir>/library`. A
previous Windows default at `<installDir>/library` is relocated into the agent
dir so upgrades keep papers. The Windows app identity is
`online.papermatrix.matrix-agent` / `PaperMatrix.exe`. Uninstall never removes
`%USERPROFILE%\.pi`, leftover `com.skitre.pideck` AppData, or other
PiDeck-named files; the agent data directory is removed by uninstall only when
the user checks Delete application data (it also covers the legacy
`%USERPROFILE%\.MatrixAgent`). First-run Desktop workspaces use the Matrix
library. Custom `knownWorkspaces` that are not under `~/.pi/agent` are left
alone when the agent dir is already isolated.

Layout: collection folders of Markdown papers, a sibling `images/` directory for
parsed figures, per-collection `<folder>.bib` files at the library root,
`notes/`, `reviews/`, and `.sync/{state.json,index.json,catalog.md,trash/}`.
Manifest requests use `with_abstract=1&with_bibtex=1&with_images=1`. Image zips
are fetched only when `md_updated_at` changes and the manifest lists files.
Synced paper bodies are server-authoritative; local edits are not overwritten
and the incoming copy is written under `reviews/conflicts/`. A paper whose body
vanished on disk while its sync state said current is refetched on the next run,
and manifest items with duplicate `dedup_key` values are processed once (first
wins) so a server-side duplicate cannot clobber another paper's state.

Sync progress and failure handling follow the library-sync protocol (§6.3):
- `.sync/state.json` is the diff baseline and is checkpointed atomically
  (fsync'd) after every settled paper, so a crash or a permanently failing
  paper can never re-trigger a full-library refetch; skipped papers keep an
  unsynced baseline and retry exactly themselves next round.
- A paper that fails after two in-round retries is skipped, not fatal; three
  consecutive failures put it on a per-paper backoff (skip ~1 round, then ~3
  rounds, then at most one attempt per 30 minutes) until it succeeds.
- A 0-byte Markdown and an empty (or empty-bodied) images archive are valid
  server data and advance the baseline; only HTTP errors or corrupt ZIPs are
  treated as failures.
- Only one sync round runs at a time (concurrent triggers merge into the
  running round), and progress counts only papers that actually needed
  downloading in the current round.

## Auth

Host persists `{ user, token, issuedAt, rememberPassword }` at
`<agentDir>/matrix-auth.json` (mode `0600`). Passwords never enter that
file. When the user opts in, Desktop stores the password in the OS keychain
(`secrets_set`, service `matrix-agent`). A 401 during sync sets
`authRequired`; Desktop performs one silent re-login if a stored password
exists.

Override the API origin in tests with `PIDECK_MATRIX_BASE_URL`.
