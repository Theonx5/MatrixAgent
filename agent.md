# AGENT.md — Matrix Agent 工程约束（AI 代理必读）

本文件是 AI 编码代理在本仓库工作时的约束与须知。深度背景按顺序阅读
`docs/README.md` 的 Suggested reading order，功能 → 源码映射见
`docs/architecture/source-map.md`。发布细节另见
`docs/operations/release.md`。

远端仓库：https://github.com/Theonx5/MatrixAgent

## 1. 项目概览

PaperMatrix / Matrix Agent 是基于 [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
的 Tauri 2 桌面学术助手，版本 0.2.6，MIT 许可。三个模块分层明确：

| 模块 | 技术栈 | 职责 |
| --- | --- | --- |
| `packages/protocol` | TypeScript | Rust / Host / UI 三进程间的类型化协议（方法、事件、校验） |
| `packages/pi-host` | Node sidecar | 业务逻辑层：Pi SDK、会话/包/Provider，以及 Paper Matrix 文献库同步 |
| `apps/desktop` | React 19 + Vite + Tauri 2 (Rust) | 界面与桌面宿主 |

默认用户数据在 Windows 安装目录 `agent\` 子目录（开发构建或安装目录不可写时回退 `~/.MatrixAgent`；旧版 `~/.MatrixAgent` 与旧安装目录残留的 `agent\` 数据会在首次启动自动迁移——目标目录只含种子文件时会让位接管，含真实数据时则保持不动）。启动时会清理指向已消失旧默认文献库的工作区记录，避免重装后出现重复的 library 工作区。默认文献库是 `<agentDir>/library`，随 agent 目录一起位于安装路径。
Windows 安装身份是 `online.papermatrix.matrix-agent` / `PaperMatrix.exe`。
卸载不会删除 Pi CLI 的 `~/.pi`，也不会删除 pideck 命名的文件；agent 数据目录仅在勾选 Delete application data 时随卸载删除。不要指向 `~/.pi/agent`。

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
   （`SettingsManager` 固定 `projectTrusted: false`）。Host 进程环境必须自密封
   （`packages/pi-host/src/env-sandbox.ts`，`main.ts` 的第一个 import）：清掉所有继承的
   `PI_*` 变量并把 `PI_CODING_AGENT_DIR`钉到隔离 agentDir；Rust 侧 spawn 同样按 `PI_`
   前缀全量清洗后仅回注该变量。所有 `SessionManager` 静态调用必须显式传 sessionDir。
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

## 6. 发布工作流（双轨：本地 Windows 直发 + CI 双平台大版本）

定义文件：`.github/workflows/release.yml`  
工作流名：`Release desktop installers`  
配套：`.github/workflows/p0.yml` 在每次 `main` push / PR 上跑源码门。

### 两条独立轨道

| 轨道 | 触发 | 平台 | 执行者 |
| --- | --- | --- | --- |
| Windows（高频） | 本地运行 `pnpm release:local --tag v0.2.9` | 仅 Windows x64 | 本机构建 + SSH 直发服务器 |
| macOS（低频、必要时） | 推送 `agent-v*` tag（如 `agent-v0.3.0`） | 仅 macOS Apple Silicon | GitHub Actions |

两平台版本号**独立演进**（如 win 0.3.1、mac 0.3.0）。服务端 latest.json 是
按平台合并的多平台清单：每个平台条目自带 `version`/`notes`，顶层 version
只是各平台最大值（不参与单平台更新判定）。客户端 updater 端点使用 Tauri
动态端点（`latest.json?target={{target}}&arch={{arch}}`），服务端按参数返回
**单平台**清单；不带参数返回整份清单（兼容旧行为）；指定平台无条目返回
204。服务端按参数过滤的逻辑已上线（0.2.7 实测返回单平台清单）。回归验证：

```bash
curl 'https://papermatrix.online/api/updates/matrix-agent/latest.json?target=windows&arch=x86_64'
# 应返回单平台清单；返回整份说明服务端新逻辑未上线（客户端仍可用，退回旧行为）
```

### 本地直发（Windows，v* tag）

前置（一次性）：

- 本机 `apps/desktop/src-tauri/.tauri-updater.key`（已 gitignore）。0.2.7 起
  密钥**无密码**（`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 需设为空串或运行时
  `--key-password ""`，publish-local 已处理）；若换用加密密钥则须设置
  **用户级**环境变量。CI 与本地必须用同一把私钥签名。
- Python 3、`ssh`/`scp` 在 PATH。
- SSH 直发目标已内置默认值（`publish-local.mjs`：`192.168.3.13` / `theonx` /
  `/home/theonx/servers-PaperDownload-prod/matrix-agent_dist` / 端口 22），
  可用 `DEPLOY_SERVER_HOST` / `DEPLOY_SERVER_USER` / `DEPLOY_DIST_DIR` /
  `DEPLOY_SSH_PORT` 或 `--server/--user/--dist-dir/--port` 覆盖；本机 SSH
  私钥须已加入服务器 `authorized_keys`。

```bash
# 1. 升版本文件（package.json / tauri.conf.json / Cargo.toml+lock / 各 package.json）并提交推送
# 2. 打 v* tag（溯源用；CI 对 v* 不做任何事）
git tag -a v0.2.9 -m "PaperMatrix 0.2.9" && git push origin v0.2.9
# 3. 本地构建 + 按平台合并装配 + SSH 直发 + 自检
#    非英文 notes 必须用 --notes-file（UTF-8 文件）：Windows 控制台代码页
#    （GBK）会把命令行里的非 ASCII 参数损坏成乱码（0.2.7 曾因此发出乱码 notes）
pnpm release:local --tag v0.2.9 --notes-file release-notes.txt
```

`pnpm release:local` 执行链：`package:release`（tag 注入版本；updater key
自动读 `.tauri-updater.key`，检测到加密 key 而无密码时快速报错）→
`generate-update-manifest --stage-platform` → `assemble-dist.mjs`
（**按平台合并**：只重写 `windows-x86_64` 条目，其余平台条目连同其
version/notes/URL 原样保留；顶层 version 取各平台最大值）→ `ssh`/`scp`
上传 `latest.json` 与新 `v{版本}/` 目录（只增不删）→ 自检 latest.json。
`--no-deploy` 只装配不上传；`--skip-build` 复用上次构建产物；
`--allow-dirty` 跳过脏工作区检查。

无 Authenticode 证书时安装器不带系统签名（updater 的 minisign 链路不受
影响）；需要签名就设置 `WINDOWS_CERTIFICATE` /
`WINDOWS_CERTIFICATE_PASSWORD` / `PIDECK_WINDOWS_CERT_THUMBPRINT`。

### 发布链路与缓存现状

公网链路：`papermatrix.online`（云 nginx TLS 终结，39.106.159.243）→
frps → 本机 frpc → 本机 nginx:8090 → `127.0.0.1:9010`（prod uvicorn）。
后端每次请求实时读 `{DEPLOY_DIST_DIR}/latest.json` 并显式带
`Cache-Control: no-cache`；本机 nginx 无缓存。后端路由若更新过
（`backend/app/api/routes/tools.py`），发版前确认 prod uvicorn 已重启到
新代码。

**已知问题**：云 nginx 对 latest.json 仍有 ~10-15 分钟响应缓存且似乎忽略
no-cache 头（待 VPS 侧修复）。表现为发版后公网最长 15 分钟返回旧版本
清单，过期自愈——不要在这个窗口内误判发布失败；紧急时可上 VPS 清缓存。

客户端更新时序（0.2.8 起）：点击更新 → 插件拉起 NSIS 安装器（`/S /R
/UPDATE /ARGS ...`）并退出应用 → 安装器 PREINSTALL 钩子无条件强制结束
新旧二进制名的残留进程（PaperMatrix.exe / pideck.exe）→ 原位覆盖
$INSTDIR → `/R` 重启。应用注册了 single-instance（按 identifier
全局互斥）：任何副本（含旧版本残留的）再次启动只会聚焦已有窗口，
不会叠加多个版本的窗口。

### 构建失败排查

`package:release` 失败先看
`apps/desktop/src-tauri/target/release-staging/PACKAGE_RELEASE.json`：
`status` / `tauriExitCode` / `stageTimingsMs` / `packagedRuntimeErrors`
定位挂在哪个阶段。注意它只有摘要，Tauri 构建的真实报错要用同样参数
手跑一次抓输出：

```bash
cd apps/desktop
node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis --config '{"version":"<版本>"}'
```

已知的 Rust 侧坑：Cargo.lock 里经 rsproxy 镜像生成的 checksum 可能与
crates.io 官方不一致；镜像不可用（直连）后构建报
`checksum ... changed between lock files`，且 `cargo update --precise`
也会被同一校验挡住。修法：从官方 sparse index 查真实 checksum（如
`https://index.crates.io/di/sp/displaydoc`，按 crate 名前缀分片），手改
Cargo.lock 后 `cargo fetch` 验证（0.2.7 的 displaydoc 0.2.7 即此问题）。

### CI macOS 发布（agent-v* tag）

`release.yml` 仅响应 `agent-v*` tag 与手动 dispatch。macOS 作业跑
`verify:quick && build` → `package:release`（darwin 分支产出 DMG +
`.app.tar.gz` updater）→ `create-release`（Draft GitHub Release）→
`publish-to-server`：`gh release download` 草稿资产后由
`assemble-dist.mjs --platform darwin-aarch64` 按**同样的合并算法**只重写
`darwin-aarch64` 条目（Windows 条目原样保留），`rsync`（不带 --delete）上传，
`curl` 自检。两侧共用同一把 `.tauri-updater.key` 私钥。

流水线细节：checkout 该 tag 指向的 commit；Node 用 `.node-version`；
Apple 证书七件套齐全则 Developer ID 签名，否则 ad-hoc；
`package:release` 要求 `PIDECK_VERIFIED_SOURCE_COMMIT` 等于 HEAD；
`generate-update-manifest --stage-platform` 接受 `v` 与 `agent-v` 前缀。

### Repository secrets

Settings → Secrets and variables → Actions → **Repository secrets**：

| Secret | 是否必须 | 说明 |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 必须 | 本机 `apps/desktop/src-tauri/.tauri-updater.key` **全文**（含 untrusted comment） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 与密钥一致 | 加密密钥必填；两侧（CI/本地）必须同一把私钥 |
| `APPLE_CERTIFICATE` | 正式 Mac 发布才要 | base64 的 Developer ID `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | 同上 | |
| `APPLE_SIGNING_IDENTITY` | 同上 | |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` / `KEYCHAIN_PASSWORD` | 同上 | 七件套要么全有要么全没有 |
| `DEPLOY_SSH_KEY` | 回流服务器必须 | 专用部署私钥全文（含 BEGIN/END） |
| `DEPLOY_SERVER_HOST` | 同上 | 公网可达的 SSH 主机 |
| `DEPLOY_SERVER_USER` | 同上 | 例如 `theonx` |
| `DEPLOY_DIST_DIR` | 同上 | 例如 `/home/theonx/servers-PaperDownload-prod/matrix-agent_dist` |
| `DEPLOY_SSH_PORT` | 可空 | 非 22 时填写；缺省 22 |

公钥在 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`；
客户端 updater 端点为动态端点
`latest.json?target={{target}}&arch={{arch}}`（Windows 静默安装；macOS 在
没有 Developer ID 公证前 UI 不启用 updater）。dist 的 URL 形如
`https://papermatrix.online/api/updates/matrix-agent/files/v{version}/...`。

### 发一版的步骤

先升级版本文件（package.json、tauri.conf.json、apps/desktop/src-tauri/Cargo.toml
+Cargo.lock、各 package.json）并提交——`generate-update-manifest` 校验
tauri.conf.json 的 version 必须等于 tag（`v` 与 `agent-v` 前缀均可）。

**Windows（本地直发）：**

```bash
git checkout main && git pull origin main
pnpm format:changed && pnpm verify:quick
git push origin main
git tag -a v0.2.9 -m "PaperMatrix 0.2.9" && git push origin v0.2.9
# 非英文 notes 用 --notes-file（UTF-8）；--notes 仅适合纯 ASCII
pnpm release:local --tag v0.2.9 --notes-file release-notes.txt
```

若打 tag 后还需修复：提交修复 → push main → 删除重建 tag 并强推
（`git tag -d v0.2.9 && git push origin :refs/tags/v0.2.9` 后重建；CI 对
v* 无副作用），再重跑 `release:local`。

发布后自检（脚本里的校验值勿用内联中文字面量——Windows 本机 python/node
的 CLI 参数同样会被代码页损坏，造成假阴性；用 UTF-8 字节匹配或从文件读）：

```bash
# 动态端点：version=本次版本、notes 与发布说明一致（单平台响应的 notes 取
# 平台条目自身）、url 指向 v{版本}/、signature 非空
curl -fsS 'https://papermatrix.online/api/updates/matrix-agent/latest.json?target=windows&arch=x86_64'
# 安装包可达性（服务器不支持 HEAD，返回 405，用 range GET）
curl -fsS -r 0-1023 -o /dev/null \
  'https://papermatrix.online/api/updates/matrix-agent/files/v0.2.9/PaperMatrix_0.2.9_x64-setup.exe'
# .sig 与本地产物一致
diff <(curl -fsS .../PaperMatrix_0.2.9_x64-setup.exe.sig) <本地 .sig>
```

**macOS（CI）：**

```bash
git checkout main && git pull origin main
pnpm format:changed && pnpm verify:quick
git push origin main
git tag -a agent-v0.3.0 -m "PaperMatrix 0.3.0 (macOS)" && git push origin agent-v0.3.0
# 在 Actions 页盯 Release desktop installers
```

