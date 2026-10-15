# ShelfMerge

A federating proxy for [Audiobookshelf](https://www.audiobookshelf.org/). Point the stock Audiobookshelf web client and mobile apps at ShelfMerge, and it presents the libraries of one or more Audiobookshelf servers as a single server. Nothing on the upstream servers changes; each one only needs an API key for a service user.

**Status: Phase 3 (merged library with edition collapsing).** Several upstream servers appear as one. The library list starts with a merged library ("Everything" by default) that combines every server's libraries into one browsable, sortable, searchable library, followed by each upstream library as `<server label>: <library name>`. Login, browsing, playback (direct and transcoded), listening progress and history, stats, bookmarks, playlists, "continue series" and live socket updates work with the unmodified web client and the Android app. Per-user library allow-lists are supported, and the config reloads without a restart. The same book on several servers (or twice on one) is shown as one card, with the other editions listed and linked on its page.

## How it works

- ShelfMerge has its own users and issues its own access and refresh tokens in exactly the shapes Audiobookshelf uses, so clients cannot tell the difference.
- Upstream item, series, author and session ids are passed through unchanged. ShelfMerge keeps an `id → server` map (SQLite) to route each request, learned from every response that passes through. An id it has never seen (a phone asking for a downloaded book after the map was lost) is probed on each server.
- `/api/libraries` is served from a cached union of all servers' libraries, so browsing keeps working when one server is down. Library names are prefixed with the server label (`prefixLibraryNames`).
- **Editions**: in a merged library, copies of the same book are grouped (identical ASIN, else identical ISBN, else the same normalized title and primary author with matching language and abridged flag) and one card is shown, the preferred edition by server order (`preferServers`), then bitrate. The item page of any edition ends with an "Other editions" list linking to the rest, which is how you pick a narrator. On the first play of an edition, the position carries over from another edition you have started (by time when the lengths match within 2 %, else by fraction). Every grouping is logged (`[editions] ...`) and a false match is pinned apart with `keepSeparate`.
- **Merged libraries** are answered from ShelfMerge's own index (SQLite): every source library is pulled once (expanded items, series, authors), kept current from the item/series/author socket events, and re-pulled every 6 hours. Items, search, filter data, series, authors, narrators, stats and the home-page shelves are computed from the index with the same sort keys, filter groups and collapse-series behaviour as Audiobookshelf. Series and authors with the same name on different servers are shown once. Item detail, covers and playback still go to the owning server; while a user is browsing a merged library, those responses are relabelled with the merged library's id so the web client stays put. Item events from upstream are echoed under each merged library that contains the item.
- Listening progress, history and stats, bookmarks, collections, playlists and the progress-driven home shelves ("continue listening", "continue series", "listen again") are owned by ShelfMerge, because by default every ShelfMerge user shares one upstream service account per server. Playback sessions are still created upstream (so transcoding works and the owner sees listening stats for the service user), and ShelfMerge mirrors each sync into its own store. Auto mark-as-finished follows each upstream library's settings.
- **Own accounts.** A user can instead hold their *own* API key for a server (`users.<name>.accounts.<serverKey>`). Every request to that server for that user is then made as their account: their library permissions apply, playback sessions and listening history land on their real account, manual progress edits are written through, and progress made natively on that server (phone app, web) is pulled into ShelfMerge at login, on each `authorize`, and every 5 minutes. Servers without a mapping keep using the service account, so a friend's server can stay on a shared guest user while your own server is really you.
- Upstream is read-only through ShelfMerge: apart from playback, every mutating request (metadata edits, uploads, scans, deletes, settings) is refused by the proxy with 403 before it reaches a server, whatever the service account is allowed to do. ShelfMerge users have no `update` permission, so the stock UI hides editing controls (and with them "add to collection"; playlists are the per-user tool, collections remain available via the API).
- Audio, covers and ebooks are relayed with `Range` support. All media bytes pass through ShelfMerge.
- One socket.io connection per upstream server relays catalog events (items added, updated, removed, …) to connected clients; user events are generated locally.
- The web client is the stock build, copied out of the official Audiobookshelf image when the Docker image is built.

## Run with Docker

```bash
cp config/shelfmerge.example.yaml config/shelfmerge.yaml   # edit servers and users
cp .env.example .env                                         # the API keys and passwords the YAML references as ${VAR}
docker compose up -d --build
```

Open <http://localhost:3333> and log in with a user from the config. In the mobile apps, add `http://<host>:3333` as a server.

For HTTPS on the open internet, set `SHELFMERGE_DOMAIN` in `.env` and run `docker compose --profile caddy up -d`; Caddy terminates TLS with an automatic certificate and proxies to ShelfMerge. If you already run a reverse proxy, skip the profile and point it at port 3333 (see below).

**Backups**: everything ShelfMerge owns (users, progress, history, playlists, the index, the token secret) is in the `/data` volume, a single SQLite file; copy it while the container is stopped, or `sqlite3 /data/shelfmerge.db ".backup /backup/shelfmerge.db"` while running. The config and `.env` are the rest. The index is a cache and rebuilds itself if lost.

## Development

Requirements: Node 22+, Docker.

```bash
npm install
./scripts/fetch-client.sh     # web client → ./client-dist
./scripts/dev-up.sh           # fixtures, two throwaway Audiobookshelf servers (:13378, :13379), seeding, config/shelfmerge.yaml
npm run dev                   # ShelfMerge on :3333; users adam/adam (everything) and guest/guest (one library)
```

Unit tests (`npm test`, vitest) cover the edition matcher, title and name normalization, the index query layer (sorting, filters, collapsed series, search, cross-server series and author grouping, edition hiding), the progress rules, token rotation and the rate limiter. CI runs them, then the smoke suites below against two real Audiobookshelf containers, and publishes the image to GHCR on pushes to `main` and on `v*` tags.

Smoke tests against the running dev stack (start the proxy with `SHELFMERGE_AUTH_RATE_LIMIT_WINDOW=15000` when running them all, since the accounts suite deliberately trips the limiter):

```bash
./scripts/smoke.sh            # single-server flows: login, browse, play, sync, progress, refresh, logout
./scripts/smoke-multi.sh      # federation: library union, allow-lists, playback on the second server, id probing
./scripts/smoke-polish.sh     # history, stats, series progress, collections, playlists, write blocking, config reload
./scripts/smoke-merged.sh     # merged library: items/sort/filter/collapse, search, series, authors, shelves, relabelling
./scripts/smoke-editions.sh   # one card per book across servers, alternates, progress carry-over, keepSeparate
node scripts/smoke-socket.mjs # socket auth and user events
node scripts/smoke-live.mjs   # an upstream edit reaches the index and is relayed under source and merged ids
./scripts/smoke-accounts.sh   # own-account mapping: sessions credited upstream, write-through, native progress pulled back; rate limit
```

## Configuration

See [config/shelfmerge.example.yaml](config/shelfmerge.example.yaml).

Login and token refresh are rate limited per IP: 20 failed attempts per 10 minutes, then `429` (`SHELFMERGE_AUTH_RATE_LIMIT` sets the count, `0` disables; `SHELFMERGE_AUTH_RATE_LIMIT_WINDOW` the window in ms). Successful requests never count.

To sign everyone out and replace the JWT signing secret: `npm run rotate-secret` (dev) or `docker exec shelfmerge node dist/tools/rotate-secret.js`, then restart. The file is re-read when it changes (polled every 2 s): users and servers can be added, removed or re-keyed live; `port` and `dataDir` need a restart. A user removed from the config keeps their progress but can no longer log in. Environment overrides: `PORT`, `SHELFMERGE_CONFIG`, `SHELFMERGE_CLIENT_DIR`, `SHELFMERGE_TOKEN_SECRET`, `ROUTER_BASE_PATH`, `LOG_LEVEL` (`debug`, `info`, `warn`, `error`).

## Upgrading Audiobookshelf

ShelfMerge bundles the web client of one Audiobookshelf version and speaks the API as of that version (`ABS_VERSION` in the Dockerfile, `scripts/fetch-client.sh` and `docker-compose.dev.yml`). When a new Audiobookshelf release comes out: bump the version in those three places, rebuild, and run the suites; the smoke tests exercise the real API, so a changed endpoint or shape shows up there. Upstream servers a version ahead of the bundled client usually keep working, since the API changes slowly, but match versions when you can.

## Behind a reverse proxy

ShelfMerge speaks plain HTTP on one port and serves everything (web client, API, media, socket.io) from it, so any reverse proxy that handles WebSockets works. It trusts `X-Forwarded-*` headers and marks the refresh cookie `Secure` when the request arrived over HTTPS. Caddy:

```
abs.example.com {
    reverse_proxy shelfmerge:3333
}
```

nginx needs the usual WebSocket upgrade headers on `/socket.io/` and `/audiobookshelf/socket.io/`, and `client_max_body_size` only matters if you ever allow uploads (ShelfMerge refuses them).

## Limitations

- Progress is per edition. The first play of another edition is seeded from the one you started; after that each keeps its own position.
- Merged libraries are book libraries; podcast libraries are passthrough only.
- Metadata edits, uploads, scans and other admin actions are hidden in the UI and refused by the proxy.
- Collections have no UI (the client ties it to the edit permission); playlists are per user and fully supported.
- Only local username and password login; no OpenID.

## License

GPL-3.0, the same as Audiobookshelf, whose web client this project redistributes unmodified.
