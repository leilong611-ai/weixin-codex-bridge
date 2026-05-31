<div align="center">

# Weixin Codex Bridge

**不依赖 OpenClaw routing 的微信到 Codex standalone bridge**

[![public-check](https://github.com/leilong611-ai/weixin-codex-bridge/actions/workflows/public-check.yml/badge.svg)](https://github.com/leilong611-ai/weixin-codex-bridge/actions/workflows/public-check.yml)
[![GitHub stars](https://img.shields.io/github/stars/leilong611-ai/weixin-codex-bridge?style=social)](https://github.com/leilong611-ai/weixin-codex-bridge/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

扫码登录 · 消息转发 · 会话隔离 · Typing 同步

English version: [README.en.md](./README.en.md)

</div>

---

它直接调用微信 bot HTTP API 完成扫码登录、收发消息和 typing 状态，再通过 `acpx` 把每个微信用户绑定到一个独立的 Codex 会话。

## 架构

```mermaid
flowchart LR
  A["微信号"] <--> B["微信 Bot API"]
  B <--> C["Standalone Bridge"]
  C <--> D["acpx"]
  D <--> E["Codex CLI"]
```

目标链路：`微信 -> standalone bridge -> acpx -> Codex`

不走 OpenClaw 的 channel routing、bindings 或 agent 分发。

## 截图

### 1. 登录流程

![login flow](./assets/login-flow.svg)

扫码登录时，bridge 会同时输出终端二维码并保存 `.local/login-qr.png`。

### 2. 诊断输出

![doctor output](./assets/doctor-output.svg)

`doctor` 用来在登录前检查工作区、`acpx` 和当前本地运行态。

### 3. 消息往返

![message roundtrip](./assets/message-roundtrip.svg)

收到微信文本后，bridge 会先发 typing，再进入对应的 Codex 会话，最后把纯文本回复拆块送回微信。

## 功能

- 微信扫码登录
- 私聊文本消息收发
- 每个微信用户一个持久 Codex 会话
- typing 状态同步
- `/new` 和 `/reset` 重置当前用户会话
- 本地状态保存在 `.local/`

## 为什么这个项目值得做

这个仓库解决的不是“再做一个聊天机器人”，而是一个更具体的维护问题：

- 很多中文用户的日常协作入口就是微信
- Codex 适合做代码和维护工作流，但默认不在微信里工作
- OpenClaw routing 很强，但并不是所有场景都需要整套 routing 和 agent 分发

这个项目因此选择了一条更窄但更实用的路线：只做 `微信 -> standalone bridge -> Codex`。它的价值在于把一个真实使用频率很高的沟通入口，接到可执行的 Codex 工作流上，同时保持部署和调试边界尽量简单。

## 当前范围

| 已覆盖 | 暂未覆盖 |
|--------|---------|
| 私聊文本 | 群聊路由 |
| 单 agent | 图片、视频、文件上传下载 |
| 纯文本回复 | 多 agent 分发 |

## 环境要求

- Node.js `>= 22`
- 本机已安装并登录 `codex`
- 网络可访问微信 bot API 和 npm

## 快速开始

```bash
git clone https://github.com/leilong611-ai/weixin-codex-bridge.git
cd weixin-codex-bridge
npm install
```

先确认 `acpx` 能找到你的工作区：

```bash
node src/cli.mjs doctor --workspace "/path/to/your/workspace"
```

扫码登录：

```bash
node src/cli.mjs login --workspace "/path/to/your/workspace"
```

启动 bridge：

```bash
node src/cli.mjs serve
```

## 常用命令

```bash
node src/cli.mjs doctor    # 环境检查
node src/cli.mjs logout    # 登出
npm run public-check       # 发布前检查
```

## 配置与 Q&A

- [docs/configuration.md](./docs/configuration.md)
- [docs/faq.md](./docs/faq.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CHANGELOG.md](./CHANGELOG.md)

## 隐私与发布

- `.local/` 已加入 `.gitignore`，token、账号信息不进仓库
- 发布前运行 `npm run public-check`
- 详见 [docs/privacy-and-publish-checklist.md](./docs/privacy-and-publish-checklist.md)

## 为什么它需要更强的安全审查

这个项目位于一个比较敏感的边界上：上游是微信消息和登录态，下游是本地 Codex 会话与运行时状态。真正重要的风险不是普通 UI bug，而是：

- 会话隔离错误导致跨用户串话
- 调试输出或日志泄露凭据
- 消息路由错误把一个用户的内容发到另一个用户会话
- 发布时误带 `.local/` 状态、二维码或账号信息

这也是为什么这个仓库适合做更严格的维护自动化和安全审查，而不只是功能开发。

## Roadmap

近期维护重点不是盲目扩功能，而是先把桥接能力做稳：

- 完善会话隔离和重置路径的验证
- 增强日志脱敏和诊断输出边界
- 增加更稳定的维护检查与发布前自动化
- 在保持 standalone 架构前提下，评估媒体消息和群聊白名单支持

## 参考资料

- 腾讯微信 OpenClaw 安装器：<https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin-cli>
- 腾讯微信 OpenClaw 插件：<https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin>
- OpenClaw ACP Agents：<https://docs.openclaw.ai/tools/acp-agents>
- ACPX：<https://www.npmjs.com/package/acpx>

---

<div align="center">

**如果这个项目帮到了你，请给个 Star ⭐**

[Report Bug](https://github.com/leilong611-ai/weixin-codex-bridge/issues) · [Request Feature](https://github.com/leilong611-ai/weixin-codex-bridge/issues) · [Discussions](https://github.com/leilong611-ai/weixin-codex-bridge/discussions)

</div>
