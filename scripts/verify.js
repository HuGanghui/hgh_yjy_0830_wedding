#!/usr/bin/env node
'use strict';
// 构建产物自检脚本（本地运行；pre-commit 钩子会调用，也可 npm run verify 手动跑）。
//   1. 条目一致性：config.json 与 public/data.json 相互对得上（防「改了配置忘了构建」）
//   2. 加解密链路：用 config.json 的【真实答案】解密每个有收件人条目的密文
//      —— 解不出或 payload 非法，说明 build.js 与 index.html 加密参数不同步
//   3. 拒绝逻辑：用错误答案试一次，确认被 GCM 认证拒绝（答案即密钥）
//   4. 媒体路径：data.json 引用的 photo + 答对后可见的 images/videos 在磁盘上大小写精确存在，
//      且与 git 实际跟踪的文件名大小写一致（macOS git core.ignorecase=true 曾把小写文件名
//      按大写提交，导致 GitHub 上 404 —— 本地磁盘大小写不敏感查不出，只能靠 git ls-files）
//
// 安全约定：只输出每个条目的 pass/fail，绝不打印答案、绝不打印解密后的明文内容。
// 任一检查失败 → 非 0 退出。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PBKDF2_ITERATIONS = 100000; // 必须与 build.js / index.html 保持一致
const SALT_BYTES = 16;            // 见 CLAUDE.md「架构与加密契约」

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

// ── 入口 ───────────────────────────────────────────────
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
const WRONG_ANSWER = '✦ 错误答案验证 ✦ 绝不可能是真实答案的占位串';

section('逐条目校验');
for (const id of ids) {
  const entry = data[id];

  const cfg = configById[id];
  if (!cfg) {
    fail(`[${id}] data.json 有条目但 config.json 中不存在（可能是未重新构建的残留）`);
    continue;
  }

  // 媒体路径（photo 必查）
  if (entry.photo) checkMediaPath(entry.photo, tracked);

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

section('总结');
console.log(`共 ${checks} 项检查，失败 ${failures} 项`);
if (failures > 0) {
  console.error('❌ 自检未通过。请修复后重新 npm run build，再提交。');
  process.exit(1);
} else {
  console.log('✅ 全部通过，可以提交');
}
