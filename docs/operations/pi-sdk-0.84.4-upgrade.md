# Pi SDK 0.84.2 → 0.84.4

> **状态：** 已落地。七个 `@earendil-works/pi-*` 包钉 `0.84.4`。残留 dist 补丁仍是 invocation ownership + Windows bundled bash；绝对 `taskkill` 已由上游 0.84.4 吸收。产品版本 `0.2.3`。
> 上一版执行稿：[`pi-sdk-0.84.2-upgrade.md`](./pi-sdk-0.84.2-upgrade.md)。

截至 2026-09-02：`dist-tags.latest` 为 **0.84.4**。coding-agent `gitHead`：`b79e4cc834970cca69daebffab7df1da7d1e52c4`。

## 为什么升

0.84.3 / 0.84.4 是 patch 级发布，包含 Host 能直接受益的修复，且不改 PiDeck 协议：

- Windows `taskkill.exe` 不在 PATH 时不再把 Host 打崩（#6596；吸收原 P4）
- 会话 JSONL 缺尾换行不再损坏下一条（#8345）
- 运行中 `triggerTurn: false` 的扩展消息不再插进 tool call/result 之间（#8537）
- 大工具结果先压缩再发给模型（#6879）
- `setModel` / `setThinkingLevel` 默认只写会话；PiDeck 在用户显式改模型/思考等级时传 `{ persist: true }`，保持原来的全局默认行为
- PowerShell 工具是 opt-in（`defaultTools`）；Host 默认工具仍是 `read/bash/edit/write`，不产品化
- Anthropic 等适配器默认 `User-Agent` 改为 `pi (...)`（#8305）；自定义 header 仍可覆盖

不使用的新 CLI 能力：terminal capability overrides、RPC `clear_queue`、fullscreen copy 设置、`/thinking` TUI。

## 补丁 rebase

`patches/@earendil-works__pi-coding-agent@0.84.4.patch` 相对 0.84.4 tarball：

| 行为 | 0.84.4 上游 | 补丁 |
|---|---|---|
| Invocation ownership（bind + reload + event + Extension tool） | 仍无公共 hook | 必留：`agent-session` + `runner` + `wrapper` + 类型/根导出 |
| 绝对路径 `taskkill` | 已有 | 补丁改为 `SYSTEMROOT` 回退 + spawn `error` 后 `process.kill` |
| Bundled bash（`PIDECK_BUNDLED_BASH` / Portable Git） | 无 | 仍留 `shell.js` |
| `model: null` / `clearModel` / PM env | 继续用 Host sentinel 与 adapter | 无 dist hunk |

## Evidence

npm pack SHA-256（2026-09-02）：

```
dfd3c929cee5a7387199a0a24dfc1be2096f1ea8f59ffb8285198a0ed01ebf93  earendil-works-pi-ai-0.84.4.tgz
5bce766d19c3ceba18f3fbaad91c449c9f9d73981f9e3400ecef932006f06968  earendil-works-pi-coding-agent-0.84.4.tgz
387f544432cb6fa777f5b16d801f81f2419c28adcb333e3a23f35b8e9c6d4fbe  earendil-works-pi-tui-0.84.4.tgz
3ceb710d18b4c993d5de2e37a65131015b44bda46330391b4e5030d65c35004a  earendil-works-pi-agent-core-0.84.4.tgz
0cc57c9ecb41c68dac0efcaa4dcbd9882e716e253945f174939e153516d75ab1  earendil-works-pi-client-0.84.4.tgz
bda0de745a0aa08ca173031420e832a22a76a949f610e6550a545588b1789a04  earendil-works-pi-protocol-0.84.4.tgz
412bde65d3bcd8f722b386c8e08f6d1f43d131b2077c9ee65b45cc3a8f29ff05  earendil-works-pi-telemetry-0.84.4.tgz
```

`scripts/release-runtime.lock.json` 的 `sdkPatchSha256` 与 `pnpmLock.sha256` 必须与当前 patch / `pnpm-lock.yaml` 一致。
