# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

QR 码加密解锁系统，**一种入口（二维码直达）**：
- **二维码直达（直开）**：每个条目生成一个 QR 码，指向 `public/index.html?id=<id>`——**URL 只与 baseUrl 和 id 相关，永不变**。扫码后直接看到公开内容——照片 + 描述文字（无加密环节）；输入收信码答对后，浏览器本地解密并**跳转到专属信件视图**（「致 [to] + 正文 + 图片/视频 + 落款」的信件卡片）。
- **一码多信**：一个条目可携带多封信（config 用 `letters: [{to, answer, secret}, ...]`，如 A-05：同一张照片，花花/梁雪/小童扫**同一个二维码** → 各自输入自己的收信码 → 各自的专属信件）。内容/收信人增删都**无需更换二维码**。
- 零服务器，纯静态，部署到 GitHub Pages。

**答案本身就是解密密钥**——`config.json` 中的 `answer` 字段从不存储在任何输出里。只有**额外内容（secret）**经 PBKDF2 派生密钥 + AES-GCM 加密：正确答案认证通过才解密成功，错误答案被拒绝，因此没有「正确答案库」可被窃取。公开内容（照片 / 描述 / 问题）为明文。

## 工作规则（强制）

**所有改动都必须通过 git 管理，不得绕过版本控制：**

- 任何修改、新增、删除文件，完成一个逻辑单元后立即 `git add` + `git commit`，不允许改动长期停留在工作区。
- 提交前先 `git status` 和 `git diff`，确认只包含预期改动，绝不误提交 `config.json`（含答案/密钥）和 `qrcodes/`（QR 码）——见下方「Git 约定」。
- 提交信息使用中文、动词开头的描述性写法（参考现有 commit 风格），例如 `feat: 新增视频内容支持`、`fix: 修复答案含中文空格时解密失败`。
- **提交前自动自检**：仓库启用 pre-commit 钩子（`.githooks/pre-commit`，已提交入库）——暂存区涉及 `public/`（构建产物）/ `scripts/` / `.githooks/` 时，`git commit` 自动运行 `node scripts/verify.js`（① config↔data.json 条目互查 ② 真实收信码解密校验 + 错误收信码被拒 ③ 媒体路径磁盘/git 大小写校验 ④ QR 码 PNG 完整性 + jsqr 解码内容 ⑤ jsdom 跑真实 index.html 解锁流程冒烟 ⑥ Lightbox 图片放大预览 + 下载 ⑦ 一码多信（同一二维码多收件人，demo：A-05 花花/梁雪/小童 三码三信）⑧ 动效冒烟（花瓣进页飘落，不影响解锁流程）⑨ 留言板（guestbook.json 与 config 一致性 + 浏览器提交祝福/回信冒烟，含公开块显示/空拦截/POST 请求断言/失败重试/disabled 隐藏）），任一失败**阻止提交**；纯文档提交自动跳过。⚠️ 该钩子靠 `git config core.hooksPath .githooks` 生效（配置不随克隆走），**新环境必须先执行这句**，否则钩子不生效。
- **较大功能改动用测试兜底**：新增或修改功能（尤其是 `public/index.html` 里的交互/逻辑）时，必须同步在 `scripts/verify.js` 中补充对应的自检测试（如解锁流程、Lightbox 的 DOM 冒烟），与代码**一并提交**；仅纯文档或样式微调可豁免。新测试未过不得提交。

## 常用命令

```bash
npm install              # 安装依赖（qrcode + sharp；sharp 用于构建时照片缩放压缩）
cp config.example.json config.json   # 首次创建配置
npm run build            # 构建：读取 config.json → 生成 public/data.json + qrcodes/*.png
npm run verify           # 提交前自检（pre-commit 自动跑）：条目一致性 + 解密链路 + 媒体路径 + QR 内容 + 浏览器流程（含图片放大预览/下载/一码多信/花瓣动效/留言板）
git config core.hooksPath .githooks  # 一次性设置：启用 pre-commit 钩子（新环境必跑）
```

本地验证：
```bash
# 浏览器端验证（模拟 GitHub Pages）——务必用支持 Range 的服务器，否则视频无法拖动进度条
node server.js              # 零依赖，支持 HTTP Range/206。默认端口 8888，目录 public
# 访问 http://localhost:8888/?id=<entryId>
# ⚠️ Python 的 http.server 不支持 Range，视频会「只有声音、画面不动、拉不动进度条」。
#    部署到 GitHub Pages 无此问题（GitHub 支持 Range）。

# Node 端到端加解密验证（一行的 node -e，见 README「测试一」）
# 用 config.json 中的真实 answer 验证解密成功、错误答案被拒绝
```

## 架构与加密契约

数据流：`config.json`（编辑）→ `build.js`（本地加密 + 拷贝媒体 + 留言板配置归一化）→ `public/data.json` + `public/media/` + `public/guestbook.json` + `qrcodes/*.png`（构建产物）→ `public/` 部署。

**build.js 与 index.html 的加密参数必须保持同步**，改动任何一边都要改另一边：

| 参数 | 值 | 位置 |
|------|-----|------|
| PBKDF2 | 100000 次迭代, SHA-256, 16 字节随机 salt | build.js 与 index.html 各一份 |
| AES | 256-bit GCM, 12 字节随机 IV, 16 字节 authTag | 同上 |
| 存储布局 | `iv(12) \|\| 密文 \|\| authTag(16)` → Base64 | build.js 拼装 / index.html 拆解 |

`public/data.json` schema（构建时写入，浏览器 fetch 后读取）：
```json
{
  "<id>": {
    "question": "问题",
    "description": "公开描述文字",
    "photo": "media/<id>/photo/xxx.jpg",   // 位图照片为 1600px 回退档；SVG 照片原样
    "photoW": 1600,   // 可选：输出照片宽高（页面据此占位，防加载时布局跳动）
    "photoH": 2133,
    "letters": [      // 门禁条目：每封信各自加密（答案即该收件人的密钥）
      { "to": "收件人", "salt": "Base64 的 16 字节随机盐", "data": "Base64 的 [iv(12) || GCM密文 || authTag(16)]" }
    ]
  }
}
```
**无收件人条目**（config 省略 `to`/`letters`）在 `data.json` 中只有 `description` 与 `photo` 两个字段，不加密、无 `letters`——页面据此（`entry.letters` 是否存在且非空）判断是否渲染问题与解锁区。config 顶层 `to`/`answer`/`secret` 简写等价于 `letters` 单元素，构建时归一化。

解密后的 payload（额外内容）：
```json
{ "text": "额外的话", "images": ["media/<id>/secret/随机名.jpg"], "videos": ["media/<id>/secret/随机名.mp4"] }
```

**关键点：**
- 媒体由 `build.js` 的 `copyMedia()` 拷贝到 `public/media/<id>/`：公开照片放 `photo/`（保留原文件名），secret 图片/视频放 `secret/`（文件名随机：`crypto.randomBytes(16).toString('hex')` + 扩展名）。data.json 只存路径。**每次构建会先清空整个 `public/media/` 和 `qrcodes/`**，保证产物与 config 严格一致、不残留旧文件（避免过期 QR 码被误发）。
- **照片自动优化（响应式）**：位图照片（jpg/jpeg/png/webp/heic 等）构建时经 `sharp` 摆正（EXIF）并生成 **480/960/1600 三档 × AVIF(q45)/WebP(q80)/JPEG(q75 渐进)**，带透明通道的压平到白底；`photo/<base>.jpg` 是 1600px 回退档。页面 `index.html` 用 `<picture>`+`srcset>` 按屏幕/DPR 选档，手机端只下载 ~60-220KB（实测最重的照片从 584KB 降到 WebP 216KB / AVIF 86KB）。secret 图片答对后才显示，保持单档 JPEG。视频与 SVG 原样拷贝；优化失败自动回退原样拷贝。相机原图动辄 5-11MB。源文件在 `assets/` 不受影响。
  - ⚠️ 变体文件名约定：`photo/<base>-480|960|1600.(jpg|webp|avif)`，`index.html` 据此拼 URL，`scripts/verify.js` 会校验变体齐全（改约定要两边同步）。
- secret 的 `text` 加密进每封信的 `data` 字段；公开字段（`question`/`description`/`photo`）为明文。`to` **可选**：无特定收件人的照片可省略，页面不显示「To 某人」标签；**有收件人**（含一码多信）公开区 To 标签**并列展示全部收件人**——单收件人「To 某人」、多收件人如「To 花花 / 梁雪 / 小童」（`index.html` 用 `entry.letters.map(l => l.to).join(' / ')` 拼）。
- **有无收件人（letters 非空）决定是否为解锁条目**：有收件人 → 必有 `question`，每封信必有 `to`/`answer`/`secret`，额外内容分别用各自 answer 加密（`build.js` 校验并加密）；无收件人 → 仅照片+描述，`question`/`answer`/`secret`/`letters` 被忽略并告警，不产出 `letters`。
- **secret 媒体是 `public/` 下可直链的静态文件**——路径随机只是防枚举的缓解，不是真正的机密性（用户已接受该取舍）。⚠️ **仓库已公开**（GitHub Pages 免费方案要求公开仓库）：`public/media/<id>/secret/` 里的 secret 文件，任何人可直接浏览仓库下载——随机名只防「猜 URL」，不防「逛仓库」（`assets/` 源文件已 gitignore、不入库）。用户已知悉并选择接受（曾考虑媒体加密方案，暂缓）。若日后要真保密，改走「build 加密媒体 + 浏览器解密」方案。图片/视频加载用 `<img>` / `<video controls preload="metadata">` 直链，**已无 Blob URL 逻辑**。
- 解密入口在 `public/index.html` 的 IIFE 脚本：加载后先渲染公开区 → `base64ToBytes()` → PBKDF2 deriveKey → `crypto.subtle.decrypt` → JSON.parse → 渲染 `text/images/videos`。解锁走 `tryUnlock()`：对 `entry.letters` **逐封试解密** `decryptPayload(letter, answer)`（失败返回 null），命中即该收件人 → 渲染对应专属信件。**不存储任何「正确答案库」**——密码即密钥，解密成功即认证。
- ⚠️ **一码多信 → 同一信封内各封信的 `answer` 必须唯一**：同一收信码命中多个收件人会路由歧义（`scripts/verify.js` 会打印重复的 id+收件人作提醒，不阻断）。不同信封（不同条目）之间答案重复**无影响**——每张二维码只路由到自己的条目。
- **专属信件视图**：答对后 `renderLetter(to, payload)`——隐藏公开区（照片/描述/输入），展示信件卡片：`致 [to]` + 正文（`white-space: pre-wrap`）+ secret 图片/视频 + 落款「来自新人的祝福」。图片继续走 Lightbox 放大预览 / 下载。
- **裸地址（无 `?id=`）无统一入口**：页面直接提示「请扫描收到的二维码」，不再有输码路由页。
- `public/index.html` 是零依赖单文件（原生 HTML/CSS/JS），移动端优先。
- base64 用浏览器原生 `atob` / Node `Buffer`，注意 UTF-8 中文用 `TextEncoder`/`TextDecoder` 统一处理。

## 留言板（Guestbook）：朋友写祝福 / 回信（云数据库直写）

扫码页增加留言输入框：**公开区**「给新人的祝福」（所有扫码者，含无收件人条目）+ 解锁后**信件视图**信末「给收件人的回信」。只收集给新人看，**页面不回显他人留言**——新人到 CloudBase 控制台查看/导出。

**存储抽象（provider + options）**：`config.json` 的 `guestbook` 块声明后端，页面用 `GB_PROVIDERS` 适配器 map 分发，换后端零页面逻辑改动：
```json
"guestbook": {
  "enabled": true,
  "provider": "cloudbase",
  "options": {
    "url": "https://<环境ID>.service.tcloudbase.com/guestbook"
  }
}
```
- 当前实现 **cloudbase**（腾讯云）：页面把留言 POST 到配置的 `url`（云函数 Web 触发器），纯 REST 零 SDK。可部署的函数代码在 `cloudbase/guestbook/`。
- build.js 与 `public/index.html` 各有一份 `GB_PROVIDERS` 必填字段表，**改一边要改另一边**。
- 未配置或校验失败 → build 写出 `public/guestbook.json` = `{"enabled": false}`（留言功能关闭，页面不显示输入框；config 无此块时构建**不报错**，属正常关闭态）。

**安全模型（重要）**：云函数是**唯一写入口**，云数据库对客户端**零权限**——宾客只能经函数写入、永远无法读取他人留言。
- **云数据库安全规则**（控制台配置，唯一强制层）：`guestbook` 集合安全规则设为 `{"read": false, "write": false}`；写数据只经云函数（函数用管理端身份，不受规则限制）。
- **云函数**（`cloudbase/guestbook/`）负责校验（非空/长度）+ 写库 + 应答 CORS 预检；扫码页只 POST 不 GET，body 仅 `{type, entryId, to, name, text}`，不携带任何权限字段。
- 客户端连接配置（云函数 Web 触发器 `url`）公开进页面属设计接受（`public/guestbook.json` 随 `public/` 提交）；安全靠「数据库零权限 + 函数校验 + 免费额度限流」兜底。
- 新人读取：CloudBase 控制台 → 云开发 → 数据库 → `guestbook` 集合（或导出）。免费体验版 3000 资源点/月（云函数调用 13.3 点/万次、数据库读写 200 点/万次），500 条留言约千分之几，完全覆盖。

**换 Supabase**：`index.html` 的 `GB_PROVIDERS` 加 `supabase.submit`（POST `${url}/rest/v1/${table}` + `apikey`/`Authorization: Bearer` 头）、`build.js` 的 `GB_PROVIDERS` 加必填表 `['url','anonKey','table']`、config 换 options、控制台开 RLS「仅插入、禁止读」。

**verify 覆盖**（`scripts/verify.js`）：① 构建产物一致性 `checkGuestbookBuild`（config ↔ guestbook.json 逐字段）；② 浏览器冒烟 `checkGuestbookFlow`（公开块显示含无收件人、空文本拦截、POST URL/头/body 不含权限字段、成功反馈后可复用、失败保留输入、解锁后回信归属收件人、disabled 隐藏）。⚠️ 服务端权限（云数据库安全规则）强制力无法在 jsdom 测，需手动 curl 验证一次（POST 应 200 + `{"code":0}`、空文本应 400、OPTIONS 预检应带 CORS 头）。

## Git 约定（安全相关）

- `config.json` **已 gitignore**——含答案（即密钥），切勿提交。
- `qrcodes/` **已 gitignore**——QR 码通过私聊分发给对应的人，切勿提交到公开仓库。
- `public/data.json` 与 `public/media/` 均由 `npm run build` 生成，属构建产物（`public/data.json` 现已提交、符合设计：公开字段明文、额外文字加密）。
- `public/guestbook.json` 也是构建产物，随 `public/` 提交——含**客户端连接配置（云函数 Web 触发器 url），这是公开配置不是机密**，勿因「像密钥」而 gitignore 掉（否则线上 404、留言功能静默关闭）。
- config 中的 `photo`/`secret.images`/`secret.videos` 指向**源媒体文件**（如 `assets/`，不在 `public/` 下）。`assets/` 与 `config.json` 一样**已 gitignore、不入库**——源媒体只在本地（**务必自行备份原图**），构建产物 `public/` 照常提交部署。
- 修改内容后重新 `npm run build` 并重新部署 `public/` 即可更新，无需改 QR 码（URL 不变）。

## 部署

`public/` 是纯静态目录，整个项目用一个 git 仓库（外层），由 `.github/workflows/deploy.yml` 在 push 到 main 时自动把**已提交的 public/** 部署到 GitHub Pages（Settings → Pages → Source: GitHub Actions）。CI **不执行** `npm run build`（config.json 含答案、不入库，CI 无法重建）——约定「本地 `npm run build` → 提交产物 → push → 自动上线」。也可换任何静态托管（Vercel/Netlify/COS 等）。
