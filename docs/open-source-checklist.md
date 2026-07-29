# Open Source Release Checklist

Use this checklist before publishing the repository or opening a pull request.

## Local Secrets

- [ ] `.env` and other `.env.*` files are not staged.
- [ ] Weixin account JSON files, bot tokens, cookies, QR codes, and sync cursors are not staged.
- [ ] Codex auth state, session transcripts, and local run logs are not staged.
- [ ] Local-only agent instructions or planning notes are not staged.

## Generated Artifacts

- [ ] `node_modules/`, `dist/`, `.local/`, `tmp/`, `logs/`, and debug folders are not staged.
- [ ] Screenshots, QR images, desktop automation captures, traces, and HAR files are not staged.
- [ ] Any public screenshots are intentionally sanitized and stored under a documented public assets path.

## Documentation

- [ ] `README.md` and `README.en.md` explain how to configure the bridge without exposing real local paths or credentials.
- [ ] `.env.example` lists required variables with placeholders only.
- [ ] The quick start works from a fresh clone after `npm install` and `npm run build`.

## Security

- [ ] `CODEX_WEIXIN_OWNER_PEER_IDS` is documented as REQUIRED.
- [ ] Default security posture is documented (console off, restricted mode, full-auto off).
- [ ] Workspace sandbox requirements are documented.
- [ ] Data retention and cleanup instructions are documented.
- [ ] SECURITY.md covers threat model, trust boundaries, and vulnerability reporting.

## Verification

Run:

```bash
npm run public-check
npm test -- --run
npm run build
npm pack --dry-run --json
```

If a check fails because it found sensitive material, remove the material from the candidate files instead of weakening the check.
