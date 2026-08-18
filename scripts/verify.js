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
//   10. 动效冒烟（jsdom，测试二内）：扫码进页 #petals 生成花瓣飘落，且不影响解锁流程。
//   11. 留言板构建产物：config.guestbook（provider+options）↔ public/guestbook.json 逐字段一致；
//       config 未启用 / 校验降级 → 产物 enabled=false；config.json 缺失时优雅跳过。
//   12. 留言板浏览器冒烟（jsdom，测试二内）：公开祝福块显示（含无收件人条目）、空文本拦截不发请求、
//       POST URL/头/body 正确且不含权限字段、成功反馈后可复用、失败保留输入可重试；
//       解锁门禁条目后信件回信块显示、body 归属收件人；disabled 时公开块隐藏。
//       ⚠️ 服务端权限（云数据库安全规则）的强制力无法在 jsdom 测（无真实网络），靠控制台配置 + 手动 curl 验证。
//   13. 背景音乐冒烟（jsdom，测试二内）：有 music 条目 → 音符按钮显示/audio.src 指向/进页自动播放（旋转）、
//       点按钮暂停→恢复；自动播放被拦（浏览器/微信）→ 首次手势兜底启动；无 music 条目 → 按钮隐藏不播放。
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
// opts（可选，向后兼容）：
//   guestbook     — 注入 public/guestbook.json 的返回内容（默认读磁盘产物，缺失 → {enabled:false}）
//   onFetch       — 拦截页面发出的绝对 http(s) 请求（如云函数 POST，jsdom 无真实网络），返回 mock 响应
//   blockAutoplay — true 时 HTMLMediaElement.play() 拒绝（模拟浏览器/微信拦截「带声音的自动播放」），
//                   用于测背景音乐「首次手势兜底启动」路径
function createDom(data, entryId, opts = {}) {
  const html = fs.readFileSync('public/index.html', 'utf-8');
  const guestbook = opts.guestbook !== undefined
    ? opts.guestbook
    : (fs.existsSync('public/guestbook.json')
        ? JSON.parse(fs.readFileSync('public/guestbook.json', 'utf-8'))
        : { enabled: false });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  virtualConsole.on('error', () => {});
  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: `http://localhost/?id=${entryId || ''}`,
    virtualConsole,
    beforeParse(window) {
      window.fetch = async (url, init) => {
        const u = String(url).split('?')[0];
        if (/^https?:\/\//.test(u)) {                  // 外部请求（如云函数 POST）→ 拦截
          if (opts.onFetch) return opts.onFetch(url, init);
          return { ok: false, status: 404, json: async () => ({}) };
        }
        if (u === 'guestbook.json') return { ok: true, status: 200, json: async () => guestbook };
        const p = path.join('public', u);
        if (u.endsWith('.lrc')) {
          // 歌词 .lrc：返回文本（磁盘产物优先；测试可注入 opts.lyricsText 样例，与真实产物解耦）
          const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : (opts.lyricsText || '');
          return { ok: true, status: 200, text: async () => text };
        }
        if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => data };
      };
      Object.defineProperty(window, 'crypto', { value: require('crypto').webcrypto, configurable: true });

      // jsdom 不实现媒体播放：打桩 HTMLMediaElement 的 load/play/pause（记录调用、不真播）。
      // 背景音乐/视频的页面逻辑依赖 play() 返回 Promise；blockAutoplay 时「只拦首次自动播放」
      // 拒绝——真实浏览器/微信只拦带声音的 autoplay，用户手势触发的 play() 是放行的，
      // 以此模拟「自动播放被拦 → 首次手势启动成功」的完整链路。
      const calls = window.__mediaCalls = { play: 0, pause: 0, blocked: !!opts.blockAutoplay, hang: !!opts.hangPlay };
      const ME = window.HTMLMediaElement;
      if (ME && ME.prototype) {
        ME.prototype.load = function () {};
        ME.prototype.pause = function () { calls.pause++; };
        ME.prototype.play = function () {
          calls.play++;
          if (calls.hang) return new Promise(() => {});   // play() 永不 settle（模拟大文件 mp3 缓冲挂起）
          // 只拦「首次自动播放」：真实浏览器/微信只拦带声音的 autoplay，
          // 用户手势触发的 play() 是放行的（模拟「自动播放被拦 → 首次手势启动成功」的链路）。
          if (calls.blocked && calls.play === 1) {
            return Promise.reject(new Error('NotAllowedError: autoplay blocked'));
          }
          return Promise.resolve();
        };
      }
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

// ── 留言板构建产物自检：config.guestbook（provider+options）↔ public/guestbook.json ──
// build.js 始终写出 guestbook.json；config 未启用/校验降级 → enabled=false，fail-safe。
function checkGuestbookBuild(config) {
  const gbFile = 'public/guestbook.json';
  if (!fs.existsSync(gbFile)) {
    fail('留言板: guestbook.json 不存在（未重新构建？）');
    return;
  }
  const gbOut = JSON.parse(fs.readFileSync(gbFile, 'utf-8'));

  if (!config) {
    pass('留言板: config.json 缺失（本地才跑解密），跳过 guestbook 一致性校验');
    return;
  }
  const gb = config.guestbook;

  if (!gb || gb.enabled !== true) {
    if (gbOut.enabled === false) {
      pass('留言板: config 未启用 → guestbook.json enabled=false');
    } else {
      fail(`留言板: config 未启用 guestbook，但 guestbook.json 却 enabled=${gbOut.enabled}（旧产物残留？）`);
    }
    return;
  }

  // config 已启用 → 产物必须 enabled=true 且字段与 config 一致
  if (gbOut.enabled !== true) {
    fail('留言板: config 已启用 guestbook，但 guestbook.json 未启用（构建校验失败降级，或未重新构建）');
    return;
  }
  if (gbOut.provider !== gb.provider) {
    fail(`留言板: provider 不一致（config=${gb.provider} vs 产物=${gbOut.provider}）`);
    return;
  }
  // 产物 options 各字段与 config 一致（provider 无关：比较两侧并集的所有键；
  // 归一化与 build.js 一致：trim + 去尾斜杠，避免 config 带尾斜杠被误报）
  const prod = gbOut.options || {};
  const conf = gb.options || {};
  const norm = v => String(v || '').trim().replace(/\/+$/, '');
  const mism = [...new Set([...Object.keys(prod), ...Object.keys(conf)])]
    .filter(k => norm(prod[k]) !== norm(conf[k]));
  if (mism.length) {
    fail(`留言板: guestbook.json options 与 config 不一致: ${mism.join(', ')}`);
  } else {
    pass(`留言板: guestbook.json 与 config 一致（${gb.provider}）`);
  }
}

// ── 留言板浏览器冒烟（jsdom）：公开祝福 / 信件回信 / 空校验 / 失败重试 / disabled ──
// ⚠️ 服务端权限（云数据库安全规则）的强制力无法在 jsdom 测（无真实网络），只能靠控制台配置 + 手动 curl 验证；
// 这里断言客户端发出去的请求正确（URL/method/headers/body、body 不含权限字段、成功/失败反馈）。
async function checkGuestbookFlow(data, configById) {
  const gbCfg = {
    enabled: true,
    provider: 'cloudbase',
    options: { url: 'https://cf.test/guestbook' }
  };
  const plainId = Object.keys(data).find(id =>
    data[id] && (!Array.isArray(data[id].letters) || data[id].letters.length === 0));
  const gatedId = Object.keys(data).find(id =>
    data[id] && Array.isArray(data[id].letters) && data[id].letters.length > 0);
  const baseId = plainId || gatedId;
  if (!baseId) { pass('留言板: 无任何条目，跳过'); return; }

  // ── 场景 A：留言板启用 + 公开祝福提交 ──
  const posts = [];
  const dom = createDom(data, baseId, {
    guestbook: gbCfg,
    onFetch: (url, init) => {
      posts.push({ url: String(url), init });
      return { ok: true, status: 201, json: async () => ({ objectId: 'obj-1' }) };
    }
  });
  const win = dom.window;
  const doc = win.document;
  try {
    const pubShown = await waitFor(win, () => doc.getElementById('guestbook-public').style.display === 'block');
    if (!pubShown) { fail('留言板: 公开留言块未显示'); return; }
    pass(plainId ? '留言板: 公开留言块显示（无收件人条目也显示）'
                 : '留言板: 公开留言块显示（当前数据无无收件人条目，用门禁条目验证）');

    const $gName = doc.getElementById('guest-name-public');
    const $gText = doc.getElementById('guest-text-public');
    const $gBtn  = doc.getElementById('guest-submit-public');
    const $gMsg  = doc.getElementById('guest-msg-public');

    // ② 空文本提交 → 拦截，不发请求
    $gBtn.click();
    const emptyBlocked = await waitFor(win, () => /留言不能为空/.test($gMsg.textContent));
    if (!emptyBlocked) { fail('留言板: 空文本提交未提示「留言不能为空」'); }
    else pass('留言板: 空文本提交被拦截并提示');
    if (posts.length !== 0) { fail(`留言板: 空提交竟发出了 ${posts.length} 次请求`); }
    else pass('留言板: 空提交未发出请求');

    // ③ 填名字+留言提交 → POST URL/方法/头/body 正确、body 不含权限字段
    $gName.value = '小胡';
    $gText.value = '新婚快乐，百年好合！';
    $gBtn.click();
    const sent = await waitFor(win, () => posts.length === 1);
    if (!sent) { fail('留言板: 提交后未发出 POST'); return; }
    const p = posts[0];
    if (p.url !== 'https://cf.test/guestbook') {
      fail(`留言板: POST URL 应为 https://cf.test/guestbook → 实际 ${p.url}`);
    } else pass('留言板: POST URL 正确（云函数 HTTP 访问服务地址）');
    if (p.init.method !== 'POST') fail('留言板: 请求方法应为 POST');
    else pass('留言板: 请求方法为 POST');
    const hdrs = p.init.headers || {};
    if ((hdrs['Content-Type'] || '').indexOf('application/json') !== 0) {
      fail(`留言板: Content-Type 应为 application/json → 实际 ${hdrs['Content-Type']}`);
    } else pass('留言板: Content-Type 为 application/json');
    if ('X-LC-Id' in hdrs || 'X-LC-Key' in hdrs) {
      fail('留言板: 不应携带 LeanCloud 专用头 X-LC-Id / X-LC-Key');
    } else pass('留言板: 无 LeanCloud 专用头（云函数只需 JSON body）');
    let body = null;
    try { body = JSON.parse(p.init.body); } catch (e) { fail('留言板: POST body 非合法 JSON'); }
    if (body) {
      const okBody = body.type === 'blessing' && body.entryId === baseId
        && body.name === '小胡' && body.text === '新婚快乐，百年好合！' && !body.ACL;
      if (!okBody) fail(`留言板: POST body 不正确（应 type=blessing/entryId=${baseId}/name/text，不含 ACL）→ ${JSON.stringify(body)}`);
      else pass('留言板: POST body 正确（type/entryId/name/text，不含公开写 ACL）');
    }

    // ④ 成功提示 + 表单可复用
    const okShown = await waitFor(win, () => /祝福已送达/.test($gMsg.textContent));
    if (!okShown) { fail('留言板: 未显示成功提示'); }
    else pass('留言板: 成功提示出现');
    if ($gText.value !== '') fail('留言板: 成功后留言未清空');
    else pass('留言板: 成功后留言已清空（保留名字）');

    $gText.value = '第二条祝福';
    $gBtn.click();
    const sent2 = await waitFor(win, () => posts.length === 2);
    if (!sent2) { fail('留言板: 第二次提交未发出 POST（表单不可复用）'); }
    else pass('留言板: 成功后表单可复用（第二次 POST 发出）');
  } finally {
    dom.window.close();
  }

  // ── 场景 B：提交失败 → 提示且保留输入可重试 ──
  const dom2 = createDom(data, baseId, {
    guestbook: gbCfg,
    onFetch: () => ({ ok: false, status: 500, json: async () => ({}) })
  });
  const win2 = dom2.window;
  const doc2 = win2.document;
  try {
    const shown2 = await waitFor(win2, () => doc2.getElementById('guestbook-public').style.display === 'block');
    if (!shown2) { fail('留言板: 失败路径公开块未显示'); }
    else {
      const t2 = doc2.getElementById('guest-text-public');
      t2.value = '这条会失败';
      doc2.getElementById('guest-submit-public').click();
      const failShown = await waitFor(win2, () => /提交失败/.test(doc2.getElementById('guest-msg-public').textContent));
      if (!failShown) { fail('留言板: 提交失败未提示「提交失败，请稍后重试」'); }
      else pass('留言板: 提交失败提示且保留输入（可重试）');
      if (t2.value !== '这条会失败') fail('留言板: 失败后输入未保留');
      else pass('留言板: 失败后输入保留');
    }
  } finally {
    dom2.window.close();
  }

  // ── 场景 C：门禁条目解锁 → 信件回信块 → type=letter、to 归属收件人 ──
  if (gatedId) {
    const answer = configById[gatedId] ? configLetterAnswers(configById[gatedId])[0] : null;
    if (answer) {
      const postsB = [];
      const domB = createDom(data, gatedId, {
        guestbook: gbCfg,
        onFetch: (url, init) => { postsB.push({ url: String(url), init }); return { ok: true, status: 201, json: async () => ({}) }; }
      });
      const winB = domB.window;
      const docB = winB.document;
      try {
        await waitFor(winB, () => docB.getElementById('public').classList.contains('active'));
        docB.getElementById('answer-input').value = answer;
        docB.getElementById('unlock-btn').click();
        const letterShown = await waitFor(winB, () => docB.getElementById('letter').classList.contains('active'));
        if (!letterShown) { fail('留言板: 门禁条目无法解锁（无法测回信）'); }
        else {
          const replyShown = docB.getElementById('guestbook-reply').style.display === 'block';
          if (!replyShown) { fail('留言板: 解锁后信件回信块未显示'); }
          else pass('留言板: 解锁后信件回信块显示');
          const expectedTo = (data[gatedId].letters[0] && data[gatedId].letters[0].to) || '';
          docB.getElementById('guest-text-reply').value = '祝你幸福！';
          docB.getElementById('guest-submit-reply').click();
          const sentB = await waitFor(winB, () => postsB.length === 1);
          if (!sentB) { fail('留言板: 回信未发出 POST'); }
          else {
            let b = null;
            try { b = JSON.parse(postsB[0].init.body); } catch (e) { fail('留言板: 回信 body 非 JSON'); }
            if (b && (b.type !== 'letter' || b.to !== expectedTo)) {
              fail(`留言板: 回信 body 应为 {type:'letter', to:'${expectedTo}'} → 实际 ${JSON.stringify(b)}`);
            } else if (b) {
              pass(`留言板: 回信 body 正确（type=letter, to=${expectedTo}）`);
            }
          }
        }
      } finally {
        domB.window.close();
      }
    } else {
      pass('留言板: config 缺失真实收信码，跳过回信流程测试');
    }
  } else {
    pass('留言板: 当前数据无门禁条目，跳过回信流程测试');
  }

  // ── 场景 D：留言板未启用 → 公开块隐藏 ──
  const domC = createDom(data, baseId, { guestbook: { enabled: false } });
  const winC = domC.window;
  const docC = winC.document;
  try {
    await waitFor(winC, () => docC.getElementById('public').classList.contains('active'));
    if (docC.getElementById('guestbook-public').style.display === 'none') {
      pass('留言板: disabled 时公开留言块隐藏');
    } else {
      fail('留言板: disabled 时公开留言块未隐藏');
    }
  } finally {
    domC.window.close();
  }

  // ── 场景 E：全局留言板启用，但条目 config guestbook:false → 该页公开块仍隐藏 ──
  const gbDisabledId = Object.keys(data).find(id => data[id] && data[id].guestbook === false);
  if (!gbDisabledId) { pass('留言板: 无 guestbook:false 条目，跳过 per-entry 关闭校验'); return; }
  const domE = createDom(data, gbDisabledId, {
    guestbook: { enabled: true, provider: 'cloudbase', options: { url: 'https://cf.test/guestbook' } }
  });
  const winE = domE.window;
  const docE = winE.document;
  try {
    await waitFor(winE, () => docE.getElementById('public').classList.contains('active'));
    if (docE.getElementById('guestbook-public').style.display === 'none') {
      pass(`留言板: [${gbDisabledId}] guestbook:false 条目在全局启用时不显示公开块`);
    } else {
      fail(`留言板: [${gbDisabledId}] guestbook:false 条目仍显示了公开块`);
    }
  } finally {
    domE.window.close();
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

// ── 动效冒烟：花瓣飘落（浏览器流程的一部分） ────
// 扫码进页 → #petals 生成花瓣；花瓣容器 pointer-events 不挡交互（纯装饰）。
async function checkPetalsEffect(data, configById) {
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

    // ② 花瓣存在时解锁流程不受影响（容器 pointer-events:none，纯装饰）
    doc.getElementById('answer-input').value = answer;
    doc.getElementById('unlock-btn').click();
    if (!await waitFor(win, () => doc.getElementById('letter').classList.contains('active'))) {
      fail('动效: 有花瓣时答对未解锁'); return;
    }
    pass('动效: 花瓣存在时解锁流程正常');
  } finally {
    dom.window.close();
  }
}

// ── 背景音乐冒烟（浏览器流程的一部分） ────────────────────
// 有 music 字段的条目：浮动音符按钮显示、audio.src 指向音乐、进页自动播放（按钮旋转）；
// 点按钮暂停→恢复；自动播放被拦（浏览器/微信）→ 首次手势（点页面任意处）兜底启动。
// 无 music 字段的条目：按钮隐藏、不触发播放。
async function checkBackgroundMusic(data) {
  const musicId = '__music_test__';
  const musicPath = 'media/__music_test__/music/test.mp3';
  // 合成一个带背景音乐的无收件人条目（真实数据暂无音乐条目时也能测；逻辑与数据解耦）
  const withMusic = Object.assign({}, data, {
    [musicId]: { description: '背景音乐测试条目', music: musicPath }
  });

  // ── 场景 A：正常自动播放 ──
  const dom = createDom(withMusic, musicId);
  const win = dom.window;
  const doc = win.document;
  try {
    if (!await waitFor(win, () => doc.getElementById('public').classList.contains('active'))) {
      fail('背景音乐: 音乐条目公开区未渲染'); return;
    }
    const $btn = doc.getElementById('music-btn');
    const $audio = doc.getElementById('bg-music');
    if ($btn.style.display === 'none') { fail('背景音乐: 音乐条目音符按钮未显示'); return; }
    pass('背景音乐: 音乐条目浮动音符按钮显示');
    if (!$audio.getAttribute('src') || $audio.getAttribute('src').indexOf(musicPath) === -1) {
      fail(`背景音乐: audio.src 应为 ${musicPath} → 实际 ${$audio.getAttribute('src')}`);
    } else {
      pass('背景音乐: audio.src 指向背景音乐文件');
    }
    if (win.__mediaCalls.play !== 1) { fail(`背景音乐: 进页应尝试自动播放 1 次（实际 ${win.__mediaCalls.play}）`); return; }
    if (!$btn.classList.contains('playing')) { fail('背景音乐: 自动播放成功后按钮应为旋转（playing）态'); return; }
    pass('背景音乐: 进页自动播放成功，音符按钮旋转');

    // 点按钮 → 暂停；再点 → 恢复播放
    $btn.click();
    if (win.__mediaCalls.pause !== 1) { fail('背景音乐: 点按钮未暂停'); return; }
    if ($btn.classList.contains('playing')) { fail('背景音乐: 暂停后按钮仍为 playing 态'); return; }
    pass('背景音乐: 点按钮暂停（音符停转）');
    $btn.click();
    if (win.__mediaCalls.play !== 2) { fail('背景音乐: 再点按钮未恢复播放'); return; }
    // play() 返回的 Promise 在微任务里才把按钮置回 playing 态，需轮询等待
    const resumed = await waitFor(win, () => $btn.classList.contains('playing'));
    if (!resumed) { fail('背景音乐: 恢复播放后按钮未回到 playing 态'); return; }
    pass('背景音乐: 再点按钮恢复播放');
  } finally {
    dom.window.close();
  }

  // ── 场景 B：自动播放被拦 → 首次手势启动（微信/浏览器兜底） ──
  const domB = createDom(withMusic, musicId, { blockAutoplay: true });
  const winB = domB.window;
  const docB = winB.document;
  try {
    if (!await waitFor(winB, () => docB.getElementById('public').classList.contains('active'))) {
      fail('背景音乐: 被拦场景公开区未渲染'); return;
    }
    const $btnB = docB.getElementById('music-btn');
    if (winB.__mediaCalls.play !== 1) { fail('背景音乐: 被拦场景应尝试过自动播放'); return; }
    if (!$btnB.classList.contains('paused')) { fail('背景音乐: 被拦后按钮应为暂停态（未播放）'); return; }
    pass('背景音乐: 自动播放被拦 → 按钮暂停态，等待用户手势');
    // 点页面任意处（非按钮）→ 音乐启动（手势兜底）
    // ⚠️ 等「playing 类」而非 play 计数：play() 由 stub 同步计数，但 setMusicPlaying(true)
    //    在 window 微任务里执行，等类出现才说明状态真正生效（与「再点恢复播放」同理）。
    docB.dispatchEvent(new winB.MouseEvent('click', { bubbles: true, cancelable: true }));
    const gestureStarted = await waitFor(winB, () =>
      winB.__mediaCalls.play >= 2 && $btnB.classList.contains('playing'));
    if (!gestureStarted) { fail('背景音乐: 手势启动后按钮应为 playing 态'); return; }
    pass('背景音乐: 被拦后首次点页面任意处启动');
  } finally {
    domB.window.close();
  }

  // ── 场景 C：无音乐条目 → 按钮隐藏、不播放 ──
  const plainId = Object.keys(data).find(id => data[id] && !data[id].music);
  if (!plainId) { pass('背景音乐: 当前数据所有条目都带音乐，跳过隐藏校验'); return; }
  const domC = createDom(data, plainId);
  const winC = domC.window;
  const docC = winC.document;
  try {
    await waitFor(winC, () => docC.getElementById('public').classList.contains('active'));
    const btnC = docC.getElementById('music-btn');
    if (btnC.style.display !== 'none') { fail('背景音乐: 无音乐条目音符按钮不应显示'); return; }
    if (winC.__mediaCalls.play !== 0) { fail('背景音乐: 无音乐条目不应触发播放'); return; }
    pass('背景音乐: 无音乐条目音符按钮隐藏、不自动播放');
  } finally {
    domC.window.close();
  }

  // ── 场景 D：play() 挂起（大文件缓冲）→ 点击按钮立即进播放态反馈 ──
  // 真实手机：9.6MB mp3 在弱网下首次 play() 会挂起十几秒等缓冲，若等 play() 结果才换 UI，
  // 按钮全程无反馈 = 「点了没反应」。乐观反馈：点击瞬间先置播放态（音符旋转），不等缓冲。
  const domD = createDom(withMusic, musicId, { hangPlay: true });
  const winD = domD.window;
  const docD = winD.document;
  try {
    if (!await waitFor(winD, () => docD.getElementById('public').classList.contains('active'))) {
      fail('背景音乐: 挂起场景公开区未渲染'); return;
    }
    const $btnD = docD.getElementById('music-btn');
    if (winD.__mediaCalls.play !== 1) { fail('背景音乐: 挂起场景进页应尝试自动播放 1 次'); return; }
    if ($btnD.classList.contains('playing')) { fail('背景音乐: play 挂起时自动播放不应直接置播放态'); return; }
    $btnD.click();
    if (winD.__mediaCalls.play !== 2) { fail('背景音乐: 点击后应再次调用 play'); return; }
    if (!$btnD.classList.contains('playing')) { fail('背景音乐: play 挂起时点击按钮应立即给播放态反馈'); return; }
    pass('背景音乐: play() 挂起时点击按钮立即进入播放态（乐观反馈，不等缓冲）');
  } finally {
    domD.window.close();
  }

  // ── 场景 E：微信 WeixinJSBridgeReady 事件 → 补试自动播放（无需用户手势） ──
  // 部分微信版本只在 WeixinJSBridge 就绪后才放行自动播放；页面监听该事件，触发时再试一次，
  // 若被拦的那次已把 play 置为暂停态，补试成功即进入播放态。
  const domE = createDom(withMusic, musicId, { blockAutoplay: true });
  const winE = domE.window;
  const docE = winE.document;
  try {
    if (!await waitFor(winE, () => docE.getElementById('public').classList.contains('active'))) {
      fail('背景音乐: 微信 bridge 场景公开区未渲染'); return;
    }
    const $btnE = docE.getElementById('music-btn');
    if (winE.__mediaCalls.play !== 1) { fail('背景音乐: bridge 场景应先有 1 次被拦的自动播放尝试'); return; }
    docE.dispatchEvent(new winE.Event('WeixinJSBridgeReady'));
    const bridged = await waitFor(winE, () =>
      winE.__mediaCalls.play >= 2 && $btnE.classList.contains('playing'));
    if (!bridged) { fail('背景音乐: WeixinJSBridgeReady 后应补试自动播放并进入播放态'); return; }
    pass('背景音乐: WeixinJSBridgeReady 事件触发自动播放补试');
  } finally {
    domE.window.close();
  }
}

// ── 歌词：随背景音乐同步滚动（浏览器冒烟） ──
// 有 lyrics 字段的条目：歌词面板显示、行数与样例 LRC 一致、timeupdate 时对应行高亮（active 类，
// seek 后自动对齐）；无 lyrics 字段：面板隐藏。样例用注入的 opts.lyricsText，与真实产物解耦。
async function checkLyrics(data) {
  const lyricsId = '__lyrics_test__';
  const musicPath = 'media/__lyrics_test__/music/test.mp3';
  const SAMPLE = [
    '[00:00.00] 第一句歌词',
    '[00:05.00] 第二句歌词',
    '[00:10.00] 第三句歌词',
    '[00:15.00] 第四句歌词'
  ].join('\n');
  const withLyrics = Object.assign({}, data, {
    [lyricsId]: {
      description: '歌词测试条目',
      music: musicPath,
      lyrics: 'media/__lyrics_test__/lyrics/test.lrc'
    }
  });

  // ── 场景 A：有歌词 → 面板显示、行数正确、timeupdate 高亮对应行 ──
  const dom = createDom(withLyrics, lyricsId, { lyricsText: SAMPLE });
  const win = dom.window;
  const doc = win.document;
  try {
    const panel = doc.getElementById('lyrics');
    if (!await waitFor(win, () => panel.style.display === 'block')) {
      fail('歌词: 有 lyrics 的条目歌词面板未显示'); return;
    }
    pass('歌词: 歌词面板显示');

    const lines = doc.getElementById('lyrics-scroll').children;
    if (lines.length !== 4) { fail(`歌词: 应渲染 4 行（实际 ${lines.length}）`); return; }
    pass('歌词: 行数与样例 LRC 一致');

    // 播放到 00:07（第 2 句）→ 派发 timeupdate → 第 2 行高亮、第 1 行取消
    const $audio = doc.getElementById('bg-music');
    $audio.currentTime = 7.0;
    $audio.dispatchEvent(new win.Event('timeupdate'));
    if (!lines[1].classList.contains('active')) { fail('歌词: 播放到第 2 句时间点，第 2 行应高亮'); return; }
    if (lines[0].classList.contains('active')) { fail('歌词: 第 1 行不应仍为高亮'); return; }
    pass('歌词: timeupdate 高亮当前行（seek 后自动对齐）');

    // 跳到最后一句之后 → 最后一行高亮
    $audio.currentTime = 99.0;
    $audio.dispatchEvent(new win.Event('timeupdate'));
    if (!lines[3].classList.contains('active')) { fail('歌词: 播放到结尾，最后一行应高亮'); return; }
    pass('歌词: 结尾处最后一行高亮');
  } finally {
    dom.window.close();
  }

  // ── 场景 B：无 lyrics → 面板隐藏 ──
  const plainId = Object.keys(data).find(id => data[id] && !data[id].lyrics);
  if (!plainId) { pass('歌词: 当前数据所有条目都带 lyrics，跳过隐藏校验'); return; }
  const domB = createDom(data, plainId);
  const winB = domB.window;
  const docB = winB.document;
  try {
    await waitFor(winB, () => docB.getElementById('public').classList.contains('active'));
    if (docB.getElementById('lyrics').style.display === 'none') {
      pass('歌词: 无 lyrics 条目歌词面板隐藏');
    } else {
      fail('歌词: 无 lyrics 条目歌词面板未隐藏');
    }
  } finally {
    domB.window.close();
  }
}

// ── 描述落点突出块（emphasis，浏览器冒烟） ─────────────
// 有 emphasis 字段的条目：突出块显示、textContent 与字段一致；无 emphasis 条目：块隐藏。
// 场景 A/B 用合成条目测显示逻辑（与真实产物解耦）；再用真实 walking-fish 数据做端到端断言
// （婚礼独白应从描述正文拆出、只出现在突出块里）。
async function checkEmphasis(data) {
  const emphId = '__emphasis_test__';
  const TEXT = '这也是想对彼此说的话：往后余生，我们互为陆地，随时可以哭泣。\n\n愿你也能遇见这样的人。';
  const withEmph = Object.assign({}, data, {
    [emphId]: { description: '测试条目', emphasis: TEXT }
  });

  // ── 场景 A：有 emphasis → 块显示、文本一致 ──
  const dom = createDom(withEmph, emphId);
  const win = dom.window;
  const doc = win.document;
  try {
    if (!await waitFor(win, () => doc.getElementById('public').classList.contains('active'))) {
      fail('emphasis: 公开区未渲染'); return;
    }
    const $el = doc.getElementById('emphasis');
    if ($el.style.display === 'none') { fail('emphasis: 有 emphasis 的条目突出块未显示'); return; }
    pass('emphasis: 有 emphasis 的条目突出块显示');
    if ($el.textContent !== TEXT) { fail('emphasis: 突出块文本与 config 字段不一致'); return; }
    pass('emphasis: 突出块文本与 emphasis 字段一致');
  } finally {
    dom.window.close();
  }

  // ── 场景 B：真实 walking-fish 端到端（独白应从描述正文拆出，只出现在突出块） ──
  const fish = data['walking-fish'];
  if (fish && fish.emphasis) {
    const domB = createDom(data, 'walking-fish');
    const winB = domB.window;
    const docB = winB.document;
    try {
      await waitFor(winB, () => docB.getElementById('public').classList.contains('active'));
      const $elB = docB.getElementById('emphasis');
      if ($elB.style.display === 'none') { fail('emphasis: walking-fish 突出块未显示'); return; }
      pass('emphasis: walking-fish 突出块显示');
      if (docB.getElementById('description').textContent.indexOf('这也是我们想对彼此说的话') !== -1) {
        fail('emphasis: 婚礼独白不应残留在描述正文中'); return;
      }
      pass('emphasis: 婚礼独白已从描述正文拆出，只出现在突出块');
    } finally {
      domB.window.close();
    }
  } else {
    pass('emphasis: walking-fish 暂无 emphasis，跳过端到端断言');
  }

  // ── 场景 C：无 emphasis 条目 → 块隐藏 ──
  const plainId = Object.keys(data).find(id => data[id] && !data[id].emphasis);
  if (!plainId) { pass('emphasis: 当前数据所有条目都带 emphasis，跳过隐藏校验'); return; }
  const domC = createDom(data, plainId);
  const winC = domC.window;
  const docC = winC.document;
  try {
    await waitFor(winC, () => docC.getElementById('public').classList.contains('active'));
    if (docC.getElementById('emphasis').style.display === 'none') {
      pass('emphasis: 无 emphasis 条目突出块隐藏');
    } else {
      fail('emphasis: 无 emphasis 条目突出块未隐藏');
    }
  } finally {
    domC.window.close();
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

  section('留言板构建产物');
  checkGuestbookBuild(config);

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
    // 背景音乐（公开自动播放，保留原文件名）媒体路径
    if (entry.music) checkMediaPath(entry.music, tracked);

    // 歌词（LRC，公开随音乐滚动）媒体路径
    if (entry.lyrics) checkMediaPath(entry.lyrics, tracked);

    // 该条目关闭留言板（guestbook:false）双向一致性：config 声明 ⇔ data 写入
    if (cfg.guestbook === false && entry.guestbook !== false) {
      fail(`[${id}] config 声明 guestbook:false 但 data 未写入该字段（未重新构建？）`);
    } else if (cfg.guestbook !== false && entry.guestbook === false) {
      fail(`[${id}] data 有 guestbook:false 但 config 未声明（残留？）`);
    }

    // 描述落点突出块（emphasis）双向一致性：config 声明 ⇔ data 写入（纯文本透传，应完全一致）
    if (cfg.emphasis && entry.emphasis !== cfg.emphasis) {
      fail(`[${id}] config 有 emphasis 但 data 未写入对应内容（未重新构建？）`);
    } else if (!cfg.emphasis && entry.emphasis) {
      fail(`[${id}] data 有 emphasis 但 config 未声明（残留？）`);
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

  section('留言板 · 提交祝福 / 回信（浏览器）');
  await checkGuestbookFlow(data, configById);

  section('裸地址 · 无 ?id= 提示');
  await checkNoEntryFallback(data);

  section('Lightbox 图片放大预览');
  await checkLightbox(data);

  section('图片下载');
  await checkDownloadImage(data);

  section('动效 · 花瓣飘落');
  await checkPetalsEffect(data, configById);

  section('背景音乐 · 自动播放/手势兜底');
  await checkBackgroundMusic(data);

  section('歌词 · 随音乐同步滚动');
  await checkLyrics(data);

  section('描述落点突出块');
  await checkEmphasis(data);

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
