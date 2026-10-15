# Running ShelfMerge in two regions with one shared config

Clients should be near their ShelfMerge: every click and every audio byte goes through it. With friends on another continent, run one instance per region and let each person use the nearest. This guide sets up two instances (say Frankfurt and New York) that share a single config file kept in a private GitHub repo, with secrets kept local to each machine.

What is shared and what is not:

| Shared (the YAML) | Local to each instance |
|---|---|
| servers, labels, merged libraries, edition rules | API keys (in `.env`) |
| users, their allow-lists, own-account mappings | each user's progress, history, playlists |
| password **hashes**, so logins work on both | the index (rebuilt by each instance) |

## 1. The shared config repo

Create a **private** GitHub repo (e.g. `shelfmerge-config`) containing one file, `shelfmerge.yaml`. Write every secret as a placeholder:

```yaml
port: 3333
dataDir: /data

servers:
  home:
    url: https://abs.haile.io
    apiKey: ${HOME_API_KEY}
    label: Home
  bob:
    url: https://abs.bob.example
    apiKey: ${BOB_API_KEY}
    label: Bob

users:
  adam:
    password: $2a$10$Qf3....................................................  # bcrypt hash, see below
    admin: true
    accounts:
      home: ${ADAM_HOME_KEY}
  bob:
    password: $2a$10$H7k....................................................
    accounts:
      bob: ${BOB_OWN_KEY}
  carol:
    password: $2a$10$ZZ9....................................................
    libraries: [merged:Everything]
```

`${NAME}` is replaced from the environment of whichever instance loads the file, so the repo never holds a key. A placeholder with no value is a startup error naming the variable, not an empty key.

### Password hashes

Each instance keeps passwords in its own database, so a password changed on one instance would not reach the other. Putting a bcrypt **hash** in the shared YAML sidesteps that: every instance applies the hash, and a login works everywhere. To make a hash:

```bash
# on a machine with the image (nothing to install):
printf 'the-password\n' | docker run --rm -i ghcr.io/adammhaile/shelfmerge:latest node dist/tools/user.js hash

# or interactively, hidden input:
docker run --rm -it ghcr.io/adammhaile/shelfmerge:latest node dist/tools/user.js hash

# or from a checkout:
npm run user -- hash
```

It prints a 60-character string starting with `$2a$10$`; paste it as the user's `password:`. Hashes are safe to keep in the repo: they cannot be turned back into the password. To change someone's password, generate a new hash and commit it; both instances apply it within a minute and sign that user out so they log in again. (The web UI's "change password" and the admin Users page still work, but only on the instance where they're used; for a shared setup, the YAML hash is the source of truth.)

## 2. A read token for the repo

GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate. Repository access: only `shelfmerge-config`. Permissions: **Contents: Read-only**. Copy the token (`github_pat_...`).

The raw file URL is `https://raw.githubusercontent.com/<you>/shelfmerge-config/main/shelfmerge.yaml`; with the header `Authorization: token github_pat_...` it serves the private file.

## 3. Each instance

On each droplet (Ubuntu, Docker installed, a DNS name pointing at it, ports 80 and 443 open):

```bash
mkdir -p ~/shelfmerge && cd ~/shelfmerge
curl -O https://raw.githubusercontent.com/adammhaile/ShelfMerge/main/docker-compose.yml
mkdir -p deploy && curl -o deploy/Caddyfile https://raw.githubusercontent.com/adammhaile/ShelfMerge/main/deploy/Caddyfile
mkdir -p config     # stays empty; the config comes from the URL
```

Create `.env` with this instance's secrets and the pointer to the shared file:

```bash
# where the config lives and how to read it
SHELFMERGE_CONFIG=https://raw.githubusercontent.com/<you>/shelfmerge-config/main/shelfmerge.yaml
SHELFMERGE_CONFIG_AUTH=token github_pat_...
SHELFMERGE_CONFIG_POLL=60

# the values the YAML's ${...} placeholders refer to
HOME_API_KEY=eyJhbGciOi...
BOB_API_KEY=eyJhbGciOi...
ADAM_HOME_KEY=eyJhbGciOi...
BOB_OWN_KEY=eyJhbGciOi...

# this instance's public name, for Caddy
SHELFMERGE_DOMAIN=shelf-eu.example.com      # shelf-us.example.com on the other one
```

Log in to the registry once (the image is private unless you make the package public): `docker login ghcr.io -u <you>` with a token that has `read:packages`. Then:

```bash
docker compose --profile caddy up -d
docker compose logs -f shelfmerge     # expect "[config] polling https://..." and "[index] ... indexed"
```

Repeat on the second droplet with the same `.env` apart from `SHELFMERGE_DOMAIN`.

Without Caddy (you already have a reverse proxy): `docker compose up -d` and proxy to port 3333; see the README's reverse-proxy section.

## 4. Verify

- Open `https://shelf-eu.example.com`, log in with a user from the YAML, see "Everything" first in the library list.
- Do the same on `https://shelf-us.example.com` with the same password.
- Push a change to `shelfmerge.yaml` (add a user, change a label). Within a minute both logs show `[config] reloaded`.

## 5. Day to day

- **Change anything**: edit the YAML, commit, push. No restarts.
- **Add a friend**: generate a hash, add a `users:` entry, push. Tell them which instance to use; their progress lives there.
- **Rotate an API key**: change it on the Audiobookshelf server, update `.env` on each instance (`docker compose up -d` re-reads it). The YAML does not change.
- **Upgrade**: `docker compose pull && docker compose up -d` on each instance. The config and data volumes carry over.
- **Back up**: the `shelfmerge-data` volume on each instance (one SQLite file) plus `.env`. The YAML is in git.

## Why not one instance with redirects to the origin servers

ShelfMerge could in principle send audio requests straight to the owning Audiobookshelf server instead of relaying them, which would remove the second Atlantic crossing. It does not, because the mobile apps attach their ShelfMerge token to every media request as a header, which the origin server would reject, and the web player's HLS fetches would fail CORS. Two small instances get the same result without fighting the clients.
