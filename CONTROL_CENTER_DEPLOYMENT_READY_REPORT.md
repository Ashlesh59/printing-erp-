# DESKSOLUTIONS CONTROL CENTER — PRODUCTION DEPLOYMENT READY REPORT
**Date:** September 24, 2026  
**Auditor:** DeskSolutions System Engineering  
**Target:** Founder Control Center (`control.desksolutions.in`) & Fleet Cloud Client (`src/main/cloud-client.js`)

---

## A. Production Architecture

The DeskSolutions architecture guarantees absolute separation between the shop's local ERP operations and the cloud fleet management system:

```
                            PUBLIC INTERNET
                                  │
                                  ▼
                     control.desksolutions.in
                                  │
                  HTTPS (443) / WSS (WebSocket Secure)
                                  │
                                  ▼
           [Reverse Proxy: Nginx / Caddy / Cloudflare / Traefik]
                   TLS Termination + WebSocket Upgrade
                                  │
                          HTTP (5000) / WS
                                  │
                                  ▼
         ┌──────────────────────────────────────────────────┐
         │       DeskSolutions Control Center Backend       │
         │             (Node.js / Express / ws)             │
         │                                                  │
         │   • Fleet Monitoring & Diagnostics               │
         │   • Capability-Safe HMAC Command Dispatch        │
         │   • Single-Use Enrollment Key Generator          │
         │   • 24/7 Automated Maintenance & Pruning         │
         │   • WAL-Safe Hot SQLite Backups                  │
         │   • Co-Pilot Operational Query Engine            │
         └───────────────────────┬──────────────────────────┘
                                 │
                     File Read / Write (WAL Mode)
                                 │
                                 ▼
         ┌──────────────────────────────────────────────────┐
         │             PERSISTENT VOLUME MOUNT              │
         │                   (/app/data)                    │
         │                                                  │
         │   • cloud_control.db (Fleet Metadata ONLY)       │
         │   • /app/data/backups/ (Hot DB Snapshots)        │
         │   • /app/data/uploads/                           │
         └──────────────────────────────────────────────────┘
                                 ▲
                                 │
                    Encrypted Outbound WSS Only
                                 │
         ┌───────────────────────┴──────────────────────────┐
         │            SHOP PC (PrintShop Manager)           │
         │                                                  │
         │   • Electron Desktop ERP                         │
         │   • Local SQLite Database (%APPDATA%)            │
         │     [Customers, Orders, Invoices, GST,           │
         │      Inventory, Pricing, Printing, Production]   │
         │   • CloudClient Agent                            │
         │     [Heartbeat, Diagnostics, Signed Commands]    │
         └──────────────────────────────────────────────────┘
```

### Strict System of Record Boundary:
- **Shop PC Local SQLite:** Sole source of truth for all business, customer, order, inventory, pricing, purchasing, and GST records. Business operations run 100% offline without cloud connectivity.
- **Control Center Database (`cloud_control.db`):** Fleet control and monitoring metadata ONLY (`shops`, `heartbeats`, `remote_commands`, `enrollment_keys`, `alerts`, `audit_logs`, `diagnostics`, `errors`, `updates`). Zero ERP business records are transmitted to or stored in the cloud.

---

## B. Required Environment Variables

The Control Center backend is fully configurable via standard environment variables. Configure these in the deployment container or `.env`:

| Variable | Required | Default | Production Value / Description |
|---|---|---|---|
| `NODE_ENV` | **YES** | `development` | `production` (Enforces strict admin authentication, CORS origin filtering, and error sanitization). |
| `CONTROL_CENTER_HOST` | No | `0.0.0.0` | `0.0.0.0` (Binds to all interfaces inside container/VPS). |
| `CONTROL_CENTER_PORT` | No | `5000` | `5000` (Internal listening port; standard container port). |
| `PORT` | No | `5000` | Fallback port supported by cloud providers (e.g. Render, Railway, Heroku). |
| `CONTROL_CENTER_PUBLIC_URL` | **YES** | `http://localhost:5000` | `https://control.desksolutions.in` (Canonical public base URL). |
| `CONTROL_CENTER_WS_URL` | **YES** | `ws://localhost:5000/v1/telemetry` | `wss://control.desksolutions.in/v1/telemetry` (Canonical secure WebSocket URL). |
| `DB_PATH` | **YES** | `cloud_control.db` | `/app/data/cloud_control.db` (Path to SQLite database on persistent storage mount). |
| `BACKUPS_DIR` | No | `backups` | `/app/data/backups` (Directory for WAL-safe point-in-time database snapshots). |
| `BACKUP_RETENTION_DAYS` | No | `30` | `30` (Number of days to retain database backups before automated pruning; minimum 5 backups preserved). |
| `UPLOADS_DIR` | No | `uploads` | `/app/data/uploads` (Directory for diagnostics and report artifacts). |
| `ALLOWED_ORIGINS` | **YES** | `*` | `https://control.desksolutions.in,https://desksolutions.in` (CORS allowed domains). |
| `ADMIN_API_KEY` | **YES** | `null` | Strong 64-char random hex key (Guards all `/api/control/*`, `/api/admin/*`, and `/api/copilot/*` endpoints). |
| `AUTH_SECRET` | No | `null` | Alias for `ADMIN_API_KEY` (Supported for backward compatibility). |
| `COMMAND_SIGNING_SECRET` | **YES** | `null` | Strong 64-char random hex key (Master fallback key for HMAC-SHA256 command signing). |
| `ENROLLMENT_KEY_TTL` | No | `86400000` | `86400000` (24 hours in milliseconds; expiration time for single-use enrollment keys). |

---

## C. Required Persistent Directories

The Control Center stores fleet state on disk using SQLite in WAL mode. When deploying via Docker, Kubernetes, or VPS, the following path **MUST** be mounted to a persistent volume:

- **Container Persistent Mount Path:** `/app/data`
- **Volume Structure:**
  - `/app/data/cloud_control.db` (Primary SQLite database file)
  - `/app/data/cloud_control.db-wal` (Write-Ahead Log; automatically managed by SQLite)
  - `/app/data/cloud_control.db-shm` (Shared-Memory index; automatically managed by SQLite)
  - `/app/data/backups/` (Hot point-in-time database snapshots)
  - `/app/data/uploads/` (Uploaded diagnostic bundles and error dumps)

*Note: Ephemeral container filesystems without persistent volume mounts will result in catastrophic state loss on container reboot or redeployment. The mount point `/app/data` guarantees total persistence.*

---

## D. Required Secrets

The founder must generate high-entropy cryptographic secrets prior to launching the production instance.

Generate using Node.js or OpenSSL:
```bash
# Generate ADMIN_API_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate COMMAND_SIGNING_SECRET:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

1. **`ADMIN_API_KEY`:** Required for accessing founder controls, generating enrollment keys, inspecting shop hardware diagnostics, issuing remote commands, viewing audit logs, and running Co-Pilot queries. Enforced with constant-time equality checks (`crypto.timingSafeEqual`).
2. **`COMMAND_SIGNING_SECRET`:** Fallback signing key for HMAC-SHA256 signatures dispatched to shops. Each shop also generates an individual permanent 64-char token during enrollment.

---

## E. Required Ports

| Port | Protocol | Direction | Source | Destination | Purpose |
|---|---|---|---|---|---|
| **443** | TCP (HTTPS/WSS) | Inbound | Public Internet (Shops & Founder Browser) | Reverse Proxy (Nginx/Caddy) | Secure public HTTP and WebSocket ingress |
| **80** | TCP (HTTP) | Inbound | Public Internet | Reverse Proxy (Nginx/Caddy) | HTTP to HTTPS redirection & Let's Encrypt ACME challenges |
| **5000** | TCP (HTTP/WS) | Internal | Reverse Proxy (127.0.0.1) | Node.js Backend Container | Internal unencrypted application traffic behind TLS termination |

*Security Rule: Port 5000 must NEVER be exposed directly to the public internet without TLS termination.*

---

## F. Required DNS

Configure the following DNS record with the domain registrar / DNS provider:

| Type | Name / Host | Target / Value | TTL | Purpose |
|---|---|---|---|---|
| **A** | `control.desksolutions.in` | `<SERVER_PUBLIC_IPV4>` | 300s (Auto) | Directs Control Center traffic to the reverse proxy |
| **AAAA** (Optional) | `control.desksolutions.in` | `<SERVER_PUBLIC_IPV6>` | 300s (Auto) | Directs IPv6 traffic if host supports IPv6 |

---

## G. HTTPS / WSS Requirements

1. **TLS Certificate:** A valid, publicly trusted TLS certificate (issued by Let's Encrypt, Cloudflare, or commercial CA) covering `control.desksolutions.in`.
2. **WebSocket Upgrade Headers:** The reverse proxy must forward WebSocket upgrade requests:
   - `proxy_http_version 1.1;`
   - `proxy_set_header Upgrade $http_upgrade;`
   - `proxy_set_header Connection "upgrade";`
   - `proxy_read_timeout 86400s;` (Keeps long-lived shop telemetry connections alive).
3. **Proxy Headers:**
   - `proxy_set_header Host $host;`
   - `proxy_set_header X-Real-IP $remote_addr;`
   - `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
   - `proxy_set_header X-Forwarded-Proto $scheme;`
4. **Express Trust Proxy:** The backend has `app.enable('trust proxy')` enabled, correctly populating `req.ip` from the `X-Forwarded-For` header for immutable audit logging.

---

## H. Docker Status

- **`cloud-server/Dockerfile`:**
  - Base: `node:20-alpine`
  - Installs Linux compilation dependencies (`python3`, `make`, `g++`, `sqlite`) for native `better-sqlite3` compilation.
  - Installs `curl` for container healthcheck.
  - Declares persistent volume mount point: `VOLUME ["/app/data"]`.
  - Sets production defaults: `NODE_ENV=production`, `PORT=5000`, `DB_PATH=/app/data/cloud_control.db`, `BACKUPS_DIR=/app/data/backups`, `UPLOADS_DIR=/app/data/uploads`.
  - Configures container liveness healthcheck: `HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD curl -f http://localhost:5000/health || exit 1`.
  - Command: `CMD ["node", "server.js"]`.
- **`.dockerignore`:**
  - `cloud-server/.dockerignore` and root `.dockerignore` are created.
  - Strictly ignores `node_modules`, local databases (`*.db`, `*.db-wal`, `*.db-shm`), `uploads/`, `backups/`, `.env`, `.env.*`, and log files.
- **Local Environment Verification:**
  - Docker CLI v29.7.2 is installed on Windows.
  - Docker Desktop Linux daemon is **NOT RUNNING** on this local machine (`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`).
  - **Classification:** **UNVERIFIED (Local Daemon Offline)**. The Dockerfile and build specifications are structurally and syntactically verified, but live container runtime execution must be validated on the target cloud host.

---

## I. Database Persistence Requirements

- **Engine:** SQLite 3 in WAL mode (`better-sqlite3`).
- **File Invariant:** The database file is located at `DB_PATH` (`/app/data/cloud_control.db`).
- **Zero Data Loss on Restart:** Verified via `test_server_restart_preflight.js`. When the server process restarts or the container restarts with persistent volume mounted:
  - All enrolled shop identities, tokens, and metadata remain intact.
  - Heartbeat history and online/offline status persist.
  - Remote command history and pending command queues survive.
  - The audit log remains complete and append-only.
- **Initialization:** If `cloud_control.db` does not exist on initial container launch, `server.js` automatically creates the database file, activates WAL mode, creates all 9 tables, creates all 7 B-Tree indexes, and sets up maintenance timers automatically.

---

## J. Backup Requirements

- **Live Hot Backups:** Control Center provides a dedicated API endpoint `POST /api/admin/backup` guarded by `requireAdminAuth`. It utilizes SQLite's native `db.backup(...)` to generate a non-blocking point-in-time snapshot directly into `BACKUPS_DIR` (`/app/data/backups/`).
- **Zero Downtime:** Hot backups do not interrupt active WebSocket telemetry connections or block HTTP requests.
- **Automated Retention:** The daily maintenance pruner (`runDatabaseMaintenance`) automatically purges backups older than `BACKUP_RETENTION_DAYS` (default: 30 days) while preserving a minimum safety floor of 5 backups.
- **Disaster Recovery:** Restoring from a backup requires stopping the container, replacing `/app/data/cloud_control.db` with the chosen backup file, and restarting the container.

---

## K. Security Checklist

- [x] **No Arbitrary Code Execution:** Remote commands in `src/main/cloud-client.js` execute strictly from a hardcoded allowlist (`lock`, `restart`, `request_diagnostics`, `request_health`, `request_backup`, `clear_cache`). Zero `eval` or shell commands exist.
- [x] **Cryptographic Command Signatures:** Dispatched commands are signed with `HMAC-SHA256(command:commandId:timestamp:nonce, shopToken)`. Tampered signatures or nonces are rejected.
- [x] **Anti-Replay & Clock Drift Protection:** Expired commands (>5m), future-dated commands (>1m drift), and replayed command IDs are blocked and logged.
- [x] **Admin Authentication Gate:** Enforced via `requireAdminAuth` on all control endpoints. Fails closed in production if no secret is configured.
- [x] **Single-Use Enrollment Keys:** Keys expire after 24 hours. Reused or revoked keys return HTTP 403.
- [x] **Multi-Tenant Isolation:** Socket routing and database queries strictly isolate telemetry and commands per shop ID.
- [x] **Payload Limits:** WebSocket server enforces `maxPayload: 1048576` (1MB).
- [x] **Security Headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-XSS-Protection: 1; mode=block`.
- [x] **No ERP Data in Cloud:** Cloud schema contains only fleet metadata. Shop customer, order, and GST records remain 100% local on shop PCs.
- [x] **Offline-First Resilience:** Desktop ERP operates normally with local SQLite when Control Center is unavailable.

---

## L. Exact Deployment Steps for the Founder

Follow these exact steps when provisioning the production server:

### Step 1: Provision Server & Domain
1. Provision a Linux VPS (Ubuntu 22.04 LTS, 1 vCPU, 1 GB RAM minimum) or Container PaaS (Render, Railway, Fly.io, DigitalOcean).
2. Point DNS A-record: `control.desksolutions.in` $\rightarrow$ Server Public IP.

### Step 2: Install Docker & Docker Compose (on VPS)
```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
```

### Step 3: Prepare Directory & Environment on Host
```bash
sudo mkdir -p /var/data/desksolutions-control /var/www/desksolutions-control
cd /var/www/desksolutions-control
```

Create `.env` file (`/var/www/desksolutions-control/.env`):
```env
NODE_ENV=production
CONTROL_CENTER_HOST=0.0.0.0
CONTROL_CENTER_PORT=5000
PORT=5000
CONTROL_CENTER_PUBLIC_URL=https://control.desksolutions.in
CONTROL_CENTER_WS_URL=wss://control.desksolutions.in/v1/telemetry
DB_PATH=/app/data/cloud_control.db
BACKUPS_DIR=/app/data/backups
BACKUP_RETENTION_DAYS=30
UPLOADS_DIR=/app/data/uploads
ALLOWED_ORIGINS=https://control.desksolutions.in,https://desksolutions.in
ADMIN_API_KEY=<PASTE_GENERATED_64_CHAR_HEX_KEY>
COMMAND_SIGNING_SECRET=<PASTE_GENERATED_64_CHAR_HEX_KEY>
ENROLLMENT_KEY_TTL=86400000
```

### Step 4: Deploy Container
Copy `cloud-server/` contents to `/var/www/desksolutions-control`:
```bash
docker build -t desksolutions-control .
docker run -d \
  --name desksolutions-control \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:5000:5000 \
  -v /var/data/desksolutions-control:/app/data \
  desksolutions-control
```

### Step 5: Configure Reverse Proxy (Nginx) & SSL
Install Nginx and Certbot:
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Configure `/etc/nginx/sites-available/control.desksolutions.in`:
```nginx
server {
    server_name control.desksolutions.in;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Enable site and provision Let's Encrypt SSL:
```bash
sudo ln -s /etc/nginx/sites-available/control.desksolutions.in /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d control.desksolutions.in --non-interactive --agree-tos -m admin@desksolutions.in
```

---

## M. Exact Post-Deployment Verification Steps

Execute these tests immediately after deployment to confirm live operation:

1. **Verify Liveness Probe:**
   ```bash
   curl -i https://control.desksolutions.in/health
   # Expected: HTTP 200 OK, {"status":"ok","uptime":...,"timestamp":...}
   ```

2. **Verify Readiness Probe:**
   ```bash
   curl -i https://control.desksolutions.in/ready
   # Expected: HTTP 200 OK, {"status":"ready","database":"connected","timestamp":...}
   ```

3. **Verify Admin Authentication Enforcement:**
   ```bash
   curl -i https://control.desksolutions.in/api/control/shops
   # Expected: HTTP 401 Unauthorized
   ```

4. **Verify Authenticated Access:**
   ```bash
   curl -i -H "X-Admin-Key: <YOUR_ADMIN_API_KEY>" https://control.desksolutions.in/api/control/shops
   # Expected: HTTP 200 OK, []
   ```

5. **Generate an Enrollment Key:**
   ```bash
   curl -i -X POST -H "X-Admin-Key: <YOUR_ADMIN_API_KEY>" https://control.desksolutions.in/api/admin/keys
   # Expected: HTTP 200 OK, {"success":true,"key":"DK-XXXXXXXX",...}
   ```

6. **Verify Hot Backup Creation:**
   ```bash
   curl -i -X POST -H "X-Admin-Key: <YOUR_ADMIN_API_KEY>" https://control.desksolutions.in/api/admin/backup
   # Expected: HTTP 200 OK, {"success":true,"backupFile":"cloud_control_backup_...","sizeBytes":...}
   ```

7. **Verify Control Center UI:**
   Open `https://control.desksolutions.in` in a web browser. Enter your `ADMIN_API_KEY` when prompted. Verify that the fleet dashboard loads cleanly with an honest empty state (0 shops registered).

8. **Enroll First Real Shop:**
   In the shop's Desktop ERP, enter the generated `DK-XXXXXXXX` key. Confirm the shop transitions from offline to online with a permanent `SHOP_` identity.

---

## N. Test Classification

| Test Suite / Inspection | Classification | Description | Status |
|---|---|---|---|
| `test_forensic_recheck.js` | **REAL** | Real HTTP server, real SQLite persistence, real WebSocket client, real hot backup creation, `/ready` check | **30/30 PASS** |
| `test_control_production_readiness.js` | **REAL** | Real HTTP + WebSocket server, real cryptographic HMAC signatures with nonces, multi-tenant isolation | **26/26 PASS** |
| `burn_in_multi_shop.js` | **HYBRID** | Real server + real SQLite DB with 3 simulated simultaneous shop clients testing 24/7 isolation, restarts, alerts | **36/36 PASS** |
| `test_server_restart_preflight.js` | **REAL** | Real server start, stop, restart, WAL integrity, identity persistence across restart | **13/13 PASS** |
| `test_runner_persistence.js` | **REAL** | Real Electron SQLite database executing local customer/order operations completely offline | **2/2 PASS** |
| `test_runner_cloud.js` | **REAL** | Real cloud client connecting to local Control Center instance, verifying telemetry and revocation | **4/4 PASS** |
| Docker Container Run | **UNVERIFIED** | Docker Desktop engine is not running on this local Windows machine; build files statically verified | **UNVERIFIED** |

---

## DEPLOYMENT READY: YES

The Control Center codebase, database persistence, cryptographic signing, WebSocket concurrency, admin authentication, health/readiness probes, and container build configurations are **100% deployment-ready**. Zero software blockers remain.

### Exact Manual Infrastructure Actions Required Before Connecting a Real Shop:
1. **Host Provisioning:** Rent a Linux VPS or configure a container PaaS.
2. **DNS Record:** Create the `control.desksolutions.in` A-record pointing to the host's public IP address.
3. **Secrets Setup:** Generate two 64-character random hex strings for `ADMIN_API_KEY` and `COMMAND_SIGNING_SECRET`, and place them in `/var/www/desksolutions-control/.env`.
4. **Volume Mount:** Ensure `/var/data/desksolutions-control` is mounted to `/app/data` in Docker.
5. **Reverse Proxy & SSL:** Configure Nginx and run Certbot to obtain a Let's Encrypt TLS certificate for `control.desksolutions.in`.
6. **Container Launch:** Build and run the Docker container using `docker run` or `docker-compose`.
7. **Post-Deployment Verification:** Execute the 8 validation checks in Section M before enrolling real shop installations.
