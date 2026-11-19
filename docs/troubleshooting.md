# 排错

## 装了但什么都不显示

按顺序排查。

### 1. 插件加载了吗

```
插件管理 → 插件列表 → 找 @uniepopep/dsh-attempt-recover
```

状态应该是「已启用」且 `fiberPhase` 为 `active`。`failed` 说明加载失败，展开看错误。

用命令验证：

```bash
curl -i -X POST http://127.0.0.1:YOUR_DSH_PORT/api/attempt-recover
```

| 返回                       | 含义                                      |
| -------------------------- | ----------------------------------------- |
| `401`                      | ✅ 路由已注册，被浏览器鉴权拦住 —— 正常 |
| `405`（`allow: GET,HEAD`） | ❌ 路由没挂上，插件宿主侧没跑起来         |
| `404`                      | ❌ 路径不对，或者插件根本没启用           |

`405` 和 `404` 都是「没生效」，不是「插件坏了」。先插件管理里关掉再打开，还不行就重启 DSH（结束进程再打开）。

### 2. 有 attempt 事件吗

只有**模型已经正在输出时失败或中断**的请求才会产生 `assistant/attempt`。正常完成的回复本来就会显示，插件对你没有任何增益 —— 这不是 bug。

### 3. 页面刷新了吗

历史 attempt 需要重新匹配事件。**重启 DSH** 才会重新扫描磁盘上的历史；单纯刷新页面足以让已下发的事件重新匹配。

如果一轮里本来就没有 attempt 事件（比如失败发生在还没有任何输出的阶段），那没什么可显示的 —— 插件不会凭空造内容。

## 块出现了，但看不到我期望的内容

### 只有「思考」没有「正文」，或者反过来

这两段是独立的。如果模型在输出正文之前就失败了，只有 reasoning 有内容，反之亦然。空的那段不渲染。

### 内容停在一句话中间

这是对的。失败就是这样 —— 文本是残缺的，插件不做补全，也不假装它完整。加回时的框架文字会明确告诉模型「它可能停在半句话上」。

### 块里的代码块没有颜色

两种可能：

1. 你的构建里 `MarkdownText` 缺失，插件退回了 `<pre>` 纯文本（功能正常，只是没高亮）。
2. 有人把 `variant` 改成了 `compact` —— 那个变体的 CSS 里有 `color: inherit !important`，会吃掉 shiki 的配色。`selfcheck.mjs` 有断言拦这个，跑 `npm test` 应该会红。

### Markdown 没渲染，显示的是原始文本

同样先看 `MarkdownText` 能不能 require 到。在日志中搜 `dsh-attempt-recover`，看有没有加载失败的日志。

## 加回按钮报错

按钮失败时界面上会显示 `加回失败：<具体原因>`，认这个错误码：

| 错误码 | 原因 | 怎么办 |
| --- | --- | --- |
| `attempt-recover/bad-request` | 请求参数不合法（sessionId 空、seq 非法、section 不是 text/reasoning） | 插件 bug，附上报错截图开 issue |
| `attempt-recover/no-session` | 这个 sessionId 解析不到会话 | 页面可能开着已关闭的旧会话，刷新 |
| `attempt-recover/no-attempt` | seq 处没有 `assistant/attempt` 事件 | 该事件可能已被清理，或页面数据是陈旧的，刷新后重试 |
| `attempt-recover/empty` | 该段文本为空 | 空段不该有按钮，属异常，开 issue |
| `attempt-recover/append-failed` | 会话写入失败 | 看 Host 日志 |
| `attempt-recover/failed` | handler 内部未预期异常 | 看 Host 日志里的堆栈 |

### `Unexpected end of JSON input`

这是**已修复**的历史 bug，如果你还看到它，说明装的是旧版本。

原理：宿主侧曾用 `await import("@deepseek-ai/dsh-llm")`，而插件以符号链接装进 profile，真实路径下没有 `node_modules` → 模块解析失败 → handler 抛异常 → `bridge` 对 reject 的 handler 不写响应体 → 浏览器 `response.json()` 拿到空 body 就报这句。

现在宿主侧只 import `node:crypto`，并且 handler 整体包了 try/catch，任何异常都会转成合法 JSON。升级到 1.0.0 以上即可。

### `401 Unauthorized`

不是 bug。Harness 的浏览器鉴权在拦未认证请求。插件的按钮走的是同一套鉴权，正常使用不会碰到；只有你手动 curl 才会看到。

## 加回之后上下文里没有

### 确认真的点了按钮

按钮文案会从「加回正文」变成「已加回」，下方会出现“上下文注入 · recovered-attempt”。没变就是没成功。

### 消息加进去了，但模型好像没看见

加回写的是 `user/message` + `surfaceOp: "append"`，它会在**下一次**请求的 provider transcript 里出现。已经完成的那一轮不会因此重算。

如果下一轮仍然没体现，检查是不是又触发了一次 compaction 把早期的消息压掉了 —— 那是另一回事，不是加回失败。

### 框架文字会不会让模型困惑

不会，它的措辞是刻意设计的：明确说明来源（你上一次回复中途失败）、位置（第 N 轮第 M 步）、性质（残缺、可能停在半句话）、以及该怎么用（当作已写过的内容继续，不要重复）。少了这段，模型可能会把它当成用户粘贴的第三方内容。

## 同一个块出现两次

同一轮里如果重试了多次且都失败，就会有多个 `assistant/attempt` 事件 —— 它们应该按 seq 顺序各自堆在轮末尾，不是重复渲染。每个的展开状态和按钮互相独立。

## 卸载

```bash
dsh plugin --profile desktop remove @uniepopep/dsh-attempt-recover
```

或直接在插件管理界面里停用。插件不写任何持久状态，卸载后干净消失 —— 但**已经加回对话的那些消息会留在会话里**，因为它们是普通的 `user/message`，已经属于那段对话的历史。这是有意的：你明确点过按钮，那个决定就该留下。

## 还是要开 issue

请附上：

1. DSH 版本（`0.2.2-rc.2` 之类）
2. 操作系统及版本
3. `curl -i -X POST http://127.0.0.1:YOUR_DSH_PORT/api/attempt-recover` 的返回
4. 界面上完整的错误文案
5. 如果方便，日志里带 `attempt-recover` 字样的行

不要贴整个会话日志 —— 里面可能有你的对话内容。
