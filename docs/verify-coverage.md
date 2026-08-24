# verify.js 自检覆盖清单

> 本清单被 `.githooks/pre-commit`（提交前自动运行）与 `CLAUDE.md`（工作规则）引用。新增或修改功能时须同步在 `scripts/verify.js` 补对应自检测试，与代码一并提交；任一失败**阻止提交**。纯文档/样式微调可豁免。手动运行：`npm run verify`。

`node scripts/verify.js` 覆盖（暂存区涉及 `public/` / `scripts/` / `.githooks/` 时，`git commit` 自动触发）：

- ① **config↔data.json 条目互查**：config 条目与构建产物 data.json 相互对得上（防「改了配置忘了重新构建」）。
- ② **真实收信码解密校验 + 错误收信码被拒**：用 config 里**真实 answer** 解每个有收件人条目的密文，错误 answer 应被 GCM 认证拒绝。
- ③ **媒体路径磁盘/git 大小写校验**：`photo` 及答对后可见的 `images`/`videos` 在磁盘上大小写精确存在，且与 git 实际跟踪名一致（拦 macOS `core.ignorecase=true` 把文件名大小写搞反、上线 404 的坑）。
- ④ **QR 码 PNG 完整性 + jsqr 解码内容**：每个 `qrcodes/<id>.png` 存在、有效 500×500、非空；用 `jsqr` 解码，断言编码内容 == `baseUrl?id=<id>`。
- ⑤ **jsdom 跑真实 index.html 解锁流程冒烟**：加载真实页面，公开区直接渲染、错误答案提示「答案不正确」、正确答案解锁出 secret 区（能抓住 index.html 自身解密参数/流程被改坏——Node 端解密查不出这个）。
- ⑥ **Lightbox 图片放大预览 + 下载**：图片点开放大、可下载。
- ⑦ **一码多信**：同一二维码多收件人（demo：A-05 花花/梁雪/小童 三码三信）。
- ⑧ **动效冒烟**：花瓣进页飘落一阵即停，不影响解锁流程。
- ⑨ **留言板**：guestbook.json 与 config 一致性 + 浏览器提交祝福/留言冒烟，含公开块显示/门禁条目隐藏公开留言块/两处匿名留言框格式一致/空拦截/POST 请求断言/失败重试/disabled 隐藏/条目级 `guestbook:false` 关闭。
- ⑩ **背景音乐**：有 `music` 条目 → 音符按钮显示/`audio.src` 指向/进页自动播放旋转/点按钮切换；自动播放被拦 → 首次手势兜底；`play()` 缓冲挂起时点击按钮立即给播放态反馈；`WeixinJSBridgeReady` 事件补试自动播放；无 `music` → 按钮隐藏。
- ⑪ **歌词**：有 `lyrics` 条目 → 歌词面板显示/行数与 LRC 一致/`timeupdate` 高亮当前行；无 `lyrics` → 面板隐藏。
- ⑫ **描述落点突出块**：有 `emphasis` 条目 → 块显示/文本与字段一致/独白已从描述正文拆出；无 `emphasis` → 隐藏。

> ⚠️ 服务端权限（云数据库安全规则）强制力无法在 jsdom 测，需手动 curl 验证一次（POST 应 200 + `{"code":0}`、空文本应 400、OPTIONS 预检应带 CORS 头）。
