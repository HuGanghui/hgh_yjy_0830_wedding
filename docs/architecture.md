# 架构与加密契约（参考）

> 本文件是被 CLAUDE.md 引用的**参考细节**：`data.json` schema、媒体布局与命名约定、一码多信、key 点。改 `build.js` / `public/index.html` 时按需阅读。**加密参数表**见 CLAUDE.md（内联保留，改单侧必同步）。

## 数据流

`config.json`（编辑）→ `build.js`（本地加密 + 拷贝媒体 + 留言板配置归一化）→ `public/data.json` + `public/media/` + `public/guestbook.json` + `qrcodes/*.png`（构建产物）→ `public/` 部署。

## `public/data.json` schema（构建时写入，浏览器 fetch 后读取）

```json
{
  "<id>": {
    "question": "问题",
    "description": "公开描述文字",
    "emphasis": "描述落点的突出块（可选，公开纯文本，不加密）",  // 页面渲染为蜡封色强调块，如信末单独写给读者的话
    "photo": "media/<id>/photo/xxx.jpg",   // 位图照片为 1600px 回退档；SVG 照片原样
    "photoW": 1600,   // 可选：输出照片宽高（页面据此占位，防加载时布局跳动）
    "photoH": 2133,
    "music": "media/<id>/music/xxx.mp3",   // 可选：公开背景音乐（扫码自动播放，保留原文件名）
    "lyrics": "media/<id>/lyrics/xxx.lrc", // 可选：背景音乐的 LRC 歌词（随音乐同步滚动，保留原文件名）
    "guestbook": false,  // 可选：仅该条目关闭留言板（默认开启；不写字段 = 开启）
    "letters": [      // 门禁条目：每封信各自加密（答案即该收件人的密钥）
      { "to": "收件人", "salt": "Base64 的 16 字节随机盐", "data": "Base64 的 [iv(12) || GCM密文 || authTag(16)]" }
    ]
  }
}
```

**无收件人条目**（config 省略 `to`/`letters`）在 `data.json` 中只有 `description` 与 `photo` 两个字段（可选加 `music` / `lyrics` / `guestbook`），不加密、无 `letters`——页面据此（`entry.letters` 是否存在且非空）判断是否渲染问题与解锁区。config 顶层 `to`/`answer`/`secret` 简写等价于 `letters` 单元素，构建时归一化。

解密后的 payload（额外内容）：

```json
{ "text": "额外的话", "images": ["media/<id>/secret/随机名.jpg"], "videos": ["media/<id>/secret/随机名.mp4"] }
```

## 媒体布局与命名约定

媒体由 `build.js` 的 `copyMedia()` 拷贝到 `public/media/<id>/`，data.json 只存路径。**每次构建先清空整个 `public/media/` 和 `qrcodes/`**，保证产物与 config 严格一致、不残留旧文件（避免过期 QR 码被误发）。

- **公开照片 `photo/`**（保留原文件名）：位图照片（jpg/jpeg/png/webp/heic 等）经 `sharp` 摆正（EXIF）并生成 **480/960/1600 三档 × AVIF(q45)/WebP(q80)/JPEG(q75 渐进)**，带透明通道的压平到白底；`photo/<base>.jpg` 是 1600px 回退档。页面 `<picture>`+`srcset>` 按屏幕/DPR 选档。secret 图片答对后才显示，保持单档 JPEG。视频与 SVG 原样拷贝；优化失败自动回退原样拷贝。相机原图动辄 5-11MB，源文件在 `assets/` 不受影响。
  - ⚠️ **变体文件名约定**：`photo/<base>-480|960|1600.(jpg|webp|avif)`，`index.html` 据此拼 URL，`scripts/verify.js` 会校验变体齐全（改约定要两边同步）。
- **公开背景音乐 `music/`**（保留原文件名）：config 条目可选 `music` 字段（公开媒体路径），data.json 写明文路径。有/无收件人条目均可配。无 `music` 不显示音符按钮。
- **公开共享视频 `video/`**（保留原文件名）：config 条目可选 `video` 字段（公开媒体路径）+ 可选 `videoCredit` 署名。渲染在公开区**照片下方、扫码即见**，有/无收件人条目均可配（一码多信时所有收件人共享同一个，无需塞进各封信的 secret）。无 `video` 不显示视频块。
- **歌词 `lyrics/`**（保留原文件名）：config 条目可选 `lyrics` 字段（.lrc 路径）。有 `music`+`lyrics` 显示歌词墙，`timeupdate` 高亮当前行并滚动居中（seek 自动对齐）；LRC 解析支持多时间戳/`[offset:±ms]`，加载失败静默隐藏。歌词文本版权属作品方，仅用于自持音频的个人页展示。
- **secret 图片/视频 `secret/`**（文件名随机：`crypto.randomBytes(16).toString('hex')` + 扩展名）。

## key 点

- **有无收件人（letters 非空）决定是否为解锁条目**：有收件人 → 必有 `question`，每封信必有 `to`/`answer`/`secret`，额外内容分别用各自 answer 加密（`build.js` 校验并加密）；无收件人 → 仅照片+描述，`question`/`answer`/`secret`/`letters` 被忽略并告警，不产出 `letters`。
- **secret 媒体是 `public/` 下可直链的静态文件**——路径随机只是防枚举的缓解，不是真正的机密性（用户已接受该取舍）。⚠️ 仓库已公开（GitHub Pages 免费方案要求公开仓库）：`public/media/<id>/secret/` 里任何人可直接浏览仓库下载——随机名只防「猜 URL」，不防「逛仓库」（`assets/` 源文件已 gitignore、不入库）。若日后要真保密，改走「build 加密媒体 + 浏览器解密」方案。图片/视频加载用 `<img>` / `<video controls preload="metadata">` 直链，**已无 Blob URL 逻辑**。
- **解密入口**在 `public/index.html` 的 IIFE 脚本：加载后先渲染公开区 → `base64ToBytes()` → PBKDF2 deriveKey → `crypto.subtle.decrypt` → JSON.parse → 渲染 `text/images/videos`。解锁走 `tryUnlock()`：对 `entry.letters` **逐封试解密** `decryptPayload(letter, answer)`（失败返回 null），命中即该收件人 → 渲染对应专属信件。**不存储任何「正确答案库」**——密码即密钥，解密成功即认证。
- ⚠️ **一码多信 → 同一信封内各封信的 `answer` 必须唯一**：同一收信码命中多个收件人会路由歧义（`scripts/verify.js` 会打印重复的 id+收件人作提醒，不阻断）。不同信封（不同条目）之间答案重复**无影响**——每张二维码只路由到自己的条目。
- **专属信件视图**：答对后 `renderLetter(to, payload)`——隐藏公开区（照片/描述/输入），展示信件卡片：`致 [to]` + 正文（`white-space: pre-wrap`）+ secret 图片/视频 + 落款「来自新人的祝福」。图片继续走 Lightbox 放大预览 / 下载。
- **`to` 标签**：公开区 To 标签**并列展示全部收件人**——单收件人「To 某人」、多收件人「To 花花 / 梁雪 / 小童」（`entry.letters.map(l => l.to).join(' / ')` 拼）。
- **裸地址（无 `?id=`）无统一入口**：页面直接提示「请扫描收到的二维码」，不再有输码路由页。
- `public/index.html` 是零依赖单文件（原生 HTML/CSS/JS），移动端优先。
- base64 用浏览器原生 `atob` / Node `Buffer`，UTF-8 中文用 `TextEncoder`/`TextDecoder` 统一处理。
