#!/usr/bin/env bash
# Federation smoke test: needs the two-server dev stack (scripts/dev-up.sh)
# and ShelfMerge running with the config it wrote.
set -euo pipefail
SM="${SM:-http://localhost:3333}"
j() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
login() { curl -fsS -X POST "$SM/login" -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" | j 'd["user"]["accessToken"]'; }

T="$(login adam adam)"; auth=(-H "authorization: Bearer $T")
G="$(login guest guest)"; gauth=(-H "authorization: Bearer $G")

step "adam sees both servers' libraries, prefixed and renumbered"
LIBS="$(curl -fsS "${auth[@]}" "$SM/api/libraries")"
echo "$LIBS" | j '[(l["name"], l["displayOrder"]) for l in d["libraries"]]'
[ "$(echo "$LIBS" | j 'len(d["libraries"])')" = "2" ] || fail "expected 2 libraries"
LIB_A="$(echo "$LIBS" | j '[l["id"] for l in d["libraries"] if l["name"].startswith("Dev A")][0]')"
LIB_B="$(echo "$LIBS" | j '[l["id"] for l in d["libraries"] if l["name"].startswith("Dev B")][0]')"

step "guest is limited to a:Books"
curl -fsS "${gauth[@]}" "$SM/api/libraries" | j '[l["name"] for l in d["libraries"]]'
curl -sS -o /dev/null -w "guest -> library B: %{http_code}\n" "${gauth[@]}" "$SM/api/libraries/$LIB_B/items"
curl -fsS -X POST "$SM/login" -H 'content-type: application/json' -d '{"username":"guest","password":"guest"}' | j '"guest default library is A:", d["userDefaultLibraryId"] == "'"$LIB_A"'"'

step "library detail keeps the prefixed name"
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B?include=filterdata" | j 'd["library"]["name"], "filterdata authors:", [a["name"] for a in d["filterdata"]["authors"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B" | j '"plain:", d["name"], d["displayOrder"]'

step "items on server B"
ITEMS_B="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/items?limit=0&minified=1")"
echo "$ITEMS_B" | j 'sorted(i["media"]["metadata"]["title"] for i in d["results"])'
ITEM_B="$(echo "$ITEMS_B" | j '[i for i in d["results"] if i["media"]["metadata"]["title"]=="Other Book"][0]["id"]')"
curl -fsS "${auth[@]}" "$SM/api/items/$ITEM_B?expanded=1" | j 'd["media"]["metadata"]["title"], "narrator:", d["media"]["metadata"]["narratorName"], "libraryId matches B:", d["libraryId"] == "'"$LIB_B"'"'

step "play on B, ranged read, sync, progress"
SESSION="$(curl -fsS "${auth[@]}" -X POST "$SM/api/items/$ITEM_B/play" -H 'content-type: application/json' -d '{"deviceInfo":{"clientName":"smoke","deviceId":"smoke-b"},"mediaPlayer":"html5","forceDirectPlay":true}')"
SID="$(echo "$SESSION" | j 'd["id"]')"
TRACK="$(echo "$SESSION" | j 'd["audioTracks"][0]["contentUrl"]')"
echo "$SESSION" | j '"playMethod:", d["playMethod"], "title:", d["displayTitle"]'
curl -sS -o /dev/null -D - -H 'range: bytes=100-199' "$SM$TRACK?token=$T" | grep -iE "^HTTP|content-range" | tr -d '\r'
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/sync" -H 'content-type: application/json' -d '{"currentTime":90,"timeListened":30,"duration":720}' -o /dev/null
curl -fsS "${auth[@]}" "$SM/api/me/progress/$ITEM_B" | j '"currentTime:", d["currentTime"], "progress:", round(d["progress"],3)'
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/close" -o /dev/null

step "continue-listening on B, items-in-progress across servers"
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/personalized" | j '[(s["id"], [e["media"]["metadata"]["title"] for e in s["entities"]]) for s in d if s["id"]=="continue-listening"]'
curl -fsS "${auth[@]}" "$SM/api/me/items-in-progress" | j '"in progress:", [i["media"]["metadata"]["title"] for i in d["libraryItems"]]'

step "merged server-wide lists and per-library data"
curl -fsS "${auth[@]}" "$SM/api/collections" | j '"collections:", len(d["collections"])'
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/filterdata" | j '"B genres:", d["genres"], "narrators:", d["narrators"]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/search?q=another" | j '"search on B:", [b["libraryItem"]["media"]["metadata"]["title"] for b in d["book"]]'

step "unknown id is probed across servers (cover is unauthenticated and streamed)"
node -e "const D=require('better-sqlite3');const db=new D('data/shelfmerge.db');console.log('forgot id map rows:', db.prepare('DELETE FROM id_map WHERE id = ?').run('$ITEM_B').changes)"
curl -sS -o /dev/null -w "cover after forgetting: %{http_code} %{content_type}\n" "$SM/api/items/$ITEM_B/cover"
curl -fsS "${auth[@]}" "$SM/api/items/$ITEM_B" | j '"item after forgetting:", d["media"]["metadata"]["title"]'

echo; echo "MULTI OK"
