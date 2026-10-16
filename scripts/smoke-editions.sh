#!/usr/bin/env bash
# Edition collapsing in the merged library. "Short Stories" by Jane Doe exists
# on dev servers A and B (different narrators, same length); it must show
# once, list its alternate, link to it from the item page, carry progress
# over on first play of the other edition, and split again with keepSeparate.
set -euo pipefail
SM="${SM:-http://localhost:3333}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$(dirname "$HERE")/config/shelfmerge.yaml"
j() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
T="$(curl -fsS -X POST "$SM/login" -H 'content-type: application/json' -d '{"username":"adam","password":"adam"}' | j 'd["user"]["accessToken"]')"
auth=(-H "authorization: Bearer $T" -H 'content-type: application/json')
LIBS="$(curl -fsS "${auth[@]}" "$SM/api/libraries")"
M="$(echo "$LIBS" | j 'd["libraries"][0]["id"]')"
A="$(echo "$LIBS" | j '[l["id"] for l in d["libraries"] if l["name"].startswith("Dev A")][0]')"
B="$(echo "$LIBS" | j '[l["id"] for l in d["libraries"] if l["name"].startswith("Dev B")][0]')"
SHORT_A="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$A/items?limit=0&minified=1" | j '[i["id"] for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories"][0]')"
SHORT_B="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$B/items?limit=0&minified=1" | j '[i["id"] for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories"][0]')"
cleanup() { for id in $SHORT_A $SHORT_B; do mp="$(curl -sS "${auth[@]}" "$SM/api/me/progress/$id" | j 'd.get("id","")' 2>/dev/null || true)"; [ -n "$mp" ] && curl -fsS "${auth[@]}" -X DELETE "$SM/api/me/progress/$mp" -o /dev/null || true; done; }
cleanup

step "one card for the duplicated book, alternates attached"
ITEMS="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?limit=0&minified=1")"
echo "$ITEMS" | j '"Short Stories cards:", sum(1 for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories"), "| total:", d["total"]'
[ "$(echo "$ITEMS" | j 'sum(1 for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories")')" = "1" ] || fail "expected one Short Stories card"
SHOWN="$(echo "$ITEMS" | j '[i for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories"][0]["id"]')"
echo "$ITEMS" | j '[(i["id"]=="'"$SHORT_A"'" and "A" or "B", i["editions"]["count"], [(a["serverKey"], a["narratorName"], a["duration"]) for a in i["editions"]["alternates"]]) for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories"]'
[ "$SHOWN" = "$SHORT_A" ] || fail "preferred edition should be server A (first in config)"
echo "Long Walk cards (different authors, must stay apart): $(echo "$ITEMS" | j 'sum(1 for i in d["results"] if i["media"]["metadata"]["title"]=="Long Walk")')"

step "search, author page and series books also collapse"
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/search?q=short%20stories" | j '"search hits:", [b["libraryItem"]["media"]["metadata"]["title"] for b in d["book"]]'
JD="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$M/filterdata" | j '[a["id"] for a in d["authors"] if a["name"]=="Jane Doe"][0]')"
curl -fsS "${auth[@]}" "$SM/api/authors/$JD?include=items" | j '"Jane Doe books:", sorted(li["media"]["metadata"]["title"] for li in d["libraryItems"])'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/filterdata" | j '"bookCount:", d["bookCount"]'

step "item page lists the other edition with a link"
curl -fsS "${auth[@]}" "$SM/api/items/$SHORT_A?expanded=1" | j '"description tail:", d["media"]["metadata"]["description"][-160:]'
curl -fsS "${auth[@]}" "$SM/api/items/$SHORT_A?expanded=1" | B="$SHORT_B" python3 -I -c 'import json,os,sys; d=json.load(sys.stdin); desc=d["media"]["metadata"]["description"]; assert "Other editions" in desc and ('href="/item/' + os.environ["B"] + '"') in desc, desc; print("link to B edition present")'
curl -fsS "${auth[@]}" "$SM/api/items/$SHORT_B?expanded=1" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); desc=d["media"]["metadata"]["description"]; assert "(shown in library)" in desc, desc; print("hidden edition page points at the shown one")'

step "progress carries over to the other edition on first play"
S="$(curl -fsS "${auth[@]}" -X POST "$SM/api/items/$SHORT_A/play" -d '{"deviceInfo":{"clientName":"smoke","deviceId":"smoke-e"},"mediaPlayer":"html5","forceDirectPlay":true}')"
SID="$(echo "$S" | j 'd["id"]')"
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/sync" -d '{"currentTime":300,"timeListened":30,"duration":1800}' -o /dev/null
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$SID/close" -o /dev/null
S2="$(curl -fsS "${auth[@]}" -X POST "$SM/api/items/$SHORT_B/play" -d '{"deviceInfo":{"clientName":"smoke","deviceId":"smoke-e"},"mediaPlayer":"html5","forceDirectPlay":true}')"
echo "$S2" | j '"B edition starts at:", d["startTime"]'
[ "$(echo "$S2" | j 'int(d["startTime"])')" = "300" ] || fail "progress not seeded"
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$(echo "$S2" | j 'd["id"]')/close" -o /dev/null
cleanup

step "keepSeparate pins a pair apart (config hot reload)"
cp "$CFG" "$CFG.bak"
python3 - "$CFG" "$SHORT_B" <<'EOF'
import sys
p, item = sys.argv[1], sys.argv[2]
s = open(p).read()
s += f"\nmerged:\n  - name: Everything\n    mediaType: book\n    sources: ['*']\n    keepSeparate: [{item}]\n"
open(p, 'w').write(s)
EOF
for _ in $(seq 1 20); do sleep 0.5; n="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?limit=0&minified=1" | j 'sum(1 for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories")')"; [ "$n" = "2" ] && break; done
echo "Short Stories cards with keepSeparate: $n"
mv "$CFG.bak" "$CFG"
for _ in $(seq 1 20); do sleep 0.5; n="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?limit=0&minified=1" | j 'sum(1 for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories")')"; [ "$n" = "1" ] && break; done
echo "after restoring config: $n"
[ "$n" = "1" ] || fail "collapse did not resume after config restore"

echo; echo "EDITIONS OK"
