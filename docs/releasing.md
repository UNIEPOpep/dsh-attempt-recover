# 发布清单

这份文档是给维护者的。**发布是不可逆的**：npm 上的版本一旦发布，即使 72 小时内可以 `npm unpublish`，也已经有人可能装过了。所以每一步都按顺序来。

## 0. 一次性准备

### 仓库与包名

已确定，不需要再改：

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/UNIEPOpep/dsh-attempt-recover` |
| npm 包名 | `@uniepopep/dsh-attempt-recover` |
| 许可证 | AGPL-3.0-only |
| 署名 | `Copyright (C) 2026 UNIEPOpep` |

`package.json` 里已经写好 `repository` / `homepage` / `bugs` / `author` / `publishConfig.access: "public"`。三处名字必须**完全一致**：

| 位置 | 值 |
| --- | --- |
| `package.json` 的 `name` | `@uniepopep/dsh-attempt-recover` |
| `cordis.patch.yml` 的 `name` | `@uniepopep/dsh-attempt-recover` |
| `client.js` 里 `__ModuleLoader__.load({ id })` | `@uniepopep/dsh-attempt-recover` |

第三条最容易漏，而且漏了**不会报错**，只会静默失效：宿主把客户端 bundle 的清单行 id 设成包名（`reconcilePackage(packageName)` → `graphRow(packageName, …)`），浏览器加载时 `arrive(row)` 用 `factories.has(row.id)` 判断"这个 bundle 注册成功了吗"；如果 bundle 注册的是短名，两边的 key 对不上，`arrive` 会一路重试到 `client-modules: could not load "…"` 然后整块前端模块不挂载。改包名时务必三处一起改，`selfcheck.mjs` 的第 71 条断言钉住了第三处。

例外：`client.js` 里的 CSS 命名空间（`style[data-plugin-css="dsh-attempt-recover"]`）与 `NS` 常量可以继续用短名，它们只是选择器字符串，不参与模块解析。

改包名或仓库地址时，这些地方要一起改（漏一处就会有死链）：

```bash
grep -rn "uniepopep\|UNIEPOpep" --include="*.md" --include="*.json" --include="*.yml" . | grep -v node_modules
```

### npm 账号与 scope

```bash
npm login
npm whoami                              # 确认身份
npm view @uniepopep/dsh-attempt-recover version   # 应返回 404，说明版本还没发过
```

scoped 包第一次发布前，scope 要么归你（`@uniepopep` 这个名字在 npm 上已注册给你），要么以公开 scope 发布。`publishConfig.access: "public"` 已经写了，scoped 包不会默认设成私有的。

## 1. 发布前检查

```bash
npm test          # 47 + 20 条断言必须全绿
npm run pack:dry  # 确认打包内容与预期一致
```

`pack:dry` 应该列出 17 个文件、约 170 KB 打包 / 248 KB 解包。当前 `files` 覆盖：两个 JS 半、`cordis.patch.yml`、两个 README、CHANGELOG、CONTRIBUTING、SECURITY、LICENSE、三张 `assets/*.png` 截图、三份 `docs/*.md`、`docs/assets/icon.png`。测试文件、`scripts/`、`.github/` 不进包 —— 它们没有运行时用途。

留意 `assets/` 里那三张截图：它们是 README 的配图，删了会造成 npm 页面上图片裂开。

### 版本号

按语义化版本改：

| 改动 | 版本 |
| --- | --- |
| 修 bug、改文案 | patch（1.0.1） |
| 加功能、加配置项 | minor（1.1.0） |
| 改加回机制、改事件语义、改最低 DSH 版本 | major（2.0.0） |

`CHANGELOG.md` 里把 `[Unreleased]` 的内容挪到新版本标题下，补上日期和对比链接。

### 文档

- `README.md` 与 `README.en.md` 同步更新（两份内容要一致，不能只更一份）
- 新增的错误码要进 `docs/troubleshooting.md` 的表格
- 改了扩展点用法要更新 `docs/architecture.md`
- 许可证相关表述改动时，`README.md`、`README.en.md`、`package.json` 的 `license` 字段、`LICENSE` 头部的署名块四处要一起看

## 2. 打 tag 与建仓库

仓库还没建的话先建，然后：

```bash
git init
git add -A
git commit -m "chore(release): dsh-attempt-recover v1.0.0"
git branch -M main
git remote add origin git@github.com:UNIEPOpep/dsh-attempt-recover.git
git push -u origin main
git tag -a v1.0.0 -m "dsh-attempt-recover v1.0.0"
git push origin v1.0.0
```

push 之后 CI 会自动跑（`.github/workflows/ci.yml`，三平台 × 两个 Node 版本）。**等 CI 绿了再发 npm** —— 发布一个 CI 红着的版本，等于让用户替你测。

## 3. 发布 npm

```bash
npm publish
```

首次发布会问一次 2FA 验证码。`publishConfig.access: "public"` 已经写了，不需要再传 `--access public`。

发布后立刻验证：

```bash
npm view @uniepopep/dsh-attempt-recover version
npm view @uniepopep/dsh-attempt-recover dist.tarball
```

再从一个干净目录装一次，确认装出来的东西能用：

```bash
mkdir -p /tmp/verify && cd /tmp/verify
npm init -y >/dev/null
npm i @uniepopep/dsh-attempt-recover
ls node_modules/@uniepopep/dsh-attempt-recover
```

应该看到 `index.js`、`client.js`、`cordis.patch.yml`、两个 README、LICENSE、`assets/`、`docs/`。

## 4. pnpm

不需要单独发布。pnpm 装的是同一个 npm registry，包发布后 pnpm 立刻可见：

```bash
pnpm add @uniepopep/dsh-attempt-recover --dir ~/.dsh/profiles/desktop
```

如果维护自己的 registry 镜像，记得同步 —— 那是镜像方的事，不是这里的事。

## 5. GitHub Release

用 tag 建 release，正文直接取 `CHANGELOG.md` 对应段落。附上：

- 一句话说明这个版本解决什么
- 安装命令
- 破坏性改动（如果有，放最前面）

## 6. 发布后

- 在本机装一次真实版本，走一遍「失败 → 看到块 → 加回」的完整链路。测试通过不等于真机可用 —— 这个插件已经吃过一次亏（`e2e.mjs` 里临时 symlink 掩盖了模块解析失败）。
- 观察几天 issue。新用户的环境组合比你想象的多。

## 如果发错了

72 小时内可以撤：

```bash
npm unpublish @uniepopep/dsh-attempt-recover@1.0.0
```

超过 72 小时只能发一个 patch 修正。**不要**为了掩盖问题而撤一个已经有人装过的版本 —— 那会让装了的人处于更糟的状态（他们的 lockfile 指向一个不存在的包）。

## 权限与安全

- npm token 用 granular token，只给 `@uniepopep/dsh-attempt-recover` 这一个包 write 权限
- 仓库开 2FA required
- 别把 `.npmrc` 提交进仓库

## 许可证提醒

AGPL-3.0 对网络服务有额外要求：如果有人拿这个插件改一版并作为在线服务提供给别人用，他必须公开自己的修改。发布时不需要额外做什么，但 issue 里被问到时要能答上来 —— 直接指向 [LICENSE](../LICENSE) 第 13 节。
