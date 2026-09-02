# agent.md — PiDeck 工程约束（AI 代理必读）

本文件是 AI 编码代理在本仓库工作时的约束与须知。深度背景按顺序阅读
`docs/README.md` 的 Suggested reading order，功能 → 源码映射见
`docs/architecture/source-map.md`。

## 1. 项目概览

PiDeck 是 [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
的 Tauri 2 原生桌面应用，版本 0.2.2，MIT 许可。三个模块分层明确：

| 模块 | 技术栈 | 职责 |
| --- | --- | --- |
| `packages/protocol` | TypeScript | Rust / Host / UI 三进程间的类型化协议（方法、事件、校验） |
| `packages/pi-host` | Node sidecar | 业务逻辑层，持有 Pi SDK 与会话/包/Provider 控制器 |
| `apps/desktop` | React 19 + Vite + Tauri 2 (Rust) | 界面与桌面宿主 |

## 2. 本机环境（2026-09-01 已配置并验证）

- Windows 11 x64；Node v22.23.2（满足 ≥22.19.0；`.node-version` 期望 24.18.0，仅提示）。
- pnpm **必须 9.15.0**（corepack 已激活）。pnpm 11 会忽略 `patchedDependencies`
  位置并装出错误的 Pi SDK 依赖树，禁止升级 pnpm。
- Rust 1.98.0 `x86_64-pc-windows-msvc`（rustup minimal profile），位于
  `C:\Users\Administrator\.cargo`。bash 中需
  `export PATH="/c/Users/Administrator/.cargo/bin:$PATH"`。
- MSVC 14.44 + Windows SDK 10.0.26100（VS 2022 Community 自带），Tauri 可编译。
- 本机网络不能直连 GitHub / static.rust-lang.org，已配置镜像：
  - cargo crates.io → rsproxy.cn（`~/.cargo/config.toml`）
  - git GitHub → `gh-proxy.com` insteadOf 重写（全局 git config，勿删）
  - rustup → `RUSTUP_DIST_SERVER=https://rsproxy.cn`
- 本仓库由源码压缩包解压而来，git 仓库为后建（基线 commit `7f83a7a`），
  本地 `core.autocrlf=false`。

## 3. 常用命令

```bash
pnpm install --frozen-lockfile                  # 依赖安装（禁止手改 pnpm-lock.yaml）
pnpm dev:fast                                   # 开发热载（vite + host 增量构建）
pnpm --filter @pideck/desktop run tauri:dev     # Tauri 桌面开发模式
pnpm build                                      # protocol + pi-host + desktop 产物构建
pnpm verify:quick                               # 提交前必须全绿：docs/fixtures/元数据/lint/类型/测试
pnpm verify:p0                                  # 大改或发布前：verify:quick + 构建 + Rust 测试
pnpm format:changed                             # 只格式化变更文件（提交前执行）
node scripts/prepare-rust-test-resources.mjs    # cargo 测试前准备资源目录（tauri:dev 已内置）
cd apps/desktop/src-tauri && cargo test         # Rust 测试（需上一步先执行）
```

## 4. 硬约束（违反即返工）

1. **三端协议一致性**：新增/修改方法或事件必须同时改 `packages/protocol`、
   `packages/pi-host`、`apps/desktop`，并通过 `protocol-coverage.test.ts` 与
   `validate.test.ts`。协议文档 `docs/architecture/protocol.md` 同步更新。
2. **安全边界**：只从 `~/.MatrixAgent` 加载用户级 Package，不继承本机
   `~/.pi/agent`；打开工作区不得执行 `<workspace>/.pi/extensions`
   （`SettingsManager` 固定 `projectTrusted: false`）。禁止引入加载项目级
   Package 的代码路径。
3. **用户数据不入库**：`~/.MatrixAgent` 下的凭据、设置、会话绝不提交；
   `verify:fixtures` 会扫描泄漏。测试一律使用
   `packages/pi-host/src/test-helpers/temp-agent.ts` 临时目录。
4. **SDK 补丁**：`@earendil-works/pi-coding-agent@0.84.2` 带 dist 补丁
   （`patches/`），升级 SDK 版本必须重新评估补丁内容并同步
   `docs/operations/` 下的升级记录。
5. **文档同改**：落地行为变更必须同一个提交内更新 `docs/` 对应页面
   （文档为英文，新增内容保持英文风格），`verify:docs` 校验链接与状态。
6. **i18n 双语同步**：`apps/desktop/src/lib/i18n/en.ts` 与 `zh.ts` 必须同步，
   `i18n.test.ts` 校验 zh 覆盖率；新界面文案两个目录都要加。
7. **测试随行**：新功能/修复必须带 colocated vitest 测试（`*.test.ts` 与
   被测文件同目录）；Rust 行为用 `#[cfg(test)]` 单测。不许删测试来让构建通过。
8. **发布管线只读**：`scripts/release-*.mjs`、`release-runtime.lock.json`、
   `.github/workflows/` 未经明确要求不得修改。

## 5. 已知坑

- `format:check` 依赖 git 工作区状态；空仓库（无 commit）会报
  `git diff --no-index` usage 错误，先提交一次基线即可。
- tauri `build.rs` 会校验 `resources/{pi-host,node,git}` 存在；裸 cargo
  check/test 前先跑 `prepare-rust-test-resources.mjs`。
- 多包 vitest 并行偶发时序抖动（如 pi-host 偶挂 1–2 个用例）：先单独复跑
  `pnpm --filter @pideck/pi-host run test` 确认，再判断是否真回归。
- Prettier：`printWidth 100`、`endOfLine auto`、`proseWrap preserve`；
  ESLint + knip（未用导出检查）在 `pnpm lint` 中强制。
- Windows bash 下 cargo/rustc 不在默认 PATH，见第 2 节 export 命令。

## 6. 提交规范

- 提交门槛：`pnpm format:changed` + `pnpm verify:quick` 全绿。
- 提交信息用简洁祈使句，一句话说明行为变化；跨三端的协议变更在正文列出
  受影响模块。
- 仓库当前无远端、无历史约定，保持单分支线性提交即可。
