#!/usr/bin/env bash
# End-to-end smoke test against a running ShelfMerge (default :3333) that
# fronts the dev Audiobookshelf. Exercises the flows the web and mobile
# clients use: login (both token flows), browse, item detail, play, sync,
# progress, personalized shelves, cover, ranged file read, refresh, logout.
set -euo pipefail
SM="${SM:-http://localhost:3333}"
USER="${SM_USER:-adam}"
PASS="${SM_PASS:-adam}"
j() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

step "status"
curl -fsS "$SM/status" | j 'd["serverVersion"], d["isInit"]'

step "login (cookie flow, like the web client)"
LOGIN="$(curl -fsS -c /tmp/sm-cookies -X POST "$SM/login" -H 'content-type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}")"
TOKEN="$(echo "$LOGIN" | j 'd["user"]["accessToken"]')"
echo "$LOGIN" | j 'd["user"]["username"], d["user"]["type"], "refreshToken in body:", d["user"]["refreshToken"] is not None, "defaultLib:", d["userDefaultLibraryId"]'
grep -q refresh_token /tmp/sm-cookies || fail "no refresh cookie"
auth=(-H "authorization: Bearer $TOKEN")

step "login (x-return-tokens, like the mobile apps)"
MLOGIN="$(curl -fsS -X POST "$SM/login" -H 'content-type: application/json' -H 'x-return-tokens: true' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}")"
REFRESH="$(echo "$MLOGIN" | j 'd["user"]["refreshToken"]')"
[ "$REFRESH" != "None" ] || fail "mobile login returned no refresh token"
echo "refresh token returned in body: yes"

step "authorize + me"
curl -fsS "${auth[@]}" -X POST "$SM/api/authorize" | j 'd["user"]["username"], len(d["serverSettings"]) > 10'
curl -fsS "${auth[@]}" "$SM/api/me" | j 'd["id"], d["permissions"]["update"]'

step "libraries + items"
LIB="$(curl -fsS "${auth[@]}" "$SM/api/libraries" | j 'd["libraries"][0]["id"]')"
ITEMS="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB/items?limit=0&minified=1")"
echo "$ITEMS" | j 'd["total"], sorted(i["media"]["metadata"]["title"] for i in d["results"])'
ITEM="$(echo "$ITEMS" | j '[i for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories"][0]["id"]')"

step "item detail with progress (none yet)"
curl -fsS "${auth[@]}" "$SM/api/items/$ITEM?expanded=1&include=progress" | j 'd["media"]["metadata"]["title"], "chapters:", len(d["media"]["chapters"]), "progress:", d["userMediaProgress"]'

step "play"
SESSION="$(curl -fsS "${auth[@]}" -X POST "$SM/api/items/$ITEM/play" -H 'content-type: application/json' \
  -d '{"deviceInfo":{"clientName":"smoke","deviceId":"smoke-1"},"supportedMimeTypes":["audio/mpeg","audio/mp4"],"mediaPlayer":"html5","forceDirectPlay":true}')"
SID="$(echo "$SESSION" | j 'd["id"]')"
echo "$SESSION" | j 'd["playMethod"], d["userId"], d["startTime"], [t["contentUrl"] for t in d["audioTracks"]]'
TRACK="$(echo "$SESSION" | j 'd["audioTracks"][0]["contentUrl"]')"

step "ranged read of the audio track through the proxy (?token= like the mobile app)"
curl -sS -o /dev/null -D - -H 'range: bytes=0-99' "$SM$TRACK?token=$TOKEN" | grep -iE "^HTTP|content-range|content-length|content-type" | tr -d '\r'

step "sync 5.5s into the book"
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/sync" -H 'content-type: application/json' -d '{"currentTime":5.5,"timeListened":5,"duration":12}' -o /dev/null -w "sync %{http_code}\n"

step "progress now visible"
curl -fsS "${auth[@]}" "$SM/api/me/progress/$ITEM" | j 'd["currentTime"], round(d["progress"],3), d["isFinished"], d["mediaItemType"]'
curl -fsS "${auth[@]}" "$SM/api/items/$ITEM?include=progress" | j '"item detail progress:", d["userMediaProgress"]["currentTime"]'
curl -fsS "${auth[@]}" "$SM/api/me" | j '"me.mediaProgress:", len(d["mediaProgress"])'
curl -fsS "${auth[@]}" "$SM/api/me/items-in-progress" | j '"in progress:", [i["media"]["metadata"]["title"] for i in d["libraryItems"]]'

step "personalized shelves"
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB/personalized" | j '[(s["id"], len(s["entities"])) for s in d]'

step "play again resumes from our progress"
curl -fsS "${auth[@]}" -X POST "$SM/api/items/$ITEM/play" -H 'content-type: application/json' \
  -d '{"deviceInfo":{"clientName":"smoke","deviceId":"smoke-1"},"mediaPlayer":"html5","forceDirectPlay":true}' | j '"startTime:", d["startTime"]'

step "close session near the end -> auto finished"
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/close" -H 'content-type: application/json' -d '{"currentTime":11.5,"timeListened":6,"duration":12}' -o /dev/null -w "close %{http_code}\n"
curl -fsS "${auth[@]}" "$SM/api/me/progress/$ITEM" | j '"finished:", d["isFinished"], "progress:", d["progress"]'

step "bookmark"
curl -fsS "${auth[@]}" -X POST "$SM/api/me/item/$ITEM/bookmark" -H 'content-type: application/json' -d '{"time":3,"title":"good bit"}' | j 'd["title"], d["time"]'

step "cover without auth, as <img> tags do"
curl -sS -o /dev/null -w "cover %{http_code} %{content_type}\n" "$SM/api/items/$ITEM/cover"

step "search + filterdata + series + authors (plain forwards)"
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB/search?q=walk" | j '[b["libraryItem"]["media"]["metadata"]["title"] for b in d["book"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB/filterdata" | j '[a["name"] for a in d["authors"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB/series" | j '[s["name"] for s in d["results"]]'

step "refresh via header (mobile) and cookie (web)"
curl -fsS -X POST "$SM/auth/refresh" -H "x-refresh-token: $REFRESH" | j '"new access token:", len(d["user"]["accessToken"]) > 20, "refresh returned:", d["user"]["refreshToken"] is not None'
curl -fsS -b /tmp/sm-cookies -c /tmp/sm-cookies -X POST "$SM/auth/refresh" | j '"cookie refresh ok:", d["user"]["refreshToken"] is None'

step "logout"
curl -fsS -b /tmp/sm-cookies -X POST "$SM/logout" | j 'd'
curl -sS -b /tmp/sm-cookies -o /dev/null -w "refresh after logout: %{http_code}\n" -X POST "$SM/auth/refresh"

step "unauthenticated api call"
curl -sS -o /dev/null -w "no token: %{http_code}\n" "$SM/api/libraries"

echo; echo "SMOKE OK"
