#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"   # cloudron/
tmp="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$tmp"' EXIT

# Stub upstreams: core says CORE, web says WEB.
node -e 'require("http").createServer((_,r)=>r.end("CORE")).listen(8787)' & sleep 0.3
node -e 'require("http").createServer((_,r)=>r.end("WEB")).listen(3000)'  & sleep 0.3

# Copy config into temp prefix; point the proxy_params include at the temp copy
# AND redirect the runtime /run/* paths (pid, temp dirs) into $tmp so the test
# runs without root/writable-/run.
cp "$here/proxy_params" "$tmp/proxy_params"
sed -e "s#/app/pkg/proxy_params#$tmp/proxy_params#g" -e "s#/run/#$tmp/#g" \
    "$here/nginx.conf" > "$tmp/nginx.conf"
mkdir -p "$tmp/nginx-body" "$tmp/nginx-proxy"
nginx -p "$tmp" -c "$tmp/nginx.conf" & sleep 0.5

fail=0
check() { # path  expected
  got="$(curl -s "http://127.0.0.1:8000$1")"
  if [ "$got" != "$2" ]; then echo "FAIL $1 -> $got (want $2)"; fail=1
  else echo "ok   $1 -> $got"; fi
}

# Public → CORE
check /users/rss.xml CORE
check /users/alice/feed.xml CORE
check /users/alice/feed.json CORE
check /users/alice/following.opml CORE
check /post/abc123/comments.xml CORE
check /websub/callback/tok-xyz CORE
check /rsscloud/notify CORE
check /rsscloud/pleaseNotify CORE
check /hub CORE
# Everything else → WEB (incl. auth, stream, deeper/looser paths)
check / WEB
check /api/auth/sign-in/magic-link WEB
check /stream WEB
check /u/alice WEB
check /users/alice/feed.xml/extra WEB   # not single-segment → web
check /x/users/alice/feed.xml WEB       # not start-anchored → web
check /post/abc/comments.xml/more WEB

exit $fail
