# Source Visuals

真实素材能显著降低“AI 一眼假”。Paper Matrix 已把 MinerU 解析图同步到论文同级 `images/`。先用这些文件，而不是从 PDF 截图或凭空生成。

## Initial Question

在确认阶段问清楚：

```text
我会默认使用这篇论文旁边 images/ 里的解析图作为真实素材。如果你还有额外截图要插入，告诉我用在哪几页。
```

## Priority

优先使用：

1. 论文同级 `images/` 中的解析 Figure：方法图、架构图、流程图、主结果图。`read` 后再决定原样嵌入还是局部重绘。
2. 实验曲线和表格：关键 benchmark、ablation、对比结果。
3. 用户真实截图：产品界面、代码、dashboard、实验记录。
4. 代码仓库截图：README 图、模型结构、运行结果。

不优先使用：

- 分辨率太低、压缩严重、文字糊的图片。
- 密密麻麻、讲不清主观点的大表。
- 有敏感信息的截图，除非用户明确允许并先脱敏。

## Placement Patterns

| Pattern | 用途 |
|---|---|
| `hero-crop` | 封面或章节页，把真实图局部放大做视觉锚点 |
| `figure-remix` | 保留真实图核心结构，旁边加解释和局部放大 |
| `evidence-panel` | 左侧结论，右侧真实表格/曲线截图 |
| `zoom-inset` | 原图 + 关键区域放大框 |
| `glass-mounted` | 在 `liquid-glass` 风格中，把真实截图放进玻璃面板 |
| `paper-strip` | 一排真实图小片段，形成证据墙 |

## Outline Requirement

每页如果使用真实素材，必须在 outline 写：

```markdown
- Source visual: LLM/images/img_2.jpg (Figure 2), crop center architecture, place as 70% width main panel, add three callouts
```

## Prompt Requirement

每页 prompt 必须写清楚：

- 使用哪个源文件或图号。
- 保留真实内容，不发明新数字、新标签、新 UI。
- 只是进行裁切、边框、玻璃面板、旁注、局部放大、背景统一。

## When To Ask User For Files

如果 PDF 里没有足够好的图，但页面需要真实截图，直接告诉用户：

```text
第 6 页最好放真实产品/实验截图，这比生图模型凭空画更可信。你可以提供截图；如果没有，我会改成抽象机制图。
```
