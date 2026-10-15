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

The simple setup is one instance, ideally on the machine that already runs your own Audiobookshelf:

```bash
cp config/shelfmerge.example.yaml config/shelfmerge.yaml   # servers, one admin user; API keys can go straight in here
docker compose up -d --build
```

Open <http://localhost:3333>, log in as the admin user, change the password on the account page, and add everyone else under Settings → Users. No other commands are needed after that: users, passwords and deactivation are all in the web UI, and config edits are picked up live. In the mobile apps, add `http://<host>:3333` (or the HTTPS address below) as a server.

`.env` is optional: if you prefer keeping keys out of the YAML, reference them as `${VAR}` and put the values there (`.env.example`).

For HTTPS, put your reverse proxy in front of port 3333 (see below). If you have none, `deploy/docker-compose.caddy.yml` is an optional overlay that adds Caddy with an automatic certificate: set `SHELFMERGE_DOMAIN` in `.env` and run `docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml up -d`.

**Backups**: everything ShelfMerge owns (users, progress, history, playlists, the index, the token secret) is in the `/data` volume, a single SQLite file; copy it while the container is stopped, or `sqlite3 /data/shelfmerge.db ".backup /backup/shelfmerge.db"` while running. The config and `.env` are the rest. The index is a cache and rebuilds itself if lost.

A worked example on a DigitalOcean droplet with HTTPS: [docs/digitalocean.md](docs/digitalocean.md).

## Development

Requirements: Node 22+, Docker.

```bash
npm install
./scripts/fetch-client.sh     # web client → ./client-dist
./scripts/dev-up.sh           # fixtures, two throwaway Audiobookshelf servers (:13378, :13379), seeding, config/shelfmerge.yaml
npm run dev                   # ShelfMerge on :3333; users adam/adam (everything) and guest/guest (one library)
```

Unit tests (`npm test`, vitest) cover the edition matcher, title and name normalization, the index query layer (sorting, filters, collapsed series, search, cross-server series and author grouping, edition hiding), the progress rules, token rotation and the rate limiter. CI runs them, then the smoke suites below against two real Audiobookshelf containers, on every push and pull request. The image is published to `ghcr.io/adammhaile/shelfmerge` only when a GitHub release is published, tagged with the release tag (`v1.2.0` gives `1.2.0`, `1.2`, `1`) and `latest`.

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

**Users and passwords.** Users are listed under `users:`, or created by an admin from the web UI. Give a user `admin: true` and the stock **Settings → Users** page works for them: list users, add one, reset a password, rename or deactivate. Users created there see every library and have no own-account keys; users from the config keep those settings in the file (and are renamed or removed there, not in the UI). The other settings pages an admin sees are about an Audiobookshelf server's own files and settings, so they render empty or refuse changes. The `password` there is only the initial one: it creates the user, and from then on the password is stored hashed in the database, so there is no need to keep it in the file. Users change their own password on the web client's account page; an admin resets one with `npm run user -- passwd <name>` (`docker exec -it shelfmerge node dist/tools/user.js passwd <name>`). `npm run user -- hash` prints a bcrypt hash to use as `password:` for a fully declarative setup, and `npm run user -- list` shows who exists.

Login and token refresh are rate limited per IP: 20 failed attempts per 10 minutes, then `429` (`SHELFMERGE_AUTH_RATE_LIMIT` sets the count, `0` disables; `SHELFMERGE_AUTH_RATE_LIMIT_WINDOW` the window in ms). Successful requests never count.

To sign everyone out and replace the JWT signing secret: `npm run rotate-secret` (dev) or `docker exec shelfmerge node dist/tools/rotate-secret.js`, then restart. The file is re-read when it changes (polled every 2 s): users and servers can be added, removed or re-keyed live; `port` and `dataDir` need a restart. A user removed from the config keeps their progress but can no longer log in. Environment overrides: `PORT`, `SHELFMERGE_CONFIG` (file path or URL), `SHELFMERGE_CONFIG_AUTH`, `SHELFMERGE_CONFIG_POLL`, `SHELFMERGE_DATA_DIR`, `SHELFMERGE_CLIENT_DIR`, `SHELFMERGE_TOKEN_SECRET`, `ROUTER_BASE_PATH`, `LOG_LEVEL` (`debug`, `info`, `warn`, `error`).

## Several instances, one config

Clients should be near their ShelfMerge, since every click and every audio byte goes through it; with friends on another continent, run a second instance there (any small VPS). Instances share nothing but the upstream servers, so each keeps its own users, progress and index, and a person just uses the nearest one.

Step-by-step for two regions with a shared config in a private repo, including password hashes so logins work on both: [docs/multi-region.md](docs/multi-region.md). In short, serve the YAML over HTTP and point every instance at it: `SHELFMERGE_CONFIG=https://raw.githubusercontent.com/<you>/<private-repo>/main/shelfmerge.yaml` with `SHELFMERGE_CONFIG_AUTH="token ghp_..."` (a fine-grained token with read access to that repo; any URL that accepts an `Authorization` header works). The file is re-fetched every `SHELFMERGE_CONFIG_POLL` seconds (default 60) and applied when it changed. Keep secrets out of the shared file by writing `${HOME_API_KEY}` and so on, and give each instance the values in its own `.env`; with a URL config, set `dataDir` to an absolute path or `SHELFMERGE_DATA_DIR`.

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
