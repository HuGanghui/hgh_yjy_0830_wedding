# CLAUDE.md

本文档是给 Claude Code 的**行为约束与硬契约**。参考细节（schema、媒体布局、留言板 provider、verify 清单）拆在 `docs/`，按需阅读；**操作手册与部署步骤见 README.md**（已覆盖，本文件不重复）。

## 项目概述

- **一种入口（二维码直达）**：每条目生成 QR 码 → `public/index.html?id=<id>`——URL 只与 baseUrl 和 id 相关，**永不变**。扫码直接看到公开内容（照片 + 描述）；有收件人的门禁条目输入收信码答对后，浏览器本地解密并跳转到专属信件视图。
- **一码多信**：一个条目可携带多封信（config `letters`，如 A-05 同一张照片多收件人扫**同一二维码**各自答自己的码 → 各自专属信）。内容/收件人增删都**无需更换二维码**。
- **零服务器，纯静态**。主托管腾讯云 CloudBase 静态托管；GitHub Pages 作镜像（push 后 CI 自动跟随）。
- **答案本身就是解密密钥**——`config.json` 的 `answer` 从不存储在任何输出里。额外内容（`secret`）经 PBKDF2 派生密钥 + AES-GCM 加密，正确答案认证通过才解密；公开内容（照片/描述/问题）明文。

## 工作规则（强制）

**所有改动必须经 git 管理**，完成一个逻辑单元立即 `git add` + `git commit`；提交前先 `git status` + `git diff` 确认只含预期改动，绝不误提交 `config.json`（含答案/密钥）和 `qrcodes/`。提交信息用中文、动词开头（如 `feat: 新增视频内容支持`）。

- **提交前自动自检**：pre-commit 钩子（`.githooks/pre-commit`）在暂存区涉及 `public/` / `scripts/` / `.githooks/` 时自动跑 `node scripts/verify.js`，任一失败阻止提交；纯文档提交自动跳过。**覆盖清单（① config↔data 互查 ② 真实码解密+错误码被拒 ③ 媒体路径大小写 ④ QR 完整性+jsqr 解码 ⑤ jsdom 解锁流程 ⑥ Lightbox 放大/下载 ⑦ 一码多信 ⑧ 花瓣动效 ⑨ 留言板 ⑩ 背景音乐 ⑪ 歌词 ⑫ emphasis 突出块）详见 [`docs/verify-coverage.md`](docs/verify-coverage.md)。**
- ⚠️ 钩子靠 `git config core.hooksPath .githooks` 生效（配置不随克隆走），**新环境必须先执行这句**，否则钩子不生效。
- **较大功能改动用测试兜底**：新增/修改功能（尤其 `public/index.html` 交互/逻辑）必须同步在 `scripts/verify.js` 补自检测试，与代码一并提交；仅纯文档或样式微调可豁免。新测试未过不得提交。

## 加密契约（改 build.js 或 index.html 任一边都要同步另一边）

| 参数 | 值 | 位置 |
|------|-----|------|
| PBKDF2 | 100000 次迭代, SHA-256, 16 字节随机 salt | build.js 与 index.html 各一份 |
| AES | 256-bit GCM, 12 字节随机 IV, 16 字节 authTag | 同上 |
| 存储布局 | `iv(12) \|\| 密文 \|\| authTag(16)` → Base64 | build.js 拼装 / index.html 拆解 |

`data.json` schema、媒体布局与命名约定（photo 三档变体 / secret 随机名 / music / lyrics）、一码多信路由、key 点见 [`docs/architecture.md`](docs/architecture.md)。解密逻辑核心：不存储「正确答案库」，密码即密钥、解密成功即认证；`letters` 逐封试解密，命中即该收件人。

## 留言板（Guestbook）

扫码页留言框**格式统一**（匿名、无标题/提示/名字输入，占位「给新人留言」、按钮「💌提交」）：公开区框仅**无收件人条目**显示；**有收件人的门禁条目**扫码不显示，解锁后**信件视图**信末显示同格式框。页面不回显他人留言，新人到 CloudBase 控制台查看/导出。

**硬安全约束（必须遵守）**：
- **云函数是唯一写入口，云数据库对客户端零权限**——安全规则设 `{"read": false, "write": false}`，宾客只能经函数写入、永远无法读取他人留言。
- 扫码页只 POST 不 GET，body 仅 `{type, entryId, to, name, text}`，**不带任何权限字段**。
- ⚠️ `public/guestbook.json` 含**客户端连接配置（云函数 HTTP 访问地址 url），是公开配置不是机密**，勿因「像密钥」gitignore 掉（否则线上 404、留言功能静默关闭）。
- ⚠️ `build.js` 与 `index.html` 各有一份 `GB_PROVIDERS` 必填字段表，改一边要改另一边。

provider+options 抽象、换 Supabase 步骤、手动 curl 验证见 [`docs/guestbook.md`](docs/guestbook.md)。

## Git 约定（安全红线）

- `config.json`（含答案即密钥）、`qrcodes/`、`assets/`（源媒体，**务必自行备份原图**）均**已 gitignore、不入库**。
- `public/data.json`、`public/media/`、`public/guestbook.json` 由 `npm run build` 生成，属构建产物，随 `public/` 提交（data.json 符合设计：公开字段明文、额外文字加密）。

## 常用命令 / 部署

构建/验证/部署完整命令与流程见 **README.md**（含 `tcb hosting deploy`、GitHub Pages 镜像、本地 `node server.js` 预览）。Claude 常跑的仅两个：`npm run build`（本地构建）与 `npm run verify`（提交前自检）。

两个运营坑：
- ⚠️ **环境到期**：CloudBase 个人版 **2026-09-17 到期**，到期前须续费/升级，否则静态托管与云函数下线、扫码直接挂。
- ⚠️ **Range 限制**：CloudBase 默认域名（`*.tcloudbaseapp.com`）不支持 HTTP Range，线上视频拉不动进度条；GitHub Pages 镜像支持 Range 可正常看视频。要修需绑自定义 CDN 域名（备案）。本地预览务必用 `node server.js`（支持 Range），不要用 `python3 -m http.server`。
