# 如何搭建微信到 Codex

这份文档描述的是一个 standalone 方案：

`微信 -> standalone bridge -> acpx -> Codex`

它不依赖 OpenClaw routing，只把公开插件实现当作接口研究样本。

## 1. 先定架构边界

最开始需要先把两条路线分开：

- 路线 A：`微信 -> OpenClaw channel -> OpenClaw routing -> Codex`
- 路线 B：`微信 -> standalone bridge -> Codex`

如果目标是“单独走，不经过 OpenClaw 路由”，应该直接做路线 B。

## 2. 研究微信侧接口

公开的微信 OpenClaw 插件里，已经能看到这套 bot API 的使用方式。对 standalone bridge 来说，核心接口只有几类：

- 登录二维码：`GET ilink/bot/get_bot_qrcode?bot_type=3`
- 登录状态：`GET ilink/bot/get_qrcode_status?qrcode=...`
- 拉消息：`POST ilink/bot/getupdates`
- 拉会话配置：`POST ilink/bot/getconfig`
- 发送 typing：`POST ilink/bot/sendtyping`
- 发文本：`POST ilink/bot/sendmessage`

观察到的关键请求头：

- `AuthorizationType: ilink_bot_token`
- `Authorization: Bearer <bot_token>`
- `X-WECHAT-UIN: <随机值的 base64>`

默认 base URL：

- `https://ilinkai.weixin.qq.com`

## 3. 把 bridge 拆成几个独立模块

为了方便调试和公开发布，bridge 被拆成这些模块：

- `src/weixin-api.mjs`
  负责微信 HTTP API
- `src/login.mjs`
  负责二维码登录和 token 落盘
- `src/bridge.mjs`
  负责长轮询消息、转发和回复
- `src/codex-runner.mjs`
  负责通过 `acpx` 调 Codex
- `src/state.mjs`
  负责本地状态文件
- `src/text.mjs`
  负责文本提取、Markdown 转纯文本和长消息拆分

这样做的好处是：微信侧问题和 Codex 侧问题可以分开排查。

## 4. 登录流程

登录流程是：

1. 调 `get_bot_qrcode` 获取二维码
2. 把二维码同时输出到终端和本地 PNG
3. 轮询 `get_qrcode_status`
4. 状态从 `wait` 变成 `scaned` 后，等待手机确认
5. 状态变成 `confirmed` 后，保存：
   - `botToken`
   - `accountId`
   - `rawAccountId`
   - `userId`
   - `baseUrl`

这些数据只写到 `.local/account.json`，不进入 Git。

## 5. 消息桥接流程

bridge 启动后会循环调用 `getupdates`。

收到消息后，处理顺序是：

1. 跳过 bot 自己发出的消息
2. 只接受当前版本支持的文本消息
3. 如果用户发 `/new` 或 `/reset`，就关闭并重建该用户对应的 Codex 会话
4. 调 `getconfig` 取 `typing_ticket`
5. 调 `sendtyping` 通知微信“正在输入”
6. 用 `acpx codex prompt` 把文本交给 Codex
7. 把回复转成纯文本并按长度切块
8. 调 `sendmessage` 回复到微信
9. 调 `sendtyping` 结束 typing

## 6. Codex 会话策略

每个微信用户映射到一个稳定会话名，例如：

`wx-<weixin_user_id>`

优点：

- 同一个微信用户有连续上下文
- 不同微信用户互不污染
- `/reset` 可以只清掉当前用户上下文

当前通过 `acpx` 调 Codex，不直接自己拼底层协议。

## 7. 端到端验证

最小验证路径建议是：

1. `node src/cli.mjs doctor --workspace "/path/to/workspace"`
2. `node src/cli.mjs login --workspace "/path/to/workspace"`
3. `node src/cli.mjs serve`
4. 在微信里发：`你好，告诉我你当前工作目录`
5. 确认 bridge 进程拉起了对应的 Codex 会话并回消息

如果登录时二维码一直过期，通常不是接口问题，而是扫码后没有在手机里完成确认。

## 8. 为什么要做隐私清理

这类 bridge 很容易在以下位置泄露隐私：

- `.local/account.json` 里的 `botToken`
- `.local/bridge.log` 里的账号和运行记录
- README 里的绝对路径
- 调试时保存的二维码图片
- 聊天示例中的真实账号 ID

所以公开仓库前，必须先把这些内容清掉，并跑一次自动检查。

## 9. 下一步可扩展项

如果要继续做第二版，优先级建议是：

1. 媒体消息支持
2. 群聊和白名单控制
3. 更好的会话管理和限流
4. system prompt / profile 注入
5. 守护进程和自动重启
