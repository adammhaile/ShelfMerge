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
# Second server (Books-B):
#   Books-B/Jane Doe/Short Stories/Short Stories.m4b      same book as on A, different narrator
#   Books-B/Mary Major/Other Book/Other Book.mp3          12 min
#   Books-B/Mary Major/Another One (Series Two #1)/book.m4b  25 min
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
cover() { # cover <dir> <hex colour>: a flat-colour cover.jpg Audiobookshelf picks up from the folder
  ffmpeg -loglevel error -y -f lavfi -i "color=c=0x$2:s=600x900" -frames:v 1 "$1/cover.jpg"
}

# 1. Single m4b with chapters
d=/out/Books/"Jane Doe"/"Short Stories"; mkdir -p "$d"
cover "$d" 3355aa
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
cover "$d" aa5533
for i in 1 2 3; do
  tone 600 $((300 + i * 100)) "$d/Long Walk - 0$i.mp3" -c:a libmp3lame -b:a 32k \
    -metadata title="Part $i" -metadata artist="Jane Doe" -metadata album="Long Walk" \
    -metadata composer="Narrator Two" -metadata track="$i/3" -metadata date=2010
done

# 3. Series book
d=/out/Books/"John Roe"/"The Sequel (Series Name #2)"; mkdir -p "$d"
cover "$d" 55aa33
tone 1200 500 "$d/book.m4b" -c:a aac -b:a 32k \
  -metadata title="The Sequel" -metadata artist="John Roe" -metadata album="The Sequel" \
  -metadata composer="Narrator One" -metadata date=2015

# 4. Duplicate title by a different author (for duplicate detection later)
d=/out/Books/"John Roe"/"Long Walk"; mkdir -p "$d"
cover "$d" aa3399
tone 900 600 "$d/Long Walk.mp3" -c:a libmp3lame -b:a 32k \
  -metadata title="Long Walk" -metadata artist="John Roe" -metadata album="Long Walk" -metadata date=2020

# ---- Second server library (Books-B) ----
# 5. Same book as server A, different narrator: the "same book on two servers" case
d=/out/Books-B/"Jane Doe"/"Short Stories"; mkdir -p "$d"
cover "$d" 3399aa
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=330:duration=1800" -i /tmp/chapters.txt -map_metadata 1 \
  -metadata composer="Narrator Three" -c:a aac -b:a 32k "$d/Short Stories.m4b"

# 6. Books only on server B
d=/out/Books-B/"Mary Major"/"Other Book"; mkdir -p "$d"
cover "$d" aaaa33
tone 720 700 "$d/Other Book.mp3" -c:a libmp3lame -b:a 32k \
  -metadata title="Other Book" -metadata artist="Mary Major" -metadata album="Other Book" -metadata composer="Narrator Two" -metadata date=2018

d=/out/Books-B/"Mary Major"/"Another One (Series Two #1)"; mkdir -p "$d"
cover "$d" 777777
tone 1500 800 "$d/book.m4b" -c:a aac -b:a 32k \
  -metadata title="Another One" -metadata artist="Mary Major" -metadata album="Another One" -metadata date=2022

chown -R '"$(id -u):$(id -g)"' /out
ls -R /out
'
