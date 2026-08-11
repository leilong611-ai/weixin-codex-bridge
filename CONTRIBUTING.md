# Contributing

Thanks for considering contributing to `weixin-codex-bridge`.

This repository is intentionally narrow in scope: a standalone WeChat-to-Codex bridge. Changes should preserve that boundary.

## Development Environment

- Node.js 22+ (uses `node:sqlite`)
- TypeScript (compiled via `tsc`)
- Vitest for testing
- Git for version control

```bash
npm ci
npm run build
```

## Project Structure

```
src/
  sqliteStore.ts       — SQLite durable inbox (writes, reads, account isolation)
  sqliteMigrations.ts  — Schema migrations (PRAGMA user_version)
  leaseManager.ts      — Lease token, heartbeat, safe state transitions
  messageIdentity.ts   — Account-scoped message UID generation
  messagePayload.ts    — Payload preparation, role-based filtering, scrubbing
  dataRetention.ts     — Cleanup, WAL checkpoint, database info
  bridge.ts            — Main bridge orchestration
  auth.ts              — Role resolution, command access
  sessionKey.ts        — Deterministic session key derivation
  codexRunner.ts       — Codex CLI runner
  consoleServer.ts     — Local web console
  redact.ts            — Log/console redaction rules
  config.ts            — Configuration (environment variables)
  types.ts             — TypeScript type definitions

test/                 — Test files (mirror src/ structure)
```

## Branch Strategy

- `main` — stable, reviewed changes only
- Feature/fix branches — prefixed with `fix/`, `feat/`, `docs/`, `ci/`
- No direct pushes to `main` — use pull requests

## Commit Convention

```
<type>: <description>

<optional body>
```

Types: `fix`, `feat`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

## Before Opening a PR

1. Run `npm run build` — must pass with zero errors
2. Run `npm test -- --run` — all tests must pass
3. Run `npm run public-check` — no secret patterns in the diff
4. Review your diff for absolute paths, account identifiers, and copied local logs
5. Update docs if behavior, commands, or boundaries changed
6. Note any security impact, especially around session isolation, credential handling, or data privacy

## Testing Requirements

All new logic must have corresponding tests:

| Module | Test file |
|--------|-----------|
| sqliteStore | test/sqliteStore.test.ts |
| sqliteMigrations | test/sqliteMigrations.test.ts |
| leaseManager | test/leaseManager.test.ts |
| messageIdentity | test/messageIdentity.test.ts |
| messagePayload | test/messagePayload.test.ts |
| dataRetention | test/dataRetention.test.ts |
| bridge | test/bridge.test.ts |
| auth | test/auth.test.ts |

Tests must:

- Cover success paths AND failure paths
- Verify invariants (no duplicate execution, no payload leakage, correct recovery)
- Use controlled time (not real waits) for lease-based tests
- Clean up temporary files after each test case

## Security-Sensitive Changes

If your change touches any of the following, call it out clearly in the PR:

- Authorization logic (auth.ts, role resolution)
- SQLite data storage (sqliteStore.ts, migrations)
- Session isolation (sessionKey.ts, bridge.ts processMessage)
- Lease/token management (leaseManager.ts)
- Payload content or privacy (messagePayload.ts, dataRetention.ts)
- Log output or redaction (redact.ts)
- Console server (consoleServer.ts)
- npm package.json `files` list
- Environment variable handling (config.ts)

If in doubt, prefer a smaller patch with a clearer explanation.

## Prohibited

- Committing anything under `.local/`, SQLite database files, or WAL/SHM files
- Including real tokens, account IDs, QR codes, or private logs in issues or PRs
- Breaking the standalone architecture without explicit discussion
- Silently swallowing SQLite errors (no bare `catch { return false }`)
- Adding secrets to the codebase
