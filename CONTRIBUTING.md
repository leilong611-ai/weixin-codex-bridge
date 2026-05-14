# Contributing

Thanks for helping improve Weixin Codex Bridge.

## Development Setup

```powershell
npm install
npm test -- --run
npm run build
```

Before publishing or opening a pull request, also run:

```powershell
npm run public-check
```

## Pull Request Guidelines

- Keep inbound Weixin text unchanged when sending it to Codex.
- Do not commit local state, logs, screenshots, QR codes, or credentials.
- Keep Windows desktop automation changes covered by tests under `test/`.
- Prefer small, focused pull requests with a clear verification section.

## Local Runtime State

The bridge supports environment-variable overrides for state and logs. Avoid
hardcoding machine-specific paths in source or docs unless they are examples.
