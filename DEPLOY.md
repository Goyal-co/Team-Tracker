# Deploying Team Tracker on an Ubuntu EC2 server

One container serves the built SPA and the API on port **5175**. PostgreSQL and
Redis run natively on the EC2 host and are configured through `.env`. Nothing
is baked into the image.

## 1. Server prerequisites

```bash
# Docker + compose plugin
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER   # re-login afterwards
```

PostgreSQL and Redis must accept connections from the Docker bridge network
(`172.17.0.0/16`), not just `localhost`:

```bash
# PostgreSQL: /etc/postgresql/<ver>/main/postgresql.conf
#   listen_addresses = '*'
# PostgreSQL: /etc/postgresql/<ver>/main/pg_hba.conf
#   host  all  all  172.16.0.0/12  scram-sha-256
sudo systemctl restart postgresql

# Redis: /etc/redis/redis.conf
#   bind 0.0.0.0
#   protected-mode yes
#   # add a requirepass and put it in REDIS_URL if the host is not firewalled
sudo systemctl restart redis-server
```

The security group should expose only 22 (SSH) and 443/80 (nginx). Port 5175
stays internal or loopback-only.

## 2. Configure

```bash
cp .env.example .env
nano .env
```

Required values:

| Variable | Notes |
| --- | --- |
| `SESSION_SECRET` | `openssl rand -hex 32`. Rotating it signs everyone out. |
| `BOOTSTRAP_ADMIN_EMAIL` | Google account that becomes the first administrator. |
| `DATABASE_URL` | `postgres://user:pass@host.docker.internal:5432/dbname`. The database is created automatically when the user may create databases. |
| `REDIS_URL` | `redis://host.docker.internal:6379`. If unreachable the app falls back to PostgreSQL for sessions, tokens, limits, and the lock. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client. |
| `GOOGLE_REDIRECT_URI` | `https://<your-domain>/api/google/calendar/callback`, must also be registered in Google Cloud. |
| `COOKIE_SECURE` / `TRUST_PROXY` | `true` when behind nginx with HTTPS. |

## 3. Run

```bash
mkdir -p data && sudo chown -R 1000:1000 ./data   # container runs as uid 1000
docker compose up -d --build
docker compose ps                                 # wait for "healthy"
curl -s http://localhost:5175/api/health          # {"ok":true}
```

On first start with an empty workspace, sign in with `BOOTSTRAP_ADMIN_EMAIL`
to become the administrator, then create a team and a project. While you are
still testing over plain `http://<ip>:5175`, set `COOKIE_SECURE=false` in
`.env` or the session cookie will be dropped; switch it back to `true` once
HTTPS is in place.

## 4. nginx + HTTPS

```nginx
server {
    listen 443 ssl;
    server_name tracker.example.com;
    # ssl_certificate /etc/letsencrypt/live/tracker.example.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/tracker.example.com/privkey.pem;

    client_max_body_size 25m;   # uploads

    location / {
        proxy_pass http://127.0.0.1:5175;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then change the port mapping in `docker-compose.yml` to `"127.0.0.1:5175:5175"`
so the app is only reachable through nginx. With `TRUST_PROXY=true` the app
rate-limits on real client IPs; without it, every request looks like it comes
from nginx.

## 5. Updating

```bash
git pull
docker compose up -d --build     # rebuilds and replaces, old requests drain
docker compose logs -f app
```

## 6. Data and backups

- Uploads live in `./data/uploads` (or S3 when `S3_*` is set).
- The workspace itself is entirely in PostgreSQL. Back it up with `pg_dump`.
- Legacy `data/db.json` is imported into PostgreSQL on first start if the
  database is empty.

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ECONNREFUSED` on startup | Postgres/Redis not reachable from the container. Check `pg_hba.conf`, Redis `bind`, and the `host.docker.internal` entries. |
| `permission denied` writing uploads | `sudo chown -R 1000:1000 ./data`. |
| `Set SESSION_SECRET...` or `Set BOOTSTRAP_ADMIN_EMAIL...` | Missing required `.env` values; the app exits by design. |
| Google sign-in loops back to `/login?error=...` | `GOOGLE_REDIRECT_URI` must exactly match the public URL registered in Google Cloud. |
| Container shows `unhealthy` | `docker compose logs app` and `curl localhost:5175/api/health`. |
