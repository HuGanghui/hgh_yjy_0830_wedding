#!/usr/bin/env node
// 本地静态文件服务器（支持 HTTP Range / 206）
// 用途：本地预览视频时浏览器能正常拖动进度条。Python 的 http.server 不支持 Range，
//       部署到 GitHub Pages 时无此问题（GitHub 支持 Range）。
// 用法：node server.js [端口] [目录]    默认 8888 / public
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8888;
const ROOT = path.resolve(process.argv[3] || 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  const filePath = path.join(ROOT, urlPath);
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { // 防目录穿越
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || (!stat.isFile() && !stat.isDirectory())) {
      res.writeHead(404); res.end('Not Found'); return;
    }

    // 目录请求 → 返回目录下的 index.html（与 http.server 行为一致）
    let target = filePath;
    if (stat.isDirectory()) {
      const index = path.join(filePath, 'index.html');
      if (fs.existsSync(index) && fs.statSync(index).isFile()) {
        target = index;
      } else {
        res.writeHead(404); res.end('Not Found'); return;
      }
    }

    fs.stat(target, (err2, stat2) => {
      if (err2 || !stat2.isFile()) { res.writeHead(404); res.end('Not Found'); return; }

      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      const size = stat2.size;
      const range = req.headers.range;

      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          let start = m[1] ? parseInt(m[1], 10) : 0;
          let end = m[2] ? parseInt(m[2], 10) : size - 1;
          if (m[1] === '' && m[2] !== '') start = size - parseInt(m[2], 10); // 后缀范围 bytes=-N
          if (start > end || start >= size) { res.writeHead(416); res.end(); return; }
          end = Math.min(end, size - 1);
          res.writeHead(206, {
            'Content-Type': type,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1
          });
          if (req.method === 'HEAD') { res.end(); return; }
          fs.createReadStream(target, { start, end }).pipe(res);
          return;
        }
      }

      // 无 Range：完整返回
      res.writeHead(200, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Length': size
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(target).pipe(res);
    });
  });
}).listen(PORT, () => {
  console.log(`🚀 本地服务器: http://localhost:${PORT}  (目录: ${ROOT})`);
  console.log(`   支持 Range，视频可正常拖动进度条`);
  console.log(`   测试页: http://localhost:${PORT}/?id=baodu-baiye`);
});
