#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Source only the helpers (start.sh returns early when TC_SOURCE_ONLY=1).
TC_SOURCE_ONLY=1 source "$here/start.sh"

# 1. Secret generation is idempotent: same value on repeat.
f="$tmp/secret"
a="$(tc_ensure_secret "$f")"
b="$(tc_ensure_secret "$f")"
[ "$a" = "$b" ] && [ -n "$a" ] && echo "ok  secret idempotent" || { echo "FAIL secret"; exit 1; }

# 2. SMTP URL is built and percent-encoded.
url="$(tc_smtp_url 'mail.example.com' '2525' 'user@x' 'p@ss:/word')"
[ "$url" = "smtp://user%40x:p%40ss%3A%2Fword@mail.example.com:2525" ] \
  && echo "ok  smtp url encoded" || { echo "FAIL smtp: $url"; exit 1; }
