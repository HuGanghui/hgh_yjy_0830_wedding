# QR 码加密解锁系统

扫码直接看到照片与描述，回答一个「To 某人」的问题，答对后解锁额外内容（文字/图片/视频）。零服务器，纯静态托管，浏览器本地解密。

没有特定收件人的照片可省略 `to` 字段：这类条目扫码后**只显示照片 + 描述**，无解锁环节（适合一次性把一批照片分享出去）。

## 使用场景

你有若干组内容，希望定向分享给特定的人。每个人扫不同的 QR 码，先看到公开的照片与描述，再回答一个只有 ta 知道答案的问题，答对后在浏览器中看到专属的额外内容（一段话 / 图片 / 视频）。

## 工作原理

```
config.json          build.js              public/
(你编辑)      →      (本地运行：      →      (部署到 GitHub Pages)
                      加密+拷贝媒体)
                         │
                         └──→ qrcodes/*.png  (QR 码，分发给对应的人)
```

### 完整流程

```
┌──────────────┐     扫一扫       ┌──────────────────────────────┐
│   QR 码      │  ───────────→   │  解锁页面 (GitHub Pages)       │
│ ?id=alice    │                 │                              │
└──────────────┘                 │  🖼 照片 + 描述文字             │
                                 │  ❓ To 阿杰：我们第一次见面…？  │
                                 │  [输入框]  [解锁]              │
                                 │                              │
                                 │  答案正确 → 解密 → 额外内容     │
                                 │  答案错误 → 认证失败 → 拒绝    │
                                 └──────────────────────────────┘
```

1. 你在本地编辑 `config.json`，填入收件人、问题、答案、公开照片与描述、额外内容（文字/图片/视频）
2. 运行 `node build.js`：拷贝媒体到 `public/media/`，用答案作为密钥 AES-256-GCM 加密额外内容，生成 `public/data.json` 和 QR 码 PNG
3. 将 `public/` 目录部署到 GitHub Pages
4. 将 QR 码图片分发给对应的人
5. 对方扫描 QR 码 → **直接看到**照片 + 描述 + 问题 → 输入答案 → 浏览器本地解密 → 看到额外内容

## 安全设计

### 答案即密钥

答案本身不存储在代码或数据中。答案通过 PBKDF2（10 万次迭代，SHA-256）派生为 AES-256 密钥。正确答案才能派生出正确的解密密钥，没有「正确答案库」可以被窃取。

### AES-256-GCM 认证加密

GCM 是一种认证加密模式，解密时自动验证数据完整性。如果密钥不对（即答案错误），解密操作会直接抛出异常——验证答案正确性的不是代码逻辑，而是密码学原语。

```
答案 ──PBKDF2(100000次)──→ AES-256 密钥
                              │
内容 ──AES-256-GCM 加密──────→ 密文 + 认证标签
                              │
                    解密时：密钥不对 → GCM 认证失败 → 拒绝
```

### 攻击面分析

| 攻击方式 | 防御措施 |
|---------|---------|
| 直接查看 data.json | 内容是 AES-256-GCM 加密的二进制密文（Base64 编码），无法解读 |
| 暴力枚举答案 | PBKDF2 10 万次迭代，单次尝试约 100-200ms，每秒只能试 5-10 个答案 |
| 浏览器开发者工具 | 解密在内存中进行，页面不暴露原始密钥 |
| 篡改 data.json | GCM 认证标签会检测到任何篡改，解密失败 |
| 额外图片/视频被猜到 URL | secret 媒体文件名随机（16 字节 hex），路径不可猜测，防的是枚举而非密码学机密。图片/视频是 `public/` 下可直链的静态文件 |
| 截图/录屏 | 无法防御。如需防截屏，需使用端到端加密通讯工具（如 Signal 阅后即焚） |

### 安全边界说明

本方案保护的是**内容机密性**——不知道答案的人无法看到内容。它不是为防御国家级攻击者设计的，而是让分享变得有门槛、有仪式感。如果你需要军事级别的安全，请使用端到端加密通讯工具。

## 项目结构

```
qr-unlock/
├── README.md             # 本文档
├── package.json           # npm 项目配置
├── build.js               # 构建脚本（加密额外内容 + 拷贝媒体 + 生成 QR 码 + 留言板配置归一化）
├── server.js              # 本地预览服务器（零依赖，支持 Range/206，视频可拖进度条）
├── scripts/
│   └── verify.js          # 构建产物自检（pre-commit 调用；条目一致性 + 解密 + 媒体路径 + QR + 浏览器流程 + 留言板）
├── .githooks/
│   └── pre-commit         # 提交前钩子（需 git config core.hooksPath .githooks 启用）
├── config.json            # 条目配置（你编辑，已 gitignore）
├── config.example.json    # 示例配置（可提交）
├── assets/                # 源媒体文件（照片/图片/视频，config 引用；已 gitignore、仅本地，务必自行备份原图）
├── .gitignore
├── qrcodes/               # 生成的 QR 码 PNG（已 gitignore）
└── public/                # 部署到 GitHub Pages
    ├── index.html          # 解锁页面（单文件，零依赖）
    ├── data.json           # 数据（公开字段明文 + 额外内容加密）
    ├── guestbook.json      # 留言板客户端配置（enabled/provider/options；未启用时 {"enabled":false}）
    └── media/              # 构建时拷贝的媒体（公开照片 / secret 随机名文件）
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 编辑配置

```bash
cp config.example.json config.json
```

编辑 `config.json`：

```json
{
  "baseUrl": "https://你的用户名.github.io/仓库名",
  "entries": [
    {
      "id": "alice-2024",
      "to": "阿杰",
      "question": "我们第一次见面的地方是哪里？",
      "answer": "西湖边的星巴克",
      "photo": "assets/photo.jpg",
      "description": "这是我们的第一张合照…\n\n支持多行文本。",
      "secret": {
        "text": "答对后的悄悄话…",
        "images": ["assets/secret-1.jpg"],
        "videos": ["assets/secret-video.mp4"]
      }
    }
  ]
}
```

**字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `baseUrl` | 是 | GitHub Pages 的访问地址，末尾不加 `/` |
| `entries[].id` | 是 | 唯一标识，英文/数字/短横线，会成为 URL 的 `?id=` 参数 |
| `entries[].to` | 否 | 收件人称呼，页面显示为「To 阿杰」。**无特定收件人的照片省略此字段**：该条目只展示公开照片+描述，不显示问题与解锁环节（见下方「无收件人条目」） |
| `entries[].question` | 否\* | 扫码后显示的问题。**\*仅当有 `to` 收件人时必填**——有收件人才有解锁环节 |
| `entries[].answer` | 否\* | 正确答案，也是解密密钥，不会被存储到任何地方。**\*仅当有 `to` 收件人时必填** |
| `entries[].photo` | 否 | 公开照片路径，扫码直接可见，复制到 `public/media/<id>/photo/` |
| `entries[].description` | 是 | 公开文字，描述这张照片（无 `to` 的条目只需此项 + `photo`） |
| `entries[].secret.text` | 否 | 答对后显示的额外段落（仅当有 `to` 收件人时使用） |
| `entries[].secret.images` | 否 | 答对后显示的图片路径数组，复制到 `public/media/<id>/secret/`（随机文件名，仅当有 `to` 时使用） |
| `entries[].secret.videos` | 否 | 答对后显示的视频路径数组，同上（仅当有 `to` 时使用） |

**无收件人条目**：若照片没有特定收件人，省略 `to` 字段即可。此时条目只需 `id` / `photo` / `description`，页面扫码后**只显示照片与描述**，不出现问题、答案输入框和解锁按钮，也没有额外内容（`question` / `answer` / `secret` 会被构建脚本忽略并提示）。这类条目的 QR 码同样生成，便于把所有照片一次性分享出去。

### 启用留言板（可选）：让朋友写祝福 / 回信

扫码页默认不显示留言框。要启用，需要部署一个只写不读的云函数并填入 `config.json` 的 `guestbook` 块（build 会写出 `public/guestbook.json`，页面据此显示留言框）。后端是**腾讯云 CloudBase**（LeanCloud 已停服，此为官方迁移推荐方案）：

1. **注册腾讯云并创建环境**：[云开发 CloudBase](https://cloud.tencent.com/product/tcb) → 新建环境（免费体验版即可；若遇 Web 触发器限制则用个人版 19.9 元/月，婚礼当月够用）。
2. **部署云函数**：把仓库 `cloudbase/guestbook/` 目录部署为一个云函数（新建函数 → 上传该目录），配置 **Web 触发器**（触发路径如 `/guestbook`，方法 POST），复制生成的**触发器 URL**。
3. **创建集合并收紧权限**：云数据库新建集合 `guestbook`，安全规则设为（关键，防任何人读/改）：
   ```json
   { "read": false, "write": false }
   ```
4. 把触发器 URL 填入 config：
   ```json
   "guestbook": {
     "enabled": true,
     "provider": "cloudbase",
     "options": { "url": "https://<环境ID>.service.tcloudbase.com/guestbook" }
   }
   ```
5. 重新 `npm run build` → 提交 `public/` → push 上线。

完整部署步骤（含 curl 验证）见 [`cloudbase/guestbook/README.md`](cloudbase/guestbook/README.md)。

**启用后页面效果**：每个扫码页的照片/描述下方出现「💌 给新人的祝福」（所有条目都有），答对收信码的信件视图信末出现「💌 给收件人的回信」。朋友填名字（选填）+ 留言（必填）提交后经云函数直写云数据库；**页面不回显他人留言**——你在 CloudBase 控制台「云开发 → 数据库 → guestbook 集合」里查看，或点「导出」。

**安全说明（必读）**：云函数是**唯一写入口**，`guestbook` 集合对客户端**零权限**（安全规则 read/write 全关）——宾客只能经函数写入、永远无法读取他人留言。扫码页只 POST 不 GET，body 仅 `{type, entryId, to, name, text}`，不带任何权限字段；`url` 是公开连接配置、本就在页面 JS 里（`public/guestbook.json` 随仓库提交），属设计接受。免费体验版 3000 资源点/月（云函数调用 13.3 点/万次、数据库读写 200 点/万次），几百条留言约千分之几的消耗。

**想换其他云数据库（如 Supabase）**？存储做了 provider 抽象：加一个适配器（`index.html` 的 `GB_PROVIDERS` + `build.js` 的必填表 + config 换 options），页面逻辑零改动。

### 3. 构建

```bash
npm run build
```

构建后：
- `qrcodes/` 目录下生成每个条目的 QR 码 PNG（构建前清空，保证与 config 一致、无残留）
- `public/data.json` 写入数据（公开字段明文 + 额外内容加密）
- `public/media/<id>/` 拷贝媒体：公开照片保留原文件名（自动生成 480/960/1600 三档 × AVIF/WebP/JPEG，页面按屏幕选档，扩展名统一为 `.jpg` 回退，带透明通道的压平到白底），secret 图片/视频使用随机文件名

### 4. 部署到 GitHub Pages

整个项目用一个 git 仓库（外层），GitHub Actions 自动把 `public/` 部署上线。**无需在 `public/` 内再建 git。**

**一次性设置：**

1. 在 GitHub 新建仓库，把整个项目推上去（`config.json` / `qrcodes/` / `media-source/` / `assets/` 已被 `.gitignore` 排除，不会上传；答案即密钥始终不入库，源媒体原图只在本地）：
   > ⚠️ `assets/` 不进仓库后，原图仅存于你的本地，**请务必把 `assets/` 备份到 U 盘 / 网盘等**，以防误删或换机丢失。
   ```bash
   git remote add origin https://github.com/你的用户名/仓库名.git
   git push -u origin main
   ```
2. 仓库 Settings → Pages → Source 选择 **GitHub Actions**。

仓库里已包含 `.github/workflows/deploy.yml`：每次 push 到 `main` 就自动把**已提交的 `public/`** 部署到 Pages（不执行 `npm run build`——config.json 含答案不入库，CI 里没有它无法重建，所以约定「本地构建 → 提交产物 → push → 自动上线」）。

**日常更新流程：**

```bash
# 改内容：编辑 config.json（或新增 assets/ 源文件）
npm run build          # 重新生成 public/data.json + public/media/ + qrcodes/
git add .              # config.json/qrcodes/ 自动被忽略，只会上传安全内容
git commit -m "更新内容"
git push               # push 后 Actions 自动部署，几分钟后线上更新
```

### 5. 分发 QR 码

将 `qrcodes/` 目录下的 QR 码图片发给对应的人。**请通过私聊发送，不要提交到公开仓库。**

你可以直接发送 PNG 图片，对方用手机相机或微信/支付宝扫码即可。

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 加密（构建时） | Node.js `crypto` | AES-256-GCM + PBKDF2-SHA256 |
| 解密（浏览器） | Web Crypto API (`crypto.subtle`) | 浏览器原生，零额外依赖 |
| 图片优化 | `sharp` (npm) | 构建时照片生成 480/960/1600 三档 × AVIF/WebP/JPEG，页面 `<picture>`+`srcset>` 按屏选档，手机端下载量减 3~6 倍 |
| QR 码生成 | `qrcode` (npm) | 500px PNG，适合手机扫描 |
| 前端页面 | 原生 HTML/CSS/JS | 单文件约 250 行，移动端优先 |
| 留言板存储 | 腾讯云 CloudBase（云函数 Web 触发器 + 云数据库，原生 fetch） | 客户端只 POST 不 GET，云函数是唯一写入口，provider 抽象便于换 Supabase 等 |
| 测试（dev） | `jsdom` + `jsqr` (npm) | pre-commit 自检：jsdom 跑真实 index.html 解锁流程，jsqr 解码 QR 内容 |
| 托管 | GitHub Pages | 免费，全球 CDN |

### 数据格式

`public/data.json` 格式：

```json
{
  "<id>": {
    "to": "阿杰",
    "question": "显示给扫码者的问题",
    "description": "公开描述文字",
    "photo": "media/<id>/photo/xxx.jpg",
    "salt": "Base64 编码的 16 字节随机盐",
    "data": "Base64 编码的 [IV(12字节) || AES-GCM密文 || 认证标签(16字节)]"
  }
}
```

**无收件人条目**（config 中省略 `to`）在 `data.json` 中只有 `description` 与 `photo` 两个字段，不加密、不生成 `salt`/`data`：

```json
{
  "<id>": {
    "description": "公开描述文字",
    "photo": "media/<id>/photo/xxx.jpg"
  }
}
```

解密后的额外内容 payload 格式：

```json
{
  "text": "额外的一段话",
  "images": ["media/<id>/secret/随机名.jpg"],
  "videos": ["media/<id>/secret/随机名.mp4"]
}
```

`to` / `question` / `description` / `photo` 为公开字段，扫码即可见（`to` 可选：无特定收件人的条目省略该字段，页面不显示 To 标签）。`data` 中加密的是额外内容：`text` 为文字，`images` / `videos` 为构建时拷贝到 `public/media/<id>/secret/` 的静态文件路径（随机文件名）。浏览器答对后解密得到这些路径，用 `<img>` / `<video>` 直接加载渲染。

## 本地验证测试

部署前建议在本地完成两个维度的验证，确保加解密逻辑和页面功能正常。

### 提交前自动自检（pre-commit 钩子）

仓库启用 pre-commit 钩子：暂存区涉及 `public/`（构建产物）等时，`git commit` 自动运行 `node scripts/verify.js`，任一检查失败会**阻止提交**：

1. **条目一致性**：`config.json` 与 `public/data.json` 相互对得上（防「改了配置忘了重新构建」）
2. **加解密链路**：用 `config.json` 的**真实答案**解密每个有收件人条目的密文；错误答案应被 GCM 认证拒绝
3. **媒体路径**：`photo` 及答对后可见的 `images`/`videos` 在磁盘上大小写精确存在，且与 git 实际跟踪名一致（拦 macOS `core.ignorecase=true` 把文件名大小写搞反、上线 404 的坑）
4. **QR 码**（测试三）：每个 `qrcodes/<id>.png` 存在、是有效 500×500 PNG、非空；并用 `jsqr` 解码，断言编码内容 == `baseUrl?id=<id>`
5. **浏览器流程**（测试二）：用 `jsdom` 加载真实 `public/index.html`，模拟输入答案点击解锁——公开区直接渲染、错误答案提示「答案不正确」、正确答案解锁出 secret 区（能抓住 `index.html` 自身的解密参数/流程被改坏——Node 端解密查不出这个）
6. **留言板**：构建产物一致性（`config.guestbook` ↔ `public/guestbook.json` 逐字段）+ 浏览器冒烟（公开祝福块显示含无收件人条目、空文本拦截不发请求、POST 的 URL/头/body 正确且不含权限字段、成功反馈后可复用、失败保留输入可重试、解锁后信件回信归属收件人、disabled 时隐藏）

纯文档/代码类提交（不涉及 `public/`/`scripts/`/`.githooks/`）会自动跳过，不付出额外耗时。也可手动运行 `npm run verify`（与钩子内容相同）。

> ⚠️ 钩子文件 `.githooks/pre-commit` 已提交入库，但让 git 使用它需一次性设置——**新克隆/新环境都要执行一次**（该配置不随克隆走）：
> ```bash
> git config core.hooksPath .githooks
> ```

### 测试一：Node.js 端到端加解密验证

验证构建脚本生成的密文能否被正确解密，以及错误答案是否被拒绝。

```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');

const data = JSON.parse(fs.readFileSync('public/data.json', 'utf-8'));

// 取第一个条目测试（也可指定 id）
const ids = Object.keys(data);
const testId = ids[0];
const entry = data[testId];

console.log('📋 测试条目:', testId);
console.log('❓ 问题:', entry.question);

// 解码
const salt = Buffer.from(entry.salt, 'base64');
const combined = Buffer.from(entry.data, 'base64');
const iv = combined.subarray(0, 12);
const ciphertext = combined.subarray(12, combined.length - 16);
const authTag = combined.subarray(combined.length - 16);

console.log('📐 IV:', iv.length, 'bytes | 密文:', ciphertext.length, 'bytes | Tag:', authTag.length, 'bytes');

// ── 正确答案测试 ──
const correctAnswer = '你的正确答案';  // 替换为实际答案
const key = crypto.pbkdf2Sync(correctAnswer, salt, 100000, 32, 'sha256');

try {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  console.log('✅ 正确答案 → 解密成功');
  console.log('📄 内容:', decrypted.toString('utf-8'));
} catch (e) {
  console.log('❌ 解密失败（不应该发生）:', e.message);
}

// ── 错误答案测试 ──
const wrongAnswer = '随便猜的答案';
const wrongKey = crypto.pbkdf2Sync(wrongAnswer, salt, 100000, 32, 'sha256');

try {
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrongKey, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  console.log('❌ 错误答案 → 意外解密成功（不应该发生）');
} catch (e) {
  console.log('✅ 错误答案 → 解密被正确拒绝');
}
"
```

**预期输出：**

```
📋 测试条目: alice-2024
❓ 问题: 我们第一次见面的地方是哪里？
📐 IV: 12 bytes | 密文: XX bytes | Tag: 16 bytes
✅ 正确答案 → 解密成功
📄 内容: {"text":"...","images":[],"videos":[]}
✅ 错误答案 → 解密被正确拒绝
```

**如果正确答案解密失败怎么办？** 检查 `correctAnswer` 变量的值是否与 `config.json` 中的 `answer` 严格一致（包括空格、标点符号、中英文全角/半角）。

### 测试二：浏览器端页面功能验证

用本地 HTTP 服务器模拟 GitHub Pages 环境，在浏览器中打开解锁页面。

```bash
# 在项目根目录启动本地服务器（零依赖，支持 HTTP Range，视频才能拖进度条）
node server.js
# 默认端口 8888，服务 public/ 目录
```

> ⚠️ **不要用 `python3 -m http.server` 预览视频**：它不支持 HTTP Range 请求，视频会「只有声音、画面不动、拉不动进度条」。`server.js` 已实现 Range/206，`node server.js` 直接可用；部署到 GitHub Pages 无此问题（GitHub 支持 Range）。

然后浏览器访问：

```
http://localhost:8888/?id=你的条目id
```

**验证清单：**

| 序号 | 操作 | 期望结果 |
|------|------|---------|
| 1 | 打开页面 | **直接看到**照片 + 描述 + To 某人 + 问题（无需先答题） |
| 2 | 不输入，直接点「解锁」 | 提示「请输入答案」 |
| 3 | 输入错误答案，点「解锁」 | 按钮短暂显示「验证中…」，然后提示「答案不正确」，输入框抖动 |
| 4 | 输入正确答案，点「解锁」 | 按钮短暂显示「验证中…」，然后显示额外段落/图片/视频（视频可播放） |
| 5 | 用手机扫码 QR 码（同一 Wi-Fi 下用局域网 IP） | 跳转到页面，流程同上 |
| 6 | 用浏览器开发者工具切换到移动端视口 | 页面布局正常，按钮和输入框大小适合触屏 |
| 7 | 打开一个**无收件人**条目（config 中省略 `to`，如 `A-07`） | 只显示照片 + 描述，**没有**问题、输入框、解锁按钮，也没有底部文案 |

> **提示**：测试手机扫码时，如果手机和电脑在同一局域网，将 `localhost:3456` 替换为电脑的局域网 IP（如 `http://192.168.1.100:3456/?id=xxx`），然后用 [QR 码生成工具](https://qr-code.io) 临时生成一个指向该地址的 QR 码，即可在手机上测试完整流程。

### 测试三：QR 码扫描距离测试

QR 码图片尺寸为 500×500px，适合屏幕展示和手机扫描。验证方法：

```bash
# 查看生成的 QR 码尺寸
file qrcodes/*.png
```

在手机上测试扫描：
- **屏幕展示**：将 QR 码在电脑屏幕上打开，手机距离屏幕 20-40cm 扫描
- **微信发送**：将 PNG 发给对方，对方在微信中长按识别
- **打印**：打印在 A4 纸上（建议不小于 3×3cm），手机扫描

如果扫描困难，可调整 `build.js` 中的 QR 码参数：增大 `width`、减小 `margin`，或在二维码旁用文字标注 URL。

## 常见问题

### QR 码扫不出来怎么办？

QR 码的 URL 非常短（例如 `https://xxx.github.io/repo?id=alice-2024`），密度很低，几乎所有手机都能轻松扫描。如果扫不出，尝试在光线充足的环境下，或使用系统相机直接扫码。

### 可以修改已经发出的内容吗？

可以。内容修改后，重新运行 `node build.js`，重新部署 `public/` 目录即可。但需要注意：如果改了答案，已经发出的 QR 码对应的答案也需要同步告知对方。

### 照片和额外内容会暴露吗？

公开照片与描述是设计上「扫码即见」的，本来就是对所有人可见的。额外内容里，`text` 经 AES-256-GCM 加密存在 `data.json`，看不到明文；图片/视频是 `public/` 下文件名随机的静态文件，路径不可猜测，但本质上属于「防枚举」而非密码学机密。

### 额外内容可以被保存吗？

额外文字是纯展示的；图片/视频是 `public/` 下的静态文件——知道 URL 就能访问和保存，可以截图或下载，这是任何静态托管方案都无法防御的。随机文件名能防止被扫目录枚举，但达不到密码学机密级别。如果你需要防截屏，请使用支持阅后即焚的端到端加密通讯工具。

### 可以不用 GitHub Pages 吗？

`public/` 目录的内容是纯静态文件，可以部署到任何静态托管服务：Vercel、Netlify、Cloudflare Pages、腾讯云 COS、阿里云 OSS 等。

### 可以支持更多格式的内容吗？

解密后的额外内容 payload 是 JSON，`text` 支持纯文本（HTML 标签会被转义），`images` 支持图片，`videos` 支持视频（MP4 等）。如需支持更多格式，可在 `build.js` 和 `index.html` 中扩展。
