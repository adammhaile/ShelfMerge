#!/usr/bin/env bash
# Merged ("Everything") library: list placement, items with sorting, paging,
# filters and collapsed series, search, filterdata, series, authors,
# narrators, stats, personalized shelves, relabelled item detail and
# playback, allow-lists. Needs the dev stack and a running ShelfMerge whose
# index has finished its first pull.
set -euo pipefail
SM="${SM:-http://localhost:3333}"
j() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
login() { curl -fsS -X POST "$SM/login" -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}"; }
b64() { python3 -c 'import sys,base64,urllib.parse;print(urllib.parse.quote(base64.b64encode(sys.argv[1].encode()).decode()))' "$1"; }

L="$(login adam adam)"; T="$(echo "$L" | j 'd["user"]["accessToken"]')"; auth=(-H "authorization: Bearer $T" -H 'content-type: application/json')

step "merged library is first and the default"
LIBS="$(curl -fsS "${auth[@]}" "$SM/api/libraries")"
echo "$LIBS" | j '[(l["name"], l["displayOrder"], l["icon"]) for l in d["libraries"]]'
M="$(echo "$LIBS" | j 'd["libraries"][0]["id"]')"
[ "$(echo "$LIBS" | j 'd["libraries"][0]["name"]')" = "Everything" ] || fail "merged library not first"
[ "$(echo "$L" | j 'd["userDefaultLibraryId"]')" = "$M" ] || fail "default library is not the merged one"
curl -fsS "${auth[@]}" "$SM/api/libraries/$M?include=filterdata" | j '"library:", d["library"]["name"], "| books:", d["filterdata"]["bookCount"], "authors:", len(d["filterdata"]["authors"]), "series:", len(d["filterdata"]["series"]), "narrators:", len(d["filterdata"]["narrators"]), "decades:", d["filterdata"]["publishedDecades"][:4]'

step "items: total, paging, sorts"
ALL="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?limit=0&minified=1&sort=media.metadata.title")"
echo "$ALL" | j '"total:", d["total"], "| all libraryId == merged:", all(i["libraryId"]=="'"$M"'" for i in d["results"]), "| first titles:", [i["media"]["metadata"]["title"][:22] for i in d["results"][:5]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?limit=5&page=1&sort=media.metadata.title" | j '"page 1 of 5:", [i["media"]["metadata"]["title"][:22] for i in d["results"]], "total", d["total"]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?limit=3&sort=media.duration&desc=1" | j '"longest:", [(i["media"]["metadata"]["title"][:20], round(i["media"]["duration"]/3600,1)) for i in d["results"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?limit=3&sort=addedAt&desc=1" | j '"newest:", [i["media"]["metadata"]["title"][:25] for i in d["results"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?limit=3&sort=media.metadata.authorNameLF" | j '"by author LF:", [i["media"]["metadata"]["authorNameLF"][:25] for i in d["results"]]'

step "title sort matches upstream (a real library when one is configured, else Dev A)"
H="$(echo "$LIBS" | j '([l["id"] for l in d["libraries"] if l["name"].startswith("Home")] or [l["id"] for l in d["libraries"] if l["name"].startswith("Dev A")])[0]')"
UP="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$H/items?limit=10&sort=media.metadata.title&minified=1" | j '[i["media"]["metadata"]["title"] for i in d["results"]]')"
MINE="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?limit=0&sort=media.metadata.title&minified=1" | j '[i["media"]["metadata"]["title"] for i in d["results"]]')"
python3 - "$UP" "$MINE" <<'PY'
import sys, ast
up, mine = ast.literal_eval(sys.argv[1]), ast.literal_eval(sys.argv[2])
sub = [t for t in mine if t in up][:len(up)]
print("identical order" if sub == up else f"ORDER DIFFERS\nupstream: {up}\nmerged:   {sub}")
PY

step "filters"
AUTHOR_ID="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$M/filterdata" | j '[a["id"] for a in d["authors"] if a["name"]=="Jane Doe"][0]')"
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?filter=authors.$(b64 "$AUTHOR_ID")&limit=0&minified=1" | j '"Jane Doe (both servers):", sorted(i["media"]["metadata"]["title"] for i in d["results"])'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?filter=narrators.$(b64 "Narrator Three")&limit=0" | j '"narrator three:", [i["media"]["metadata"]["title"] for i in d["results"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?filter=genres.$(b64 "Fiction")&limit=0" | j '"genre fiction:", d["total"]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?filter=series.$(b64 no-series)&limit=0" | j '"no series:", d["total"]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/playlists" | j '"playlists under merged:", d["total"]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?filter=missing.$(b64 cover)&limit=0" | j '"missing cover:", d["total"]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?filter=progress.$(b64 not-started)&limit=0" | j '"not started:", d["total"]'

step "series: list, detail, items filtered by series, collapsed"
SER="$(curl -fsS "${auth[@]}" "$SM/api/libraries/$M/series?limit=500&sort=name")"
echo "$SER" | j '"series:", d["total"], "| sample:", [(s["name"], len(s["books"])) for s in d["results"] if s["name"] in ("Series Name","Series Two")]'
S2="$(echo "$SER" | j '[s["id"] for s in d["results"] if s["name"]=="Series Two"][0]')"
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/series/$S2?include=progress" | j 'd["name"], "books:", len(d["progress"]["libraryItemIds"]), "libraryId == merged:", d["libraryId"]=="'"$M"'"'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?filter=series.$(b64 "$S2")&sort=sequence&limit=0" | j '"by sequence:", [(i["media"]["metadata"]["title"], i["series"]["sequence"]) for i in d["results"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/items?collapseseries=1&limit=0&sort=media.metadata.title" | j '"collapsed total:", d["total"], "| collapsed cards:", [(i["collapsedSeries"]["name"], i["collapsedSeries"]["numBooks"]) for i in d["results"] if "collapsedSeries" in i][:5]'

step "search / authors / narrators / stats"
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/search?q=short" | j '"books:", [b["libraryItem"]["media"]["metadata"]["title"] for b in d["book"]], "| series:", [s["series"]["name"] for s in d["series"]], "| authors:", [a["name"] for a in d["authors"]]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/authors" | j '"authors:", len(d["authors"]), "| Jane Doe numBooks (both servers):", [a["numBooks"] for a in d["authors"] if a["name"]=="Jane Doe"]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/narrators" | j '"narrators:", len(d["narrators"]), [n for n in d["narrators"] if n["name"].startswith("Narrator")][:3]'
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/stats" | j '"items:", d["totalItems"], "authors:", d["totalAuthors"], "hours:", round(d["totalDuration"]/3600), "top author:", d["authorsWithCount"][0]["name"]'

step "personalized shelves"
curl -fsS "${auth[@]}" "$SM/api/libraries/$M/personalized" | j '[(s["id"], len(s["entities"])) for s in d]'

step "item detail and playback are relabelled while browsing the merged library"
SHORT="$(echo "$ALL" | j '[i["id"] for i in d["results"] if i["media"]["metadata"]["title"]=="Short Stories"][0]')"
curl -fsS "${auth[@]}" "$SM/api/items/$SHORT?expanded=1" | j '"item libraryId == merged:", d["libraryId"]=="'"$M"'"'
S="$(curl -fsS "${auth[@]}" -X POST "$SM/api/items/$SHORT/play" -d '{"deviceInfo":{"clientName":"smoke","deviceId":"smoke-m"},"mediaPlayer":"html5","forceDirectPlay":true}')"
echo "$S" | j '"session libraryId == merged:", d["libraryId"]=="'"$M"'", "| playMethod:", d["playMethod"]'
curl -fsS "${auth[@]}" -X POST "$SM/api/session/$(echo "$S" | j 'd["id"]')/close" -o /dev/null
A="$(echo "$LIBS" | j '[l["id"] for l in d["libraries"] if l["name"].startswith("Dev A")][0]')"
curl -fsS "${auth[@]}" "$SM/api/libraries/$A/items?limit=1" -o /dev/null
curl -fsS "${auth[@]}" "$SM/api/items/$SHORT" | j '"after browsing Dev A, item libraryId == Dev A:", d["libraryId"]=="'"$A"'"'

step "allow-list and refusals"
curl -fsS "$SM/api/libraries" -H "authorization: Bearer $(login guest guest | j 'd["user"]["accessToken"]')" | j '"guest sees:", [l["name"] for l in d["libraries"]]'
curl -sS -o /dev/null -w "scan on merged: %{http_code}\n" "${auth[@]}" -X POST "$SM/api/libraries/$M/scan"
curl -sS -o /dev/null -w "download on merged: %{http_code}\n" "${auth[@]}" "$SM/api/libraries/$M/download"

echo; echo "MERGED OK"
