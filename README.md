# ShelfMerge

A federating proxy for [Audiobookshelf](https://www.audiobookshelf.org/). Point the stock Audiobookshelf web client and mobile apps at ShelfMerge, and it presents the libraries of one or more Audiobookshelf servers as a single server. Nothing on the upstream servers changes; each one only needs an API key for a service user.

**Status: Phase 1 (multi-server passthrough) plus polish.** Several upstream servers appear as one: the library list is the union of every server's libraries (prefixed with the server label), and everything else routes by id to the owning server. Login, browsing, playback (direct and transcoded), listening progress and history, stats, bookmarks, collections, playlists, "continue series" and live socket updates work with the unmodified web client and the Android app. Per-user library allow-lists are supported, and the config reloads without a restart. A merged "virtual library" that combines several libraries into one is a later phase.

## How it works

- ShelfMerge has its own users and issues its own access and refresh tokens in exactly the shapes Audiobookshelf uses, so clients cannot tell the difference.
- Upstream item, series, author and session ids are passed through unchanged. ShelfMerge keeps an `id → server` map (SQLite) to route each request, learned from every response that passes through. An id it has never seen (a phone asking for a downloaded book after the map was lost) is probed on each server.
- `/api/libraries` is served from a cached union of all servers' libraries, so browsing keeps working when one server is down. Library names are prefixed with the server label (`prefixLibraryNames`).
- Listening progress, history and stats, bookmarks, collections, playlists and the progress-driven home shelves ("continue listening", "continue series", "listen again") are owned by ShelfMerge, because every ShelfMerge user shares one upstream service account per server. Playback sessions are still created upstream (so transcoding works and the owner sees listening stats for the service user), and ShelfMerge mirrors each sync into its own store. Auto mark-as-finished follows each upstream library's settings.
- Upstream is read-only through ShelfMerge: apart from playback, every mutating request (metadata edits, uploads, scans, deletes, settings) is refused by the proxy with 403 before it reaches a server, whatever the service account is allowed to do. ShelfMerge users report the `update` permission so the collection UI appears; collections live in ShelfMerge and may span servers.
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
./scripts/fetch-client.sh     # web client → ./client-dist
./scripts/dev-up.sh           # fixtures, two throwaway Audiobookshelf servers (:13378, :13379), seeding, config/shelfmerge.yaml
npm run dev                   # ShelfMerge on :3333; users adam/adam (everything) and guest/guest (one library)
```

Smoke tests against the running dev stack:

```bash
./scripts/smoke.sh            # single-server flows: login, browse, play, sync, progress, refresh, logout
./scripts/smoke-multi.sh      # federation: library union, allow-lists, playback on the second server, id probing
./scripts/smoke-polish.sh     # history, stats, series progress, collections, playlists, write blocking, config reload
node scripts/smoke-socket.mjs # socket auth and user events
```

## Configuration

See [config/shelfmerge.example.yaml](config/shelfmerge.example.yaml). The file is re-read when it changes (polled every 2 s): users and servers can be added, removed or re-keyed live; `port` and `dataDir` need a restart. A user removed from the config keeps their progress but can no longer log in. Environment overrides: `PORT`, `SHELFMERGE_CONFIG`, `SHELFMERGE_CLIENT_DIR`, `SHELFMERGE_TOKEN_SECRET`, `ROUTER_BASE_PATH`, `LOG_LEVEL` (`debug`, `info`, `warn`, `error`).

## Behind a reverse proxy

ShelfMerge speaks plain HTTP on one port and serves everything (web client, API, media, socket.io) from it, so any reverse proxy that handles WebSockets works. It trusts `X-Forwarded-*` headers and marks the refresh cookie `Secure` when the request arrived over HTTPS. Caddy:

```
abs.example.com {
    reverse_proxy shelfmerge:3333
}
```

nginx needs the usual WebSocket upgrade headers on `/socket.io/` and `/audiobookshelf/socket.io/`, and `client_max_body_size` only matters if you ever allow uploads (ShelfMerge refuses them).

## Limitations

- Each library is still one upstream library; there is no merged view across servers yet, and the same book on two servers shows up twice.
- Metadata edits, uploads, scans and other admin actions are refused by the proxy; the stock UI still shows some of those buttons (they fail with a 403 toast).
- Collections are shared between ShelfMerge users, as they are in Audiobookshelf; playlists are per user.
- Only local username and password login; no OpenID.

## License

GPL-3.0, the same as Audiobookshelf, whose web client this project redistributes unmodified.
