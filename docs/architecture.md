# 架构

这份文档解释插件为什么长这样。如果你只想用，读 [README](../README.md) 就够了。

## 问题精确定义

一次模型请求的生命周期里，Harness 有三种方式结束一个 step：

| 结局 | 写入的事件 | 界面上显示 | 模型下一轮可见 |
| --- | --- | --- | --- |
| 正常完成 | `assistant/message` | ✅ | ✅ |
| 用户主动中断 | `assistant/message` + `interrupted: true` | ✅（标记为已中断） | ✅ |
| 流异常 / `finish.kind === "error"` | **`assistant/attempt`** | ❌ | ❌ |

第三行就是本插件存在的理由。它在 `dsh-agent-loop` 的错误分支里，内容完整、结构完整、写入磁盘，然后就没有然后了。

具体是这三个地方：

- 流迭代抛异常 → `live.settle("assistant/attempt", () => session.append("assistant/attempt", { turn, step, stream: live.stream }))`
- `finish.kind === "error" || finish.kind === "aborted"` → 同上
- 唯一的例外是 `signal.aborted`（用户主动取消）→ 走 `live.interruptedBlocks()`，非空则写 `assistant/message` 并带 `interrupted: true`

`assistant/attempt` 为什么绝对不可见，有三道独立的闸：

1. `dsh-session/lib/types/known-event-types.js` 里它在名单内，但 `SURFACE_EVENT_TYPES` 不含它 → **不进模型可见 surface**
2. `dsh-client-ui-chat/lib/client.js` 的 `visibleAssistantEvent` 对它 `return false` → **客户端不建节点**
3. `dsh-api-session-controller` 的历史分页只按 `user/message` + `assistant/message` 计数切窗 → **它随窗口下发但不参与分页**

第 3 点很关键：它意味着数据**已经在前端了**。插件不需要回后端捞历史，只需要有人愿意读。

## 扩展点选择

选定方案前评估过四条路。

### ❌ 改 DSH 源码

把错误分支里的 `append("assistant/attempt", ...)` 改成也写一条 `assistant/message`。

否决原因：Harness 是打包分发的（`app.asar`），改完要么每次升级重打补丁，要么锁死版本。而且这会让「失败」在语义上变成「完成」，污染下游所有消费者。为了一处显示需求改动核心事件语义，代价不成比例。

### ❌ 拦 `agent/request-error`

`agent/request-error` 是 waterfall，插件可以监听并返回 `{ kind: "retry" }`。

否决原因：这解决的是**重试**，不是**显示**。而且返回 `retry` 意味着把已生成的内容全部丢掉重来 —— 与插件目标正好相反。

### ✅ 客户端读 `assistant/attempt` + 宿主写 `user/message`

这就是最终方案。分成两个半，各用最合适的扩展点：

- **读**：客户端 `ctx.uiConversation.events.register`。事件已经在前端，零成本。
- **写**：宿主 `ctx.connection.fetch.register`。追加事件必须在宿主侧，因为 `Session.append` 在那边。

### 为什么不自动加回

技术上完全可行 —— 监听到 `assistant/attempt` 就直接 append。但那样等于把「模型失败了一半」这件事静默升级成「模型说了这么多」，模型会拿残缺内容当作已完成的事实继续推理。**加不加回必须是人的判断。**

## 宿主侧

```
POST /api/attempt-recover
{ sessionId: string, seq: number, section: "text" | "reasoning" }
```

### 为什么用 `fetch.register` 而不是 `rpc.handle`

这是踩得最深的坑，值得记下来。

`ctx.connection.rpc.handle(channel, handler)` 看起来是标准做法，但它内部是：

```js
register(owner, channel, handler) {
  return owner.effect(() => owner.webServer.register(route), ...);
}
```

`owner` 是**读取该服务的那个 ctx**。插件只 inject 了 `connection`，`owner.webServer` 不存在，抛 `cannot get property "webServer" without inject` —— 而这个异常被 `effect` 静默吞掉了。

表现：`apply` 正常执行、日志一切正常、路由 404/405，毫无线索。把 `webServer` 加进 inject 也没用，scoped ctx 报同样的错。

`ctx.connection.fetch.register({ path, methods, requestBody, fetch })` 只往内部 `fetchRoutes` map 里塞一条记录，由 connection 自己已经挂好的 `/api` 前缀分发器处理，完全不碰 `webServer`。

**判定信号**：`POST` 返回 `401` = 挂上了但没过浏览器鉴权（正常）；返回 `405 allow: GET,HEAD` = 根本没挂上；`404` = 路径写错。

### 校验链

```
sessionId 非空串              → 否则 bad-request
seq 非负安全整数              → 否则 bad-request
section ∈ {text, reasoning}   → 否则 bad-request
sessions.get(sessionId)       → 否则 no-session
snapshotEvents(0, seq).find(c => c.seq === seq)
    且 c.type === "assistant/attempt"  → 否则 no-attempt
提取文本，trim 后非空        → 否则 empty
session.append("user/message", message, { surfaceOp: "append" })
                              → 失败则 append-failed
```

任何一步失败都返回 `{ ok: false, error: { code, message } }`。

### 为什么只能写 `user/message`

失败轮次的 turn 已经被 `turn/end` 闭合（`reason: { kind: "error" }`）。`assistant/message` 的 invariant 是 `requireOpenStep(trace, type, turn, step, fail)` —— 没有 open step，直接拒绝。

`user/message` 的 invariant 是 `case "user/message": break;`，即**无约束**。

代价是 `user/message` 的 surface 投影是原样返回 `event.data`，不会自动加任何框架 —— 所以「这是恢复的残缺内容」这段话必须自己写进 `content`。少了它，模型会以为这是用户贴进来的别人的东西，可能完全忽略，也可能把它当成新指令。

### 消息形状

```js
{
  id: randomUUID(),          // 非空字符串
  role: "user",              // 必须是 "user"
  content: [{ type: "text", text: banner(...) }],
  source: { kind: "recovered-attempt" }  // 任意非空字符串
}
```

`source.kind` 允许自定义值，这让我们能在日志里把恢复的消息和真实用户输入区分开。

### 零运行时依赖

宿主侧**只** `import { randomUUID } from "node:crypto"`。

这不是洁癖。插件通过符号链接装进 profile：

```
~/.dsh/profiles/desktop/node_modules/@uniepopep/dsh-attempt-recover
  → C:\...\default-workspace\dsh-attempt-recover
```

符号链接解析后，真实路径下**没有** `node_modules`。任何裸 `@deepseek-ai/*` 说明符都会 `ERR_MODULE_NOT_FOUND`。而 handler 抛异常时 `bridge` 不写响应体，浏览器 `response.json()` 报：

```
Failed to execute 'json' on 'Response': Unexpected end of JSON input
```

这个 bug 曾经被 `e2e.mjs` 里临时 `ln -s node_modules` 完美掩盖。现在的 `e2e.mjs` 刻意在**没有** `node_modules` 的形态下跑，谁再引入裸包名就立刻红。

## 客户端侧

### 节点声明为 hidden，走 turnTail 槽

失败的轮次会把大量活动折叠进「过程」分组。普通 Chat 节点会被 `processMember` 判定为过程成员，跟着折进去 —— 恰好是最不该藏起来的时候。

`TURN_PROCESS_INDEPENDENT_KINDS` 是白名单，命中它的 kind 不参与过程折叠：`system-prompt`、`user`、`steering`、`turn-trigger`、`turn-process`、`turn-error`、`turn-max-tokens`、`turn-tail`。

所以节点声明 `visibility: "hidden"`（不进主时间线），改由 `conversation.chat.turnTail` 槽渲染。`TurnTailNodeView` 在每轮末尾调用这个槽，props 是 `{ turn, seq, openFile }`。

组件拿 `turn` 反查同轮所有 attempt：

```js
snapshot.nodes.turnDataSource(Number(turn), "recovered-attempt")
```

返回按 `anchorSeq` 升序的 data 数组。

### 流还原

`data.stream` 是紧凑记录数组。两条路径都要处理：

- `{ type: "text-chunks", texts: [...] }` / `{ type: "reasoning-chunks", texts: [...] }` —— 批量形式
- `{ type: "chunk", chunk: { type: "text-delta", text } }` —— 单条形式

tool-call 类记录属于调用参数，不属于任何一段，跳过。

### Markdown 渲染与那个 `!important`

内容用 Harness 自带的 `MarkdownText`（`@deepseek-ai/dsh-client-ui-primitives`）渲染，它在 shell 的 seed module 表里，插件可以直接 `require`。缺失时退回 `<pre>`，内容照样完整可读。

**关键坑**：`MarkdownText` 的 `compact` 变体带一条

```css
.compact pre, .compact pre :is(code, span) { color: inherit !important; }
```

shiki 把配色写成内联 `style` 上的 `--shiki-*` 变量，这条 `!important` 直接覆盖成继承色 —— 代码块变成单色。所以必须用默认 `body` 变体，紧凑排版靠自己注入一段只改间距的 CSS（选择器限定在 `[data-recovered-body]`）。

`selfcheck.mjs` 里有一条断言专门钉住「不给 `variant` 属性」，防止有人为了排版又把它改回去。

### 样式

全部用主题变量：`--dsw-alias-border-l2`、`--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-state-error-primary`、`--dsw-radius-md/sm`、`--dsh-content-font-size`。换主题、换深浅色都不会瞎。

## 数据流全景

```
模型请求失败
    │
    ▼
dsh-agent-loop 错误分支
    │  session.append("assistant/attempt", { turn, step, stream })
    ▼
会话日志（磁盘）
    │  session/event 全量转发
    ▼
前端事件流
    │  ctx.uiConversation.events.register 的 match()
    ▼
插件 definition 捕获 → buildViewNode（visibility: "hidden"）
    │
    ▼
turnTail 槽 → RecoveredAttempts 组件
    │  用户展开、点「加回正文」
    ▼
POST /api/attempt-recover
    │  宿主校验 → session.append("user/message", …, { surfaceOp: "append" })
    ▼
surface 投影 → 下一轮 provider transcript 里出现这段文本
```

## 测试分层

**`selfcheck.mjs`（47 条）** —— 契约形状。导出、路由配置、请求校验分支、definition 的 match/start/buildViewNode、槽注册、组件渲染出的文案与 DOM 属性、`MarkdownText` 的 props。跑得快，改文案就会红。

**`e2e.mjs`（20 条）** —— 端到端。假 session，验证两段各自追加、互不污染、消息身份合法、框架文字正确、以及 append 抛错时响应体必须非空且是合法 JSON。**不用任何 `node_modules` 链接**，这就是运行时真实形态。

两个都不需要真的启动 DSH。
