# ShelfMerge

A federating proxy for [Audiobookshelf](https://www.audiobookshelf.org/). Point the stock Audiobookshelf web client and mobile apps at ShelfMerge, and it presents the libraries of one or more Audiobookshelf servers as a single server. Nothing on the upstream servers changes; each one only needs an API key for a service user.

**Status: Phase 0.** One upstream server, transparently proxied. Login, browsing, playback (direct and transcoded), listening progress, bookmarks and live socket updates work with the unmodified web client. The mobile apps are expected to work but have not been verified yet. Multi-server federation is Phase 1.

## How it works

- ShelfMerge has its own users and issues its own access and refresh tokens in exactly the shapes Audiobookshelf uses, so clients cannot tell the difference.
- Upstream item, series, author and session ids are passed through unchanged. ShelfMerge keeps an `id → server` map (SQLite) to route each request.
- Listening progress, bookmarks and "continue listening" are owned by ShelfMerge, because every ShelfMerge user shares one upstream service account per server. Playback sessions are still created upstream (so transcoding works and the owner sees listening stats for the service user), and ShelfMerge mirrors each sync into its own store.
- Audio, covers and ebooks are relayed with `Range` support. All media bytes pass through ShelfMerge.
- One socket.io connection per upstream server relays catalog events (items added, updated, removed, …) to connected clients; user events are generated locally.
- The web client is the stock build, copied out of the official Audiobookshelf image when the Docker image is built.

## Run with Docker

```bash
cp config/shelfmerge.example.yaml config/shelfmerge.yaml   # edit servers and users
docker compose up -d --build
```

Open <http://localhost:3333> and log in with a user from the config. In the mobile apps, add `http://<host>:3333` as a server.

## Development

Requirements: Node 22+, Docker.

```bash
npm install
./scripts/fetch-client.sh                    # web client → ./client-dist
./test/fixtures/generate.sh                  # synthetic audiobooks via ffmpeg
docker compose -f docker-compose.dev.yml up -d   # throwaway Audiobookshelf on :13378
./scripts/seed-abs.sh                        # root user, library, service API key, config/shelfmerge.yaml
npm run dev                                  # ShelfMerge on :3333
```

Smoke tests against the running dev stack:

```bash
./scripts/smoke.sh            # HTTP flows: login, browse, play, sync, progress, refresh, logout
node scripts/smoke-socket.mjs # socket auth and user events
```

## Configuration

See [config/shelfmerge.example.yaml](config/shelfmerge.example.yaml). Environment overrides: `PORT`, `SHELFMERGE_CONFIG`, `SHELFMERGE_CLIENT_DIR`, `SHELFMERGE_TOKEN_SECRET`, `LOG_LEVEL` (`debug`, `info`, `warn`, `error`).

## Limitations (Phase 0)

- Listening history and stats are not kept; the stats pages show zeros.
- Metadata edits, uploads, scans and other admin actions are hidden in the UI (ShelfMerge users have read-only permissions) and would be rejected upstream for the service account anyway.
- Collections and playlists are the service account's, shared by all ShelfMerge users.
- Only local username and password login; no OpenID.

## License

GPL-3.0, the same as Audiobookshelf, whose web client this project redistributes unmodified.
