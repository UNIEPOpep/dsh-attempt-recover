# 参与贡献

感谢你愿意花时间。这个插件很小，贡献流程也保持一样小。

## 开始之前

- 有 bug：直接开 issue，附上 DSH 版本、操作系统，以及界面上出现的完整错误文案（`加回失败：...` 会带错误码）。
- 有新功能想法：先开 issue 说明动机，别直接写一大坨 PR。

## 开发环境

```bash
git clone https://github.com/UNIEPOpep/dsh-attempt-recover.git
cd dsh-attempt-recover
npm test
```

没有构建步骤，没有依赖安装。仓库里的 `.js` 就是会跑的那份文件。

把工作副本装进本地 DSH：

```bash
dsh plugin --profile desktop add "$(pwd)"
```

改完重载：在插件管理里关掉再打开，或者 `set_plugin enabled=false` 再 `true`。

## 提交前必须满足

1. **`npm test` 全绿**（47 + 20 条断言）。
2. **新增行为有对应断言。** 改 `client.js` 加断言到 `selfcheck.mjs`，改 `index.js` 加断言到 `e2e.mjs`。
3. **不引入运行时依赖。** 宿主侧只允许 `node:` 内建模块。这条不是风格偏好：插件以符号链接装进 profile，真实路径下没有 `node_modules`，裸包名会在运行时解析失败。`e2e.mjs` 会在无 `node_modules` 的形态下直接把你拦下。

## 代码约定

- 两侧各自独立：`index.js` 是宿主（Node），`client.js` 是浏览器（React 由 `require("react")` 取得）。不要互相 import。
- 宿主侧的错误一律转成 `{ ok: false, error: { code, message } }` 加 HTTP 状态码，**永远不要**让 handler 抛异常 —— 抛异常会导致空响应体，前端只能报 `Unexpected end of JSON input`。
- 客户端样式只用主题变量（`--dsw-alias-*`、`--dsh-*`），不要写死颜色，否则换主题会瞎。
- 面向用户的文案**必须**用中文，注释用中文或英文皆可。

## PR

- 一个 PR 一件事。
- 描述里说清「为什么」，而不只是「改了什么」。
- 涉及界面改动的，附一张截图。

## 报告问题时的隐私

DSH 的会话日志里可能有你的对话内容。贴日志前请自行删掉不需要的部分 —— 本插件不需要也不要求任何会话原文。
