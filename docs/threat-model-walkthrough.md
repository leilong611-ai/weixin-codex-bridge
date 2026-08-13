# Threat-model walkthrough

This walkthrough follows one placeholder text message through the bridge. It complements the control inventory and disclosure policy in [SECURITY.md](../SECURITY.md); it does not claim complete security or guaranteed delivery.

## End-to-end path

```text
WeChat input
  -> role authorization
  -> SQLite durable inbox
  -> account/session scheduler
  -> sandboxed Codex runner
  -> scrubbed state and reply
```

| Stage | Trust decision | Primary controls | Residual risk |
|---|---|---|---|
| WeChat input | Untrusted, even when sent by an allowed peer | Size checks, text-only scope, no automatic media writes | Prompt injection and malicious instructions remain possible |
| Authorization | Peer identity is compared with explicit role lists | Default deny; owner, allowed, readonly, and unknown roles | A mistakenly trusted peer receives the configured role |
| SQLite inbox | Local private state, not a trust boundary bypass | Account-scoped IDs, transactional inserts, 0700 directory, 0600 database | A local administrator can still read or alter state |
| Scheduler | A message may run only inside its account and peer session | Deterministic account/peer session keys, account-scoped queries, lease tokens | External side effects may outlive a lost lease |
| Codex runner | Local code execution with untrusted prompt content | Restricted mode, workspace-root validation, full-auto and skip-git checks disabled | Codex output and commands still require operator review |
| Reply and cleanup | Output may contain sensitive workspace content | Authorized recipient routing, reply splitting, minimal logs, payload scrubbing and retention | The recipient can copy or redistribute a reply |

## Walkthrough

1. A placeholder peer sends a private text message. The bridge treats the content as untrusted and does not infer trust from conversational tone.
2. The authorization layer maps the peer to one role. An unknown peer receives a generic refusal and cannot trigger Codex. A readonly peer can use public status commands but cannot execute a prompt.
3. An accepted message receives an account-scoped stable identifier and is inserted with the fetch cursor in one SQLite transaction. A failed transaction is rolled back instead of being treated as a duplicate.
4. The scheduler claims the next message for the same account using a unique lease token. The session key is derived from both account and peer, preventing a matching peer identifier on another account from sharing a session.
5. Before Codex starts, restricted mode validates that the workspace is inside the configured sandbox or allowed roots. Home, credential, and state directories remain prohibited by the workspace policy.
6. A heartbeat renews the lease while work continues. Completion or failure requires the current lease token, so a stale worker cannot overwrite a newer claim.
7. The reply is sent only to the authorized peer associated with the claimed message. Completed, skipped, rejected, and terminally failed records have message payloads scrubbed according to the storage policy.

## Login and account state

`weixin-codex-bridge login` renders the QR code in the terminal and does not write the QR payload or URL to disk or logs. Each confirmed credential file is written by atomic replacement under the bridge state root, while account discovery derives from the credential directory instead of a shared mutable index. On POSIX systems, account directories use mode 0700 and account files use mode 0600.

The bridge can also read an existing OpenClaw-compatible account store. Local bridge state is preferred when the same account appears in both stores. `logout` deletes only bridge-managed credentials; it never deletes an OpenClaw-compatible account.

## Crash and delivery limits

- SQLite WAL and transactional cursor updates reduce silent message loss, but disk corruption and upstream outages can still prevent delivery.
- Lease recovery allows a later worker to retry expired work, but an already-started external command may not be cancellable.
- Deduplication prevents the same stored identity from running twice; it cannot prove that an upstream service will always provide stable identifiers.
- A successful Codex run does not prove that the generated change is safe, correct, or reviewed.

## Reviewer checklist

- Does every executable message pass role authorization before storage and execution?
- Are account and peer identifiers included in every session and inbox boundary?
- Can any configured workspace escape the sandbox through path normalization or a symbolic link?
- Are QR payloads, tokens, message text, and Codex output absent from default logs?
- Do failed state transitions require the active lease token?
- Does the npm package exclude local account state, databases, logs, and debug captures?

Report suspected vulnerabilities through the private channel described in [SECURITY.md](../SECURITY.md#reporting-a-vulnerability).
