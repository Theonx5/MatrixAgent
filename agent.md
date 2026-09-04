# agent.md — PiDeck / PaperMatrix 编码代理指南

> 本文件是仓库级 AI 编码代理的工作约束，不是产品设计文档。先遵守本文件的安全与验证要求，再按任务阅读 `docs/` 中的权威文档。若本文件与源码、`package.json`、工作流或 `docs/` 不一致，以当前实现和权威文档为准，并在同一变更中修正文档。

## 1. 快速概览

PiDeck（产品名 **PaperMatrix**）是基于 Pi Coding Agent 的 Tauri 2 桌面应用，MIT 许可。当前仓库基线版本为 `0.2.9`；版本以以下文件的一致性为准，不要只修改一个文件：

- `package.json`
- `apps/desktop/package.json`
- `packages/protocol/package.json`
- `packages/pi-host/package.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`

| 层 | 目录 | 责任 |
| --- | --- | --- |
| 协议 | `packages/protocol` | Rust、Node Host、React UI 之间的类型、方法、事件、校验和错误契约 |
| Host | `packages/pi-host` | Node sidecar；Pi SDK、会话、Provider、Package/Extension、Paper Matrix 文献库同步 |
| 桌面端 | `apps/desktop` | React 19 + Vite UI、Tauri 2 Rust 宿主、Host 生命周期与原生能力 |

支持边界：源码开发覆盖 Windows 11 x64 和 Apple Silicon macOS；仓库不声明 Linux 桌面支持。`pnpm package:release` 生成的是开发候选包，不等于已经完成公开发行验收。

产品身份：Tauri `identifier` 为 `online.papermatrix.matrix-agent`，主二进制和 Windows 产品名为 `PaperMatrix`。远端为 `origin`（MatrixAgent）。

## 2. 开始任务前

1. 先运行 `git status --short`，不要覆盖用户已有改动。
2. 读取与任务相关的源码、测试和文档；功能到源码的映射以 `docs/architecture/source-map.md` 为入口。
3. 先确认边界：这是协议、Host、React、Rust/Tauri、Package/Extension、安全、发布还是文档变更。
4. 只做必要范围的修改；不要把生成物、运行时资源、用户数据或凭据加入提交。
5. 完成后运行与改动匹配的最小验证，条件允许时再运行完整门禁。

推荐阅读顺序：

1. `docs/README.md`
2. `docs/architecture/overview.md`
3. `docs/architecture/process-boundaries.md`
4. `docs/architecture/protocol.md`
5. `docs/architecture/chat-runtime.md`
6. `docs/architecture/packages-workspaces.md`
7. `docs/architecture/pi-settings.md`
8. `docs/architecture/matrix.md`
9. `docs/architecture/source-map.md`
10. `docs/operations/p0-scope.md`
11. `docs/operations/development.md`
12. `docs/operations/release.md`

`docs/history/` 是历史记录，不能覆盖当前 `docs/operations/p0-scope.md` 与 `p0-status.json` 的定义。

## 3. 本地工具链

- Node.js 最低 `22.19.0`；开发和 CI 使用 `.node-version` / `.nvmrc` 中的精确版本（当前为 `24.18.0`）。
- pnpm 固定为 **9.15.0**，必须使用 `pnpm-lock.yaml`；不要升级到 pnpm 11，仓库的 `patchedDependencies` 依赖当前 pnpm 行为。
- Rust stable；Windows 目标为 `x86_64-pc-windows-msvc`。桌面开发还需要 Microsoft C++ Build Tools（Desktop development with C++）和 WebView2；macOS 需要 Xcode Command Line Tools。
- Windows PowerShell 命令优先使用 PowerShell 语法；不要把 bash、PowerShell、cmd 的路径/引号规则混用。
- 本机缺少 `rustfmt`/`clippy` 时，不要为了让本地通过而绕过检查；记录限制并依赖 Windows CI 的 `lint:rust` 结果。

安装依赖：

```powershell
pnpm install --frozen-lockfile
```

## 4. 架构与不可破坏的边界

### 4.1 进程与数据流

React UI 通过协议与 Tauri/Rust 宿主通信；Rust 管理窗口、原生命令、Host 子进程及其生命周期；Node Host 通过 JSONL stdio 提供协议服务并调用 Pi SDK。不要让 UI 直接绕过协议访问 Host 内部模块，也不要让 Rust 重复实现 Host 业务逻辑。

入口与地图：

- 协议：`packages/protocol/src/`
- Host 入口/服务：`packages/pi-host/src/main.ts`、`server.ts`
- Host 安全封装：`packages/pi-host/src/env-sandbox.ts`
- UI：`apps/desktop/src/`
- Tauri：`apps/desktop/src-tauri/src/main.rs`、`lib.rs`
- Host 生命周期：`apps/desktop/src-tauri/src/pi_host.rs`
- 原生命令：`apps/desktop/src-tauri/src/commands.rs`
- 桌面设置：`apps/desktop/src-tauri/src/desktop_settings.rs`
- 协议文档：`docs/architecture/protocol.md`

### 4.2 协议契约

新增或修改方法、事件、错误、身份字段或修订号时，必须同步检查：

1. `packages/protocol/src/`
2. `packages/pi-host/src/`
3. `apps/desktop/src/`
4. `docs/architecture/protocol.md`
5. `packages/protocol/src/protocol-coverage.test.ts`
6. `packages/protocol/src/validate.test.ts`

先修改协议类型/校验，再接 Host 和 UI；不要只在某一端增加“临时字段”。保持请求、响应、事件的 revision/identity 语义，序列间隙必须 fail closed。

### 4.3 安全与用户数据

以下是强约束：

- 只从隔离的 Pi agent 目录加载用户级 Package；不得继承或读取本机 Pi CLI 的 `~/.pi/agent`。
- 打开工作区不得执行 `<workspace>/.pi/extensions`；`SettingsManager` 必须保持 `projectTrusted: false`。
- Host 入口的环境封装必须在加载 Pi SDK 前生效：清理所有继承的 `PI_*` 变量，只回注解析后的 `PI_CODING_AGENT_DIR`。Rust 启动 Host 时也要按 `PI_` 前缀清理后再注入该变量。
- 所有 `SessionManager` 静态调用必须显式传入正确的 `sessionDir`，避免会话串库。
- Host 自有数据位于 `agentDir` 根下的 `migration-backups/`、`session-archive/`、`library/` 等目录；不要新增 `agentDir/pideck/...` 旧布局。
- 测试、打包、安装/卸载验证都必须使用临时 agent 目录，不能触碰真实 `~/.MatrixAgent` 或 `~/.pi`。
- 凭据、设置、会话、签名私钥和证书永不提交：`.env`、`apps/desktop/src-tauri/.tauri-updater.key`、`*.pfx` 等保持 gitignored。
- Windows 替换已有文件时正确处理 `EPERM`：参考 `packages/pi-host/src/credential-store.ts` 的 unlink 重试 / `copyFile` 降级，不要假设 `rename` 能覆盖打开中的文件。

默认数据目录由 Tauri 设置代码决定：打包应用优先使用可写安装目录下的 `agent\`，不可写时回退到 `~/.MatrixAgent`；`library` 是默认文献库。迁移和旧默认工作区清理属于现有启动行为，修改前先阅读 `desktop_settings.rs` 及其测试。

### 4.4 Package、资源与 SDK

- 工作区选择、启动预加载、会话创建/打开必须保持离线解析：继续使用 `packages/pi-host/src/offline-package-resolution.ts` 的 `withoutImplicitPackageInstall()`，不要让缺失 Package 触发隐式 npm/git 网络安装。
- Package reconcile/显式安装更新才允许联网；用户数据和 workspace-local 扩展仍不得越过安全边界。
- 当前 Pi SDK 四件套固定为 `0.84.4`，并使用 `patches/@earendil-works__pi-coding-agent@0.84.4.patch`。升级 SDK 时必须重新评估补丁、锁文件、Host 适配和 `docs/operations/`，不能只改版本号。
- 不要直接编辑 `node_modules`、`dist`、Tauri `target` 或打包资源；它们应由脚本从锁定源重新生成。

## 5. 按改动类型执行的同步要求

| 改动类型 | 必须同步检查 |
| --- | --- |
| 协议 / Host API | protocol、Host、UI、协议文档、协议覆盖/校验测试 |
| React UI | `en.ts` 与 `zh.ts` 同步；组件/状态测试；必要时更新 source map |
| 会话 / 工作区 / Package | Host 集成测试、临时 agent、数据路径、离线解析和恢复行为 |
| Rust / Tauri | Rust 单测、Host 进程树/路径安全、Windows 行为；本机不能 lint 时看 CI |
| Pi SDK / patch | 四个 Pi 包版本、patch、lockfile、适配器测试、开发文档 |
| 用户可见行为 | `docs/architecture` 或 `docs/operations` 在同一提交更新；文档为英文 |
| 发布 / 版本 | 所有版本文件、release 脚本测试、`p0-status.json`；不要宣称未验收的公开发行 |

新功能或修复必须带 colocated Vitest/Rust 测试；不得删除测试或放宽校验来“修复”构建。

## 6. 常用命令

从仓库根目录运行：

```powershell
# 开发
pnpm dev:fast
pnpm dev:host
pnpm dev:desktop
pnpm --filter @pideck/desktop run tauri:dev

# 构建与检查
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:changed
pnpm verify:quick
pnpm verify:p0

# Host / 资源 / 候选包
pnpm spike:sidecar
pnpm package:sidecar:with-node
pnpm validate:resources
pnpm smoke:staged-host
pnpm package:release
```

命令语义：

- `verify:quick` = 文档链接、fixture、发布元数据、JS lint/format、类型检查和测试。
- `verify:p0` = `verify:quick` + JS 构建 + Rust 测试 + Rust fmt/clippy；是源码/P0 门禁，不是安装包验收。
- `dev:fast` 仅适合 Windows 快速迭代，复用已编译的 Tauri debug binary；完整行为使用 `tauri:dev`。
- `package:release` 生成开发候选包并写入 `artifacts/` 或 staging 证据；不要把它当作已经签名、安装验收或公开发行。

## 7. 测试隔离与手动 Host smoke

写测试前设置独立目录，或使用 `packages/pi-host/src/test-helpers/temp-agent.ts`：

```powershell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\pideck-test-agent"
```

手动验证 Host 的最小 JSONL 往返：

```powershell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\pi-host-smoke"
pnpm --filter @pideck/pi-host exec tsx src/main.ts
# stdin 输入：
# {"protocolVersion":1,"id":"1","method":"system.hello","context":{},"params":{"clientName":"cli","clientVersion":"0","protocolVersion":1}}
```

测试失败时先判断是代码、环境、网络/依赖下载，还是旧 staging 资源问题；不要用真实用户目录重跑以“验证”。

## 8. CI、发布与版本

### 源码门禁

- `.github/workflows/p0.yml` 在 Pull Request 和 `main` push 上运行；包括 Windows `windows-2022` 的 `verify:quick` 和 P0 job。
- `.github/workflows/extension-compat-latest.yml` 是每周/手动的上游 Extension 兼容性审计，不是 PR/main 门禁。
- 修改 Rust、进程树、安装资源或发布脚本后，优先查看对应 CI artifact 和 `artifacts/p0` 证据。

### 当前发布轨道

- **Windows patch**：在 Windows 发布机运行 `pnpm release:local --tag vX.Y.Z --notes-file release-notes.txt`。非 ASCII 发布说明必须走 UTF-8 `--notes-file`；可用 `--skip-build`、`--no-deploy` 等参数前先阅读 `scripts/publish-local.mjs`。
- **macOS candidate**：`.github/workflows/release.yml` 响应 `agent-v*` tag 或手动 dispatch，当前构建 macOS 15 Apple Silicon，生成 Draft GitHub Release，并可将 updater feed 回流服务器。
- `release:local` 与工作流都会进行版本/tag 校验；升版本时同步所有 package、Cargo 和 Tauri manifest 并先提交，再打 tag。
- Tauri updater 使用 `tauri.conf.json` 中的公钥和 `https://papermatrix.online/api/updates/matrix-agent/latest.json?target={{target}}&arch={{arch}}`；私钥只从本地 gitignored 文件或 CI secret 读取。
- 当前 `docs/operations/p0-status.json` 的 `claimStatus` 为 `not-complete`。没有 Authenticode（Windows）或 Developer ID + notarization（macOS）及安装/更新人工证据时，不得声称已完成公开发行。

发布细节、签名 secret、回滚和服务器部署以 `docs/operations/release.md` 为准；不要把服务器 IP、私钥内容或临时部署凭据写进代码、日志或文档。

## 9. 提交前清单

```powershell
git status --short
pnpm format:changed
pnpm verify:quick
```

若改动 Rust、打包、资源或协议，再执行对应专项测试；条件允许时执行：

```powershell
pnpm verify:p0
```

确认：

- 没有修改或提交用户数据、secret、`node_modules`、`dist`、`target`、`artifacts` 等生成物；
- 协议、i18n、测试和英文文档已同步；
- 失败项是已定位的环境限制，而不是被跳过、删除或放宽的检查；
- 提交信息使用简洁的祈使句；主分支为 `main`，远端名为 `origin`。
