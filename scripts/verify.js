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
//      公开区直接渲染、错误答案提示「答案不正确」、正确答案解锁出 secret 区。
//      ⚠️ Node 端解密查不出 index.html 自身代码被改坏（参数/流程），这段专门抓它。
//   7. Lightbox 图片放大预览（jsdom，测试二内）：点照片打开预览、图内点按放大/还原、
//      点背景/Esc/✕ 关闭 —— 逐项断言，防止 index.html 的交互代码被改坏。
//   8. 图片下载（jsdom，测试二内）：lightbox 点「下载」——手机端走 navigator.share(文件)，
//      桌面/Android 退回 <a download>，逐路径断言。
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
async function checkQRCodes(config) {
  const ids = config
    ? (config.entries || []).map(e => e.id).filter(Boolean)
    : [];
  const baseUrl = config ? (config.baseUrl || '').replace(/\/+$/, '') : '';

  if (ids.length === 0) { pass('无条目，跳过 QR 检查'); return; }
  if (!config) { fail('config.json 不存在，无法校验 QR 编码内容'); }
  else if (!baseUrl) { fail('config.baseUrl 缺失，无法校验 QR 编码内容'); }

  for (const id of ids) {
    const qrPath = path.join('qrcodes', `${id}.png`);
    if (!fs.existsSync(qrPath)) {
      fail(`QR 码缺失: qrcodes/${id}.png（未运行 npm run build）`);
      continue;
    }
    const sizeKB = (fs.statSync(qrPath).size / 1024).toFixed(1);

    let raw, info;
    try {
      ({ data: raw, info } = await sharp(qrPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
    } catch (err) {
      fail(`QR 码不是有效 PNG: qrcodes/${id}.png (${err.message})`);
      continue;
    }
    if (info.width !== 500 || info.height !== 500) {
      fail(`QR 码尺寸异常: qrcodes/${id}.png ${info.width}x${info.height}（应为 500x500）`);
      continue;
    }
    pass(`QR PNG 有效: qrcodes/${id}.png (500×500, ${sizeKB} KB)`);

    if (!baseUrl) continue; // 内容校验的前提缺失，前面已 fail
    const code = jsQR(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), info.width, info.height);
    const expected = `${baseUrl}?id=${encodeURIComponent(id)}`;
    if (!code) {
      fail(`QR 内容无法识别: qrcodes/${id}.png`);
    } else if (code.data === expected) {
      pass(`QR 编码内容正确: ${code.data}`);
    } else {
      fail(`QR 编码内容与预期不符: qrcodes/${id}.png\n    预期: ${expected}\n    实际: ${code.data}`);
    }
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
  const gatedId = Object.keys(data).find(id => data[id] && data[id].data);
  const answer = (gatedId && configById[gatedId] && configById[gatedId].answer) || null;

  const dom = createDom(data, gatedId);
  const win = dom.window;
  const doc = win.document;

  try {
    // ① 加载后公开区直接渲染（无需答题）
    const publicShown = await waitFor(win, () =>doc.getElementById('public').classList.contains('active'));
    if (!publicShown) { fail('浏览器: 加载后公开区未显示'); return; }
    pass('浏览器: 公开区直接渲染（照片/描述/问题，无需答题）');

    if (!gatedId) { pass('浏览器: 无解锁条目，仅验公开区（符合设计）'); return; }
    if (!answer) { fail(`浏览器: 需真实答案测解锁流程，但 config 中 [${gatedId}] 缺 answer`); return; }

    const $input = doc.getElementById('answer-input');
    const $btn = doc.getElementById('unlock-btn');
    const $err = doc.getElementById('error-msg');

    // ② 错误答案 → 提示「答案不正确」（不依赖真实答案，config 缺失也能验）
    $input.value = WRONG_ANSWER;
    $btn.click();
    const errShown = await waitFor(win, () =>/答案不正确/.test($err.textContent));
    if (!errShown) { fail('浏览器: 错误答案未提示「答案不正确」'); }
    else pass('浏览器: 错误答案被拒绝并提示');

    // ③ 正确答案 → secret 区显示且渲染了额外内容
    $input.value = answer;
    $btn.click();
    const secretShown = await waitFor(win, () =>doc.getElementById('secret').classList.contains('active'));
    if (!secretShown) { fail('浏览器: 正确答案未解锁出额外内容'); return; }
    const hasMedia =
      doc.getElementById('secret-images').children.length > 0 ||
      doc.getElementById('secret-videos').children.length > 0;
    if (doc.getElementById('content-text').textContent.trim() || hasMedia) {
      pass('浏览器: 正确答案解锁成功，额外内容已渲染');
    } else {
      fail('浏览器: secret 区显示了但内容为空');
    }
  } finally {
    dom.window.close();
  }
}

// ── Lightbox 图片放大预览冒烟（浏览器流程的一部分） ────
// 点照片打开全屏预览 → 图内点按放大/还原 → 点图外背景 / Esc / ✕ 关闭、背景滚动锁定。
// jsdom 的 getBoundingClientRect 恒为 0，测试里覆写成假矩形，让「点在图内/图外」可判定。
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
    const $lbClose = doc.getElementById('lightbox-close');
    const click = (el, x, y) =>
      el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));

    // ① 点照片 → 打开预览 + 锁定背景滚动
    $photo.click();
    if (!$lb.classList.contains('open')) { fail('lightbox: 点照片未打开预览'); return; }
    if (!$lbImg.getAttribute('src')) { fail('lightbox: 预览 img 无 src'); return; }
    if (!doc.body.classList.contains('lightbox-open')) { fail('lightbox: 背景滚动未锁定'); return; }
    pass('lightbox: 点照片打开预览并锁定背景滚动');

    // ② 图内点按 → 放大 2.4x；再点按 → 还原
    Object.defineProperty($lbImg, 'getBoundingClientRect', { value: () => ({ left: 100, top: 100, right: 300, bottom: 300 }) });
    click($lbStage, 150, 150);
    if (!/scale\(2\.4\)/.test($lbImg.style.transform)) {
      fail(`lightbox: 图内点按未放大到 2.4x → ${$lbImg.style.transform}`); return;
    }
    pass('lightbox: 图内点按放大到 2.4x');
    click($lbStage, 150, 150);
    if ($lbImg.style.transform !== 'translate(0px, 0px) scale(1)') {
      fail('lightbox: 再点按未还原'); return;
    }
    pass('lightbox: 再点按还原');

    // ③ 点图外背景 → 关闭
    click($lbStage, 10, 10);
    if ($lb.classList.contains('open')) { fail('lightbox: 点背景未关闭'); return; }
    pass('lightbox: 点图外背景关闭');

    // ④ 重新打开 → Esc 关闭
    $photo.click();
    if (!$lb.classList.contains('open')) { fail('lightbox: 二次打开失败'); return; }
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if ($lb.classList.contains('open')) { fail('lightbox: Esc 未关闭'); return; }
    pass('lightbox: Esc 关闭');

    // ⑤ ✕ 按钮关闭
    $photo.click();
    if (!$lb.classList.contains('open')) { fail('lightbox: 第三次打开失败'); return; }
    $lbClose.click();
    if ($lb.classList.contains('open')) { fail('lightbox: ✕ 按钮未关闭'); return; }
    pass('lightbox: ✕ 按钮关闭');
  } finally {
    dom.window.close();
  }
}

// ── 图片下载（浏览器流程的一部分） ────────────────────
// lightbox 里的「下载」按钮：fetch 原图 → Blob → ① 手机端 navigator.share(文件)（可存相册）
// ② 桌面/Android 退回 <a download>（createObjectURL）。jsdom 里打桩 fetch/URL/canShare 分别断言。
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

    // 打桩：图片 fetch 喂 Blob；URL.createObjectURL / window.open 记录调用
    const blobFor = new win.Blob(['fake-image'], { type: 'image/jpeg' });
    const created = [];
    win.URL.createObjectURL = (b) => { created.push(b); return 'blob:mock'; };
    win.fetch = async () => ({ ok: true, status: 200, blob: async () => blobFor });
    win.open = () => {};

    $photo.click();   // 打开 lightbox
    if (!$lb.classList.contains('open')) { fail('下载: lightbox 未打开'); return; }

    // ① 手机端：canShare 支持 → 走 navigator.share，携带图片文件
    let shared = null;
    Object.defineProperty(win.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(win.navigator, 'share', { value: async (payload) => { shared = payload; }, configurable: true });

    $dl.click();
    const sharedDone = await waitFor(win, () => shared !== null);
    if (!sharedDone) { fail('下载: 手机端分享未触发'); return; }
    if (!shared || !shared.files || shared.files.length !== 1) {
      fail('下载: 分享未携带图片文件'); return;
    }
    if (!(shared.files[0] instanceof win.File)) { fail('下载: 分享文件不是 File 类型'); return; }
    pass('下载: 手机端优先走分享（携带图片文件）');

    // ② 桌面/Android：canShare 不支持 → 走 <a download>（createObjectURL 被调用）
    const before = created.length;
    Object.defineProperty(win.navigator, 'canShare', { value: () => false, configurable: true });
    $dl.click();
    const objDone = await waitFor(win, () => created.length > before);
    if (!objDone) { fail('下载: 桌面路径未走 createObjectURL'); return; }
    if (!(created[created.length - 1] instanceof win.Blob)) { fail('下载: createObjectURL 参数不是 Blob'); return; }
    pass('下载: 桌面/Android 走 <a download> 下载');
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
    if (!entry.data) {
      pass(`[${id}] 无收件人条目（仅公开照片+描述）`);
      continue;
    }

    // 有收件人条目：必须能凭 config 的真实答案解出 payload
    if (!cfg.answer) {
      fail(`[${id}] 有收件人但 config 缺 answer`);
      continue;
    }

    let payload;
    try {
      const plaintext = decryptData(entry.salt, entry.data, cfg.answer);
      payload = JSON.parse(plaintext);
    } catch (e) {
      fail(`[${id}] 真实答案解密失败（加密参数或答案不同步）: ${e.message}`);
      continue;
    }
    if (typeof payload !== 'object' || payload === null) {
      fail(`[${id}] 解密成功但 payload 非法`);
      continue;
    }
    const hasContent = !!payload.text ||
      (Array.isArray(payload.images) && payload.images.length > 0) ||
      (Array.isArray(payload.videos) && payload.videos.length > 0);
    if (!hasContent) {
      fail(`[${id}] 解密出的额外内容为空（text/images/videos 全空）`);
      continue;
    }
    pass(`[${id}] 真实答案解密成功，payload 合法`);

    // 答对后可见的 secret 媒体路径也校验
    for (const rel of [...(payload.images || []), ...(payload.videos || [])]) {
      checkMediaPath(rel, tracked);
    }

    // 错误答案拒绝测试（密码学原语对每个条目相同，测一次即可）
    if (!wrongTestDone) {
      wrongTestDone = true;
      try {
        decryptData(entry.salt, entry.data, WRONG_ANSWER);
        fail('错误答案竟然解密成功 —— 拒绝逻辑失效！');
      } catch {
        pass('错误答案被正确拒绝（GCM 认证失败）');
      }
    }
  }

  section('QR 码（测试三）');
  await checkQRCodes(config);

  section('浏览器流程（测试二）');
  await checkBrowserFlow(data, configById);

  section('Lightbox 图片放大预览');
  await checkLightbox(data);

  section('图片下载');
  await checkDownloadImage(data);

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
