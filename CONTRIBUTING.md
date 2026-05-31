# Contributing

Thanks for contributing to `weixin-codex-bridge`.

This repository is intentionally narrow in scope: it focuses on a standalone WeChat-to-Codex bridge without depending on OpenClaw routing. Changes should preserve that boundary unless the direction is explicitly discussed first.

## Before You Start

Make sure you have:

- Node.js `>= 22`
- a local Codex installation
- a test workspace path you can use safely

Install dependencies:

```bash
npm install
```

## Useful Commands

```bash
node src/cli.mjs doctor --workspace "/path/to/workspace"
node src/cli.mjs login --workspace "/path/to/workspace"
node src/cli.mjs serve
npm run public-check
```

## Contribution Rules

- keep changes narrow and directly related to the problem being solved
- do not commit anything under `.local/`
- do not include real tokens, account IDs, QR codes, or private logs in issues or pull requests
- preserve the standalone architecture unless there is explicit agreement to broaden scope

## Pull Request Checklist

Before opening a PR:

1. Run `npm run public-check`
2. Review your diff for absolute paths, account identifiers, and copied local logs
3. Update docs if behavior, commands, or boundaries changed
4. Note any security impact, especially around session isolation or credential handling

## What Makes a Good Issue

For bug reports:

- include exact reproduction steps
- describe expected vs actual behavior
- say whether the problem affects login, routing, session isolation, or reply delivery

For feature requests:

- explain the user problem first
- explain why it fits the standalone bridge scope

## Security-Sensitive Contributions

If your change touches any of the following, call it out clearly in the PR:

- `.local/` state handling
- token masking
- `doctor` output
- session naming or session reuse
- message routing and reply delivery

If in doubt, prefer a smaller patch with a clearer explanation.
