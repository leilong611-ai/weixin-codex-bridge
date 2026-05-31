# Changelog

All notable changes to this project will be documented in this file.

## v0.1.0

Initial public release of the standalone WeChat-to-Codex bridge.

### Added

- QR login flow for WeChat bot authentication
- standalone bridge architecture using `acpx` and Codex
- per-user persistent Codex session mapping
- `doctor`, `login`, `serve`, `start`, and `logout` CLI commands
- Chinese and English README files
- configuration, FAQ, build-process, and privacy documentation
- GitHub issue templates and public-check workflow

### Security

- masked `botToken` in `doctor` output
- added repository scans for email, phone, IP, key, and path patterns
- excluded sensitive local state and temporary files from publish flow
