#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Running public repository checks..."

status=0

fail() {
  echo "ERROR: $*"
  status=1
}

if ! command -v git >/dev/null 2>&1; then
  fail "git is required to determine publish candidate files."
fi

if ! command -v rg >/dev/null 2>&1; then
  fail "ripgrep (rg) is required for content scanning."
fi

if [[ $status -ne 0 ]]; then
  exit "$status"
fi

publish_files=()
while IFS= read -r -d '' file; do
  [[ -f "$file" ]] || continue
  case "$file" in
    package-lock.json|scripts/public-check.sh)
      continue
      ;;
  esac
  publish_files+=("$file")
done < <(git ls-files -z --cached --others --exclude-standard)

if [[ ${#publish_files[@]} -eq 0 ]]; then
  echo "No publish candidate files found."
  exit 0
fi

for file in "${publish_files[@]}"; do
  normalized="${file//\\//}"
  lower="$(printf '%s' "$normalized" | tr '[:upper:]' '[:lower:]')"

  case "$lower" in
    .env|.env.*|*/.env|*/.env.*)
      if [[ "$lower" != ".env.example" ]]; then
        fail "Environment file is a publish candidate: $file"
      fi
      ;;
  esac

  case "$lower" in
    node_modules/*|*/node_modules/*|dist/*|*/dist/*|coverage/*|*/coverage/*|.local/*|*/.local/*|tmp/*|*/tmp/*|temp/*|*/temp/*|logs/*|*/logs/*|log/*|*/log/*|state/*|*/state/*|.openclaw/*|*/.openclaw/*|debug/*|*/debug/*|screenshots/*|*/screenshots/*|screenshot/*|*/screenshot/*|docs/superpowers/*)
      fail "Generated, runtime, or local-only path is a publish candidate: $file"
      ;;
  esac

  case "$lower" in
    *.log|*.pid|*.sqlite|*.sqlite3|*.db|*.db-shm|*.db-wal|*.har|*.trace|*.webm)
      fail "Generated or diagnostic file is a publish candidate: $file"
      ;;
  esac

  if [[ "$lower" =~ (^|/)(login-)?qr(code)?[^/]*\.(png|jpe?g|webp|gif|svg)$ ]]; then
    fail "QR image is a publish candidate: $file"
  fi

  if [[ "$lower" =~ (^|/).*(debug|screenshot|screen-shot|desktop-input).*\.(png|jpe?g|webp|gif|bmp)$ ]]; then
    fail "Debug screenshot/capture is a publish candidate: $file"
  fi
done

labels=(
  "macOS user path"
  "Linux home path"
  "Windows user path"
  "Weixin bot id"
  "Weixin account id"
  "Weixin wxid"
  "OpenAI-style API key"
  "Slack-style token"
  "JSON token or cookie"
  "Environment token or cookie"
  "QR query payload"
  "Mainland China phone number"
)

patterns=(
  '/Users/[A-Za-z0-9._-]+'
  '/home/[A-Za-z0-9._-]+'
  'C:\\Users\\[A-Za-z0-9._-]+'
  '@im\.bot:[A-Za-z0-9._:-]{12,}'
  '[A-Za-z0-9._-]{8,}@im\.wechat'
  'wxid_[A-Za-z0-9_-]{6,}'
  'sk-[A-Za-z0-9]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{20,}'
  '"(botToken|token|access_token|refresh_token|cookie)"[[:space:]]*:[[:space:]]*"[A-Za-z0-9._/+~=-]{16,}"'
  '(^|[[:space:]])(BOT_TOKEN|WEIXIN_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|COOKIE)=[A-Za-z0-9._/+~=-]{16,}'
  '(qrcode|qr_code|login-qr)=[A-Za-z0-9_-]{16,}'
  '\b1[3-9][0-9]{9}\b'
)

for index in "${!patterns[@]}"; do
  pattern="${patterns[$index]}"
  label="${labels[$index]}"
  if matches="$(rg -n --hidden --color never -- "$pattern" "${publish_files[@]}" 2>/dev/null)"; then
    echo "$matches"
    fail "Matched sensitive content pattern: $label"
  fi
done

if [[ $status -ne 0 ]]; then
  echo "Public check failed."
  exit "$status"
fi

echo "Public check passed."
