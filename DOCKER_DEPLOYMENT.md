# Docker deployment

How to run the full stack (API, frontend, scan worker, ingestion worker) with Docker
Compose on a Linux host. This is the current way the pipeline is hosted while the EC2
instance is unavailable; the EC2/pm2 guides (`EC2_DEPLOYMENT.md`, `deploy-ec2.sh`) describe
the previous setup and are kept for when it returns.

## The one rule

**Only one host may run the `worker` and `ingestion` services against the production
database.** Two hosts will each run the nightly scan and can email a customer the same
report twice. Before starting the stack here, stop it wherever else it runs
(`pm2 delete all` on a pm2 host, `docker compose down` on another Docker host).

## What runs

| Service | What it does | Schedule (UTC) |
|---|---|---|
| `ingestion` | Routes `filter-docs/` into `planning-docs/` in S3 | 23:00, marker clean-up 00:05 |
| `api` | REST API; writes the document register CSV | 00:05 |
| `worker` | Enqueues and runs the nightly scans, emails customers | 00:10; deliveries from 09:00 |
| `web` | nginx: serves the frontend, proxies `/api/` to `api` | — |

MongoDB (Atlas), Redis (Upstash), email (Gmail SMTP) and documents (S3) are external. The
host keeps only two Docker volumes: `logs` and `register_outputs`.

All containers run in UTC. Do not change `TZ`: the scan worker mixes UTC dates with
local-time schedules, and on any other zone the Monday delivery is skipped.

## First deployment

Requirements: Docker Engine with the Compose plugin, git, outbound access to GitHub,
Docker Hub, MongoDB Atlas, Redis, S3 and `smtp.gmail.com:587`.

```bash
git clone git@github.com:karlennis/fi_email_automation.git app
cd app

# 1. Secrets. Copy backend/.env.example and fill it in, or copy the .env from the host
#    being replaced. Never commit it.
cp backend/.env.example backend/.env
chmod 600 backend/.env

# 2. Who may reach the web UI (plain HTTP, so keep this list tight).
cp docker/allow.conf.example docker/allow.conf

# 3. Build and start.
docker compose build
docker compose up -d
docker compose ps
```

In `backend/.env`, set `FRONTEND_URL` to the address users open (for example
`http://<server-ip>`), and generate a fresh `JWT_SECRET` with
`node backend/scripts/generate-jwt-secret.js`. If the database's network access list is
restricted, add this server's public IP to it.

To check a new host without running anything scheduled, start only the web side with
schedulers off:

```bash
SCHEDULERS_ENABLED=false docker compose up -d api web
docker compose exec web wget -qO- http://127.0.0.1/health
```

## Day to day

```bash
# Update to the latest code
git pull && docker compose up -d --build

# Is everything up?
docker compose ps

# Live output of one service
docker compose logs -f worker

# The searchable application log (run ids, scan summaries)
docker compose exec api npm --prefix backend run logs -- --runs

# Run a maintenance script
docker compose exec worker node backend/scripts/check-stuck-jobs.js

# Change the IP allow-list
nano docker/allow.conf && docker compose exec web nginx -s reload

# Stop everything (required before another host takes over)
docker compose down
```

`docker compose down` keeps the volumes, so logs and register CSVs survive. The stack
restarts by itself after a reboot (`restart: unless-stopped`).

## Web access

`web` publishes port 80 (override with `WEB_PORT`). Requests are refused unless the client
address is in `docker/allow.conf`, and the host's cloud firewall should allow port 80 from
the same addresses only. The app is served over HTTP, so logins are not encrypted in
transit; the allow-list is what makes that acceptable. To move to HTTPS, put a hostname on
the server and terminate TLS in front of `web`.

## Troubleshooting

- **`web` keeps restarting:** `docker/allow.conf` is missing (Docker creates a directory in
  its place). Remove the directory, copy the example, start again.
- **`api` exits at boot:** `JWT_SECRET` is missing, short or a placeholder, or the S3
  bucket/region variables disagree. The reason is in `docker compose logs api`.
- **`worker` exits at boot:** `MONGODB_URI` is unset or unreachable.
- **`ingestion` exits at boot:** S3 credentials cannot list the bucket.
- **Scanned PDFs produce no text:** check `docker compose exec worker pdftoppm -v` and
  `tesseract --version`.
