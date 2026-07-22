const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

// ── MIME 类型映射 ──────────────────────────────
const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

async function main() {
  // ── 读取配置 ──────────────────────────────────
  const config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
  const BASE_URL = config.baseUrl.replace(/\/+$/, '');

  if (!config.entries || config.entries.length === 0) {
    console.error('❌ config.json 中没有条目，请先添加 entries');
    process.exit(1);
  }

  // 确保输出目录存在
  fs.mkdirSync('qrcodes', { recursive: true });
  fs.mkdirSync('public', { recursive: true });

  const output = {};
  const errors = [];
  let totalPhotoSize = 0;

  for (const entry of config.entries) {
    const { id, question, answer, content } = entry;

    // 校验必填字段
    if (!id || !question || !answer || !content) {
      errors.push(`[${id || '???'}] 缺少必填字段 (id/question/answer/content)`);
      continue;
    }
    if (output[id]) {
      errors.push(`[${id}] ID 重复，将覆盖之前的条目`);
    }

    // ── 照片 Base64 编码（内嵌到加密 payload） ──
    const photoEntries = [];
    if (content.photos && content.photos.length > 0) {
      for (const photoPath of content.photos) {
        const srcPath = path.resolve(photoPath);
        const basename = path.basename(photoPath);

        if (!fs.existsSync(srcPath)) {
          errors.push(`[${id}] 照片不存在: ${srcPath}`);
          continue;
        }

        const fileBuffer = fs.readFileSync(srcPath);
        const b64 = fileBuffer.toString('base64');
        const mimeType = getMimeType(basename);
        const sizeKB = (fileBuffer.length / 1024).toFixed(1);

        photoEntries.push({
          name: basename,
          type: mimeType,
          data: b64
        });

        totalPhotoSize += fileBuffer.length;
        console.log(`  📷 [${id}] 照片已编码: ${basename} (${sizeKB} KB, ${mimeType})`);
      }
    }

    if (photoEntries.length > 0) {
      console.log(`  📦 [${id}] 共 ${photoEntries.length} 张照片将内嵌加密`);
    }

    // ── 生成随机 salt 和 IV ────────────────────
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);

    // ── PBKDF2 密钥派生 ────────────────────────
    const key = crypto.pbkdf2Sync(answer, salt, 100000, 32, 'sha256');

    // ── AES-256-GCM 加密 ───────────────────────
    // 照片 Base64 数据与文字一起加密，统一保护
    const payload = JSON.stringify({
      text: content.text || '',
      photos: photoEntries
    });

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(payload, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 拼接格式：iv(12字节) + 密文 + authTag(16字节)
    const combined = Buffer.concat([iv, encrypted, authTag]);

    output[id] = {
      question,
      salt: salt.toString('base64'),
      data: combined.toString('base64')
    };

    // ── 生成 QR 码 ─────────────────────────────
    const url = `${BASE_URL}?id=${encodeURIComponent(id)}`;
    const qrPath = path.join('qrcodes', `${id}.png`);

    try {
      await QRCode.toFile(qrPath, url, {
        type: 'png',
        width: 500,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
      console.log(`✅ [${id}] QR: ${qrPath}`);
      console.log(`   🔗 ${url}`);
    } catch (err) {
      errors.push(`[${id}] QR 生成失败: ${err.message}`);
    }
  }

  // ── 写入 data.json ───────────────────────────
  fs.writeFileSync('public/data.json', JSON.stringify(output), 'utf-8');

  const totalSizeMB = (totalPhotoSize / (1024 * 1024)).toFixed(1);

  // ── 汇总 ─────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📦 共处理 ${Object.keys(output).length} 个条目 → public/data.json`);
  console.log(`📁 QR 码: qrcodes/ 目录`);
  if (totalPhotoSize > 0) {
    console.log(`🖼️  照片: ${totalSizeMB} MB（Base64 内嵌加密，不输出独立文件）`);
  }
  console.log(`🔐 照片与文字统一加密，只有答对才能获取 Blob URL`);

  if (errors.length > 0) {
    console.log(`\n⚠️  警告/错误:`);
    errors.forEach(e => console.log(`   ${e}`));
  }

  console.log(`\n✨ 下一步：将 public/ 目录部署到 GitHub Pages`);
  console.log(`   (QR 码请勿上传到公开仓库，通过私聊分发给对应的人)`);
}

main().catch(err => {
  console.error('构建失败:', err);
  process.exit(1);
});
