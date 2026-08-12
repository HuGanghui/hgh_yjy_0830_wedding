const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

// ── 生成不可猜测的随机文件名（secret 媒体用） ──
function randomFileName(originalPath) {
  const ext = path.extname(originalPath);
  return crypto.randomBytes(16).toString('hex') + ext;
}

// ── 拷贝单个媒体文件到 public/media/<id>/<folder> ──
// folder: 'photo'（公开，保留原文件名）| 'secret'（随机文件名）
function copyMedia(srcPath, id, folder) {
  const absSrc = path.resolve(srcPath);
  if (!fs.existsSync(absSrc)) {
    throw new Error(`文件不存在: ${srcPath}`);
  }

  const filename = folder === 'photo'
    ? path.basename(srcPath)
    : randomFileName(srcPath);

  const outDir = path.join('public', 'media', id, folder);
  fs.mkdirSync(outDir, { recursive: true });

  const dest = path.join(outDir, filename);
  fs.copyFileSync(absSrc, dest);

  const sizeKB = (fs.statSync(dest).size / 1024).toFixed(1);
  const url = path.posix.join('media', id, folder, filename);
  return { url, sizeKB };
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

  // 每次构建前清空 media 目录，保证构建产物与 data.json 严格一致、不残留孤儿文件
  fs.rmSync('public/media', { recursive: true, force: true });

  const output = {};
  const errors = [];

  for (const entry of config.entries) {
    const { id, to, question, answer, description, photo, secret } = entry;

    // 校验必填字段
    if (!id || !to || !question || !answer || !description) {
      errors.push(`[${id || '???'}] 缺少必填字段 (id/to/question/answer/description)`);
      continue;
    }
    if (output[id]) {
      errors.push(`[${id}] ID 重复，将覆盖之前的条目`);
    }
    const hasSecretMedia =
      (secret && secret.images && secret.images.length > 0) ||
      (secret && secret.videos && secret.videos.length > 0);
    if (!secret || (!secret.text && !hasSecretMedia)) {
      errors.push(`[${id}] secret 至少包含 text/images/videos 之一`);
      continue;
    }

    // ── 公开照片（直接可见，保留原文件名） ──
    let photoUrl = null;
    if (photo) {
      try {
        const r = copyMedia(photo, id, 'photo');
        photoUrl = r.url;
        console.log(`  🖼️  [${id}] 公开照片: ${r.url} (${r.sizeKB} KB)`);
      } catch (err) {
        errors.push(`[${id}] 公开照片 ${photo}: ${err.message}`);
      }
    }

    // ── secret 媒体（随机文件名，答对后可见） ──
    const images = [];
    const videos = [];
    for (const src of (secret.images || [])) {
      try {
        const r = copyMedia(src, id, 'secret');
        images.push(r.url);
        console.log(`  🖼️  [${id}] secret 图片: ${r.url} (${r.sizeKB} KB)`);
      } catch (err) {
        errors.push(`[${id}] secret 图片 ${src}: ${err.message}`);
      }
    }
    for (const src of (secret.videos || [])) {
      try {
        const r = copyMedia(src, id, 'secret');
        videos.push(r.url);
        console.log(`  🎬 [${id}] secret 视频: ${r.url} (${r.sizeKB} KB)`);
      } catch (err) {
        errors.push(`[${id}] secret 视频 ${src}: ${err.message}`);
      }
    }

    // ── 生成随机 salt 和 IV ────────────────────
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);

    // ── PBKDF2 密钥派生（答案即密钥） ────────────
    const key = crypto.pbkdf2Sync(answer, salt, 100000, 32, 'sha256');

    // ── AES-256-GCM 加密 secret payload ────────
    // 额外内容统一加密；媒体以静态文件路径形式存放
    const payload = JSON.stringify({
      text: secret.text || '',
      images,
      videos
    });

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(payload, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 拼接格式：iv(12字节) + 密文 + authTag(16字节)
    const combined = Buffer.concat([iv, encrypted, authTag]);

    output[id] = {
      to,
      question,
      description,
      photo: photoUrl,
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

  // ── 汇总 ─────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📦 共处理 ${Object.keys(output).length} 个条目 → public/data.json`);
  console.log(`📁 QR 码: qrcodes/ 目录`);
  console.log(`📷 媒体: public/media/<id>/ (公开照片 / secret 加密路径)`);

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
