# AGENT.md — Matrix Agent 工程约束（AI 代理必读）

本文件是 AI 编码代理在本仓库工作时的约束与须知。深度背景按顺序阅读
`docs/README.md` 的 Suggested reading order，功能 → 源码映射见
`docs/architecture/source-map.md`。发布细节另见
`docs/operations/release.md`。

远端仓库：https://github.com/Theonx5/MatrixAgent

## 1. 项目概览

PaperMatrix / Matrix Agent 是基于 [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
的 Tauri 2 桌面学术助手，版本 0.2.3，MIT 许可。三个模块分层明确：

| 模块 | 技术栈 | 职责 |
| --- | --- | --- |
| `packages/protocol` | TypeScript | Rust / Host / UI 三进程间的类型化协议（方法、事件、校验） |
| `packages/pi-host` | Node sidecar | 业务逻辑层：Pi SDK、会话/包/Provider，以及 Paper Matrix 文献库同步 |
| `apps/desktop` | React 19 + Vite + Tauri 2 (Rust) | 界面与桌面宿主 |

默认用户数据在 `~/.MatrixAgent`。默认文献库是 `~/.MatrixAgent/library`。
Windows 安装身份是 `online.papermatrix.matrix-agent` / `PaperMatrix.exe`。
卸载不会删除 Pi CLI 的 `~/.pi`，也不会删除 pideck 命名的文件。不要指向 `~/.pi/agent`。

## 2. 本机环境

- Windows 11 x64；Node ≥22.19.0（`.node-version` 为 24.18.0）。
- pnpm **必须 9.15.0**（corepack 已激活）。禁止升级 pnpm。
- Rust `x86_64-pc-windows-msvc`。bash 中需
  `export PATH="/c/Users/Administrator/.cargo/bin:$PATH"`。
- 本机 rustup 经常下不了 `rustfmt` / `clippy`。这两种检查以 GitHub Actions
  的 Windows job 为准，改 Rust 后必须等 CI `lint:rust`。
- 本机 DNS 访问 github.com 不稳定时，SSH 使用 `~/.ssh/config` 里的
  `HostName` IPv4 + `HostKeyAlias github.com`。

## 3. 常用命令

```bash
pnpm install --frozen-lockfile
pnpm dev:fast
pnpm --filter @pideck/desktop run tauri:dev
pnpm build
pnpm format:changed          # 提交前格式化变更文件
pnpm verify:quick            # docs / fixtures / 元数据 / lint / 类型 / 测试
pnpm verify:p0               # verify:quick + 构建 + Rust 测试 + clippy/fmt
```

不要把 `pnpm package:release` 当正式发布。安装包只由 GitHub Actions 打。

## 4. 硬约束（违反即返工）

1. **三端协议一致性**：新增/修改方法或事件必须同时改 `packages/protocol`、
   `packages/pi-host`、`apps/desktop`，并通过 `protocol-coverage.test.ts` 与
   `validate.test.ts`。协议文档 `docs/architecture/protocol.md` 同步更新。
2. **安全边界**：只从 `~/.MatrixAgent` 加载用户级 Package，不继承本机
   `~/.pi/agent`；打开工作区不得执行 `<workspace>/.pi/extensions`
   （`SettingsManager` 固定 `projectTrusted: false`）。
3. **用户数据不入库**：`~/.MatrixAgent` 下的凭据、设置、会话绝不提交；
   更新签名私钥 `apps/desktop/src-tauri/.tauri-updater.key`、`.env`、`*.pfx`
   绝不提交。测试使用
   `packages/pi-host/src/test-helpers/temp-agent.ts`。
4. **SDK 补丁**：`@earendil-works/pi-coding-agent@0.84.4` 带 dist 补丁
   （`patches/`），升级必须重评补丁并更新 `docs/operations/`。
5. **文档同改**：落地行为变更必须同一个提交内更新 `docs/`（文档为英文）。
6. **i18n 双语同步**：`apps/desktop/src/lib/i18n/en.ts` 与 `zh.ts` 必须同步。
7. **测试随行**：新功能/修复带 colocated vitest；不许删测试来让构建通过。
8. **路径与 Host 数据**：Host 数据在 `agentDir` 根下
   （`migration-backups/`、`session-archive/`、`library/`），不要再写
   `agentDir/pideck/...`。
9. **Windows 覆盖文件**：替换已有文件时按 `credential-store.ts` 的方式处理
   `EPERM`（unlink 重试，必要时 `copyFile`），不要假设 `rename` 能覆盖。

## 5. 提交规范

- 门槛：`pnpm format:changed` + `pnpm verify:quick`。改了
  `apps/desktop/src-tauri` 还要意识到本机可能跑不了 `pnpm lint:rust`，
  推送后看 Windows CI。
- 提交信息用简洁祈使句。
- 主分支 `main`。推送到 `origin`（`git@github.com:Theonx5/MatrixAgent.git`）。

## 6. 发布工作流（只走 GitHub Actions）

定义文件：`.github/workflows/release.yml`  
工作流名：`Release desktop installers`  
配套：`.github/workflows/p0.yml` 在每次 `main` push / PR 上跑源码门。

### 打什么包

| 平台 | Runner | 产物 |
| --- | --- | --- |
| Windows x64 | `windows-2022` | NSIS `PaperMatrix_*_x64-setup.exe` + updater `.sig` |
| macOS Apple Silicon | `macos-15` | DMG + `.app.tar.gz` updater |
| Intel macOS | **不构建** | — |

### 何时触发

- 推送 tag：`v*` 或 `agent-v*`（例如 `v1.2.0`、`agent-v1.2.0`）
- 或 Actions 页手动 `workflow_dispatch`，输入已有 tag
- 打包时从 tag 抽出 semver，经 `tauri build --config` 注入应用版本，不改工作区文件

同一 tag 的新 run 会取消旧 run（`cancel-in-progress: true`）。

### 流水线在做什么

每个平台 job：

1. checkout **该 tag 指向的 commit**（不是当时的 `main`  tip，除非 tag 已跟上）。
2. pnpm 9.15.0 + `.node-version` 的 Node + stable Rust。
3. macOS：若 Repository secrets 里 Apple 证书七件套齐全，则 Developer ID
   签名；一件都没有则 ad-hoc。缺几件会直接失败。
4. **Windows 源码门** `pnpm verify:p0`（含 ESLint、knip、Prettier、测试、
   `cargo fmt --check`、`clippy -D warnings`）。
   **macOS** 只跑 `pnpm verify:quick && pnpm build`。
5. `git restore` 掉 verify 期间生成的 Tauri schema 等文件。
6. `pnpm package:release`（`PIDECK_VERIFIED_SOURCE_COMMIT` 必须等于 HEAD）。
7. `scripts/generate-update-manifest.mjs --stage-platform` 收集本平台资产。
8. 上传 artifact `release-platform-<id>`。

`create-release` job（Ubuntu）在两个平台都成功后：

1. 下载全部 platform artifact。
2. 合成跨平台 `latest.json`。
3. 创建或更新 **Draft** GitHub Release，标题 `PaperMatrix <tag>`。
   不会自动 Publish。

`publish-to-server` job（Ubuntu，`needs: create-release`）：

1. `gh release download` 草稿资产。
2. `scripts/publish.py` 装配 `latest.json` + `v{version}/`。
3. `rsync` 到 `DEPLOY_DIST_DIR`（只增不删）。
4. `curl` 自检 `https://papermatrix.online/api/updates/matrix-agent/latest.json`。

### Repository secrets

Settings → Secrets and variables → Actions → **Repository secrets**：

| Secret | 是否必须 | 说明 |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 必须 | 本机 `apps/desktop/src-tauri/.tauri-updater.key` **全文**（含 untrusted comment） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 可空 | 私钥无密码就不要填，或填空 |
| `APPLE_CERTIFICATE` | 正式 Mac 发布才要 | base64 的 Developer ID `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | 同上 | |
| `APPLE_SIGNING_IDENTITY` | 同上 | |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` / `KEYCHAIN_PASSWORD` | 同上 | 七件套要么全有要么全没有 |
| `DEPLOY_SSH_KEY` | 回流服务器必须 | 专用部署私钥全文（含 BEGIN/END） |
| `DEPLOY_SERVER_HOST` | 同上 | 公网可达的 SSH 主机 |
| `DEPLOY_SERVER_USER` | 同上 | 例如 `theonx` |
| `DEPLOY_DIST_DIR` | 同上 | 例如 `/home/theonx/servers-PaperDownload-prod/matrix-agent_dist` |
| `DEPLOY_SSH_PORT` | 可空 | 非 22 时填写，例如 frp 映射端口；缺省 22 |

公钥在 `apps/desktop/src-tauri/tauri.conf.json` 的
`plugins.updater.pubkey`。客户端启动时向
`https://papermatrix.online/api/updates/matrix-agent/latest.json` 查更新
（Windows 静默安装；macOS 在没有 Developer ID 前不启用 updater）。
`scripts/publish.py` 把 Draft Release 产物装配进该分发目录；URL 为
`https://papermatrix.online/api/updates/matrix-agent/files/v{version}/...`。

### 发一版的步骤

```bash
git checkout main
git pull origin main
pnpm format:changed
pnpm verify:quick
git push origin main
# 等 P0 workflow 绿了再打 tag
git tag -a v0.2.3 -m "PaperMatrix 0.2.3"
git push origin v0.2.3
```

然后打开 https://github.com/Theonx5/MatrixAgent/actions 看
`Release desktop installers`。四个 job 都绿后，
`curl -fsS https://papermatrix.online/api/updates/matrix-agent/latest.json`
应出现本版本与 `windows-x86_64` / `darwin-aarch64`。Draft GitHub Release
仍可人工核对，不必 Publish 草稿。

已对外发布的 tag **不要** `git tag -f` / force-push。迭代未发布的 draft 才可以。

### 代理改发布相关代码时

- 改 `.github/workflows/`、`scripts/package-release*.mjs`、
  `scripts/release-*.mjs`、`release-runtime.lock.json` 必须同步更新本节和
  `docs/operations/release.md`。
- 推送前至少跑 `pnpm format:changed` 和 `pnpm verify:quick`。
- 新增未使用的 `export` 会被 knip 拦住；测试里的路径必须用
  `pideck-data.ts` 的辅助函数，不要写死 `pideck/` 子目录。
- Windows CI 对 Rust 执行 `cargo fmt --check` 和 `clippy -D warnings`。
  本机没有 rustfmt 时，按 CI 日志里的 diff 改，或在能装 rustfmt 的环境格式化。
