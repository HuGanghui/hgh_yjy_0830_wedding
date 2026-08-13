const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const sharp = require('sharp');

// ── 图片优化参数 ─────────────────────────────────────
// 页面里照片最宽约 440px（max-width 440px 卡片），1600px 已覆盖 3x 视网膜屏，绰绰有余。
// 相机原图动辄 4000-6000px、5-11MB，直接上线手机要下载很久 —— 这里统一缩放+压缩。
const MAX_PHOTO_WIDTH = 1600;  // 只缩小不放大
const JPEG_QUALITY = 82;       // 肉眼几乎无损，体积减 95%+
const RASTER_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.avif'
]);

// ── 生成不可猜测的随机文件名（secret 媒体用，不含扩展名） ──
function randomFileName() {
  return crypto.randomBytes(16).toString('hex');
}

// ── 拷贝单个媒体文件到 public/media/<id>/<folder> ──
// folder: 'photo'（公开，保留原文件名）| 'secret'（随机文件名）
// 位图照片一律缩放+重压缩输出 .jpg（带透明通道的压平到卡片白底）；视频/SVG 原样拷贝。
// 优化失败自动回退为原样拷贝，保证构建永不因个别图片中断。
async function copyMedia(srcPath, id, folder) {
  const absSrc = path.resolve(srcPath);
  if (!fs.existsSync(absSrc)) {
    throw new Error(`文件不存在: ${srcPath}`);
  }

  const ext = path.extname(srcPath).toLowerCase();
  const outDir = path.join('public', 'media', id, folder);
  fs.mkdirSync(outDir, { recursive: true });

  let dest;
  if (RASTER_EXTS.has(ext)) {
    // 位图：缩放 + 重压缩
    const baseName = folder === 'photo'
      ? path.basename(srcPath, path.extname(srcPath))
      : randomFileName();
    try {
      const meta = await sharp(absSrc, { failOn: 'none' }).metadata();
      const hasAlpha = meta.channels === 4;
      dest = path.join(outDir, `${baseName}.jpg`);
      let img = sharp(absSrc, { failOn: 'none' })
        .rotate()  // 按 EXIF 方向摆正（手机照片常见）
        .resize({ width: MAX_PHOTO_WIDTH, withoutEnlargement: true });
      // 带 alpha 的照片多为导出残留（实测半透明像素≈254，压平前后视觉无差异），压平到卡片白底再压 JPEG
      if (hasAlpha) img = img.flatten({ background: '#ffffff' });
      const buf = await img.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
      fs.writeFileSync(dest, buf);
    } catch (err) {
      dest = path.join(outDir, path.basename(srcPath));
      fs.copyFileSync(absSrc, dest);
      console.warn(`  ⚠️  [${id}] 图片优化失败，已原样拷贝: ${err.message}`);
    }
  } else {
    // 视频 / SVG 等：原样拷贝
    const filename = folder === 'photo'
      ? path.basename(srcPath)
      : randomFileName() + ext;
    dest = path.join(outDir, filename);
    fs.copyFileSync(absSrc, dest);
  }

  const sizeKB = (fs.statSync(dest).size / 1024).toFixed(1);
  const url = path.posix.join('media', id, folder, path.basename(dest));
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

  // 每次构建前清空 qrcodes 与 media 目录，保证构建产物与 config 严格一致、不残留孤儿文件
  fs.rmSync('qrcodes', { recursive: true, force: true });
  fs.rmSync('public/media', { recursive: true, force: true });
  fs.mkdirSync('qrcodes', { recursive: true });
  fs.mkdirSync('public', { recursive: true });

  const output = {};
  const errors = [];

  for (const entry of config.entries) {
    const { id, to, question, answer, description, photo, secret } = entry;

    // 校验必填字段（to 可选；无 to 的条目只需 id/description）
    if (!id || !description) {
      errors.push(`[${id || '???'}] 缺少必填字段 (id/description)（to 可选）`);
      continue;
    }
    if (output[id]) {
      errors.push(`[${id}] ID 重复，将覆盖之前的条目`);
    }

    // 有 to（收件人）才有解锁环节；无 to 的条目仅展示照片+描述
    const isGated = !!to;

    // ── 公开照片（直接可见，保留原文件名） ──
    let photoUrl = null;
    if (photo) {
      try {
        const r = await copyMedia(photo, id, 'photo');
        photoUrl = r.url;
        console.log(`  🖼️  [${id}] 公开照片: ${r.url} (${r.sizeKB} KB)`);
      } catch (err) {
        errors.push(`[${id}] 公开照片 ${photo}: ${err.message}`);
      }
    }

    let outEntry;
    if (isGated) {
      // ── 有收件人：需要问题/答案，额外内容加密 ──
      if (!question || !answer) {
        errors.push(`[${id}] 有收件人 (to=${to})，缺少 question/answer`);
        continue;
      }
      const hasSecretMedia =
        (secret && secret.images && secret.images.length > 0) ||
        (secret && secret.videos && secret.videos.length > 0);
      if (!secret || (!secret.text && !hasSecretMedia)) {
        errors.push(`[${id}] secret 至少包含 text/images/videos 之一`);
        continue;
      }

      // secret 媒体（随机文件名，答对后可见）
      const images = [];
      const videos = [];
      for (const src of (secret.images || [])) {
        try {
          const r = await copyMedia(src, id, 'secret');
          images.push(r.url);
          console.log(`  🖼️  [${id}] secret 图片: ${r.url} (${r.sizeKB} KB)`);
        } catch (err) {
          errors.push(`[${id}] secret 图片 ${src}: ${err.message}`);
        }
      }
      for (const src of (secret.videos || [])) {
        try {
          const r = await copyMedia(src, id, 'secret');
          videos.push(r.url);
          console.log(`  🎬 [${id}] secret 视频: ${r.url} (${r.sizeKB} KB)`);
        } catch (err) {
          errors.push(`[${id}] secret 视频 ${src}: ${err.message}`);
        }
      }

      // 生成随机 salt 和 IV
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);

      // PBKDF2 密钥派生（答案即密钥）
      const key = crypto.pbkdf2Sync(answer, salt, 100000, 32, 'sha256');

      // AES-256-GCM 加密 secret payload（媒体以静态文件路径形式存放）
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

      outEntry = {
        question,
        description,
        photo: photoUrl,
        salt: salt.toString('base64'),
        data: combined.toString('base64'),
        to
      };
    } else {
      // ── 无收件人：仅公开照片+描述，无 question/answer/secret ──
      if (question || answer || secret) {
        errors.push(`[${id}] 无收件人条目仅展示照片+描述，已忽略 question/answer/secret`);
      }
      outEntry = { description, photo: photoUrl };
    }
    output[id] = outEntry;

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
