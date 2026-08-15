#!/usr/bin/env node
'use strict';
// 构建产物自检脚本（本地运行；pre-commit 钩子会调用，也可 npm run verify 手动跑）。
//   1. 条目一致性：config.json 与 public/data.json 相互对得上（防「改了配置忘了构建」）
//   2. 加解密链路（Node 端）：用 config.json 的【真实答案】解密每个有收件人条目的密文
//   3. 拒绝逻辑：用错误答案试一次，确认被 GCM 认证拒绝（答案即密钥）
//   4. 媒体路径：photo + 答对后可见的 images/videos 在磁盘上大小写精确存在，且与 git 跟踪名一致
//      （macOS git core.ignorecase=true 曾把小写文件名按大写提交，导致 GitHub 上 404）
//   5. QR 码（测试三）：每个 qrcodes/<id>.png 存在、是有效 500×500 PNG、非空；并用 jsqr 解码，
//      断言编码内容 == baseUrl?id=<id>
//   6. 浏览器流程（jsdom，测试二）：加载真实 public/index.html 脚本，模拟输入答案点击解锁——
//      公开区直接渲染、错误答案提示「答案不正确」、正确答案解锁出专属信件视图（致[to]+正文）。
//      ⚠️ Node 端解密查不出 index.html 自身代码被改坏（参数/流程），这段专门抓它。
//   7. Lightbox 图片放大预览（jsdom，测试二内）：点照片打开预览、再点一下缩小退出、
//      Esc 关闭、无 ✕ 按钮（仅左上角下载）——逐项断言，防止 index.html 的交互代码被改坏。
//   8. 图片下载（jsdom，测试二内）：lightbox 点「下载」——手机端走 navigator.share(文件)；
//      桌面退回 <a download> 直链；手机端无分享能力（微信内置浏览器等）提示长按保存、不触发下载。
//   9. 一码多信（jsdom，测试二内）：同一二维码（?id=A-05）→ 公开区直接渲染；输入错误
//      收信码被拒；输入不同收信码分别路由到不同专属信件（demo：A-05 花花/梁雪/小童 三码三信）。
//   10. 动效冒烟（jsdom，测试二内）：扫码进页 #petals 生成花瓣；答对解锁触发礼花
//      （#confetti 标记 data-fired）；错误收信码不触发。jsdom 无 canvas 2D，绘制自动跳过。
//
// 安全约定：只输出 pass/fail，绝不打印答案、绝不打印解密后的明文内容。任一失败 → 非 0 退出。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const jsQR = require('jsqr');
const sharp = require('sharp');
const { JSDOM, VirtualConsole } = require('jsdom');

const PBKDF2_ITERATIONS = 100000; // 必须与 build.js / index.html 保持一致
const WRONG_ANSWER = '✦ 错误答案验证 ✦ 绝不可能是真实答案的占位串';

let failures = 0;
let checks = 0;
function pass(msg) { console.log(`  ✅ ${msg}`); checks++; }
function fail(msg) { console.error(`  ❌ ${msg}`); failures++; }
function section(title) { console.log(`\n── ${title} ──`); }

// 复用 build.js / index.html 的存储布局：iv(12) || GCM密文 || authTag(16) → Base64
function decryptData(saltB64, dataB64, answer) {
  const salt = Buffer.from(saltB64, 'base64');
  const combined = Buffer.from(dataB64, 'base64');
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12, combined.length - 16);
  const authTag = combined.subarray(combined.length - 16);
  const key = crypto.pbkdf2Sync(answer, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

// config 条目 → 其所有信件的答案列表（兼容两种写法：letters[] 与顶层 to/answer/secret 简写）
function configLetterAnswers(cfg) {
  if (!cfg) return [];
  if (Array.isArray(cfg.letters) && cfg.letters.length) return cfg.letters.map(l => l.answer);
  if (cfg.answer) return [cfg.answer];
  return [];
}

// config 条目 → 其所有信件的收件人列表（顺序与 configLetterAnswers 对齐）
function configLetterTos(cfg) {
  if (!cfg) return [];
  if (Array.isArray(cfg.letters) && cfg.letters.length) return cfg.letters.map(l => l.to);
  if (cfg.to) return [cfg.to];
  return [];
}

// git 当前（已暂存/已提交）跟踪的 media 路径集合，去掉 public/ 前缀与 data.json 引用对齐
function gitTrackedMediaPaths() {
  try {
    const out = execSync('git ls-files -c public/media', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const set = new Set();
    for (const line of out.split('\n')) {
      const p = line.trim();
      if (p && p.startsWith('public/')) set.add(p.slice('public/'.length));
    }
    return set;
  } catch (err) {
    console.log('  ⚠️  git 不可用，跳过 git 跟踪名校验');
    return null;
  }
}

// 校验单个媒体引用：磁盘上大小写精确存在 + git 跟踪名一致
function checkMediaPath(rel, tracked) {
  const p = path.join('public', rel);
  const dir = path.dirname(p);
  const base = path.basename(p);
  if (!fs.existsSync(dir) || !fs.readdirSync(dir).includes(base)) {
    fail(`媒体在磁盘上不存在或大小写不一致: ${rel}`);
    return;
  }
  pass(`媒体存在于磁盘: ${rel}`);
  if (!tracked) return;
  if (tracked.has(rel)) {
    pass(`git 跟踪名一致: ${rel}`);
  } else {
    // 未跟踪有两种可能：还没 git add（正常，跳过）；或 git 以不同大小写跟踪了同名文件（ignorecase 陷阱，拦下）
    const lower = rel.toLowerCase();
    const clash = [...tracked].find(p2 => p2.toLowerCase() === lower && p2 !== rel);
    if (clash) {
      fail(`git 以不同大小写跟踪了 ${clash}，而引用为 ${rel}（macOS ignorecase 陷阱）`);
    } else {
      pass(`已构建但尚未跟踪，git 名校验跳过: ${rel}`);
    }
  }
}

// 位图公开照片的响应式变体校验：build 会为每张位图照片生成 480/960/1600 档的
// AVIF/WebP/JPEG（见 build.js），这里逐一确认磁盘上存在，防止漏构建导致图片 404。
function checkPhotoVariants(photoRel) {
  const m = /^(.+)\.(jpe?g|png|webp|avif)$/i.exec(photoRel);
  if (!m) return;  // SVG 等非位图：不生成变体
  const base = m[1];
  const expects = [
    ...['jpg', 'webp', 'avif'].map(f => `${base}-480.${f}`),
    ...['jpg', 'webp', 'avif'].map(f => `${base}-960.${f}`),
    ...['webp', 'avif'].map(f => `${base}-1600.${f}`),
  ];
  for (const rel of expects) {
    const p = path.join('public', rel);
    const dir = path.dirname(p);
    const baseName = path.basename(p);
    if (fs.existsSync(dir) && fs.readdirSync(dir).includes(baseName)) {
      pass(`响应式变体存在: ${rel}`);
    } else {
      fail(`响应式变体缺失: ${rel}（未重新 npm run build？）`);
    }
  }
}

// ── QR 码：完整性 + 内容解码（测试三） ─────────────────────
// 每张二维码应编码 baseUrl?id=<id> —— URL 只与 baseUrl 和 id 相关，因此永不变：
// 同一张二维码（如 A-05）被多人扫描，各人输自己的收信码解锁各自的专属信件。
async function checkQRCodes(config) {
  const ids = config
    ? (config.entries || []).map(e => e.id).filter(Boolean)
    : [];
  const baseUrl = config ? (config.baseUrl || '').replace(/\/+$/, '') : '';

  if (ids.length === 0) { pass('无条目，跳过 QR 检查'); return; }
  if (!config) { fail('config.json 不存在，无法校验 QR 编码内容'); }
  else if (!baseUrl) { fail('config.baseUrl 缺失，无法校验 QR 编码内容'); }

  // 单张 QR：PNG 完整性 + jsqr 解码内容比对
  const checkQR = async (qrPath, expectedUrl, tag) => {
    if (!fs.existsSync(qrPath)) {
      fail(`${tag} 缺失: ${qrPath}（未运行 npm run build）`);
      return;
    }
    const sizeKB = (fs.statSync(qrPath).size / 1024).toFixed(1);

    let raw, info;
    try {
      ({ data: raw, info } = await sharp(qrPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
    } catch (err) {
      fail(`${tag} 不是有效 PNG: ${qrPath} (${err.message})`);
      return;
    }
    if (info.width !== 500 || info.height !== 500) {
      fail(`${tag} 尺寸异常: ${qrPath} ${info.width}x${info.height}（应为 500x500）`);
      return;
    }
    pass(`${tag} PNG 有效: ${qrPath} (500×500, ${sizeKB} KB)`);

    if (!baseUrl) return; // 内容校验的前提缺失，前面已 fail
    const code = jsQR(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), info.width, info.height);
    if (!code) {
      fail(`${tag} 内容无法识别: ${qrPath}`);
    } else if (code.data === expectedUrl) {
      pass(`${tag} 编码内容正确: ${code.data}`);
    } else {
      fail(`${tag} 编码内容与预期不符: ${qrPath}\n    预期: ${expectedUrl}\n    实际: ${code.data}`);
    }
  };

  for (const id of ids) {
    await checkQR(path.join('qrcodes', `${id}.png`), `${baseUrl}?id=${encodeURIComponent(id)}`, 'QR 码');
  }
}

// 用真实 public/index.html 起一个 jsdom 页面：
// 页面脚本 fetch('data.json') 从本地磁盘喂给它；jsdom 没有 crypto.subtle，换成 Node 的
// 原生 WebCrypto（同一套 PBKDF2/AES-GCM）；压掉「答案不正确」的 console.error（预期行为）。
function createDom(data, entryId) {
  const html = fs.readFileSync('public/index.html', 'utf-8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  virtualConsole.on('error', () => {});
  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: `http://localhost/?id=${entryId || ''}`,
    virtualConsole,
    beforeParse(window) {
      window.fetch = async (url) => {
        const p = path.join('public', url);
        if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => data };
      };
      Object.defineProperty(window, 'crypto', { value: require('crypto').webcrypto, configurable: true });
    }
  });
}

async function waitFor(win, check, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

// ── 浏览器流程冒烟测试（测试二）：真实 index.html + 模拟点击 ─────
async function checkBrowserFlow(data, configById) {
  // 挑一个有收件人（可解锁）的条目做流程测试；没有就只验公开区渲染
  const gatedId = Object.keys(data).find(id =>
    data[id] && Array.isArray(data[id].letters) && data[id].letters.length > 0);
  const answer = configLetterAnswers(configById[gatedId])[0] || null;

  const dom = createDom(data, gatedId);
  const win = dom.window;
  const doc = win.document;

  try {
    // ① 加载后公开区直接渲染（无需答题）
    const publicShown = await waitFor(win, () =>doc.getElementById('public').classList.contains('active'));
    if (!publicShown) { fail('浏览器: 加载后公开区未显示'); return; }
    pass('浏览器: 公开区直接渲染（照片/描述/问题，无需答题）');

    // 本次改动：question 文案进输入框占位符；question 单独一行与 footer 已移除
    if (doc.getElementById('question') || doc.getElementById('footer')) {
      fail('浏览器: question 单独一行 / footer 仍在（应已移除）');
    } else {
      pass('浏览器: question 单独一行与 footer 已移除');
    }

    if (!gatedId) { pass('浏览器: 无解锁条目，仅验公开区（符合设计）'); return; }
    if (!answer) { fail(`浏览器: 需真实答案测解锁流程，但 config 中 [${gatedId}] 缺 answer`); return; }

    const $input = doc.getElementById('answer-input');
    const $btn = doc.getElementById('unlock-btn');
    const $err = doc.getElementById('error-msg');

    // 问题文案作为输入框占位符（不再单独一行展示）
    const expectPh = (configById[gatedId] && configById[gatedId].question) || '请输入答案';
    if ($input.placeholder !== expectPh) {
      fail(`浏览器: 输入框占位符应为「${expectPh}」→ 实际「${$input.placeholder}」`);
    } else {
      pass('浏览器: 问题文案作为输入框占位符');
    }

    // ② 错误答案 → 提示「答案不正确」（不依赖真实答案，config 缺失也能验）
    $input.value = WRONG_ANSWER;
    $btn.click();
    const errShown = await waitFor(win, () =>/答案不正确/.test($err.textContent));
    if (!errShown) { fail('浏览器: 错误答案未提示「答案不正确」'); }
    else pass('浏览器: 错误答案被拒绝并提示');

    // ③ 正确答案 → 专属信件视图显示，致[to] 与正文匹配
    $input.value = answer;
    $btn.click();
    const letterShown = await waitFor(win, () => doc.getElementById('letter').classList.contains('active'));
    if (!letterShown) { fail('浏览器: 正确答案未解锁出专属信件'); return; }
    const toShown = doc.getElementById('letter-to').textContent;
    const expectedTo = (data[gatedId].letters[0] && data[gatedId].letters[0].to) || '';
    if (toShown !== expectedTo) {
      fail(`浏览器: 信件收信人应为「${expectedTo}」→ 实际「${toShown}」`);
      return;
    }
    pass(`浏览器: 正确答案解锁出专属信件（致 ${toShown}）`);
    const hasMedia =
      doc.getElementById('secret-images').children.length > 0 ||
      doc.getElementById('secret-videos').children.length > 0;
    if (doc.getElementById('content-text').textContent.trim() || hasMedia) {
      pass('浏览器: 专属信件正文/媒体已渲染');
    } else {
      fail('浏览器: 专属信件显示了但内容为空');
    }
  } finally {
    dom.window.close();
  }
}

// ── 一码多信（浏览器流程的一部分） ────────
// 同一张二维码（?id=A-05）→ 公开区直接渲染；输入不同收信码 → 各自专属信件。
// 断言：公开区渲染、错误收信码被拒、每封信的真实收信码 → 对应收信人的信件。
async function checkMultiLetterRouting(data, configById) {
  // 找一个「一封多信」条目（letters 多于 1 封），优先 A-05
  const multi = Object.keys(data).filter(id =>
    data[id] && Array.isArray(data[id].letters) && data[id].letters.length > 1);
  const gatedId = multi.includes('A-05') ? 'A-05' : multi[0];
  if (!gatedId) { pass('一码多信: 当前数据无多信件条目，跳过'); return; }

  const letters = data[gatedId].letters;
  const answers = configLetterAnswers(configById[gatedId]);
  if (answers.length < letters.length) {
    fail(`一码多信: [${gatedId}] config 答案数(${answers.length}) < data letters 数(${letters.length})`);
    return;
  }
  pass(`一码多信: 选中「${gatedId}」（${letters.length} 封信: ${letters.map(l => l.to).join('、')}）`);

  // ① 同一二维码扫码 → 公开区直接渲染（照片/描述/输入框，To 标签并列展示全部收件人）
  const dom = createDom(data, gatedId);
  const win = dom.window;
  const doc = win.document;
  try {
    const publicShown = await waitFor(win, () => doc.getElementById('public').classList.contains('active'));
    if (!publicShown) { fail(`一码多信: [${gatedId}] 扫码后公开区未渲染`); return; }
    pass('一码多信: 同一二维码扫码后公开区直接渲染');

    // ①′ 公开区 To 标签并列展示全部收件人（如「To 花花 / 梁雪 / 小童」）
    const expectLabel = `To ${letters.map(l => l.to).join(' / ')}`;
    const toLabelShown = doc.getElementById('to-label').textContent;
    if (toLabelShown !== expectLabel) {
      fail(`一码多信: [${gatedId}] 公开区收件人标签应为「${expectLabel}」→ 实际「${toLabelShown}」`);
    } else {
      pass(`一码多信: 公开区 To 标签并列展示收件人「${expectLabel}」`);
    }

    // ② 错误收信码 → 拒绝并提示，不出现专属信件
    const $input = doc.getElementById('answer-input');
    const $btn = doc.getElementById('unlock-btn');
    const $err = doc.getElementById('error-msg');
    $input.value = WRONG_ANSWER;
    $btn.click();
    const errShown = await waitFor(win, () => /答案不正确/.test($err.textContent));
    if (!errShown) { fail(`一码多信: [${gatedId}] 错误收信码未被拒绝`); }
    else pass('一码多信: 错误收信码被拒并提示');
    if (doc.getElementById('letter').classList.contains('active')) {
      fail(`一码多信: [${gatedId}] 错误收信码竟然解锁了专属信件`);
    }
  } finally {
    dom.window.close();
  }

  // ③ 每封信输自己的真实收信码 → 各自专属信件（收信人正确）
  for (let i = 0; i < letters.length; i++) {
    const letter = letters[i];
    const d2 = createDom(data, gatedId);
    const w2 = d2.window;
    const doc2 = w2.document;
    try {
      const shown = await waitFor(w2, () => doc2.getElementById('public').classList.contains('active'));
      if (!shown) { fail(`一码多信: [${gatedId}/${letter.to}] 公开区未渲染`); continue; }
      doc2.getElementById('answer-input').value = answers[i];
      doc2.getElementById('unlock-btn').click();
      const letterShown = await waitFor(w2, () => doc2.getElementById('letter').classList.contains('active'));
      if (!letterShown) { fail(`一码多信: [${gatedId}/${letter.to}] 输入正确收信码后未出现专属信件`); continue; }
      const toShown = doc2.getElementById('letter-to').textContent;
      if (toShown !== letter.to) {
        fail(`一码多信: [${gatedId}/${letter.to}] 应致「${letter.to}」→ 实际「${toShown}」`);
        continue;
      }
      pass(`一码多信: [${gatedId}/${letter.to}] 输入收信码解锁出专属信件（致 ${toShown}）`);
    } finally {
      d2.window.close();
    }
  }
}

// ── 裸地址（无 ?id=）：无统一入口，提示扫描收到的二维码 ──
async function checkNoEntryFallback(data) {
  const dom = createDom(data, null);   // ?id= 为空 → 无条目
  const win = dom.window;
  const doc = win.document;
  try {
    const errShown = await waitFor(win, () => doc.getElementById('state-error').classList.contains('active'));
    if (!errShown) { fail('裸地址: 未显示「请扫描收到的二维码」提示'); return; }
    if (!/扫描/.test(doc.getElementById('state-error-msg').textContent)) {
      fail('裸地址: 提示文案不包含「扫描」（应为请扫描收到的二维码）');
      return;
    }
    if (doc.getElementById('public').classList.contains('active')) {
      fail('裸地址: 不应显示公开区');
      return;
    }
    pass('裸地址: 提示请扫描收到的二维码，不显示公开区');
  } finally {
    dom.window.close();
  }
}

// ── Lightbox 图片放大预览冒烟（浏览器流程的一部分） ────
// 点照片打开全屏预览 → 再点一下即缩小退出 → Esc 关闭、背景滚动锁定。
// 无 ✕ 按钮（只有左上角下载）；jsdom 只发 click（无 pointer 手势）→ 视为干净点按。
async function checkLightbox(data) {
  const photoId = Object.keys(data).find(id => data[id] && data[id].photo);
  if (!photoId) { pass('lightbox: 当前数据无照片条目，跳过'); return; }

  const dom = createDom(data, photoId);
  const win = dom.window;
  const doc = win.document;

  try {
    if (!await waitFor(win, () => doc.getElementById('public').classList.contains('active'))) {
      fail('lightbox: 公开区未渲染，无法测照片放大');
      return;
    }
    const $photo = doc.getElementById('public-photo');
    if (!$photo.getAttribute('src')) { fail('lightbox: 公开照片未渲染 src'); return; }
    if (doc.getElementById('photo-wrap').style.display !== 'block') {
      fail('lightbox: 照片容器未显示'); return;
    }

    const $lb = doc.getElementById('lightbox');
    const $lbImg = doc.getElementById('lightbox-img');
    const $lbStage = doc.getElementById('lightbox-stage');
    const click = () => $lbStage.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

    // ① 点照片 → 打开预览 + 锁定背景滚动
    $photo.click();
    if (!$lb.classList.contains('open')) { fail('lightbox: 点照片未打开预览'); return; }
    if (!$lbImg.getAttribute('src')) { fail('lightbox: 预览 img 无 src'); return; }
    if (!doc.body.classList.contains('lightbox-open')) { fail('lightbox: 背景滚动未锁定'); return; }
    pass('lightbox: 点照片打开预览并锁定背景滚动');

    // ② 打开后再点一下 → 缩小退出
    click();
    if ($lb.classList.contains('open')) { fail('lightbox: 再点一下未关闭'); return; }
    pass('lightbox: 再点一下缩小退出');

    // ③ 重新打开 → Esc 关闭
    $photo.click();
    if (!$lb.classList.contains('open')) { fail('lightbox: 二次打开失败'); return; }
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if ($lb.classList.contains('open')) { fail('lightbox: Esc 未关闭'); return; }
    pass('lightbox: Esc 关闭');

    // ④ 无 ✕ 按钮（只保留左上角下载）
    if (doc.getElementById('lightbox-close')) { fail('lightbox: 不应再有 ✕ 关闭按钮'); return; }
    if (!doc.getElementById('lightbox-download')) { fail('lightbox: 应保留左上角下载按钮'); return; }
    pass('lightbox: 无 ✕ 按钮，仅保留左上角下载');
  } finally {
    dom.window.close();
  }
}

// ── 图片下载（浏览器流程的一部分） ────────────────────
// lightbox 里的「下载」按钮三条路径：① 手机端 navigator.share(文件)（可存相册）
// ② 桌面 <a download> 直链 ③ 手机端无分享能力（微信内置浏览器等）→ 提示长按保存，绝不触发下载
// （微信拦截一切下载）。jsdom 里打桩 fetch/canShare/matchMedia，分别断言。
async function checkDownloadImage(data) {
  const photoId = Object.keys(data).find(id => data[id] && data[id].photo);
  if (!photoId) { pass('下载: 当前数据无照片条目，跳过'); return; }

  const dom = createDom(data, photoId);
  const win = dom.window;
  const doc = win.document;

  try {
    if (!await waitFor(win, () => doc.getElementById('public').classList.contains('active'))) {
      fail('下载: 公开区未渲染'); return;
    }
    const $photo = doc.getElementById('public-photo');
    const $lb = doc.getElementById('lightbox');
    const $dl = doc.getElementById('lightbox-download');
    if (!$dl) { fail('下载: 缺少下载按钮'); return; }
    pass('下载: lightbox 内有下载按钮');

    // 打桩：图片 fetch 喂 Blob
    const blobFor = new win.Blob(['fake-image'], { type: 'image/jpeg' });
    win.fetch = async () => ({ ok: true, status: 200, blob: async () => blobFor });

    $photo.click();   // 打开 lightbox
    if (!$lb.classList.contains('open')) { fail('下载: lightbox 未打开'); return; }

    // ① 手机端 + 支持分享 → 走 navigator.share，携带图片文件
    win.matchMedia = () => ({ matches: false });   // 触屏设备（非 fine pointer）
    let shared = null;
    Object.defineProperty(win.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(win.navigator, 'share', { value: async (payload) => { shared = payload; }, configurable: true });
    $dl.click();
    if (!await waitFor(win, () => shared !== null)) { fail('下载: 手机端分享未触发'); return; }
    if (!shared.files || shared.files.length !== 1) { fail('下载: 分享未携带图片文件'); return; }
    if (!(shared.files[0] instanceof win.File)) { fail('下载: 分享文件不是 File 类型'); return; }
    pass('下载: 手机端优先走分享（携带图片文件）');

    // ② 桌面（fine pointer）→ <a download> 直链下载
    win.matchMedia = () => ({ matches: true });
    Object.defineProperty(win.navigator, 'canShare', { value: () => false, configurable: true });
    let anchor = null;
    const origClick = win.HTMLAnchorElement.prototype.click;
    win.HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute('download')) anchor = { href: this.href, download: this.getAttribute('download') };
      return origClick.call(this);
    };
    $dl.click();
    if (!await waitFor(win, () => anchor !== null)) { fail('下载: 桌面未触发 <a download>'); return; }
    if (!/\.(jpe?g|png|webp|avif|svg)$/i.test(anchor.download)) {
      fail(`下载: 下载文件名不对 → ${anchor.download}`); return;
    }
    pass(`下载: 桌面走 <a download> 直链下载（${anchor.download}）`);

    // ③ 手机端但无分享能力（微信内置浏览器等）→ 提示长按保存，不触发任何下载
    win.matchMedia = () => ({ matches: false });
    Object.defineProperty(win.navigator, 'canShare', { value: () => false, configurable: true });
    anchor = null;   // 重置 ② 的下载锚点，确认 ③ 不再触发下载
    $dl.click();
    const hintShown = await waitFor(win, () => {
      const el = doc.getElementById('download-hint');
      return el && el.classList.contains('show');
    });
    if (!hintShown) { fail('下载: 手机端无分享能力时未提示长按保存'); return; }
    if (anchor) { fail('下载: 微信场景误触发了 <a download>'); return; }
    pass('下载: 手机端无分享能力时提示长按保存（不触发下载）');
  } finally {
    dom.window.close();
  }
}

// ── 动效冒烟：花瓣飘落 + 解锁礼花（浏览器流程的一部分） ────
// 扫码进页 → #petals 生成花瓣；错误收信码不触发礼花；答对 → 专属信件出现且 #confetti 标记 fired。
// jsdom 无 canvas 2D（getContext 返回 null），fireConfetti 自动跳过绘制，data-fired 作触发断言点。
async function checkAmbienceEffects(data, configById) {
  const gatedId = Object.keys(data).find(id =>
    data[id] && Array.isArray(data[id].letters) && data[id].letters.length > 0);
  if (!gatedId) { pass('动效: 当前数据无门禁条目，跳过'); return; }
  const answer = configLetterAnswers(configById[gatedId])[0];
  if (!answer) { fail(`动效: [${gatedId}] 找不到真实收信码`); return; }

  const dom = createDom(data, gatedId);
  const win = dom.window;
  const doc = win.document;
  try {
    // ① 扫码进页 → 花瓣飘落容器生成花瓣
    if (!await waitFor(win, () => doc.getElementById('public').classList.contains('active'))) {
      fail('动效: 公开区未渲染'); return;
    }
    const petalCount = doc.getElementById('petals').children.length;
    if (petalCount === 0) { fail('动效: 进页后未生成花瓣'); return; }
    pass(`动效: 进页生成 ${petalCount} 片花瓣飘落`);
    if (!doc.getElementById('confetti')) { fail('动效: 缺少礼花 canvas'); return; }
    pass('动效: 礼花 canvas 就位');

    // ② 错误收信码 → 不触发礼花
    doc.getElementById('answer-input').value = WRONG_ANSWER;
    doc.getElementById('unlock-btn').click();
    await waitFor(win, () => /答案不正确/.test(doc.getElementById('error-msg').textContent));
    if (doc.getElementById('confetti').dataset.fired === '1') {
      fail('动效: 错误收信码竟触发了礼花'); return;
    }
    pass('动效: 错误收信码不触发礼花');

    // ③ 答对 → 专属信件出现 + 触发礼花（data-fired）
    doc.getElementById('answer-input').value = answer;
    doc.getElementById('unlock-btn').click();
    if (!await waitFor(win, () => doc.getElementById('letter').classList.contains('active'))) {
      fail('动效: 答对后专属信件未出现'); return;
    }
    if (doc.getElementById('confetti').dataset.fired !== '1') {
      fail('动效: 答对后未触发礼花'); return;
    }
    pass('动效: 答对解锁即触发礼花庆祝');
  } finally {
    dom.window.close();
  }
}

// ── 入口 ───────────────────────────────────────────────
async function main() {
  console.log('🔍 构建产物自检');

  if (!fs.existsSync('public/data.json')) {
    console.error('❌ public/data.json 不存在，请先运行 npm run build');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync('public/data.json', 'utf-8'));

  let config = null;
  if (fs.existsSync('config.json')) {
    config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
  } else {
    console.log('  ⚠️  config.json 不存在（本地才有），跳过解密校验，仅做媒体路径检查');
  }

  const tracked = gitTrackedMediaPaths();
  const configById = {};
  if (config) for (const e of (config.entries || [])) configById[e.id] = e;

  // 一码多信：同一信封内各封信的收信码必须两两不同，否则同一收信码命中多个收件人、路由歧义。
  // 只提醒不阻断（现仍有共享占位答案，等替换成真实答案后自然消失）；绝不打印答案本身。
  if (config) {
    for (const e of (config.entries || [])) {
      const ansList = configLetterAnswers(e);
      const toList = configLetterTos(e);
      const byAnswer = new Map();
      ansList.forEach((ans, i) => {
        if (!ans) return;
        if (!byAnswer.has(ans)) byAnswer.set(ans, []);
        byAnswer.get(ans).push(toList[i] || `#${i + 1}`);
      });
      for (const [answer, tos] of byAnswer) {
        if (tos.length > 1) {
          console.log(`  ⚠️ [${e.id}] 同一信封内多封信共用同一收信码，会命中错人（请改为唯一收信码）: ${tos.join('、')}`);
        }
      }
    }
  }

  const ids = Object.keys(data);
  if (ids.length === 0) fail('data.json 没有任何条目');

  // 反向一致性：config 有条目但 data.json 里没有 → 没重新构建，或构建时报错被跳过
  if (config) {
    for (const e of (config.entries || [])) {
      if (!data[e.id]) {
        fail(`config 有条目 [${e.id}] 但 data.json 中不存在 —— 未重新构建，或构建时该条目报错被跳过`);
      }
    }
  }

  let wrongTestDone = false;

  section('逐条目校验');
  for (const id of ids) {
    const entry = data[id];

    const cfg = configById[id];
    if (!cfg) {
      fail(`[${id}] data.json 有条目但 config.json 中不存在（可能是未重新构建的残留）`);
      continue;
    }

    // 媒体路径（photo 必查）+ 位图照片的响应式变体齐全
    if (entry.photo) {
      checkMediaPath(entry.photo, tracked);
      checkPhotoVariants(entry.photo);
    }

    // 无收件人条目：仅公开内容，无解密环节
    const letters = Array.isArray(entry.letters) ? entry.letters : [];
    if (letters.length === 0) {
      pass(`[${id}] 无收件人条目（仅公开照片+描述）`);
      continue;
    }

    // 门禁条目：逐封信用 config 的真实收信码解出 payload（答案即密钥）
    const answers = configLetterAnswers(cfg);
    if (answers.length !== letters.length) {
      fail(`[${id}] config 信件数与 data 不一致（${answers.length} vs ${letters.length}）`);
      continue;
    }

    for (let i = 0; i < letters.length; i++) {
      const letter = letters[i];
      const tag = `${id}/${letter.to || '???'}`;
      const answer = answers[i];

      let payload;
      try {
        const plaintext = decryptData(letter.salt, letter.data, answer);
        payload = JSON.parse(plaintext);
      } catch (e) {
        fail(`[${tag}] 真实收信码解密失败（加密参数或答案不同步）: ${e.message}`);
        continue;
      }
      if (typeof payload !== 'object' || payload === null) {
        fail(`[${tag}] 解密成功但 payload 非法`);
        continue;
      }
      const hasContent = !!payload.text ||
        (Array.isArray(payload.images) && payload.images.length > 0) ||
        (Array.isArray(payload.videos) && payload.videos.length > 0);
      if (!hasContent) {
        fail(`[${tag}] 解密出的额外内容为空（text/images/videos 全空）`);
        continue;
      }
      pass(`[${tag}] 真实收信码解密成功，payload 合法`);

      // 答对后可见的 secret 媒体路径也校验
      for (const rel of [...(payload.images || []), ...(payload.videos || [])]) {
        checkMediaPath(rel, tracked);
      }

      // 错误收信码拒绝测试（密码学原语对每条相同，测一次即可）
      if (!wrongTestDone) {
        wrongTestDone = true;
        try {
          decryptData(letter.salt, letter.data, WRONG_ANSWER);
          fail(`[${tag}] 错误收信码竟然解密成功 —— 拒绝逻辑失效！`);
        } catch {
          pass('错误收信码被正确拒绝（GCM 认证失败）');
        }
      }
    }
  }

  section('QR 码（测试三）');
  await checkQRCodes(config);

  section('浏览器流程（测试二）');
  await checkBrowserFlow(data, configById);

  section('一码多信 · 同一二维码多收件人');
  await checkMultiLetterRouting(data, configById);

  section('裸地址 · 无 ?id= 提示');
  await checkNoEntryFallback(data);

  section('Lightbox 图片放大预览');
  await checkLightbox(data);

  section('图片下载');
  await checkDownloadImage(data);

  section('动效 · 花瓣飘落 + 解锁礼花');
  await checkAmbienceEffects(data, configById);

  section('总结');
  console.log(`共 ${checks} 项检查，失败 ${failures} 项`);
  if (failures > 0) {
    console.error('❌ 自检未通过。请修复后重新 npm run build，再提交。');
    process.exit(1);
  } else {
    console.log('✅ 全部通过，可以提交');
  }
}

main().catch(err => {
  console.error('❌ 自检脚本异常:', err);
  process.exit(1);
});
