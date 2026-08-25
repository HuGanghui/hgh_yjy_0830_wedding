const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const sharp = require('sharp');

// ── 图片优化参数 ─────────────────────────────────────
// 页面里照片最宽约 440px（max-width 440px 卡片），1600px 已覆盖 3x 视网膜屏，绰绰有余。
// 相机原图动辄 4000-6000px、5-11MB，直接上线手机要下载很久 —— 这里统一缩放+压缩。
// 公开照片额外生成 480/960/1600 三档 × AVIF/WebP/JPEG，页面用 <picture>/srcset 按屏幕选档：
// 手机端只需下载 ~60-220KB，而不是整张 1600px（实测最大照片从 584KB 降到 WebP 216KB / AVIF 86KB）。
const MAX_PHOTO_WIDTH = 1600;          // 只缩小不放大（photo/<base>.jpg 回退档）
const PHOTO_SIZES = [480, 960, 1600];  // 响应式档位
const JPEG_QUALITY = 75;               // 渐进式 + 适度压缩，肉眼差别极小，体积更小
const WEBP_QUALITY = 72;               // 较 mozjpeg q75 的 JPEG 再省 ~5%（q80 反而比 JPEG 大，已实测调低）
const AVIF_QUALITY = 45;               // 较 JPEG 再省 ~50-65%（Safari 16.4+ 及现代浏览器）
const RASTER_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.avif'
]);

// ── 留言板（guestbook）：云数据库直写，provider 抽象 ──────────
// 每个 provider 声明必填字段（与 public/index.html 的 GB_PROVIDERS 表同构，改一边要改另一边）。
// 当前实现 cloudbase：POST 到腾讯云云函数 HTTP 访问服务（云接入）（函数是唯一写入口，云数据库对客户端零权限）。
// 换 supabase 只需：此表加一项 + index.html GB_PROVIDERS 加适配器 + config 换 options。
// 安全模型：云函数负责校验+写库；云数据库安全规则 read/write 全关，宾客只能经函数写入、无法读取；
// 新人读取走 CloudBase 控制台/导出。函数代码见 cloudbase/guestbook/（可部署）。
const GB_PROVIDERS = {
  cloudbase: { required: ['url'] }
};

// ── 生成不可猜测的随机文件名（secret 媒体用，不含扩展名） ──
function randomFileName() {
  return crypto.randomBytes(16).toString('hex');
}

// ── 拷贝单个媒体文件到 public/media/<id>/<folder> ──
// folder: 'photo'（公开，保留原文件名）| 'music'（公开背景音乐，保留原文件名）| 'secret'（随机文件名）
// 位图照片一律缩放+重压缩输出 .jpg（带透明通道的压平到卡片白底）；视频/音频/SVG 原样拷贝。
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
  let outDims = null;   // 公开照片的输出尺寸（页面占位用）
  if (RASTER_EXTS.has(ext)) {
    // 位图：缩放 + 重压缩（公开照片多尺寸多格式；secret 单档）
    const baseName = folder === 'photo'
      ? path.basename(srcPath, path.extname(srcPath))
      : randomFileName();
    try {
      const meta = await sharp(absSrc, { failOn: 'none' }).metadata();
      const hasAlpha = meta.channels === 4;
      // 统一管线：EXIF 摆正 + 可选压平到卡片白底；每个变体从这里 clone 再 resize
      let pipe = sharp(absSrc, { failOn: 'none' }).rotate();
      if (hasAlpha) pipe = pipe.flatten({ background: '#ffffff' });

      const JPEG = { quality: JPEG_QUALITY, mozjpeg: true, progressive: true };
      const render = (w, fmt, opts) =>
        pipe.clone().resize({ width: w, withoutEnlargement: true })[fmt](opts).toBuffer();

      if (folder === 'photo') {
        // ── 公开照片：480/960/1600 × AVIF/WebP/JPEG（photo/<base>.jpg 是 1600px 回退档） ──
        const buf1600 = await render(MAX_PHOTO_WIDTH, 'jpeg', JPEG);
        dest = path.join(outDir, `${baseName}.jpg`);
        fs.writeFileSync(dest, buf1600);
        await Promise.all([
          render(480, 'jpeg', JPEG).then(b => fs.writeFileSync(path.join(outDir, `${baseName}-480.jpg`), b)),
          render(960, 'jpeg', JPEG).then(b => fs.writeFileSync(path.join(outDir, `${baseName}-960.jpg`), b)),
          ...PHOTO_SIZES.map(w => render(w, 'webp', { quality: WEBP_QUALITY })
            .then(b => fs.writeFileSync(path.join(outDir, `${baseName}-${w}.webp`), b))),
          ...PHOTO_SIZES.map(w => render(w, 'avif', { quality: AVIF_QUALITY })
            .then(b => fs.writeFileSync(path.join(outDir, `${baseName}-${w}.avif`), b))),
        ]);
        const dims = await sharp(buf1600).metadata();  // 输出尺寸 → data.json，页面占位防布局跳动
        outDims = { width: dims.width, height: dims.height };
      } else {
        // ── secret 图片：答对后才显示，单档即可 ──
        const buf = await render(MAX_PHOTO_WIDTH, 'jpeg', JPEG);
        dest = path.join(outDir, `${baseName}.jpg`);
        fs.writeFileSync(dest, buf);
      }
    } catch (err) {
      dest = path.join(outDir, path.basename(srcPath));
      fs.copyFileSync(absSrc, dest);
      console.warn(`  ⚠️  [${id}] 图片优化失败，已原样拷贝: ${err.message}`);
    }
  } else {
    // 视频 / 音频 / LRC / SVG 等：原样拷贝（公开目录 photo/music/lyrics 保留原文件名，secret 随机名防枚举）
    const filename = folder === 'photo' || folder === 'music' || folder === 'lyrics'
      ? path.basename(srcPath)
      : randomFileName() + ext;
    dest = path.join(outDir, filename);
    fs.copyFileSync(absSrc, dest);
  }

  const sizeKB = (fs.statSync(dest).size / 1024).toFixed(1);
  const url = path.posix.join('media', id, folder, path.basename(dest));
  return { url, sizeKB, ...outDims };
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
    const { id, to, question, answer, description, photo, music, lyrics, secret, guestbook, emphasis } = entry;

    // 校验必填字段（to 可选；无收件人条目只需 id/description）
    if (!id || !description) {
      errors.push(`[${id || '???'}] 缺少必填字段 (id/description)（to 可选）`);
      continue;
    }
    if (output[id]) {
      errors.push(`[${id}] ID 重复，将覆盖之前的条目`);
    }

    // ── 归一化收件人列表（letters） ──
    // 门禁条目 = 至少一封「信件」。两种写法：
    //   ① letters: [{to, answer, secret}, ...] —— 一码多信（A-05：同一照片，多人各自密码→各自专属信件）
    //   ② 顶层 to/answer/secret 简写             —— 单收件人，等价于 letters 单元素
    // 无任何收件人 → 仅展示照片+描述，无解锁环节。
    const letters = Array.isArray(entry.letters)
      ? entry.letters
      : (to ? [{ to, answer, secret, signer: entry.signer }] : []);
    const isGated = letters.length > 0;

    // ── 公开照片（直接可见，保留原文件名） ──
    let photoUrl = null;
    let photoW = null, photoH = null;
    if (photo) {
      try {
        const r = await copyMedia(photo, id, 'photo');
        photoUrl = r.url;
        photoW = r.width ?? null;
        photoH = r.height ?? null;
        console.log(`  🖼️  [${id}] 公开照片: ${r.url} (${r.sizeKB} KB)`);
      } catch (err) {
        errors.push(`[${id}] 公开照片 ${photo}: ${err.message}`);
      }
    }

    // ── 背景音乐（公开自动播放，保留原文件名） ──
    let musicUrl = null;
    if (music) {
      try {
        const r = await copyMedia(music, id, 'music');
        musicUrl = r.url;
        console.log(`  🎵 [${id}] 背景音乐: ${r.url} (${r.sizeKB} KB)`);
      } catch (err) {
        errors.push(`[${id}] 背景音乐 ${music}: ${err.message}`);
      }
    }

    // ── 歌词（LRC，随音乐同步滚动；保留原文件名） ──
    let lyricsUrl = null;
    if (lyrics) {
      try {
        const r = await copyMedia(lyrics, id, 'lyrics');
        lyricsUrl = r.url;
        console.log(`  📜 [${id}] 歌词: ${r.url} (${r.sizeKB} KB)`);
      } catch (err) {
        errors.push(`[${id}] 歌词 ${lyrics}: ${err.message}`);
      }
    }

    let outEntry;
    if (isGated) {
      // ── 门禁条目：需要问题；每封信各自校验/加密（答案即该收件人的密钥） ──
      if (!question) {
        errors.push(`[${id}] 门禁条目缺少 question`);
        continue;
      }

      let failed = false;
      const lettersOut = [];
      for (const letter of letters) {
        const tag = `${id}/${letter.to || '???'}`;
        if (!letter.to || !letter.answer) {
          errors.push(`[${tag}] 信件缺少 to/answer`);
          failed = true;
          continue;
        }
        const hasSecretMedia =
          (letter.secret && letter.secret.images && letter.secret.images.length > 0) ||
          (letter.secret && letter.secret.videos && letter.secret.videos.length > 0);
        if (!letter.secret || (!letter.secret.text && !hasSecretMedia)) {
          errors.push(`[${tag}] secret 至少包含 text/images/videos 之一`);
          failed = true;
          continue;
        }

        // secret 媒体（随机文件名，答对后可见）
        const images = [];
        const videos = [];
        for (const src of (letter.secret.images || [])) {
          try {
            const r = await copyMedia(src, id, 'secret');
            images.push(r.url);
            console.log(`  🖼️  [${tag}] secret 图片: ${r.url} (${r.sizeKB} KB)`);
          } catch (err) {
            errors.push(`[${tag}] secret 图片 ${src}: ${err.message}`);
          }
        }
        for (const src of (letter.secret.videos || [])) {
          try {
            const r = await copyMedia(src, id, 'secret');
            videos.push(r.url);
            console.log(`  🎬 [${tag}] secret 视频: ${r.url} (${r.sizeKB} KB)`);
          } catch (err) {
            errors.push(`[${tag}] secret 视频 ${src}: ${err.message}`);
          }
        }

        // 每封信独立随机 salt + IV；PBKDF2 密钥派生（答案即密钥）
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(12);
        const key = crypto.pbkdf2Sync(letter.answer, salt, 100000, 32, 'sha256');

        // AES-256-GCM 加密 secret payload（媒体以静态文件路径形式存放）
        const payload = JSON.stringify({
          text: letter.secret.text || '',
          images,
          videos
        });

        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(payload, 'utf-8');
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        const authTag = cipher.getAuthTag();

        // 拼接格式：iv(12字节) + 密文 + authTag(16字节)
        const combined = Buffer.concat([iv, encrypted, authTag]);
        lettersOut.push({
          to: letter.to,
          ...(letter.signer ? { signer: letter.signer } : {}),
          salt: salt.toString('base64'),
          data: combined.toString('base64')
        });
      }

      // 任一封校验失败 → 整条不产出（构建已报错，verify 会兜底）
      if (failed) continue;

      outEntry = {
        question,
        description,
        photo: photoUrl,
        ...(photoW ? { photoW, photoH } : {}),
        ...(musicUrl ? { music: musicUrl } : {}),
        letters: lettersOut
      };
    } else {
      // ── 无收件人：仅公开照片+描述，无 question/answer/secret ──
      if (question || answer || secret || (Array.isArray(entry.letters) && entry.letters.length === 0)) {
        errors.push(`[${id}] 无收件人条目仅展示照片+描述，已忽略 question/answer/secret/letters`);
      }
      outEntry = { description, photo: photoUrl, ...(photoW ? { photoW, photoH } : {}), ...(musicUrl ? { music: musicUrl } : {}) };
    }

    // 通用可选项（两个分支共用）：歌词路径 + 该条目关闭留言板（guestbook:false 才写字段，默认开启）
    // + 描述落点突出块（emphasis，公开纯文本，不加密）
    outEntry = {
      ...outEntry,
      ...(lyricsUrl ? { lyrics: lyricsUrl } : {}),
      ...(emphasis ? { emphasis } : {}),
      ...(guestbook === false ? { guestbook: false } : {})
    };
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

  // ── 写入 guestbook.json（留言板客户端配置；始终写出） ──
  // enabled=false 表示留言功能关闭；有配置且合法才写客户端连接参数（云函数 HTTP 访问地址 URL）。
  const gbOut = { enabled: false };
  const gb = config.guestbook;
  if (gb && gb.enabled === true) {
    const provider = GB_PROVIDERS[gb.provider];
    if (!provider) {
      errors.push(`guestbook: 未知 provider「${gb.provider}」（支持: ${Object.keys(GB_PROVIDERS).join(', ')}）`);
    } else {
      const opts = Object.assign({}, gb.options || {});
      const missing = provider.required.filter(k => !opts[k]);
      if (missing.length) {
        errors.push(`guestbook.options 缺少字段: ${missing.join(', ')}`);
      } else {
        gbOut.enabled = true;
        gbOut.provider = gb.provider;
        gbOut.options = {};
        for (const k of provider.required) gbOut.options[k] = String(opts[k]).trim();
        if (!/^https?:\/\//.test(gbOut.options.url)) {
          errors.push('guestbook.options.url 须为 http(s):// 开头（云函数 HTTP 访问服务地址）');
          gbOut.enabled = false;
        } else {
          gbOut.options.url = gbOut.options.url.replace(/\/+$/, '');
        }
      }
    }
  }
  fs.writeFileSync('public/guestbook.json', JSON.stringify(gbOut), 'utf-8');
  if (gbOut.enabled) {
    console.log(`💬 guestbook: 已启用（${gbOut.provider}）→ POST ${gbOut.options.url}`);
  }

  // ── 汇总 ─────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📦 共处理 ${Object.keys(output).length} 个条目 → public/data.json`);
  console.log(`📁 QR 码: qrcodes/ 目录`);
  console.log(`📷 媒体: public/media/<id>/ (公开照片 / 背景音乐 / secret 加密路径)`);

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
