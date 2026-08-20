// 腾讯云 CloudBase 留言板云函数（HTTP 访问服务 → 云数据库）
//
// 角色：婚礼留言板「唯一写入口」。扫码页（GitHub Pages，零服务器）把朋友留言
//  POST 到本函数的 HTTP 访问服务地址；函数校验后写入 guestbook 集合。
// 安全模型：云数据库 guestbook 集合安全规则设为 read/write 全关（客户端零权限），
//  宾客只能经本函数写入、永远无法读取他人留言；新人读取走控制台/导出。
//
// 部署（详见 cloudbase/guestbook/README.md）：
//   1. CloudBase 控制台 → 云函数 → 新建「guestbook」→ 上传本目录代码
//   2. 配置「HTTP 访问服务」：关联本函数，触发路径如 /guestbook
//   3. 云数据库新建集合 guestbook，安全规则设为 `{ "read": false, "write": false }`
//   4. 复制 HTTP 访问地址 → 填入 config.json 的 guestbook.options.url
//
// 依赖：@cloudbase/node-sdk 由 CloudBase 云函数运行时内置（控制台创建函数时会自动带上）。

const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();

// 扫码页与函数跨域（github.io → tcb-api），Content-Type: application/json 会触发预检，
// 因此函数必须应答 OPTIONS 并在每个响应带 CORS 头（* 足够——页面不读数据，只收成败）。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const MAX_TEXT = 500;   // 与扫码页 textarea maxlength 一致
const MAX_NAME = 50;
const MAX_TO = 100;

exports.main = async (event) => {
  // HTTP 访问服务把请求包装进 event：method 在 httpMethod，body 为 JSON 字符串
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  let payload = event;
  if (typeof event.body === 'string' && event.body) {
    try {
      payload = JSON.parse(event.body);
    } catch (e) {
      return json(400, { code: 400, message: 'body 不是合法 JSON' });
    }
  }

  const text = String(payload.text || '').trim();
  if (!text) return json(400, { code: 400, message: '留言不能为空' });
  if (text.length > MAX_TEXT) return json(400, { code: 400, message: `留言过长（最多 ${MAX_TEXT} 字）` });

  try {
    const res = await db.collection('guestbook').add({
      type: String(payload.type || 'blessing'),        // 'blessing' 公开祝福 | 'letter' 解锁后留言（匿名，name 可为空）
      entryId: String(payload.entryId || '').slice(0, 64),
      to: String(payload.to || '').slice(0, MAX_TO),
      name: String(payload.name || '').slice(0, MAX_NAME),
      text,
      _client: 'wedding-qr-unlock',                    // 标记来源，便于控制台筛选
      createdAt: db.serverDate()
    });
    return json(200, { code: 0, id: res.id });
  } catch (err) {
    console.error('guestbook write failed:', err);
    return json(500, { code: 500, message: '写入失败' });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS),
    body: JSON.stringify(body)
  };
}
