# Security Policy

## Supported Versions

This project is early-stage. Security fixes are applied to the default branch
until formal releases are published.

## Sensitive Data

Do not commit:

- Weixin account credentials, QR codes, cookies, or session files
- Codex auth state, session transcripts, or local logs
- `.env` files, debug screenshots, or runtime state directories
- Personal local paths or machine-specific account identifiers

Use `.env.example` for documentation and keep real values local.

## Reporting a Vulnerability

Please report security issues privately to the maintainer instead of opening a
public issue with exploit details. Include:

- A short description of the issue
- A minimal reproduction or affected file path
- Whether credentials, local state, or message contents can be exposed

If you are unsure whether something is sensitive, treat it as sensitive.
