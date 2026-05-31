# Security Policy

`weixin-codex-bridge` sits between WeChat, local runtime state, and Codex-driven workflows. That makes session boundaries, credential handling, and log hygiene core security concerns rather than secondary cleanup work.

## Security Scope

The current security-sensitive areas are:

- WeChat login state stored in `.local/account.json`
- local runtime state stored in `.local/runtime.json`
- per-user Codex session isolation
- message routing between WeChat and Codex
- local logs and diagnostic output

## Primary Risks

The project is designed to reduce the following classes of mistakes:

- credential leakage through committed files, screenshots, or logs
- cross-user session leakage caused by incorrect session mapping
- unsafe diagnostic output that exposes bot tokens, account IDs, or personal data
- message routing mistakes that send one user's content into another user's Codex session

## Current Protections

- local state is stored under `.local/` and excluded from Git
- `public-check` scans the repository for common sensitive patterns before publishing
- each WeChat user is mapped to a stable, isolated Codex session name
- `doctor` output is designed for environment checks and should not expose raw secrets

## Reporting a Vulnerability

Please do not open a public GitHub issue for suspected credential exposure, session-mixing bugs, or other security-sensitive findings.

Instead:

1. Prepare a minimal reproduction without real credentials
2. Describe impact, affected files, and expected fix direction
3. Send the report through a private channel before public disclosure

If a bug could expose user messages, login state, or session data across users, treat it as a security issue even if the root cause looks like an ordinary logic bug.

## Safe Disclosure Rules

When reporting or reproducing a security issue, never include:

- real `botToken` values
- real WeChat account IDs
- QR codes or login images
- raw `.local/` files
- logs with unredacted user content unless strictly necessary

Use placeholders such as:

- `/path/to/workspace`
- `example-user-id`
- `example-bot-token`

## Security Review Focus

The highest-value review areas for this project are:

- session isolation correctness
- secret redaction in logs and diagnostics
- command and runtime boundary checks
- publish-time privacy verification

These are also the main reasons this repository is a good fit for deeper tooling such as Codex Security.
