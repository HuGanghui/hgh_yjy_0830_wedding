// 大小写校验：GitHub Pages 是区分大小写的服务器，而本地 macOS 的 git 默认
// core.ignorecase=true，可能把小写文件名按大写提交（曾导致照片线上 404）。
// 部署前在 Linux runner 上核对 data.json 每个 photo 路径都能按原样找到文件。
// 抽成独立脚本而非内联到 YAML：避免冒号/引号等在 workflow 文件里触发解析问题。
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync('public/data.json', 'utf-8'));
const bad = [];

for (const [id, entry] of Object.entries(data)) {
  if (!entry.photo) continue;
  const p = path.join('public', entry.photo);
  const dir = path.dirname(p);
  const base = path.basename(p);
  if (!fs.existsSync(dir) || !fs.readdirSync(dir).includes(base)) {
    bad.push(id + ': ' + entry.photo);
  }
}

if (bad.length) {
  console.error('照片路径与文件大小写不一致: ' + bad.join('; '));
  process.exit(1);
}
console.log(Object.keys(data).length + ' 个条目的照片路径全部与文件一致');
