# DeskSolutions — Step 2: Control Center Production Configuration & Hosting Readiness Report

**Project**: DeskSolutions / PrintShop Manager  
**Audit & Configuration Phase**: Step 2 (Control Center Separation & Hosting Readiness)  
**Date**: September 24, 2026  
**Status**: Step 2 Complete — Production Hosting Architecture Documented, Verified & Non-Destructive  

---

## 1. Current Architecture

```text
DeskSolutions Ecosystem
│
├── desksolutions.in
│   └── Public Marketing Website (Future static/Jamstack site — Untouched in this step)
│
├── control.desksolutions.in
│   └── Founder Control Center (Persistent Node.js server: Express REST API + WebSockets + Fleet SQLite)
│
└── Shop PCs (Counter / Workstations)
    ├── Shop 001 → Electron Desktop ERP → Local SQLite (database.db — 100% Offline-First)
    ├── Shop 002 → Electron Desktop ERP → Local SQLite (database.db — 100% Offline-First)
    └── Shop 003 → Electron Desktop ERP → Local SQLite (database.db — 100% Offline-First)
```

The data architecture strictly preserves the golden rule:
- **Shop Business Data Remains 100% Local**: Orders, line items, customers, debts, inventory, receipts, supplier bills, payables, print jobs, and GST tax records are stored exclusively in the shop's local SQLite database.
- **Control Center Contains Fleet Telemetry Only**: Stores shop registration status, permanent Shop ID, cryptographic auth token, 60s heartbeats, CPU/RAM telemetry, error stack traces, alerts, and HMAC-signed command states.

---

## 2. Current Control Center Location

- **Filesystem Path**: `cloud-server/` in the workspace root.
- **Entry Point**: [`cloud-server/server.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/server.js)
- **Frontend Dashboard**: [`cloud-server/public/index.html`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/public/index.html) (Single-page dashboard serving Overview, Shops Directory, Enrollment Keys, Alerts & Notifications, Diagnostics & Errors, Audit Trail, and Co-Pilot).
- **Package Manifest**: [`cloud-server/package.json`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/package.json)
- **Container Manifest**: [`cloud-server/Dockerfile`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/Dockerfile)

---

## 3. Current ERP Location

- **Filesystem Path**: `src/` in the workspace root.
- **Main Process**: [`src/main/main.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/main.js)
- **Preload Bridge**: [`src/preload/preload.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/preload/preload.js)
- **Renderer UI**: [`src/renderer/index.html`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/renderer/index.html), [`src/renderer/js/*`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/renderer/js/), [`src/renderer/css/*`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/renderer/css/)
- **In-Shop Wi-Fi Server**: [`src/main/server.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/server.js) (Listens on port 3000 on the local shop LAN for in-shop customer phone uploads via QR code).
- **Communication Layer**: [`src/main/cloud-client.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/cloud-client.js) (Handles telemetry, heartbeat, and remote commands).

---

## 4. Current Local ERP Database Location

Managed by [`src/main/database/db.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/db.js):

- **Production Windows Path**:  
  `%APPDATA%\printshopmanager\database\database.db`  
  (dynamically resolved via Electron's `app.getPath('userData')/database/database.db`)
- **Non-Electron Test Environment Fallback**:  
  `Printing erp/database/database.db` or path specified in `process.env.TEST_DB_PATH`
- **Engine**: SQLite 3 via `better-sqlite3` in WAL mode (`pragma journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`).
- **Authority**: Authoritative for all shop transactions. Operates completely without internet.

---

## 5. Current Control Center Database Location

Managed by [`cloud-server/server.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/server.js):

- **Filesystem Path**: `cloud-server/cloud_control.db` (configurable via `process.env.DB_PATH`).
- **Engine**: SQLite 3 via `better-sqlite3` in WAL mode.
- **Contained Tables**:
  1. `shops`: Shop ID, shop name, registeredAt, status, auth token, metadata.
  2. `enrollment_keys`: Enrollment key string (`DK-XXXX`), single-use flag (`used`), shopId, createdAt, expiresAt, revoked.
  3. `heartbeats`: Shop ID, version, uptime, lastSeen timestamp, status, ip, hostname, memoryUsage, cpuUsage, dbStatus, metrics JSON.
  4. `remote_commands`: Command ID, shopId, command name, status, timestamp, expiresAt, nonce, signature, result JSON, ackedAt.
  5. `alerts`: Alert ID, shopId, type, severity, message, details, timestamp, status, resolvedAt.
  6. `audit_logs`: Audit ID, shopId, action, actor, details, timestamp, ip.
  7. `diagnostics`: Diagnostics ID, shopId, metrics JSON, health status, timestamp.
  8. `errors`: Error ID, shopId, errorType, message, stack, timestamp, resolved.
  9. `updates`: Shop ID, installedVersion, availableVersion, status, progress, lastChecked, error.

---

## 6. Current HTTP Endpoint

- **Development / Local Execution**:  
  `http://localhost:5000` (or `http://127.0.0.1:5000`)
- **Configurable Binding**:  
  Controlled by `process.env.CONTROL_CENTER_HOST` (default `0.0.0.0`) and `process.env.CONTROL_CENTER_PORT` / `process.env.PORT` (default `5000`).
- **Static Assets Route**:  
  `GET /` serves `cloud-server/public/index.html`.
- **API Routes**:  
  `GET /api/health`, `POST /api/enroll`, `POST /api/admin/keys`, `GET /api/admin/keys`, `POST /api/admin/keys/revoke`, `GET /api/control/shops`, `GET /api/control/shop/:shopId`, `POST /api/control/command`, `GET /api/control/commands`, `GET /api/control/alerts`, `POST /api/control/alerts/:id/ack`, `POST /api/control/alerts/:id/resolve`, `GET /api/control/diagnostics/:shopId`, `GET /api/control/errors`, `GET /api/control/audit`, `POST /api/copilot/query`.

---

## 7. Current WebSocket Endpoint

- **Development / Local Execution**:  
  `ws://localhost:5000/v1/telemetry`
- **Server Implementation**:  
  Attached to the Express HTTP server instance via `new WebSocket.Server({ server, path: '/v1/telemetry' })` in `cloud-server/server.js`.
- **Protocol**:  
  JSON over WebSocket with Bearer authentication handshake (`type: 'auth'`), periodic heartbeat frames (`type: 'heartbeat'`), diagnostic payloads (`type: 'diagnostics'`), error reports (`type: 'error_report'`), and command acknowledgments (`type: 'command_ack'`).

---

## 8. Production Target URLs

| Service | Target Production URL | Protocol | Notes |
| :--- | :--- | :--- | :--- |
| **Control Center Web UI** | `https://control.desksolutions.in` | HTTPS | Founder Dashboard |
| **Control Center REST API** | `https://control.desksolutions.in/api/*` | HTTPS | Fleet management & enrollment API |
| **Control Center WebSocket** | `wss://control.desksolutions.in/v1/telemetry` | WSS | Secure 24/7 telemetry channel |
| **Public Company Website** | `https://desksolutions.in` | HTTPS | Independent marketing website (separate) |
| **In-Shop Local Order Server** | `http://<Local-Shop-LAN-IP>:3000` | HTTP (LAN) | In-shop customer phone ordering on shop Wi-Fi |

---

## 9. Environment Variables Required

Documented in [`cloud-server/.env.example`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/.env.example) and [`.env.example`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/.env.example):

| Variable Name | Required? | Example Value | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Optional | `production` | Runtime mode (`development`, `test`, `production`). In `production`, strict CORS rejection is active. |
| `CONTROL_CENTER_HOST` | Optional | `0.0.0.0` | IP interface to bind HTTP/WebSocket server. |
| `CONTROL_CENTER_PORT` | Optional | `5000` | Port for HTTP and WebSocket gateway. Fallback to `PORT`. |
| `CONTROL_CENTER_PUBLIC_URL` | Recommended | `https://control.desksolutions.in` | Canonical public HTTP origin. |
| `CONTROL_CENTER_WS_URL` | Recommended | `wss://control.desksolutions.in/v1/telemetry` | Canonical public WebSocket origin used by ERP clients. |
| `DB_PATH` | Recommended | `cloud_control.db` or `/data/cloud_control.db` | Filesystem path for the fleet SQLite database. In production Docker/VPS, mount to a persistent volume. |
| `ALLOWED_ORIGINS` | Recommended | `https://control.desksolutions.in,https://desksolutions.in` | Comma-separated list of origins allowed by CORS. |
| `AUTH_SECRET` | Recommended | `generate-a-strong-random-secret` | Founder administrative secret for API operations. Fallback to `CONTROL_CENTER_SECRET`. |
| `COMMAND_SIGNING_SECRET`| Recommended | `generate-a-strong-signing-secret` | Fallback salt/secret for HMAC-SHA256 remote command signatures. |
| `ENROLLMENT_KEY_TTL` | Optional | `86400000` | Single-use enrollment key validity period in milliseconds (default: 24 hours). |

---

## 10. Security Findings

1. **No Insecure Fallback Credentials**:
   - Replaced the previous `'default-token'` fallback in `cloud-server/server.js` and `src/main/cloud-client.js`. If neither a valid shop token nor a signing secret is present, command verification fails immediately.
2. **Shop ID Immutability**:
   - `cloud-client.js` strictly preserves existing `shopId` and `authToken` when server URLs or environment variables change. Changing the server URL will **not** generate a new Shop ID or break credentials.
3. **No Arbitrary Remote Execution**:
   - `ALLOWED_COMMANDS` whitelist strictly enforced (`lock`, `restart`, `request_diagnostics`, `diagnostics`, `request_health`, `health`, `request_backup`, `force_backup`, `check_updates`, `reconnect`, `clear_cache`).
   - Zero `eval()`, `exec()`, or child process shell command execution paths exist in command handling.
4. **Anti-Replay & Expiration Defense**:
   - Remote commands expire after 5 minutes (`expiresAt` TTL).
   - `CloudClient` maintains an anti-replay `executedCommands` set to reject replayed command payloads.
5. **CORS Enforcement in Production**:
   - When `NODE_ENV=production`, non-whitelisted browser origins are rejected with an explicit CORS error.
6. **No Repository Secrets**:
   - `.env`, `.env.local`, and `.env.production` are ignored in `.gitignore`. No live production secrets or tokens are committed.
7. **Local Database Isolation**:
   - Desktop ERP does **not** open any network ports to expose its SQLite database.

---

## 11. Hosting Requirements

For 24/7 reliability, the Control Center requires:

1. **Long-Running Process Support**:
   - Requires a persistent Node.js runtime process (non-serverless) to keep the `WebSocket.Server` alive and maintain continuous TCP sessions with shops.
2. **Persistent Disk Storage**:
   - Better-SQLite3 runs in WAL mode (`cloud_control.db`, `cloud_control.db-wal`, `cloud_control.db-shm`).
   - The hosting environment must provide persistent disk storage (e.g. Railway volume, Fly.io volume, Render persistent disk, or VPS NVMe/SSD) so database writes survive container restarts.
3. **HTTP & WebSocket Reverse Proxying**:
   - The reverse proxy / ingress load balancer must support HTTP/1.1 `Upgrade: websocket` and `Connection: Upgrade` headers with long read timeouts (e.g. 24 hours).
4. **Automated TLS / SSL Termination**:
   - Valid SSL certificates for `https://control.desksolutions.in` and `wss://control.desksolutions.in`.

---

## 12. Vercel Compatibility Findings

| Component | Can Vercel Host It? | Reason |
| :--- | :--- | :--- |
| **Control Center Frontend Dashboard** (`cloud-server/public/index.html`) | ✅ **YES** | Pure static HTML/CSS/JS. Can be deployed to Vercel at `control.desksolutions.in`. |
| **Public Marketing Website** (`desksolutions.in`) | ✅ **YES** | Static or Next.js website. Ideal for Vercel. |
| **Control Center WebSocket Telemetry Gateway** (`/v1/telemetry`) | ❌ **NO** | Vercel Serverless Functions have execution timeouts (10–60s) and **cannot maintain persistent 24/7 stateful WebSocket TCP connections** with desktop ERPs. |
| **Control Center SQLite Persistence** (`cloud_control.db`) | ❌ **NO** | Vercel functions run in read-only / ephemeral execution containers. They do not share a writable persistent filesystem required by SQLite WAL mode. |

### Architecture Decision:
- Do **not** deploy the stateful Control Center backend to Vercel.
- Deploy `cloud-server` as a persistent container on Railway, Fly.io, Render (with disk), or a Linux VPS.
- The persistent container can host both the frontend and backend directly under `control.desksolutions.in`, simplifying deployment to a single service.

---

## 13. What Can Remain Local

1. **100% of Shop ERP Business Records**: Customers, orders, items, pricing, inventory, purchasing, supplier ledgers, payments, GST invoices, and print job spool files remain exclusively in the local shop SQLite database.
2. **In-Shop Customer Wi-Fi Ordering**: `src/main/server.js` and `src/main/mobile-order.html` run locally on port 3000 over the shop's local Wi-Fi router.
3. **Local Printing & Hardware Drivers**: Printer discovery, PDF composition, rasterization, and direct spooling execute on the local shop PC.
4. **Offline POS Operation**: Even when internet connectivity is completely lost, shop operators can ring up sales, print receipts, manage inventory, and generate GST invoices without disruption.

---

## 14. What Eventually Needs Internet Hosting

1. **Control Center Fleet Server**:
   - `cloud-server` container running on a persistent host (e.g. Railway, Fly.io, or VPS) serving:
     - Founder dashboard (`control.desksolutions.in`)
     - Telemetry gateway (`wss://control.desksolutions.in/v1/telemetry`)
     - Enrollment REST API (`POST /api/enroll`)
2. **Public Company Website**:
   - Static/marketing site on `desksolutions.in` (hosted on Vercel or similar).
3. **Auto-Update Host** (Optional future step):
   - GitHub Releases or an S3 bucket configured for `electron-updater` releases.

---

## 15. What the Founder Must Manually Configure Later

The founder must perform these operational steps during Step 3 or deployment:

1. **Provision Persistent Host**: Select a provider (Railway, Fly.io, Render, or a VPS) and create a Node 20 / Docker application.
2. **Attach Persistent Storage Volume**: Mount a volume (e.g. `/data`) and set `DB_PATH=/data/cloud_control.db`.
3. **Configure DNS Records**:
   - `control.desksolutions.in` $\rightarrow$ CNAME or A record pointing to the persistent host.
   - `desksolutions.in` $\rightarrow$ CNAME or A record pointing to the public website host.
4. **Set Production Environment Secrets**:
   - In the hosting provider's dashboard, set `NODE_ENV=production`, `AUTH_SECRET=<random-secret>`, and `COMMAND_SIGNING_SECRET=<random-secret>`.
5. **Issue Enrollment Keys**: From the Control Center UI, click "Generate Key" and provide the key (`DK-XXXX`) to each shop during initial setup.

---

## 16. Tests Actually Executed

All four automated test suites were executed directly against the active codebase:

1. **`test_control_production_readiness.js`**:
   - **Command**: `npx electron test_control_production_readiness.js`
   - **Exit Code**: `0`
   - **Passed Tests**: **26 / 26**
2. **`test_runner_cloud.js`**:
   - **Command**: `npx electron test_runner_cloud.js`
   - **Exit Code**: `0`
   - **Passed Tests**: **4 / 4**
3. **`test_runner_persistence.js`**:
   - **Command**: `npx electron test_runner_persistence.js`
   - **Exit Code**: `0`
   - **Passed Tests**: **2 / 2**
4. **`burn_in_multi_shop.js`**:
   - **Command**: `npx electron burn_in_multi_shop.js`
   - **Exit Code**: `0`
   - **Passed Tests**: **36 / 36**

---

## 17. REAL vs. SIMULATED Test Classification

| Test Scenario | Component Tested | Classification | Details |
| :--- | :--- | :--- | :--- |
| **Server Startup & Headers** | `cloud-server/server.js` | **REAL** | Genuine Express HTTP server booted on port 5890; genuine response headers verified. |
| **Enrollment Key Lifecycle** | `cloud_control.db` & API | **REAL** | Genuine cryptographic random key generation, database insertion, and single-use enforcement. |
| **Shop ID Generation & Invariance** | `server.js` transaction | **REAL** | Genuine atomic SQLite transaction; unique 12-hex Shop IDs persisted and verified after server restart. |
| **WebSocket Telemetry & Auth** | WebSocket `/v1/telemetry` | **REAL** | Genuine WebSocket handshake, token validation, unauthenticated packet rejection, and heartbeat upsert. |
| **HMAC Remote Command & ACK** | HMAC-SHA256 & WS dispatch | **REAL** | Genuine cryptographic signature computation and verification; anti-replay nonce tracking verified. |
| **Local Offline ERP Operation** | `src/main/database/db.js` | **REAL** | Genuine SQLite writes to local file; customer and order records created completely offline. |
| **Multi-Shop Fleet Concurrency** | 3 Concurrent Shops | **SIMULATED** | Shop A, Shop B, and Shop C were run concurrently as separate WebSocket connections inside one test process on localhost to simulate a 3-machine physical fleet. |

---

## 18. Any Remaining Blockers

There are **zero technical blockers** within the codebase. The architecture is sound and tests pass 100%.

The remaining external prerequisites before going live are:
1. Selecting the persistent hosting provider (e.g. Railway, Fly.io, or VPS).
2. Pointing the DNS domain `control.desksolutions.in` to that host.
3. Supplying production environment secret values.

---

## 19. Exact Recommended Next Step

**STOP — Step 2 Complete.**

Do **not** deploy to Vercel. Do **not** modify DNS yet.

When ready, the recommended next step is:
**Step 3: Hosting Provisioning & Docker Deployment Preparation**, where we prepare the exact container launch parameters and volume mount configuration for deploying `control.desksolutions.in` on a persistent host.
