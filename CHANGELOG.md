# Changelog

All notable changes to this project will be documented in this file.

## v0.3.0 (unreleased)

### Added

- **Transactional batch persistence** — `persistFetchedBatch()` uses `BEGIN IMMEDIATE`/`COMMIT` for atomic message + cursor writes. On error, `ROLLBACK` prevents partial writes.
- **Account-scoped message UIDs** — `makeMessageUid()` creates stable identifiers with account hash prefix (`weixin:<hash>:msg:<id>`), preventing cross-account ID collision.
- **Lease token system** — `leaseManager.ts` provides per-claim `crypto.randomUUID()` tokens. `completeMessage()` and `failMessage()` verify `id + lease_token` match before transitioning state.
- **Heartbeat renewal** — `startHeartbeat()` renews lease every 30 seconds during execution. Long-running tasks stay claimed; expired heartbeat allows recovery.
- **Safe lease recovery** — `recoverExpiredLeases()` checks `lease_until < now` (not `now - leaseMs`), preventing false recovery of active leases.
- **Schema migrations** — `sqliteMigrations.ts` uses `PRAGMA user_version` with transactional apply. Upgrades cleanly from v1 (original schema) through v2 (account_key, lease_token) to v3 (extended statuses, error_category).
- **Data retention cleanup** — `dataRetention.ts` deletes records past the configured window (default 7 days), runs on startup and periodically.
- **Payload scrubbing** — completed/skipped/rejected/dead messages automatically have `raw_json` and `text` cleared. `scrubResidualPayloads()` catches any residual payloads.
- **Privacy-aware payload storage** — `payloadForRole()` strips content for unauthorized users before storage. `preparePayload()` only stores `raw_json` in `full-debug` log level.
- **Startup priority** — `runForever()` drains pending messages BEFORE the first `getUpdates()`, so crash recovery works even when WeChat API is temporarily down.
- **Skipped backlog** — statusOverride='skipped' stores minimal record (no payload), never processed by drainInbox.
- **Account-isolated queries** — all `countPending()`, `claimNextMessage()`, `listRecentMessages()`, `recoverExpiredLeases()` require `accountKey`.
- **Extended message statuses** — `skipped` (backlog skip), `rejected` (unauthorized, oversized) added to the status CHECK constraint.
- **`error_category` column** — failed messages can carry a structured error category for diagnostics.
- **`reason_code` column** on `failed_tasks` table.
- **SQLite file permissions** — database file set to 0600, directory set to 0700 on POSIX systems.
- **npm pack content validation in CI** — CI extracts the tarball and verifies presence of dist/, README, LICENSE, SECURITY, and absence of .env, bridge.db, WAL files.
- **CI for Windows and Linux** with build, test, public-check, and npm pack verification.
- **Comprehensive test coverage** — new test files for leaseManager, sqliteMigrations, messageIdentity, messagePayload, dataRetention (27 test files, 250+ tests).

### Fixed

- SQLite errors (disk full, corruption, I/O) no longer silently treated as "duplicate" — replaced bare `catch { return false }` with `ON CONFLICT DO NOTHING` and explicit result type.
- Lease expiry check corrected — `recoverStuckMessages` previously used `lease_until < Date.now() - leaseMs`, which could recover live messages. Now correctly checks `lease_until < now`.
- Long-running tasks beyond initial lease window could be re-claimed — mitigated by lease token + heartbeat.
- `unknown` user messages could have full content stored in SQLite — now stripped by `payloadForRole()`.
- Completed messages retained raw payload indefinitely — now scrubbed on completion.
- Different WeChat accounts with same message_id could conflict — resolved by account-scoped UIDs.
- Startup backlog "skipped" messages could be processed next restart — now stored as `skipped` status with no payload, never drained.
- Database directory had no explicit file permissions — now set to 0700/0600.

### Documentation

- Complete rewrite of Chinese and English READMEs with accurate architecture, security policy, reliability model, and limitations.
- Rewrote SECURITY.md with threat model, attacker profiles, and comprehensive control listing.
- Rewrote CONTRIBUTING.md with project structure, branch strategy, and testing requirements.
- Updated .env.example with clearer categories and usage guidance.
- Updated CI workflow with npm pack content validation.
- Updated CHANGELOG.md for v0.3.0.

## v0.2.0 — Security Refactor

### Added

- Role-based authorization (owner / allowed / readonly / unknown)
- Default-deny: unknown users receive generic refusal
- Codex workspace sandbox validation
- `--full-auto` disabled by default
- `--skip-git-repo-check` disabled by default
- Local console disabled by default
- Bearer Token, Origin, Host, CSRF checks for console
- Log redaction (tokens, account IDs, paths, emails, phone numbers)
- TypeScript as the primary runtime entry point
- npm publish file whitelist
- Security tests and CI

## v0.1.0 — Initial Public Release

### Added

- QR login flow for WeChat bot authentication
- Standalone bridge architecture using `acpx` and Codex
- Per-user persistent Codex session mapping
- `doctor`, `login`, `serve`, `start`, and `logout` CLI commands
- Chinese and English README files
- Configuration, FAQ, build-process, and privacy documentation
- GitHub issue templates and maintainer-check workflow

### Security

- Masked `botToken` in `doctor` output
- Added repository scans for email, phone, IP, key, and path patterns
- Excluded sensitive local state and temporary files from publish flow
