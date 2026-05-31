# Weixin Codex Bridge

[![public-check](https://github.com/leilong611-ai/weixin-codex-bridge/actions/workflows/public-check.yml/badge.svg)](https://github.com/leilong611-ai/weixin-codex-bridge/actions/workflows/public-check.yml)

A standalone bridge from Weixin to Codex without OpenClaw routing.

It talks to the Weixin bot HTTP API directly for QR login, message polling, replies, and typing state, then uses `acpx` to map each Weixin user to an isolated Codex session.

Chinese version: [README.md](./README.md)

## Architecture

```mermaid
flowchart LR
  A["Weixin Account"] <--> B["Weixin Bot API"]
  B <--> C["Standalone Bridge"]
  C <--> D["acpx"]
  D <--> E["Codex CLI"]
```

Target flow:

`Weixin -> standalone bridge -> acpx -> Codex`

This repo does not rely on OpenClaw channel routing, bindings, or agent dispatching.

## Screenshots

### 1. Login flow

![login flow](./assets/login-flow.svg)

The public repo uses a sanitized illustrative screenshot here. Real QR codes, account IDs, and local paths are intentionally excluded from the published materials.

### 2. Doctor output

![doctor output](./assets/doctor-output.svg)

Use `doctor` before login to verify workspace, `acpx`, and the saved runtime state.

### 3. Message round trip

![message roundtrip](./assets/message-roundtrip.svg)

After a text message arrives from Weixin, the bridge sends typing, prompts the matching Codex session, and returns a plain-text reply.

## Features

- QR login for Weixin bot accounts
- Direct-message text chat
- One persistent Codex session per Weixin user
- Typing state support
- `/new` and `/reset` to reset the current user's session
- Local runtime state under `.local/`

## Why This Project Matters

This repository is not trying to be "just another chatbot." It addresses a more specific maintainer workflow problem:

- many Chinese-speaking users already coordinate day-to-day work in WeChat
- Codex is strong at coding and maintainer workflows, but it does not naturally live inside WeChat
- OpenClaw routing is powerful, but not every deployment needs the full routing and agent-dispatch layer

That is why this project takes a narrower path: `Weixin -> standalone bridge -> Codex`. The value is practical rather than theoretical: it connects a high-frequency communication channel to an executable Codex workflow while keeping deployment and debugging boundaries simple.

## Current Scope

Included in v0.1:

- Direct-message text only
- Single-agent routing
- Plain-text replies

Not included yet:

- Group chat routing
- Media upload and download
- Multi-agent dispatch

## Requirements

- Node.js `>= 22`
- Local `codex` CLI installed and already authenticated
- Network access to the Weixin bot API and npm

## Quick Start

```bash
git clone <your-repo-url>
cd weixin-codex-bridge
npm install
```

Verify `acpx` can see your target workspace:

```bash
node src/cli.mjs doctor --workspace "/path/to/your/workspace"
```

Link a Weixin account:

```bash
node src/cli.mjs login --workspace "/path/to/your/workspace"
```

During login, the bridge outputs:

- A terminal QR code
- A local QR image at `.local/login-qr.png`

Start the bridge:

```bash
node src/cli.mjs serve
```

Or do login + serve in one step:

```bash
node src/cli.mjs start --workspace "/path/to/your/workspace"
```

## Useful Commands

```bash
node src/cli.mjs doctor
node src/cli.mjs logout
npm run public-check
```

## Repository Layout

```text
src/
  cli.mjs
  login.mjs
  bridge.mjs
  weixin-api.mjs
  codex-runner.mjs
  text.mjs
  state.mjs
  config.mjs
  log.mjs
  paths.mjs
docs/
  build-process.md
  configuration.md
  faq.md
  privacy-and-publish-checklist.md
scripts/
  public-check.sh
```

## Configuration and FAQ

- [docs/configuration.md](./docs/configuration.md)
- [docs/faq.md](./docs/faq.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CHANGELOG.md](./CHANGELOG.md)

## Privacy and Publishing

- `.local/` is ignored and must never be committed
- Run `npm run public-check` before publishing changes
- See [docs/privacy-and-publish-checklist.md](./docs/privacy-and-publish-checklist.md) for the release checklist

## Why It Benefits From Stronger Security Review

This project sits on a sensitive boundary: upstream it handles WeChat login state and messages, and downstream it drives local Codex sessions and runtime state. The meaningful risks are not ordinary UI bugs, but mistakes such as:

- session-isolation failures that leak context across users
- diagnostic output or logs exposing secrets
- routing mistakes that send one user's content into another user's Codex session
- accidental publication of `.local/` state, QR images, or account identifiers

That is why the repository is a strong fit for maintainer automation and deeper security review, not just feature development.

## Roadmap

The near-term goal is not to add features blindly, but to make the bridge more reliable as a maintainable OSS project:

- strengthen validation around session isolation and reset flows
- improve log redaction and diagnostic boundaries
- add more stable maintainer checks and pre-release automation
- evaluate media-message support and group-chat allowlisting without breaking the standalone architecture

## References

- Tencent Weixin OpenClaw installer: <https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin-cli>
- Tencent Weixin OpenClaw plugin: <https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin>
- OpenClaw ACP Agents: <https://docs.openclaw.ai/tools/acp-agents>
- OpenClaw ACP CLI: <https://docs.openclaw.ai/cli/acp>
- ACPX: <https://www.npmjs.com/package/acpx>

## Notes

This repository focuses on the standalone "Weixin directly to Codex" approach. If you want to reuse OpenClaw routing itself, that is a different architecture and intentionally out of scope here.

## License

MIT
