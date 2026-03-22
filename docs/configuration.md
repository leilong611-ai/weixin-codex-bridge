# 配置说明

这份文档说明 `weixin-codex-bridge` 的运行参数、默认值、优先级和本地状态文件。

## 配置优先级

bridge 启动时，配置按这个顺序解析：

1. 当前命令行参数
2. `.local/runtime.json`
3. 代码里的默认值

也就是说，同一个参数如果同时出现在命令行和 `.local/runtime.json` 里，命令行优先。

## 命令总览

```bash
node src/cli.mjs login --workspace "/path/to/workspace"
node src/cli.mjs serve
node src/cli.mjs start --workspace "/path/to/workspace"
node src/cli.mjs doctor --workspace "/path/to/workspace"
node src/cli.mjs logout
```

含义：

- `login`
  获取二维码并完成微信登录
- `serve`
  启动消息桥接
- `start`
  如果未登录则先登录，再启动 bridge
- `doctor`
  检查工作区、`acpx`、已保存运行时配置和当前绑定账号
- `logout`
  清理本地登录凭证和同步游标

## CLI 参数

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--workspace <path>` | Codex 工作区根目录，必须是绝对路径 | 当前进程目录或已保存值 |
| `--base-url <url>` | 微信 bot API base URL | `https://ilinkai.weixin.qq.com` |
| `--bot-type <id>` | 登录二维码使用的 bot type | `3` |
| `--session-prefix <prefix>` | 每个微信用户对应的会话前缀 | `wx` |
| `--timeout <sec>` | Codex 调用超时时间，单位秒 | `300` |
| `--poll-timeout <ms>` | 微信长轮询超时，单位毫秒 | `35000` |
| `--acpx-command <path>` | 显式指定 `acpx` 可执行文件 | `./node_modules/.bin/acpx` |

## 默认值来源

代码里的默认配置在 [src/config.mjs](../src/config.mjs)：

- `DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"`
- `DEFAULT_BOT_TYPE = "3"`
- `DEFAULT_LONG_POLL_TIMEOUT_MS = 35000`
- `DEFAULT_POLL_RETRY_MS = 2000`
- `DEFAULT_TIMEOUT_SECONDS = 300`
- `DEFAULT_SESSION_PREFIX = "wx"`

## `.local/runtime.json`

bridge 在登录时会把当前运行参数保存到 `.local/runtime.json`，结构大致如下：

```json
{
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "botType": "3",
  "workspace": "/path/to/workspace",
  "longPollTimeoutMs": 35000,
  "retryDelayMs": 2000,
  "codexTimeoutSeconds": 300,
  "sessionPrefix": "wx",
  "acpxCommand": "./node_modules/.bin/acpx"
}
```

这个文件是本地运行态，不应该提交到 Git。

## `.local/` 目录里都有什么

| 文件 | 用途 | 是否允许提交 |
| --- | --- | --- |
| `.local/account.json` | 微信登录凭证和账号元信息 | 否 |
| `.local/runtime.json` | 最近一次运行时配置 | 否 |
| `.local/sync.json` | `getupdates` 游标 | 否 |
| `.local/bridge.log` | bridge 本地日志 | 否 |
| `.local/login-qr.png` | 最近一次二维码图片 | 否 |

## 会话命名规则

每个微信用户都会映射到一个稳定的 Codex 会话名：

`<sessionPrefix>-<weixinUserId>`

默认前缀是 `wx`，例如：

`wx-o9cq8example`

如果你想给不同 bridge 实例做隔离，可以换前缀：

```bash
node src/cli.mjs start \
  --workspace "/path/to/workspace" \
  --session-prefix "team-a"
```

## 常见配置场景

### 1. 指向另一个工作区

```bash
node src/cli.mjs doctor --workspace "/path/to/another-workspace"
node src/cli.mjs start --workspace "/path/to/another-workspace"
```

### 2. 显式指定 `acpx`

```bash
node src/cli.mjs doctor \
  --workspace "/path/to/workspace" \
  --acpx-command "/custom/path/to/acpx"
```

### 3. 增加 Codex 超时

```bash
node src/cli.mjs start \
  --workspace "/path/to/workspace" \
  --timeout 600
```

### 4. 缩短长轮询时间

```bash
node src/cli.mjs serve --poll-timeout 15000
```

## 推荐启动顺序

第一次启动建议按这个顺序：

1. `npm install`
2. `node src/cli.mjs doctor --workspace "/path/to/workspace"`
3. `node src/cli.mjs login --workspace "/path/to/workspace"`
4. `node src/cli.mjs serve`

如果你只想“一条命令起完”，可以用：

```bash
node src/cli.mjs start --workspace "/path/to/workspace"
```

## 当前没有做的配置层

当前版本没有单独引入：

- `.env`
- YAML 配置文件
- 远程配置中心

这样做的原因是第一版先保持简单，所有配置都可以从命令行和 `.local/runtime.json` 解决。
