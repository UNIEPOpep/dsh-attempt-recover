# 安全策略

## 报告漏洞

请不要在公开 issue 里披露安全问题。用 GitHub 的 [Private Vulnerability Reporting](https://github.com/UNIEPOpep/dsh-attempt-recover/security/advisories/new)，或直接邮件联系维护者。

请包含：受影响的版本、复现步骤、影响范围，以及你认为的严重程度。通常会在 7 天内回复。

## 这个插件能碰到什么

了解攻击面有助于判断你看到的问题是否严重。

**宿主侧（`index.js`）**

- 注册一个 HTTP 路由 `/api/attempt-recover`，只接受 `POST`，只做一件事：把指定会话里某个 `assistant/attempt` 的文本追加成一条 `user/message`。
- 该路由受 Harness 自己的浏览器鉴权保护（`admit(req)`），未经认证的请求不会进入 handler。插件不实现、也不绕过鉴权。
- 请求体校验：`sessionId` 必须是非空字符串且能解析到真实会话，`seq` 必须是非负安全整数且在该会话中真实存在，`section` 必须是 `text` 或 `reasoning`。任何一项不过就拒绝，不做任何写入。
- 不读文件系统，不发起网络请求，不执行子进程。仅使用 `node:crypto` 的 `randomUUID`。

**浏览器侧（`client.js`）**

- 只读取当前会话已经下发到前端的事件，不额外请求后端（除加回按钮触发的那个 POST）。
- 渲染 Markdown 时使用 Harness 自带的 `MarkdownText`，不自行解析 HTML，不注入 `dangerouslySetInnerHTML`。
- 注入的 CSS 是一段静态常量，选择器限定在 `[data-recovered-body]` 下，不逃逸到全局。

**权限**

插件以你的用户权限运行，与 DSH 本身相同。它不做提权，也不请求任何额外权限。

## 支持的版本

安全修复只针对最新发布的次版本。请保持更新。
