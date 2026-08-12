# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

QR 码加密解锁系统：每个条目生成一个 QR 码，指向 `public/index.html?id=<id>`。扫码后**直接看到**公开内容——照片 + 描述文字 + 一个「To 某人」的问题（无加密环节）；答对问题后浏览器本地解密，展示额外内容（一段话 / 图片 / 视频）。零服务器，纯静态，部署到 GitHub Pages。

**答案本身就是解密密钥**——`config.json` 中的 `answer` 字段从不存储在任何输出里。只有**额外内容（secret）**经 PBKDF2 派生密钥 + AES-GCM 加密：正确答案认证通过才解密成功，错误答案被拒绝，因此没有「正确答案库」可被窃取。公开内容（照片 / 描述 / 问题）为明文。

## 工作规则（强制）

**所有改动都必须通过 git 管理，不得绕过版本控制：**

- 任何修改、新增、删除文件，完成一个逻辑单元后立即 `git add` + `git commit`，不允许改动长期停留在工作区。
- 提交前先 `git status` 和 `git diff`，确认只包含预期改动，绝不误提交 `config.json`（含答案/密钥）和 `qrcodes/`（QR 码）——见下方「Git 约定」。
- 提交信息使用中文、动词开头的描述性写法（参考现有 commit 风格），例如 `feat: 新增视频内容支持`、`fix: 修复答案含中文空格时解密失败`。

## 常用命令

```bash
npm install              # 安装依赖（仅 qrcode）
cp config.example.json config.json   # 首次创建配置
npm run build            # 构建：读取 config.json → 生成 public/data.json + qrcodes/*.png
```

本地验证：
```bash
# 浏览器端验证（模拟 GitHub Pages）
cd public && python3 -m http.server 8888
# 访问 http://localhost:8888/?id=<entryId>

# Node 端到端加解密验证（一行的 node -e，见 README「测试一」）
# 用 config.json 中的真实 answer 验证解密成功、错误答案被拒绝
```

## 架构与加密契约

数据流：`config.json`（编辑）→ `build.js`（本地加密 + 拷贝媒体）→ `public/data.json` + `public/media/` + `qrcodes/*.png`（构建产物）→ `public/` 部署。

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
    "to": "收件人",
    "question": "问题",
    "description": "公开描述文字",
    "photo": "media/<id>/photo/xxx.svg",
    "salt": "Base64 的 16 字节随机盐",
    "data": "Base64 的 [iv(12) || GCM密文 || authTag(16)]"
  }
}
```

解密后的 payload（额外内容）：
```json
{ "text": "额外的话", "images": ["media/<id>/secret/随机名.jpg"], "videos": ["media/<id>/secret/随机名.mp4"] }
```

**关键点：**
- 媒体由 `build.js` 的 `copyMedia()` 拷贝到 `public/media/<id>/`：公开照片放 `photo/`（保留原文件名），secret 图片/视频放 `secret/`（文件名随机：`crypto.randomBytes(16).toString('hex')` + 扩展名）。data.json 只存路径。
- secret 的 `text` 加密进 `data` 字段；公开字段（`to`/`question`/`description`/`photo`）为明文。
- **secret 媒体是 `public/` 下可直链的静态文件**——路径随机只是防枚举的缓解，不是真正的机密性（用户已接受该取舍）。图片/视频加载用 `<img>` / `<video controls preload="metadata">` 直链，**已无 Blob URL 逻辑**。
- 解密入口在 `public/index.html` 的 IIFE 脚本：加载后先渲染公开区 → `base64ToBytes()` → PBKDF2 deriveKey → `crypto.subtle.decrypt` → JSON.parse → 渲染 `text/images/videos`。
- `public/index.html` 是零依赖单文件（原生 HTML/CSS/JS），移动端优先。
- base64 用浏览器原生 `atob` / Node `Buffer`，注意 UTF-8 中文用 `TextEncoder`/`TextDecoder` 统一处理。

## Git 约定（安全相关）

- `config.json` **已 gitignore**——含答案（即密钥），切勿提交。
- `qrcodes/` **已 gitignore**——QR 码通过私聊分发给对应的人，切勿提交到公开仓库。
- `public/data.json` 与 `public/media/` 均由 `npm run build` 生成，属构建产物（`public/data.json` 现已提交、符合设计：公开字段明文、额外文字加密）。
- config 中的 `photo`/`secret.images`/`secret.videos` 指向**源媒体文件**（如 `assets/`，不在 `public/` 下），源文件与 config 一起管理、可提交。
- 修改内容后重新 `npm run build` 并重新部署 `public/` 即可更新，无需改 QR 码（URL 不变）。

## 部署

`public/` 是纯静态目录，部署到 GitHub Pages（Settings → Pages → Source: main 分支）即可，也可换任何静态托管。
