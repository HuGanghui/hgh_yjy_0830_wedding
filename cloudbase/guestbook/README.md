# CloudBase 留言板云函数

婚礼扫码页的留言后端：一个**只写不读**的 REST 入口。扫码页把朋友的祝福/回信 POST 到本函数的 Web 触发器地址，函数校验后写入云数据库 `guestbook` 集合。新人到 CloudBase 控制台查看/导出留言，**没有任何 API 能读**——天然实现「只收集、不回显」。

## 一次性部署步骤（约 10 分钟，需腾讯云账号 + 实名认证）

1. **创建环境**：控制台 → [云开发 CloudBase](https://cloud.tencent.com/product/tcb) → 新建环境（免费体验版即可，若遇 Web 触发器限制则用个人版 19.9 元/月，婚礼一个月够用）。

2. **创建云函数**：控制台 → 云函数 → 新建函数：
   - 名称：`guestbook`（保持默认「上传文件夹/zip」即可，选中本目录上传）
   - 运行时：Node.js

3. **配置 Web 触发器**：函数详情 → 「Web 触发器」→ 新建触发器，触发路径如 `/guestbook`，HTTP 方法 `POST`。创建后复制生成的**触发器 URL**（形如 `https://<环境ID>.service.tcloudbase.com/guestbook`）。

4. **创建集合并收紧权限**：云数据库 → 新建集合 `guestbook` → 在「安全规则」里设为（关键，防任何人读/改）：
   ```json
   { "read": false, "write": false }
   ```
   宾客写数据只经过云函数（函数用的是管理端身份，不受安全规则限制），客户端永远拿不到集合的读写权限。

5. **接入扫码页**：把触发器 URL 填入项目根 `config.json` 的 `guestbook` 块，然后 `npm run build`：
   ```json
   "guestbook": {
     "enabled": true,
     "provider": "cloudbase",
     "options": { "url": "https://<环境ID>.service.tcloudbase.com/guestbook" }
   }
   ```

6. **验证一次**（curl 模拟浏览器跨域写）：
   ```bash
   curl -X OPTIONS 'https://<环境ID>.service.tcloudbase.com/guestbook' \
     -H 'Origin: https://huganghui.github.io' -H 'Access-Control-Request-Method: POST' \
     -H 'Access-Control-Request-Headers: Content-Type' -i        # 期望 200 + CORS 头
   curl -X POST 'https://<环境ID>.service.tcloudbase.com/guestbook' \
     -H 'Content-Type: application/json' \
     -d '{"type":"blessing","entryId":"A-01","to":"","name":"测试","text":"新婚快乐！"}' -i
   # 期望 200 + {"code":0,"id":"..."}；控制台 guestbook 集合里出现这条记录
   curl -X POST 'https://<环境ID>.service.tcloudbase.com/guestbook' \
     -H 'Content-Type: application/json' -d '{"text":""}' -i     # 期望 400 留言不能为空
   ```

## 数据字段

| 字段 | 说明 |
|------|------|
| `type` | `blessing`（公开祝福）\| `letter`（信件回信） |
| `entryId` | 扫码条目 id（如 `A-01`） |
| `to` | 收件人（公开区为空；信件回信为该收件人） |
| `name` | 留言者名字（选填） |
| `text` | 留言正文（必填，≤500 字） |
| `createdAt` | 服务端时间 |

## 新人如何读留言

控制台 → 云开发 → 数据库 → `guestbook` 集合，直接看/筛选，或点「导出」为 JSON/CSV。**无需暴露任何读接口**，这就是安全模型的一部分。

## 费用

免费体验版 3000 资源点/月：云函数调用 13.3 点/万次、数据库读写 200 点/万次——几百条留言约千分之几的点数消耗，完全覆盖。若免费版限制 Web 触发器，个人版 19.9 元/月（婚礼当月够用，用完可停）。

## 换 Supabase

存储已做 provider 抽象（`index.html` 的 `GB_PROVIDERS` + `build.js` 的必填表 + config 换 options）。换 Supabase 时本云函数不再需要：改用 PostgREST 直写（`POST /rest/v1/{table}` + anon key + RLS 仅插入、禁止读），页面逻辑零改动。
