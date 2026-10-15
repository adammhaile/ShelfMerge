#!/usr/bin/env bash
# Personal account mapping: adam has his own account on dev server A. Playback
# through ShelfMerge must land on that account upstream, manual progress
# edits must be written through, native progress on A must flow back into
# ShelfMerge, and server B (unmapped) must keep using the service account.
# Also checks the login rate limiter.
set -euo pipefail
SM="${SM:-http://localhost:3333}"
ABS_A="${ABS_A:-http://localhost:13378}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$(dirname "$HERE")/config/shelfmerge.yaml"
j() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

ADAM_A="$(python3 - "$CFG" <<'EOF'
import sys,re
s=open(sys.argv[1]).read()
m=re.search(r'adam:\n(?:.*\n)*?\s+accounts:\n\s+a:\s*(\S+)', s)
print(m.group(1) if m else '')
EOF
)"
[ -n "$ADAM_A" ] || fail "config has no accounts.a for adam (run scripts/dev-up.sh)"
up=(-H "authorization: Bearer $ADAM_A" -H 'content-type: application/json')
T="$(curl -fsS -X POST "$SM/login" -H 'content-type: application/json' -d '{"username":"adam","password":"adam"}' | j 'd["user"]["accessToken"]')"
auth=(-H "authorization: Bearer $T" -H 'content-type: application/json')
LIBS="$(curl -fsS "${auth[@]}" "$SM/api/libraries")"
A="$(echo "$LIBS" | j '[l["id"] for l in d["libraries"] if l["name"].startswith("Dev A")][0]')"
WALK="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$A/items?limit=0&minified=1" | j '[i["id"] for i in d["results"] if i["media"]["metadata"]["title"]=="Long Walk"][0]')"
clear_upstream() { for id in $(curl -fsS "${up[@]}" "$ABS_A/api/me" | j '" ".join(m["id"] for m in d["mediaProgress"])'); do curl -fsS "${up[@]}" -X DELETE "$ABS_A/api/me/progress/$id" -o /dev/null; done; }
clear_local() { mp="$(curl -sS "${auth[@]}" "$SM/api/me/progress/$WALK" | j 'd.get("id","")' 2>/dev/null || true)"; [ -n "$mp" ] && curl -fsS "${auth[@]}" -X DELETE "$SM/api/me/progress/$mp" -o /dev/null || true; }
clear_upstream; clear_local

step "playback through ShelfMerge is credited to adam's own account on A"
S="$(curl -fsS "${auth[@]}" -X POST "$SM/api/items/$WALK/play" -d '{"deviceInfo":{"clientName":"smoke","deviceId":"smoke-acct"},"mediaPlayer":"html5","forceDirectPlay":true}')"
SID="$(echo "$S" | j 'd["id"]')"
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/sync" -d '{"currentTime":200,"timeListened":20,"duration":1800}' -o /dev/null
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/close" -o /dev/null
curl -fsS "${up[@]}" "$ABS_A/api/me" | j '"upstream adam progress:", [(m["libraryItemId"][:8], m["currentTime"]) for m in d["mediaProgress"]]'
[ "$(curl -fsS "${up[@]}" "$ABS_A/api/me" | j 'int([m["currentTime"] for m in d["mediaProgress"] if m["libraryItemId"]=="'"$WALK"'"][0])')" = "200" ] || fail "upstream account did not get the session progress"
curl -fsS "${up[@]}" "$ABS_A/api/me/listening-sessions" | j '"upstream listening sessions for adam:", d["total"]'

step "manual progress edit in ShelfMerge is written through"
curl -fsS "${auth[@]}" -X PATCH "$SM/api/me/progress/$WALK" -d '{"isFinished":true}' -o /dev/null
sleep 1
curl -fsS "${up[@]}" "$ABS_A/api/me" | j '"upstream isFinished:", [m["isFinished"] for m in d["mediaProgress"] if m["libraryItemId"]=="'"$WALK"'"]'

step "native listening on A flows back into ShelfMerge"
# Unfinishing resets the position upstream, so set the position in a second call as a player would.
curl -fsS "${up[@]}" -X PATCH "$ABS_A/api/me/progress/$WALK" -d '{"isFinished":false}' -o /dev/null
sleep 1
curl -fsS "${up[@]}" -X PATCH "$ABS_A/api/me/progress/$WALK" -d '{"currentTime":777,"duration":1800,"progress":0.43}' -o /dev/null
sleep 1
curl -fsS "${auth[@]}" -X POST "$SM/api/authorize" | j '"after authorize, ShelfMerge currentTime:", [m["currentTime"] for m in d["user"]["mediaProgress"] if m["libraryItemId"]=="'"$WALK"'"]'
[ "$(curl -fsS "${auth[@]}" "$SM/api/me/progress/$WALK" | j 'int(d["currentTime"])')" = "777" ] || fail "native progress did not flow back"

step "server B (no mapping) still uses the service account"
B="$(echo "$LIBS" | j '[l["id"] for l in d["libraries"] if l["name"].startswith("Dev B")][0]')"
curl -fsS "${auth[@]}" "$SM/api/libraries/$B/items?limit=1" | j '"B items reachable:", d["total"] > 0'

step "login rate limit"
for i in $(seq 1 25); do code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SM/login" -H 'content-type: application/json' -d '{"username":"nobody","password":"x"}')"; [ "$code" = "429" ] && break; done
echo "status after $i bad attempts: $code"
[ "$code" = "429" ] || fail "rate limit never triggered"

clear_upstream; clear_local
echo; echo "ACCOUNTS OK"
