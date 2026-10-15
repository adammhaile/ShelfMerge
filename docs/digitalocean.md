# ShelfMerge on a DigitalOcean droplet

One instance, HTTPS via the Caddy overlay, image pulled from GHCR. About 20 minutes.

## Before you start

- **A hostname** for it, e.g. `shelf.example.com`, at a DNS provider you control.
- **A published release** so the image exists: GitHub → Releases → *Draft a new release* → tag `v0.1.0` → *Publish*. CI builds and pushes `ghcr.io/adammhaile/shelfmerge` (takes ~10 min). Then either make the package public (GitHub → your profile → Packages → shelfmerge → Package settings → *Change visibility*), which lets the droplet pull without credentials, or create a token: Settings → Developer settings → Personal access tokens (classic) → scope `read:packages`.
- **Service accounts on each Audiobookshelf server**: a user of type *User* named e.g. `shelfmerge`, with access to the libraries you want to share, and an API key for it (Settings → API Keys). Also, optionally, an API key for *your own* account on your own server.

## 1. Create the droplet

DigitalOcean → Create → Droplets:

- Region: the one nearest most users (New York or San Francisco).
- Image: **Marketplace → Docker** (Ubuntu with Docker and Compose preinstalled).
- Size: Basic, Regular; the **$6 / 1 GB** plan works, **$12 / 2 GB** gives headroom.
- Authentication: SSH key.
- Hostname: `shelfmerge`.

When it's up, note its public IPv4 address.

## 2. DNS

At your DNS provider add an **A record**: `shelf` → the droplet's IP. Caddy can only get a certificate once the name resolves, so do this first; it usually propagates within minutes.

## 3. Open the web ports

```bash
ssh root@<droplet-ip>
ufw allow 80/tcp
ufw allow 443/tcp
ufw status
```

(The Docker image ships with `ufw` enabled and only SSH open.)

## 4. Put the files in place

```bash
mkdir -p ~/shelfmerge/config ~/shelfmerge/deploy && cd ~/shelfmerge
```

`docker-compose.yml`:

```yaml
services:
  shelfmerge:
    image: ghcr.io/adammhaile/shelfmerge:latest
    container_name: shelfmerge
    volumes:
      - ./config:/config
      - shelfmerge-data:/data
    env_file:
      - path: .env
        required: false
    restart: unless-stopped

volumes:
  shelfmerge-data:
```

`deploy/docker-compose.caddy.yml`:

```yaml
services:
  caddy:
    image: caddy:2
    container_name: shelfmerge-caddy
    ports:
      - "80:80"
      - "443:443"
    environment:
      - SHELFMERGE_DOMAIN=${SHELFMERGE_DOMAIN:?set SHELFMERGE_DOMAIN in .env}
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - shelfmerge
    restart: unless-stopped

volumes:
  caddy-data:
  caddy-config:
```

`deploy/Caddyfile`:

```
{$SHELFMERGE_DOMAIN} {
    encode gzip
    reverse_proxy shelfmerge:3333
}
```

`.env`:

```bash
SHELFMERGE_DOMAIN=shelf.example.com
```

`config/shelfmerge.yaml` (keys pasted in directly is fine; the file is only on this machine):

```yaml
port: 3333
dataDir: /data

servers:
  home:
    url: https://abs.example.com
    apiKey: <API key of the shelfmerge service user on your server>
    label: Home
  # bob:
  #   url: https://abs.bob.example
  #   apiKey: <API key Bob made for you>
  #   label: Bob

users:
  adam:
    password: change-me          # initial only; change it on the account page after first login
    admin: true                  # Settings -> Users: add friends, reset passwords
    accounts:
      home: <API key of YOUR OWN account on your server>   # optional: progress and history on your real account
```

## 5. Start it

```bash
# only if the package is private:
docker login ghcr.io -u adammhaile      # password: the read:packages token

docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml pull
docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml up -d
docker compose logs -f shelfmerge
```

In the log you should see each server recognised (`[upstream:home] ... is Audiobookshelf 2.37.1`), the merged library (`[catalog] merged library "Everything" <- ...`), and the index filling (`[index] home/...: 464 of 464 items indexed`). `Ctrl-C` leaves it running.

## 6. Use it

- Open `https://shelf.example.com`, log in as `adam` / `change-me`, click your name → Account → change the password.
- Settings → Users → add each friend (username + password). They can log in right away and see every library.
- In the Audiobookshelf apps, add `https://shelf.example.com` as a server and log in.

## Maintenance

- **Update**: after a new release, `docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml pull && docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml up -d`.
- **Config changes** (add a server, give someone their own account key): edit `config/shelfmerge.yaml`; it is picked up within a couple of seconds, no restart.
- **Backup**: everything ShelfMerge owns is the `shelfmerge-data` volume: `docker run --rm -v shelfmerge_shelfmerge-data:/data -v $PWD:/backup alpine tar czf /backup/shelfmerge-data.tgz -C /data .` Plus `config/` and `.env`. DigitalOcean's droplet backups (weekly, +20 %) cover all of it too.
- **Logs**: `docker compose logs --tail 200 shelfmerge`. Lines starting with `[editions]` show which duplicate books were merged.
- **Forgot the admin password**: `docker exec -it shelfmerge node dist/tools/user.js passwd adam`.
