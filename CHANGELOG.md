# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

暂无。

## [1.0.0] - 2026-11-19

首个公开版本。以 **AGPL-3.0** 发布，npm 包名 `@uniepopep/dsh-attempt-recover`。

### Added

- 把 `assistant/attempt` 事件渲染成对话中的折叠块，位置在该轮末尾，不参与「过程」分组折叠。
- 按记录类型把内容拆成**思考**（`reasoning-chunks` / `reasoning-delta`）与**正文**（`text-chunks` / `text-delta`）两节，各自独立展开、独立加回。
- 加回按钮：`POST /api/attempt-recover`，宿主校验 `assistant/attempt` 真实性后追加一条 `user/message` 并带 `surfaceOp: "append"`，使其进入模型可见 surface。
- 两段内容按 Markdown 渲染，复用 Harness 的 `MarkdownText`；没有 `@deepseek-ai/dsh-client-ui-primitives` 的构建会退回等宽纯文本。
- 围栏代码块带 shiki 语法高亮，使用默认 `body` 变体并自注入间距 CSS。
- `selfcheck.mjs`（47 条契约断言）与 `e2e.mjs`（20 条端到端断言）。

### Fixed

- 宿主半曾用 `await import("@deepseek-ai/dsh-llm")`，在符号链接安装形态下解析失败，导致 handler 抛异常、响应体为空、前端报 `Unexpected end of JSON input`。现改为只依赖 `node:crypto`，并给 handler 加了兜底 catch。
- 代码块一度无高亮：`MarkdownText` 的 `compact` 变体带 `.compact pre :is(code,span){color:inherit !important}`，覆盖 shiki 的内联配色。改用默认变体。

### Known limitations

- 历史 attempt 需重启 Host 重新扫描；页面刷新足以重匹配已有事件。
- 同轮多条失败 attempt 按 seq 顺序堆叠，展开状态彼此独立。

[Unreleased]: https://github.com/UNIEPOpep/dsh-attempt-recover/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/UNIEPOpep/dsh-attempt-recover/releases/tag/v1.0.0
