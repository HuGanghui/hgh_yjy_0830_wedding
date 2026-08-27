# 留言板（Guestbook）：存储抽象与换后端（参考）

> 本文件是被 CLAUDE.md 引用的**参考细节**：provider+options 抽象、`GB_PROVIDERS` 必填表、换 Supabase 步骤。改 `public/index.html` / `build.js` 的留言板逻辑时按需阅读。**硬安全约束**见 CLAUDE.md（内联保留）。

## 展示规则

扫码页留言框有两种展示位置、**格式统一**（均匿名无标题/无提示/无名字输入，占位「给新人留言」、按钮「提交」，直接写给新人）：**公开区**「给新人留言」框仅**无收件人条目**显示（这类条目扫码留言是唯一互动）；**有收件人的门禁条目**扫码后不显示留言框，解锁后**信件视图**信末显示同格式「给新人留言」框。只收集给新人看，**页面不回显他人留言**——新人到 CloudBase 控制台查看/导出。

## 存储抽象（provider + options）

`config.json` 的 `guestbook` 块声明后端，页面用 `GB_PROVIDERS` 适配器 map 分发，换后端零页面逻辑改动：

```json
"guestbook": {
  "enabled": true,
  "provider": "cloudbase",
  "options": {
    "url": "https://<环境ID>.service.tcloudbase.com/guestbook"
  }
}
```

- 当前实现 **cloudbase**（腾讯云）：页面把留言 POST 到配置的 `url`（云函数 HTTP 访问服务/云接入），纯 REST 零 SDK。可部署的函数代码在 `cloudbase/guestbook/`。
- ⚠️ **`build.js` 与 `public/index.html` 各有一份 `GB_PROVIDERS` 必填字段表，改一边要改另一边。**
- 未配置或校验失败 → build 写出 `public/guestbook.json` = `{"enabled": false}`（留言功能关闭，页面不显示输入框；config 无此块时构建**不报错**，属正常关闭态）。
- **条目级关闭**：config 条目加 `"guestbook": false` → build 在 `data.json` 该条目写 `guestbook: false`，页面该页公开「祝福」块与解锁后「留言」块都不显示（默认不写 = 随全局开启）。适合纯音乐/氛围页不想要留言框（demo：`walking-fish`）。

## 安全模型

云函数是**唯一写入口**，云数据库对客户端**零权限**——宾客只能经函数写入、永远无法读取他人留言。

- **云数据库安全规则**（控制台配置，唯一强制层）：`guestbook` 集合安全规则设为 `{"read": false, "write": false}`；写数据只经云函数（函数用管理端身份，不受规则限制）。
- **云函数**（`cloudbase/guestbook/`）负责校验（非空/长度）+ 写库 + 应答 CORS 预检；扫码页只 POST 不 GET，body 仅 `{type, entryId, to, name, text}`，不携带任何权限字段。
- 客户端连接配置（云函数 HTTP 访问地址 `url`）公开进页面属设计接受（`public/guestbook.json` 随 `public/` 提交）；安全靠「数据库零权限 + 函数校验 + 免费额度限流」兜底。
- 新人读取：CloudBase 控制台 → 云开发 → 数据库 → `guestbook` 集合（或导出）。免费体验版 3000 资源点/月（云函数调用 13.3 点/万次、数据库读写 200 点/万次），500 条留言约千分之几，完全覆盖。

## 换 Supabase

`index.html` 的 `GB_PROVIDERS` 加 `supabase.submit`（POST `${url}/rest/v1/${table}` + `apikey`/`Authorization: Bearer` 头）、`build.js` 的 `GB_PROVIDERS` 加必填表 `['url','anonKey','table']`、config 换 options、控制台开 RLS「仅插入、禁止读」。

## 手动验证（服务端权限）

云数据库安全规则强制力无法在 jsdom 测，需手动 curl 验证一次：POST 应 200 + `{"code":0}`、空文本应 400、OPTIONS 预检应带 CORS 头。
