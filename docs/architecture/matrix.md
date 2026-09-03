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
`system.rehydrate` includes a `matrix` snapshot.

Sync is unidirectional (server → client) using
`GET /api/collections/sync/manifest?with_abstract=1&with_bibtex=1&with_images=1`,
`GET /api/collections/assets/{id}/md`, and
`GET /api/collections/sync/images/{id}` (ZIP of MinerU `images/`). The Agent does
not call Paper Matrix.

## Local library

Default agent directory is `~/.MatrixAgent`, isolated from the Pi CLI's
`~/.pi/agent`. Leftover Desktop settings that still point at the CLI directory
are rewritten silently: Matrix Agent forgets that agent dir and any workspaces
recorded while sharing it, then first-run uses the Matrix library instead of a
Pi CLI project. The Host child does not inherit `PI_CODING_AGENT_SESSION_DIR`,
`PI_CODING_AGENT`, or `PI_PACKAGE_DIR`. The default library root is
`<agentDir>/library` (`~/.MatrixAgent/library`). A previous Windows default at
`<installDir>/library` is relocated there so uninstalling the app does not
delete papers. The Windows app identity is `online.papermatrix.matrix-agent` /
`PaperMatrix.exe`. Uninstall never removes `%USERPROFILE%\.pi`, leftover
`com.skitre.pideck` AppData, or other PiDeck-named files. Checking Delete
application data removes `%USERPROFILE%\.MatrixAgent` plus this app's Tauri
bundle folders under AppData. First-run Desktop workspaces use the Matrix
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

## Auth

Host persists `{ user, token, issuedAt, rememberPassword }` at
`<agentDir>/matrix-auth.json` (mode `0600`). Passwords never enter that
file. When the user opts in, Desktop stores the password in the OS keychain
(`secrets_set`, service `matrix-agent`). A 401 during sync sets
`authRequired`; Desktop performs one silent re-login if a stored password
exists.

Override the API origin in tests with `PIDECK_MATRIX_BASE_URL`.
