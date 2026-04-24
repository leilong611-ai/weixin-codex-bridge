#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Running public repo privacy checks..."

status=0

patterns=(
  '/Users/'
  '/home/[a-z]'
  'C:\\Users\\'
  '@im\.bot:[A-Za-z0-9]+'
  '[A-Za-z0-9_-]+@im\.wechat'
  'qrcode=[0-9a-f]{16,}'
  '\b1[3-9]\d{9}\b'
  '\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b'
  'sk-[a-zA-Z0-9]{20,}'
  '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
)

for pattern in "${patterns[@]}"; do
  if rg -n --hidden \
    --glob '!node_modules/**' \
    --glob '!.git/**' \
    --glob '!.local/**' \
    --glob '!package-lock.json' \
    --glob '!scripts/public-check.sh' \
    "$pattern" .; then
    echo "Matched sensitive pattern: $pattern"
    status=1
  fi
done

extra_files=(
  ".tmp-test-qr.png"
)

for file in "${extra_files[@]}"; do
  if [[ -e "$file" ]]; then
    echo "Remove temporary file before publishing: $file"
    status=1
  fi
done

if [[ $status -ne 0 ]]; then
  echo "Public check failed."
  exit 1
fi

echo "Public check passed."
