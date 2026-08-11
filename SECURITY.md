# Security Policy

`weixin-codex-bridge` sits between WeChat, local runtime state, and Codex-driven workflows. Session boundaries, credential handling, data privacy, and code execution safety are core security concerns.

## Threat Model

### Trust Boundaries

```
[WeChat User — UNTRUSTED]
    ↓ WeChat Bot API
[Bridge Process — TRUSTED but audited]
    ↓ Authorization Check
[SQLite Inbox — LOCAL, PRIVATE]
    ↓ Session Scheduler
[Codex Desktop / CLI — LOCAL EXECUTION]
    ↓ Output delivered to authorized peer
```

### Assets

- WeChat bot token and login session
- SQLite database with message history
- Codex workspace files and generated code
- Local console session

### Attackers

| Attacker | Capability |
|----------|------------|
| Unauthorized WeChat user | Can send any message to the bot |
| Authorized malicious user | Can send commands to Codex |
| Network attacker | Could intercept WeChat API traffic (mitigated by HTTPS) |
| Local process | Could read SQLite files (mitigated by file permissions) |

### Threats and Controls

| Threat | Control |
|--------|---------|
| Unauthorized user triggers Codex | Default-deny allowlist, role-based access |
| Prompt injection via WeChat | Workspace isolation, restricted execution mode |
| SQLite data leakage | File permissions (0600), periodic cleanup, payload scrubbing on completion |
| Cross-user session leakage | Deterministic per-account session keys, account-isolated queries |
| Log/console leaks credentials | Redaction rules for tokens, accounts, paths, emails, phones |
| Duplicate Codex execution | Account-scoped UID dedup, lease tokens with state-conditioned updates |
| Crash loses messages | SQLite WAL, transactional batch persistence, crash recovery |
| npm package leaks local data | `files` whitelist in package.json, public-check CI, pack validation |

## Current Protections

### Authorization

- owner / allowed / readonly / unknown role system
- Default-deny: unknown users receive generic refusal — no internal state leaked
- Command-level access control (owner-only commands, public status commands)
- Startup guard: refuses to start with no owners configured (unless dev mode)

### Workspace Security

- Sandbox root validation — Codex workspace must be within allowed tree
- `--full-auto` and `--skip-git-repo-check` disabled by default
- Execution mode: "restricted" (default) enforces all checks; "high-risk" bypasses (not recommended)

### SQLite Durable Inbox

- WAL mode for crash-safe concurrent access
- Transactional batch writes: messages + cursor in one atomic commit
- Account-scoped message UIDs prevent cross-account ID collision
- ON CONFLICT DO NOTHING for dedup; other SQLite errors propagate (no silent swallowing)
- Lease tokens for safe state transitions — complete/fail requires matching token
- Heartbeat renewal for long-running tasks
- Leases expire and can be recovered on restart
- Payload scrubbing on completion/skip/reject — no residual PII

### Privacy

- `minimal` log level by default — no message content in logs
- Payload per role: unauthorized users never store raw_json or text
- Data retention cleanup (default 7 days)
- Log redaction for tokens, account IDs, paths, emails, phone numbers
- Database file permissions: 0600 (POSIX), directory: 0700
- Files whitelist in package.json prevents accidental publication of sensitive files

### Console Security

- Disabled by default
- Bearer token authentication
- Origin / Host header validation
- CSRF token validation
- Body size limit
- Only listens on 127.0.0.1

## Reporting a Vulnerability

Please do not open a public GitHub issue for suspected security vulnerabilities.

**Preferred reporting channel:** GitHub Security Advisories
Navigate to the repository → Security → Advisories → New advisory
This creates a private, controlled disclosure channel.

**Alternative:** Contact the repository maintainers through their GitHub profiles.

### Required information

1. A minimal reproduction without real credentials
2. Impact description, affected files, and expected fix direction
3. Bridge version and commit hash

**Do not include in any report:**
- Real `botToken` values
- Real WeChat account IDs, cookie values, or QR codes
- Real `.local/` or SQLite database files
- Logs with unredacted user content

**Do include:**
- Placeholder values (`/path/to/workspace`, `example-user-id`, `example-bot-token`)
- Steps to reproduce
- Expected vs actual behavior

If a bug could expose user messages, login state, session data, or local files across users, treat it as a security issue even if the root cause looks like an ordinary logic bug.

## Remaining Risks

The following risks cannot be eliminated by the bridge alone and require operator awareness:

| Risk | Mitigation |
|------|-----------|
| **Prompt injection** | Workspace isolation, restricted execution mode. Cannot be fully prevented. |
| **Authorized malicious user** | Role-based access, sandboxed workspace. The operator chooses who to trust. |
| **Codex-generated destructive commands** | Git branches, code review, backups. The bridge does not filter Codex output. |
| **Lease loss during non-cancellable external side effects** | In-flight tracking + grace period. Some Codex subprocesses may outlive the bridge. |
| **Local administrator access** | Database file permissions (0600), configurable state directory. A local admin can always read SQLite. |
| **Windows UI automation uncertainty** | Desktop UI runner depends on Codex window state and DPI — may fail silently. |

## Security Review Focus

The highest-value review areas for this project are:

1. Session isolation correctness — can one user's prompt reach another's session?
2. Authorization boundary — can an unauthorized user trigger Codex execution?
3. SQLite data privacy — is payload properly scrubbed at each lifecycle stage?
4. Lease token safety — can an expired lease overwrite active processing?
5. Log and diagnostic redaction — are secrets leaked anywhere?
6. npm package content — are local state files excluded from publication?
