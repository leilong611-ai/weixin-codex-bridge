# Weixin Codex Bridge

[![ci](https://github.com/leilong611-ai/weixin-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/leilong611-ai/weixin-codex-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

A standalone bridge from Weixin direct messages to Codex. It reads an existing Weixin/OpenClaw bot account, polls text messages, sends the original text to Codex, and returns plain-text replies to Weixin.

Chinese version: [README.md](./README.md)

Language policy: Weixin-facing replies and the local console default to Simplified Chinese. Developer docs, command aliases, API paths, and JSON fields stay English for open-source maintenance and automation.

## What It Does

- Forwards Weixin direct-message text to Codex.
- Keeps local bridge state and Codex session mapping per Weixin conversation.
- Supports Codex Desktop UI delivery and a Codex CLI mode.
- Starts an optional local console for status and retry operations.

This project does not use OpenClaw channel routing, bindings, or multi-agent dispatch. It only reuses locally stored Weixin/OpenClaw account credentials.

## How It Differs From Other Bridges

- **Not an OpenClaw routing plugin**: it does not take over OpenClaw channel routing, bindings, or multi-agent dispatch, and it does not rewrite OpenClaw configuration. It only uses an already logged-in Weixin bot account as a read-only message source.
- **Not just a CLI forwarder**: Desktop UI delivery is the default, so Weixin messages can land in the live Codex Desktop session. Codex CLI mode is still available when a shell-based workflow is preferred.
- **No prompt wrapping**: the text sent to Codex is the original Weixin message text. The bridge does not prepend sender names, timestamps, routing hints, markdown wrappers, or hidden control instructions.
- **Per-Weixin-conversation state**: each Weixin conversation has its own local state, Codex conversation binding, failed-task queue, and transcript mirror, which makes delivery issues auditable.
- **Built for Desktop automation reliability**: Desktop delivery does not rely only on fixed coordinates. The scripts include UI Automation lookup, DPI-aware coordinates, screenshot detection, calibration caching, and a pre-send detector.
- **Local-first and open-source friendly**: runtime state stays in a user-configured local directory, credentials are reused read-only, and the repo includes setup preflight checks, public-release checks, CI, failed-task handling, and a local console.

## Architecture

```mermaid
flowchart LR
  A["Weixin direct message"] --> B["Weixin Bot API"]
  B --> C["Standalone bridge"]
  C --> D{"Delivery mode"}
  D --> E["Codex Desktop UI"]
  D --> F["Codex CLI"]
  E --> C
  F --> C
  C --> B
```

## Requirements

- Node.js `>= 22`
- Codex Desktop or Codex CLI installed and authenticated
- A local Weixin/OpenClaw bot account already logged in
- Windows 10/11 is recommended for Desktop UI automation; CLI mode can run in a more generic shell environment

## Quick Start

```powershell
git clone https://github.com/leilong611-ai/weixin-codex-bridge.git
cd weixin-codex-bridge
npm install
Copy-Item .env.example .env
```

Edit `.env` and set at least:

```dotenv
CODEX_WEIXIN_CWD=C:\work\my-codex-project
CODEX_WEIXIN_STATE_ROOT=C:\work\codex-weixin-state
OPENCLAW_STATE_DIR=C:\path\to\openclaw-state
CODEX_WEIXIN_DELIVERY_MODE=desktop-ui
CODEX_WEIXIN_CONSOLE_PORT=18790
```

Note: the app does not load `.env` automatically. Use your shell, terminal profile, process manager, or CI secrets to export the same values. `.env.example` is a public template only; never commit real credentials.

Temporary PowerShell example:

```powershell
$env:CODEX_WEIXIN_CWD = "C:\work\my-codex-project"
$env:CODEX_WEIXIN_STATE_ROOT = "C:\work\codex-weixin-state"
$env:OPENCLAW_STATE_DIR = "C:\path\to\openclaw-state"
$env:CODEX_WEIXIN_DELIVERY_MODE = "desktop-ui"

npm run build
node dist/cli.js
```

To bypass Desktop UI and use Codex CLI:

```powershell
$env:CODEX_WEIXIN_DELIVERY_MODE = "codex-cli"
$env:CODEX_WEIXIN_CLI_FALLBACK = "false"
node dist/cli.js
```

## Key Environment Variables

| Variable | Purpose |
| --- | --- |
| `CODEX_WEIXIN_CWD` | Workspace directory where Codex should run. |
| `OPENCLAW_STATE_DIR` | Root directory for read-only Weixin/OpenClaw account state. |
| `OPENCLAW_CONFIG_PATH` | Optional override for the OpenClaw config file. |
| `CODEX_WEIXIN_ACCOUNT_ID` | Optional Weixin account ID; the first saved account is used when unset. |
| `CODEX_WEIXIN_STATE_ROOT` | Bridge runtime state, logs, and local queue directory. |
| `CODEX_WEIXIN_LOG_ROOT` | Backward-compatible alias; if both roots are set, this value wins. |
| `CODEX_WEIXIN_CONSOLE_ENABLED` | Enables the local console, default `true`. |
| `CODEX_WEIXIN_CONSOLE_PORT` | Local console port, default `18790`. |
| `CODEX_WEIXIN_DELIVERY_MODE` | `desktop-ui` or `codex-cli`. |
| `CODEX_WEIXIN_MAX_PARALLEL` | Maximum parallel worker lanes for `codex-cli`; `desktop-ui` is always single-lane. |
| `CODEX_WEIXIN_CLI_FALLBACK` | Whether Desktop UI failures may fall back to CLI, default `false`. |
| `CODEX_DESKTOP_APP_ID` | Optional Windows AppID override for launching Codex Desktop. |
| `CODEX_WEIXIN_MODEL` | Codex CLI model name. |

See [.env.example](./.env.example) for the full template.

On a new computer, or after moving/resizing the Desktop setup, run the local preflight first:

```powershell
npm run setup-check
# Or run directly:
powershell -ExecutionPolicy Bypass -File scripts\Test-CodexWeixinSetup.ps1
```

It performs read-only checks for Node/npm, the built entrypoint, Weixin account index, Codex Desktop AppID, visible Codex window, desktop input/model scripts, console status, and ports `18789`/`8787`. Add `-Json` when another tool should consume the report.

## Most Common Configuration Failures

- Wrong `OPENCLAW_STATE_DIR`: diagnostics will show a missing `Weixin account index`. Complete the Weixin/OpenClaw login first, then point this to the state root that contains `openclaw-weixin/accounts.json`.
- Missing `CODEX_WEIXIN_CWD`: Codex may run in the wrong project or fail immediately. Set it to the real workspace Codex should operate in.
- `CODEX_WEIXIN_MAX_PARALLEL>1` in `desktop-ui`: this is ignored because one Codex Desktop window must stay single-lane.
- Wrong `CODEX_WEIXIN_DESKTOP_INPUT_SCRIPT` or `CODEX_WEIXIN_DESKTOP_MODEL_SCRIPT`: input detection, paste, or model switching will fail.
- `codex-cli` or `CODEX_WEIXIN_CLI_FALLBACK=true` with a broken `CODEX_CMD_PATH`: CLI fallback will fail.
- Ports `18789` or `8787` already owned by OpenClaw or an old bridge: launcher scripts and diagnostics will flag this.

The console `Run Diagnostics` action now lists these configuration checks with fix suggestions.

## NPM Scripts

```powershell
npm run build          # Compile TypeScript into dist/
npm test -- --run      # Run tests
npm run setup-check    # Run local machine setup preflight
npm run public-check   # Run privacy and repository hygiene checks
```

## Repository Hygiene

- Do not commit `.env`, QR codes, screenshots, logs, runtime state, Codex transcripts, or Weixin account credentials.
- `dist/`, `node_modules/`, `.local/`, and common debug artifacts are ignored by default.
- Run `npm run public-check` before publishing or opening a pull request.
- See [docs/open-source-checklist.md](./docs/open-source-checklist.md).

## References

- Tencent Weixin OpenClaw installer: <https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin-cli>
- Tencent Weixin OpenClaw plugin: <https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin>
- ACPX: <https://www.npmjs.com/package/acpx>

## License

MIT
