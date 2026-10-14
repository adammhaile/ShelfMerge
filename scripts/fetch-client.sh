#!/usr/bin/env bash
# Copies the built Audiobookshelf web client out of the official image into
# ./client-dist for local development. The Docker build does the same thing
# with a COPY --from stage.
set -euo pipefail
VERSION="${1:-2.37.1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(dirname "$HERE")/client-dist"

id="$(docker create "advplyr/audiobookshelf:$VERSION")"
trap 'docker rm -f "$id" >/dev/null' EXIT
rm -rf "$OUT"
docker cp "$id:/app/client/dist" "$OUT"
echo "Web client $VERSION copied to $OUT"
