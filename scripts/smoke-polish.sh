#!/usr/bin/env bash
# Listening history, stats, collections, playlists, series progress,
# continue-series, write blocking and config reload. Needs the two-server
# dev stack and a running ShelfMerge.
set -euo pipefail
SM="${SM:-http://localhost:3333}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$(dirname "$HERE")/config/shelfmerge.yaml"
j() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
login() { curl -fsS -X POST "$SM/login" -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" | j 'd["user"]["accessToken"]'; }
T="$(login adam adam)"; auth=(-H "authorization: Bearer $T" -H 'content-type: application/json')

LIBS="$(curl -fsS "${auth[@]}" "$SM/api/libraries")"
LIB_A="$(echo "$LIBS" | j '[l["id"] for l in d["libraries"] if l["name"].startswith("Dev A")][0]')"
LIB_B="$(echo "$LIBS" | j '[l["id"] for l in d["libraries"] if l["name"].startswith("Dev B")][0]')"
ITEMS_A="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_A/items?limit=0&minified=1")"
ITEMS_B="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/items?limit=0&minified=1")"
pick() { echo "$1" | j '[i["id"] for i in d["results"] if i["media"]["metadata"]["title"]=="'"$2"'"][0]'; }
SHORT_A="$(pick "$ITEMS_A" "Short Stories")"; SEQUEL_A="$(pick "$ITEMS_A" "The Sequel")"; WALK_A="$(pick "$ITEMS_A" "Long Walk")"
ONE_B="$(pick "$ITEMS_B" "Another One")"; TWO_B="$(pick "$ITEMS_B" "Another Two")"; OTHER_B="$(pick "$ITEMS_B" "Other Book")"

step "upstream writes are refused, playback is not"
curl -sS -o /dev/null -w "PATCH item media: %{http_code}\n" "${auth[@]}" -X PATCH "$SM/api/items/$SHORT_A/media" -d '{"metadata":{"title":"Hacked"}}'
curl -sS -o /dev/null -w "POST library scan: %{http_code}\n" "${auth[@]}" -X POST "$SM/api/libraries/$LIB_A/scan"
S="$(curl -fsS "${auth[@]}" -X POST "$SM/api/items/$SHORT_A/play" -d '{"deviceInfo":{"clientName":"smoke","deviceId":"smoke-p"},"mediaPlayer":"html5","forceDirectPlay":true}')"
SID="$(echo "$S" | j 'd["id"]')"; echo "play: ok (session $SID)"

step "listening history from syncs"
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/sync" -d '{"currentTime":120,"timeListened":45,"duration":1800}' -o /dev/null
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/sync" -d '{"currentTime":150,"timeListened":30,"duration":1800}' -o /dev/null
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/close" -d '{"currentTime":160,"timeListened":10,"duration":1800}' -o /dev/null
curl -fsS "${auth[@]}" "$SM/api/me/listening-sessions" | j '"sessions:", d["total"], "| first:", d["sessions"][0]["displayTitle"], "timeListening:", d["sessions"][0]["timeListening"], "currentTime:", d["sessions"][0]["currentTime"], "day:", d["sessions"][0]["dayOfWeek"]'
curl -fsS "${auth[@]}" "$SM/api/me/item/listening-sessions/$SHORT_A" | j '"item sessions:", d["total"]'
curl -fsS "${auth[@]}" "$SM/api/me/listening-stats" | j '"totalTime:", d["totalTime"], "today:", d["today"], "items:", list(d["items"].keys())[0][:8], "recent:", len(d["recentSessions"])'

step "offline session upload lands in history and progress"
NOW=$(python3 -c 'import time;print(int(time.time()*1000))')
curl -fsS "${auth[@]}" -X POST "$SM/api/session/local" -d "{\"id\":\"local-smoke-1\",\"libraryItemId\":\"$OTHER_B\",\"mediaType\":\"book\",\"displayTitle\":\"Other Book\",\"duration\":720,\"currentTime\":300,\"timeListening\":200,\"startedAt\":$((NOW-300000)),\"updatedAt\":$NOW,\"mediaMetadata\":{\"authors\":[{\"name\":\"Mary Major\"}],\"narrators\":[\"Narrator Two\"],\"genres\":[\"Fiction\"]}}" -o /dev/null -w "local sync: %{http_code}\n"
curl -fsS "${auth[@]}" "$SM/api/me/listening-stats" | j '"totalTime now:", d["totalTime"]'
curl -fsS "${auth[@]}" "$SM/api/me/progress/$OTHER_B" | j '"Other Book progress:", d["currentTime"]'

step "year in review"
curl -fsS "${auth[@]}" "$SM/api/me/stats/year/$(date +%Y)" | j '"sessions:", d["totalListeningSessions"], "time:", d["totalListeningTime"], "topAuthors:", d["topAuthors"], "narrator:", d["mostListenedNarrator"]'

step "series progress uses our store"
SERIES_B="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/series?limit=100" | j '[s["id"] for s in d["results"] if s["name"]=="Series Two"][0]')"
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/series/$SERIES_B?include=progress" | j '"books:", len(d["progress"]["libraryItemIds"]), "finished:", len(d["progress"]["libraryItemIdsFinished"])'
curl -fsS "${auth[@]}" -X PATCH "$SM/api/me/progress/$ONE_B" -d '{"isFinished":true}' -o /dev/null
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/series/$SERIES_B?include=progress" | j '"after finishing #1 -> finished:", len(d["progress"]["libraryItemIdsFinished"]), "isFinished:", d["progress"]["isFinished"]'

step "continue-series shelf"
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/personalized" | j '[(s["id"], [e["media"]["metadata"]["title"] for e in s["entities"]]) for s in d if s["id"] in ("continue-series","listen-again")]'

step "collections (shared, local, can span servers)"
C="$(curl -fsS "${auth[@]}" -X POST "$SM/api/collections" -d "{\"libraryId\":\"$LIB_A\",\"name\":\"Favourites\",\"books\":[\"$SHORT_A\",\"$SEQUEL_A\"]}")"
CID="$(echo "$C" | j 'd["id"]')"; echo "$C" | j '"created:", d["name"], [b["media"]["metadata"]["title"] for b in d["books"]]'
curl -fsS "${auth[@]}" -X POST "$SM/api/collections/$CID/book" -d "{\"id\":\"$WALK_A\"}" | j '"after add:", [b["media"]["metadata"]["title"] for b in d["books"]]'
curl -sS -o /dev/null -w "add book from other library: %{http_code}\n" "${auth[@]}" -X POST "$SM/api/collections/$CID/book" -d "{\"id\":\"$OTHER_B\"}"
curl -fsS "${auth[@]}" -X PATCH "$SM/api/collections/$CID" -d "{\"name\":\"Favourites!\",\"books\":[\"$WALK_A\",\"$SHORT_A\",\"$SEQUEL_A\"]}" | j '"renamed+reordered:", d["name"], [b["media"]["metadata"]["title"] for b in d["books"]]'
curl -fsS "${auth[@]}" -X DELETE "$SM/api/collections/$CID/book/$SEQUEL_A" | j '"after remove:", [b["media"]["metadata"]["title"] for b in d["books"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_A/collections" | j '"library A collections:", [(c["name"], len(c["books"])) for c in d["results"]], "total", d["total"]'
curl -fsS "${auth[@]}" "$SM/api/collections/$CID?include=rssfeed" | j '"detail:", d["name"], "rssFeed:", d["rssFeed"]'

step "playlists (per user)"
P="$(curl -fsS "${auth[@]}" -X POST "$SM/api/playlists" -d "{\"libraryId\":\"$LIB_B\",\"name\":\"Queue\",\"items\":[{\"libraryItemId\":\"$ONE_B\"}]}")"
PID="$(echo "$P" | j 'd["id"]')"; echo "$P" | j '"created:", d["name"], [i["libraryItem"]["media"]["metadata"]["title"] for i in d["items"]]'
curl -fsS "${auth[@]}" -X POST "$SM/api/playlists/$PID/batch/add" -d "{\"items\":[{\"libraryItemId\":\"$TWO_B\"},{\"libraryItemId\":\"$OTHER_B\"}]}" | j '"after batch add:", [i["libraryItem"]["media"]["metadata"]["title"] for i in d["items"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$LIB_B/playlists" | j '"library B playlists:", [(p["name"], len(p["items"])) for p in d["results"]]'
G="$(login guest guest)"; curl -sS -o /dev/null -w "guest reading adam's playlist: %{http_code}\n" -H "authorization: Bearer $G" "$SM/api/playlists/$PID"
curl -fsS "${auth[@]}" -X DELETE "$SM/api/playlists/$PID/item/$ONE_B" | j '"after remove:", [i["libraryItem"]["media"]["metadata"]["title"] for i in d["items"]]'
curl -fsS "${auth[@]}" -X POST "$SM/api/playlists/$PID/batch/remove" -d "{\"items\":[{\"libraryItemId\":\"$TWO_B\"},{\"libraryItemId\":\"$OTHER_B\"}]}" | j '"emptied -> items:", len(d["items"])'
curl -sS -o /dev/null -w "empty playlist auto-removed: %{http_code}\n" "${auth[@]}" "$SM/api/playlists/$PID"
P2="$(curl -fsS "${auth[@]}" -X POST "$SM/api/playlists/collection/$CID")"; echo "$P2" | j '"from collection:", d["name"], len(d["items"]), "items"'
curl -fsS "${auth[@]}" -X DELETE "$SM/api/playlists/$(echo "$P2" | j 'd["id"]')" -o /dev/null
curl -fsS "${auth[@]}" -X DELETE "$SM/api/collections/$CID" -o /dev/null -w "collection deleted: %{http_code}\n"

step "config hot reload: add a user, log in, remove"
cp "$CFG" "$CFG.bak"
printf '  reloadtest:\n    password: reloadpw\n' >> "$CFG"
for _ in $(seq 1 20); do sleep 0.5; curl -fsS -X POST "$SM/login" -H 'content-type: application/json' -d '{"username":"reloadtest","password":"reloadpw"}' -o /dev/null 2>/dev/null && break; done
curl -sS -o /dev/null -w "login as reloadtest: %{http_code}\n" -X POST "$SM/login" -H 'content-type: application/json' -d '{"username":"reloadtest","password":"reloadpw"}'
mv "$CFG.bak" "$CFG"

step "cleanup test progress"
for id in $SHORT_A $OTHER_B $ONE_B; do mp="$(curl -sS "${auth[@]}" "$SM/api/me/progress/$id" | j 'd.get("id","")' 2>/dev/null || true)"; [ -n "$mp" ] && curl -fsS "${auth[@]}" -X DELETE "$SM/api/me/progress/$mp" -o /dev/null; done
echo "done"

echo; echo "POLISH OK"
