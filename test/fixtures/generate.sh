#!/usr/bin/env bash
# Generates a small synthetic audiobook library for tests.
# Uses the ffmpeg shipped inside the Audiobookshelf image, so nothing needs
# to be installed on the host. Output: test/fixtures/generated/<library>/Author/Title/...
#
# Books (all audio is sine tones, tagged like real files; long enough that the
# players' sync intervals and the "finished when <10 s remain" rule behave as
# they would with real books):
#   Books/Jane Doe/Short Stories/Short Stories.m4b        30 min m4b with 3 chapters
#   Books/Jane Doe/Long Walk/Long Walk - 01.mp3 .. 03     3 x 10 min multi-file mp3 book
#   Books/John Roe/The Sequel (Series Name #2)/book.m4b   20 min, series + sequence in folder name
#   Books/John Roe/Long Walk/Long Walk.mp3                15 min, same title as Jane Doe's for duplicate tests
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/generated"
IMAGE="${ABS_IMAGE:-advplyr/audiobookshelf:2.37.1}"

# Clear contents rather than removing the directory: it may be bind-mounted
# into the dev container, and removing it would break the mount.
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -delete

# Everything runs inside one container invocation so it is fast.
docker run --rm --entrypoint sh -v "$OUT:/out" "$IMAGE" -c '
set -e
tone() { # tone <seconds> <freq> <out> [extra ffmpeg args...]
  secs=$1; freq=$2; out=$3; shift 3
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=$freq:duration=$secs" "$@" "$out"
}

# 1. Single m4b with chapters
d=/out/Books/"Jane Doe"/"Short Stories"; mkdir -p "$d"
cat > /tmp/chapters.txt <<EOF
;FFMETADATA1
title=Short Stories
artist=Jane Doe
album=Short Stories
composer=Narrator One
genre=Fiction
date=2001
[CHAPTER]
TIMEBASE=1/1000
START=0
END=600000
title=Chapter One
[CHAPTER]
TIMEBASE=1/1000
START=600000
END=1200000
title=Chapter Two
[CHAPTER]
TIMEBASE=1/1000
START=1200000
END=1800000
title=Chapter Three
EOF
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=1800" -i /tmp/chapters.txt -map_metadata 1 -c:a aac -b:a 32k "$d/Short Stories.m4b"

# 2. Multi-file mp3 book
d=/out/Books/"Jane Doe"/"Long Walk"; mkdir -p "$d"
for i in 1 2 3; do
  tone 600 $((300 + i * 100)) "$d/Long Walk - 0$i.mp3" -c:a libmp3lame -b:a 32k \
    -metadata title="Part $i" -metadata artist="Jane Doe" -metadata album="Long Walk" \
    -metadata composer="Narrator Two" -metadata track="$i/3" -metadata date=2010
done

# 3. Series book
d=/out/Books/"John Roe"/"The Sequel (Series Name #2)"; mkdir -p "$d"
tone 1200 500 "$d/book.m4b" -c:a aac -b:a 32k \
  -metadata title="The Sequel" -metadata artist="John Roe" -metadata album="The Sequel" \
  -metadata composer="Narrator One" -metadata date=2015

# 4. Duplicate title by a different author (for duplicate detection later)
d=/out/Books/"John Roe"/"Long Walk"; mkdir -p "$d"
tone 900 600 "$d/Long Walk.mp3" -c:a libmp3lame -b:a 32k \
  -metadata title="Long Walk" -metadata artist="John Roe" -metadata album="Long Walk" -metadata date=2020

chown -R '"$(id -u):$(id -g)"' /out
ls -R /out
'
