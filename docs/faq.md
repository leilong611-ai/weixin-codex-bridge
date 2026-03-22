# FAQ

## 1. 这个仓库和 OpenClaw routing 有什么区别？

这个仓库走的是 standalone 方案：

`微信 -> standalone bridge -> acpx -> Codex`

它不会依赖 OpenClaw 的 channel routing、bindings 或 agent 分发。公开插件实现只被当作接口研究样本。

## 2. 为什么我扫码后状态停在 `scaned`？

这通常表示二维码已经被扫到，但还没有在手机里的微信界面完成确认。仅扫码不确认，状态会停在 `scaned`，最后过期。

## 3. 为什么二维码老是过期？

最常见的原因有两个：

- 扫码后没有在手机里点确认
- 从生成二维码到实际扫码的时间太长

重新执行 `login` 即可刷新二维码。

## 4. 凭证存在哪里？

本地凭证保存在 `.local/account.json`。这也是最敏感的文件之一，不应该提交到 Git。

## 5. 如何切换绑定的微信账号？

先清掉本地状态，再重新登录：

```bash
node src/cli.mjs logout
node src/cli.mjs login --workspace "/path/to/workspace"
```

## 6. 如何重置某个微信用户的对话上下文？

让该微信用户直接发：

- `/new`
- `/reset`

bridge 会关闭并重建该用户对应的 Codex 会话。

## 7. 为什么回复是纯文本？

当前版本在发送回微信前，会把 Markdown 做一层纯文本化处理，避免复杂格式、表格和代码块在微信消息里表现不稳定。

## 8. 支持群聊吗？

当前不支持。这一版只处理私聊文本消息。

## 9. 支持图片、视频、文件吗？

当前不支持。这一版只覆盖文本消息和 typing 状态。

## 10. `doctor` 主要检查什么？

它会检查：

- 工作区路径是否存在
- `acpx` 路径是否存在
- `acpx` 版本
- 当前保存的 runtime 配置
- 当前是否已经绑定微信账号

## 11. 如果 `doctor` 里 `acpxExists` 是 `false` 怎么办？

优先检查两件事：

1. 是否已经运行过 `npm install`
2. 是否需要手动传 `--acpx-command`

例如：

```bash
node src/cli.mjs doctor \
  --workspace "/path/to/workspace" \
  --acpx-command "/custom/path/to/acpx"
```

## 12. bridge 收到消息后为什么没有立刻回？

可能的原因包括：

- Codex 正在处理，仍处于 typing 状态
- 当前请求超时
- 微信长轮询刚好在重连
- 当前会话已过期，需要重新登录

可以先查看 `.local/bridge.log`。

## 13. 如何判断是微信侧问题还是 Codex 侧问题？

建议按这个顺序排查：

1. 先跑 `doctor`
2. 再确认 `login` 是否成功
3. 查看 `.local/bridge.log`
4. 单独验证 `acpx` 能否调用 Codex

如果 `doctor` 正常、登录正常，但 bridge 无回复，通常再重点看 `bridge.log` 和 `acpx` 调用。

## 14. 支持多工作区吗？

当前一个 bridge 实例只面向一个工作区。如果你要接多个工作区，建议起多个 bridge 进程，并用不同的 `sessionPrefix` 做隔离。

## 15. 适合怎么部署成常驻服务？

仓库当前没有内置守护进程能力。比较现实的做法是用：

- `pm2`
- `systemd`
- `launchd`
- Docker 外部守护

第一版先把核心桥接逻辑做清楚，部署层留给上层环境。
