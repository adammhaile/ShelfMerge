#!/usr/bin/env bash
# Initializes a fresh Audiobookshelf dev server (from docker-compose.dev.yml):
# root user, one book library on /audiobooks, a scan, and a "shelfmerge"
# service user with an API key. Idempotent. Prints the API key on the last
# line as `API_KEY=<key>` so dev-up.sh can collect it.
#
# Usage: scripts/seed-abs.sh <base-url> <library-name> <expected-item-count>
set -euo pipefail

ABS="${1:?base url}"
LIB_NAME="${2:-Books}"
EXPECT="${3:-1}"
ROOT_USER="root"
ROOT_PASS="rootpass"
SVC_USER="shelfmerge"
SVC_PASS="shelfmergepass"

json() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

echo "[$ABS] waiting ..." >&2
for _ in $(seq 1 60); do
  if curl -fsS "$ABS/status" >/dev/null 2>&1; then break; fi
  sleep 1
done

if [ "$(curl -fsS "$ABS/status" | json 'd["isInit"]')" = "False" ]; then
  echo "[$ABS] initializing root user" >&2
  curl -fsS -X POST "$ABS/init" -H 'content-type: application/json' \
    -d "{\"newRoot\":{\"username\":\"$ROOT_USER\",\"password\":\"$ROOT_PASS\"}}" >/dev/null
fi

TOKEN="$(curl -fsS -X POST "$ABS/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$ROOT_USER\",\"password\":\"$ROOT_PASS\"}" | json 'd["user"]["accessToken"]')"
auth=(-H "authorization: Bearer $TOKEN")

LIBS="$(curl -fsS "${auth[@]}" "$ABS/api/libraries")"
if [ "$(echo "$LIBS" | json 'len(d["libraries"])')" = "0" ]; then
  echo "[$ABS] creating library $LIB_NAME" >&2
  curl -fsS "${auth[@]}" -X POST "$ABS/api/libraries" -H 'content-type: application/json' \
    -d "{\"name\":\"$LIB_NAME\",\"mediaType\":\"book\",\"provider\":\"audible\",\"folders\":[{\"fullPath\":\"/audiobooks\"}]}" >/dev/null
  LIBS="$(curl -fsS "${auth[@]}" "$ABS/api/libraries")"
fi
LIB_ID="$(echo "$LIBS" | json 'd["libraries"][0]["id"]')"

curl -fsS "${auth[@]}" -X POST "$ABS/api/libraries/$LIB_ID/scan?force=1" >/dev/null
for _ in $(seq 1 60); do
  n="$(curl -fsS "${auth[@]}" "$ABS/api/libraries/$LIB_ID/items?limit=0&minified=1" | json 'd["total"]')"
  [ "$n" -ge "$EXPECT" ] && break
  sleep 1
done
echo "[$ABS] library $LIB_ID has $n items" >&2

USERS="$(curl -fsS "${auth[@]}" "$ABS/api/users")"
SVC_ID="$(echo "$USERS" | json '"".join(u["id"] for u in d["users"] if u["username"]=="'"$SVC_USER"'")')"
if [ -z "$SVC_ID" ]; then
  echo "[$ABS] creating service user $SVC_USER" >&2
  SVC_ID="$(curl -fsS "${auth[@]}" -X POST "$ABS/api/users" -H 'content-type: application/json' \
    -d "{\"username\":\"$SVC_USER\",\"password\":\"$SVC_PASS\",\"type\":\"user\",\"isActive\":true,\"permissions\":{\"download\":true,\"update\":false,\"delete\":false,\"upload\":false,\"accessAllLibraries\":true,\"accessAllTags\":true,\"accessExplicitContent\":true,\"createEreader\":false}}" \
    | json 'd["user"]["id"]')"
fi

API_KEY="$(curl -fsS "${auth[@]}" -X POST "$ABS/api/api-keys" -H 'content-type: application/json' \
  -d "{\"name\":\"shelfmerge-dev-$(date +%s)\",\"userId\":\"$SVC_ID\",\"isActive\":true}" | json 'd["apiKey"]["apiKey"]')"
echo "API_KEY=$API_KEY"
