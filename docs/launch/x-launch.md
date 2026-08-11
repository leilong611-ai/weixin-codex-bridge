# X (Twitter) Launch Assets

## One-line Positioning

**English:**
A local-first WeChat bridge for Codex, with allowlists, session isolation, sandboxing, and a durable SQLite inbox.

**Chinese:**
把本地 Codex 接进微信，同时保留白名单、会话隔离、沙箱和可恢复消息队列。

---

## Three Short Posts (280-char versions)

### Post 1 — Pain Point

WeChat is where the conversation happens. Codex is where the work gets done.

Weixin Codex Bridge connects them — securely.

No hosted bridge service required. Codex execution and bridge state stay local, with role-based access and a durable queue.

GitHub → [URL]

### Post 2 — Security Design

WeChat → Codex locally.

Default-deny. Sandboxed workspace. Per-peer session isolation. Lease tokens reduce stale-worker and duplicate-execution risk.

If it\'s not on the allowlist, it doesn\'t reach Codex.

Weixin Codex Bridge — secure by default, durable by design.

### Post 3 — Built for Reliability

SQLite WAL durable inbox. Transactional batch writes. Heartbeat lease renewal. Crash recovery.

Durable SQLite recovery reduces message-loss risk across restarts.

本地持久化和崩溃恢复可降低重启期间的消息丢失风险。

---

## Thread (5 messages)

### 1. Hook — The WeChat Problem

Most of our daily coordination happens in WeChat. But our dev tools — Codex, Claude Code — live on the desktop.

Bridging them means putting a local execution endpoint behind a messaging app. That\'s a security boundary worth respecting.

### 2. How Weixin Codex Bridge Works

Three layers:

1. Authorization — role-based (owner/allowed/readonly), default-deny
2. Durable inbox — SQLite WAL, atomic batch writes, cursor persistence
3. Execution — Codex Desktop or CLI, workspace sandboxed

Every message classified before persistence. Unauthorized? Never reaches the inbox.

### 3. Security Model

We don\'t claim "perfect security." We document the controls:

- Prompt injection? Can\'t be eliminated — workspace isolation mitigates
- Duplicate execution? Lease tokens + heartbeat reduce the risk
- Data leakage? Payload scrubbed on completion, retention cleanup runs automatically
- SQLite errors? They propagate — no silent swallows

### 4. What Makes It Different

Not a chatbot. Not a SaaS. Not replacing OpenClaw routing.

A focused local bridge for a specific use case: triggering Codex from WeChat on your own machine.

Windows-first. Open source. MIT.

### 5. Call to Action

Weixin Codex Bridge on GitHub.

[URL]

Star if it helps. Issues welcome. PRs reviewed.

---

## Demo Script (15-second screencast)

### Scene 1 (0-3s): WeChat → Bridge
Screen recording: mobile WeChat sends text message.
Overlay caption: `微信发任务 → 白名单鉴权`

Audio (optional): typing notification sound.

### Scene 2 (3-6s): Bridge Processing
Terminal shows:
```
[bridge] message classified: process (authorized)
[bridge] claimed message msg:12345 with lease token
```
Overlay: `SQLite durable inbox → Session Scheduler`

### Scene 3 (6-10s): Codex Desktop Reaction
Codex Desktop window shows: task appears in conversation, begins executing.

Terminal shows:
```
[codex] executing prompt: "..."
```

### Scene 4 (10-15s): WeChat Reply
Switch back to mobile WeChat.
Reply message arrives.

Overlay: `Codex 执行 → 微信回复`

### Script Notes
- Keep phone/desktop mockups sanitized — no real account info
- Use example wxid_example_owner for all peer references
- Blur or pixelate non-essential UI areas
- 1280×720 target resolution

---

## Social Preview Design Spec

| Property | Value |
|----------|-------|
| Dimensions | 1280×640 px |
| Format | PNG |
| Max file size | 1 MB |
| Background | Dark (#0f172a) with accent gradient (#1e3a5f → #0f172a) |
| Primary text | white, bold, sans-serif |
| Secondary text | #94a3b8, regular weight |

### Layout (mobile-safe)

```
┌────────────────────────────────────────┐
│  [icon] WEIXIN CODEX BRIDGE             │
│                                         │
│  WeChat → Local Codex                   │
│  Secure by default. Durable by design.   │
│                                         │
│  ─────────────────────────────────────   │
│  Allowlist · Sandbox · Session Isolation │
│  · SQLite Inbox · Windows-first           │
│                                         │
│              [GitHub Star]               │
└────────────────────────────────────────┘
```

### Icon Suggestion
A bridge icon (two pillars with arch) composed of:
- Left pillar: WeChat green (#07c160) chat bubble
- Right pillar: Codex blue (#3b82f6) terminal bracket
- Arch: data flow arrow

### Font Suggestion
- Title: Inter or system-ui, 36px, bold
- Tagline: Inter, 24px, semibold
- Features: 14px, monospace (Cascadia Code or similar)

### Restrictions
- Exclude: real QR codes, real account IDs, real tokens, real session data
- Exclude: screenshots of actual WeChat conversations with identifiable content
- Exclude: "fully secure" or "never loses messages" claims

---

## Build in Public Angles

### Problem

WeChat is where many conversations happen. Codex is where development work happens. Connecting them introduces a local execution security boundary.

### Engineering

Why the bridge uses default-deny authorization, per-peer session isolation, a workspace sandbox, a durable SQLite inbox, lease tokens with heartbeat renewal, and payload scrubbing.

### Failure and Learning

Real maintenance lessons: Windows SQLite handle lifecycle, a temp-directory security fixture that contradicted production policy, Git Bash drive-path handling in npm pack verification, and crash-recovery semantics.

---

## OpenAI Codex Ecosystem Show & Tell Draft

**A security-first WeChat → local Codex bridge**

I built a narrow, auditable bridge instead of a full routing framework. It treats WeChat input as untrusted, applies default-deny roles, isolates sessions and workspaces, and persists queued work in SQLite with lease tokens, heartbeat renewal, and crash recovery.

The project documents its trust boundaries and limitations, runs Windows/Linux CI, and keeps Codex execution and bridge state local. It is a Chinese developer use case and an ongoing open-source maintainer workflow—not an official OpenAI project or endorsement.
