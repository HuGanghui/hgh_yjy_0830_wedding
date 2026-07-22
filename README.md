# QR 码加密解锁系统

扫码回答问题，答对才能看到内容。零服务器，纯静态托管，浏览器本地解密。

## 使用场景

你有若干组内容（文字+照片），希望定向分享给特定的人。每个人扫不同的 QR 码，回答一个只有 ta 知道答案的问题，答对后在浏览器中看到专属内容。

## 工作原理

```
config.json          build.js              public/
(你编辑)      →      (本地运行)      →      (部署到 GitHub Pages)
                         │
                         └──→ qrcodes/*.png  (QR 码，分发给对应的人)
```

### 完整流程

```
┌──────────────┐     扫一扫       ┌─────────────────────────────┐
│   QR 码      │  ───────────→   │  解锁页面 (GitHub Pages)      │
│ ?id=alice    │                 │                             │
└──────────────┘                 │  ❓ "我们第一次见面的地方？"    │
                                 │  [输入框]  [解锁]             │
                                 │                             │
                                 │  答案正确 → AES 解密 → 内容   │
                                 │  答案错误 → 认证失败 → 拒绝   │
                                 └─────────────────────────────┘
```

1. 你在本地编辑 `config.json`，填入问题、答案、文字内容、照片路径
2. 运行 `node build.js`：用答案作为密钥，AES-256-GCM 加密内容，生成 `public/data.json` 和 QR 码 PNG
3. 将 `public/` 目录部署到 GitHub Pages
4. 将 QR 码图片分发给对应的人
5. 对方扫描 QR 码 → 输入答案 → 浏览器本地解密 → 看到内容

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
| 照片外泄（保存 URL 后反复访问） | 照片 Base64 内嵌加密，解密后通过 Blob URL 渲染。Blob URL 仅在当前页面会话的内存中存在，关闭页面即永久失效，无法被书签保存或直接访问 |
| 截图/录屏 | 无法防御。如需防截屏，需使用端到端加密通讯工具（如 Signal 阅后即焚） |

### 安全边界说明

本方案保护的是**内容机密性**——不知道答案的人无法看到内容。它不是为防御国家级攻击者设计的，而是让分享变得有门槛、有仪式感。如果你需要军事级别的安全，请使用端到端加密通讯工具。

## 项目结构

```
qr-unlock/
├── README.md             # 本文档
├── package.json           # npm 项目配置
├── build.js               # 构建脚本（加密 + 生成 QR 码）
├── config.json            # 条目配置（你编辑，已 gitignore）
├── config.example.json    # 示例配置（可提交）
├── .gitignore
├── qrcodes/               # 生成的 QR 码 PNG（已 gitignore）
└── public/                # 部署到 GitHub Pages
    ├── index.html          # 解锁页面（单文件，零依赖）
    └── data.json           # 加密后的数据（文字+照片均内嵌加密）
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
      "question": "我们第一次见面的地方是哪里？",
      "answer": "西湖边的星巴克",
      "content": {
        "text": "亲爱的 Alice，这是我们一起度过的美好时光…\n\n支持多行文本。",
        "photos": ["/path/to/photo1.jpg", "/path/to/photo2.jpg"]
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
| `entries[].question` | 是 | 扫码后显示的问题 |
| `entries[].answer` | 是 | 正确答案，也是解密密钥。不会被存储到任何地方 |
| `entries[].content.text` | 否 | 解锁后显示的文字 |
| `entries[].content.photos` | 否 | 照片文件路径数组，照片会被复制到 `public/photos/` 并使用随机文件名 |

### 3. 构建

```bash
npm run build
```

构建后：
- `qrcodes/` 目录下生成每个条目的 QR 码 PNG
- `public/data.json` 写入加密数据
- `public/photos/` 复制了照片文件（如果有的话）

### 4. 部署到 GitHub Pages

```bash
# 将 public/ 目录的内容推送到 GitHub 仓库
cd public
git init
git add .
git commit -m "Deploy"
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

然后在 GitHub 仓库 Settings → Pages 中，将 Source 设为 `main` 分支。

### 5. 分发 QR 码

将 `qrcodes/` 目录下的 QR 码图片发给对应的人。**请通过私聊发送，不要提交到公开仓库。**

你可以直接发送 PNG 图片，对方用手机相机或微信/支付宝扫码即可。

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 加密（构建时） | Node.js `crypto` | AES-256-GCM + PBKDF2-SHA256 |
| 解密（浏览器） | Web Crypto API (`crypto.subtle`) | 浏览器原生，零额外依赖 |
| QR 码生成 | `qrcode` (npm) | 500px PNG，适合手机扫描 |
| 前端页面 | 原生 HTML/CSS/JS | 单文件约 250 行，移动端优先 |
| 托管 | GitHub Pages | 免费，全球 CDN |

### 数据格式

`public/data.json` 格式：

```json
{
  "<id>": {
    "question": "显示给扫码者的问题",
    "salt": "Base64 编码的 16 字节随机盐",
    "data": "Base64 编码的 [IV(12字节) || AES-GCM密文 || 认证标签(16字节)]"
  }
}
```

解密后的 payload 格式：

```json
{
  "text": "文字内容",
  "photos": [
    {
      "name": "photo1.jpg",
      "type": "image/jpeg",
      "data": "Base64 编码的图片二进制数据"
    }
  ]
}
```

照片在构建时被读取为 Base64 字符串，与文字一起经 AES-256-GCM 加密存入 `data` 字段。解密后，浏览器将 Base64 转换为 Blob 对象，生成 `blob:` 协议的 URL 用于 `<img>` 渲染。该 URL 仅在当前页面会话的内存中存在，关闭页面即被垃圾回收，无法被外部访问。

## 本地验证测试

部署前建议在本地完成两个维度的验证，确保加解密逻辑和页面功能正常。

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
📄 内容: {"text":"...","photos":[]}
✅ 错误答案 → 解密被正确拒绝
```

**如果正确答案解密失败怎么办？** 检查 `correctAnswer` 变量的值是否与 `config.json` 中的 `answer` 严格一致（包括空格、标点符号、中英文全角/半角）。

### 测试二：浏览器端页面功能验证

用本地 HTTP 服务器模拟 GitHub Pages 环境，在浏览器中打开解锁页面。

```bash
# 在 public/ 目录启动本地服务器
cd public
python3 -m http.server 8888
```

然后浏览器访问：

```
http://localhost:8888/?id=你的条目id
```

**验证清单：**

| 序号 | 操作 | 期望结果 |
|------|------|---------|
| 1 | 打开页面 | 看到「加载中…」后显示问题 |
| 2 | 不输入，直接点「解锁」 | 提示「请输入答案」 |
| 3 | 输入错误答案，点「解锁」 | 按钮短暂显示「验证中…」，然后提示「答案不正确」，输入框抖动 |
| 4 | 输入正确答案，点「解锁」 | 按钮短暂显示「验证中…」，然后显示文字和照片 |
| 5 | 用手机扫码 QR 码（同一 Wi-Fi 下用局域网 IP） | 跳转到页面，流程同上 |
| 6 | 用浏览器开发者工具切换到移动端视口 | 页面布局正常，按钮和输入框大小适合触屏 |

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

### 照片会暴露吗？

不会。照片数据以 Base64 编码后与文字一起经 AES-256-GCM 加密，作为 `data` 字段的一部分存入 `data.json`。服务器上不存在独立的照片文件——照片只是密文中的一段 Base64 字符串。

### 解锁后照片可以被保存吗？

可以截图，这是任何方案都无法防御的。但从 URL 层面无法被「保存后反复访问」：

1. 解密后的图片通过 **Blob URL**（`blob:https://...`）渲染，该 URL 只在当前页面会话的浏览器内存中存在
2. 关闭页面后 Blob URL 自动失效，无法通过书签、链接分享、或直接输入地址来访问
3. 刷新页面需要重新输入答案，重新解密才能生成新的 Blob URL
4. 即使查看页面源代码或开发者工具，也只能看到 `blob:` 开头的临时引用，无法获取到图片数据本身

> 唯一能持久保存内容的方式是截图。如果你需要防截屏，请使用支持阅后即焚的端到端加密通讯工具。

### 可以不用 GitHub Pages 吗？

`public/` 目录的内容是纯静态文件，可以部署到任何静态托管服务：Vercel、Netlify、Cloudflare Pages、腾讯云 COS、阿里云 OSS 等。

### 可以支持更多格式的内容吗？

解密后的 payload 是 JSON，`text` 支持纯文本（HTML 标签会被转义），`photos` 支持图片。如需支持视频、音频，可在 `build.js` 和 `index.html` 中扩展。
