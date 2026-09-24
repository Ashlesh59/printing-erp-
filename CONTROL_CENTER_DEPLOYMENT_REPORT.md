# DeskSolutions Control Center & Co-Pilot — Production Deployment Report

**Target Domain**: `https://control.desksolutions.in`  
**System**: DeskSolutions Control Center + Co-Pilot + PrintShop Manager ERP  
**Report Date**: September 24, 2026  
**Status**: Ready for Production Provisioning & DNS Binding  

---

## 1. Current Architecture vs. New Architecture

### Current Architecture (Local / Single Machine)
* **Control Center**: Monolithic Node.js service running Express HTTP REST API, serving static dashboard UI (`/public/index.html`), and hosting an attached WebSocket server on path `/v1/telemetry` on port `5000`.
* **State Persistence**: Local SQLite file (`cloud_control.db`) in WAL mode accessed via `better-sqlite3`.
* **Client Binding**: Electron Desktop ERP points by default to local port `5005` or hardcoded development fallbacks.
* **Scope**: Local development & single-machine testing.

### New Architecture (Production Fleet Deployment)
* **Domain Structure**:
  * `desksolutions.in` / `www.desksolutions.in` $\rightarrow$ Public Marketing Website (Vercel, untouched & unaffected).
  * `control.desksolutions.in` $\rightarrow$ Founder Control Center & Co-Pilot Dashboard.
  * `wss://control.desksolutions.in/v1/telemetry` $\rightarrow$ Secure 24/7 WebSocket Realtime Telemetry Gateway.
* **Backend Tier**:
  * **Option A (Recommended — Unified Persistent Host)**: Deploy `cloud-server` on Railway, Render, Fly.io, DigitalOcean App Platform, or a Linux VPS / Docker container. Serves both the web UI, REST API, and maintains persistent WebSocket TCP connections for the whole fleet on `control.desksolutions.in`.
  * **Option B (Hybrid Vercel + Backend Gateway)**: Control Center web UI hosted on Vercel at `control.desksolutions.in` with API rewrites pointing to `api-control.desksolutions.in` for persistent WebSocket connections.
* **Database Tier**: Persistent storage via managed PostgreSQL (`DATABASE_URL`) in production or persistent disk volume for SQLite WAL.
* **Client Tier**: Desktop PrintShop Manager ERP connects securely to `https://control.desksolutions.in` and `wss://control.desksolutions.in/v1/telemetry`. Fully preserves 100% offline POS and printing operation when internet connectivity drops.

---

## 2. Files Changed & Created

| File | Type | Summary of Changes |
| :--- | :--- | :--- |
| [`cloud-server/server.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/server.js) | Hardened | Added dynamic CORS origins from `ALLOWED_ORIGINS`, added security response headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-XSS-Protection`), parameterized database path and port. |
| [`src/main/cloud-client.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/cloud-client.js) | Updated | Configured default production endpoints to `https://control.desksolutions.in` and `wss://control.desksolutions.in/v1/telemetry`. Robust environment variable overrides (`CLOUD_SERVER_URL`, `CLOUD_MASTER_URL`). |
| [`.env.example`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/.env.example) | Created | Root environment variable template documenting all server, database, security, and client configurations. |
| [`cloud-server/.env.example`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/.env.example) | Created | Server-specific environment template for production deployment. |
| [`cloud-server/vercel.json`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/vercel.json) | Created | Vercel deployment specification with security headers and API reverse proxy routing. |
| [`cloud-server/Dockerfile`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/Dockerfile) | Created | Production container manifest for 1-click persistent cloud host deployment (Railway/Render/Fly.io/VPS). |
| [`.gitignore`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/.gitignore) | Updated | Ignored SQLite temporary runtime lock and WAL files (`*.db-wal`, `*.db-shm`). |
| [`test_control_production_readiness.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/test_control_production_readiness.js) | Created | 26-step automated test suite verifying security headers, enrollment keys, Shop ID permanence, HMAC signatures, multi-tenant isolation, and Co-Pilot queries. |

---

## 3. Environment Variables Specification

```ini
# Environment Mode
NODE_ENV=production

# HTTP / WebSocket Server Port
PORT=5000

# Allowed CORS Origins (Comma-separated)
ALLOWED_ORIGINS=https://control.desksolutions.in,https://desksolutions.in,http://localhost:5000,http://127.0.0.1:5000

# Founder / Administrator Operational Secret
CONTROL_CENTER_SECRET=generate-a-strong-random-secret-in-production

# Persistent Database (PostgreSQL URL for scalable cloud deployment)
# Leave blank for local/single-instance SQLite storage
DATABASE_URL=

# SQLite Local Database File Path (fallback if DATABASE_URL is empty)
DB_PATH=cloud_control.db

# Desktop ERP Client Cloud Endpoints
CLOUD_SERVER_URL=https://control.desksolutions.in
CLOUD_MASTER_URL=wss://control.desksolutions.in/v1/telemetry
```

---

## 4. Vercel Configuration Details

For deploying the Control Center Frontend on Vercel:

```json
{
  "version": 2,
  "name": "control-desksolutions",
  "cleanUrls": true,
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "SAMEORIGIN" },
        { "key": "X-XSS-Protection", "value": "1; mode=block" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ],
  "routes": [
    {
      "src": "/api/(.*)",
      "dest": "https://api-control.desksolutions.in/api/$1"
    },
    {
      "src": "/(.*)",
      "dest": "/public/$1"
    }
  ]
}
```

> [!IMPORTANT]
> **Vercel Serverless Constraint**: Vercel functions cannot hold open persistent WebSocket connections or run continuous background intervals for offline health scanning. The WebSocket telemetry layer (`/v1/telemetry`) **must** reside on persistent infrastructure (e.g. Railway, Render, Fly.io, or VPS).

---

## 5. Backend & Realtime Requirements

* **Persistent Node.js Process**: Required for keeping open long-lived TCP/WebSocket connections from all enrolled Shop PCs.
* **Bidirectional Telemetry**:
  * Inbound: System metrics (CPU, RAM, DB health, printer queues) every 30–60 seconds.
  * Outbound: Immediate push of HMAC-SHA256 signed capability commands.
* **Background Health Monitor**: 30-second interval detecting disconnected shops (>10 minutes without heartbeat) and creating deduplicated `SHOP_OFFLINE` alerts.

---

## 6. Database Requirements

* **Local Development / Staging**: SQLite in WAL mode (`better-sqlite3`).
* **Production Fleet**: Managed PostgreSQL database (Supabase, Neon, AWS RDS, or Railway PostgreSQL) or persistent SSD block storage attached to the persistent backend container.
* **Schema Tables**: `shops`, `heartbeats`, `remote_commands`, `enrollment_keys`, `alerts`, `audit_logs`, `diagnostics`, `errors`, `updates`, `pending_orders`.

---

## 7. DNS Requirements for `control.desksolutions.in`

To connect the subdomain **without touching or disturbing** the main website `desksolutions.in`:

| Host / Subdomain | Type | Target / Value | Purpose |
| :--- | :--- | :--- | :--- |
| `control` | **CNAME** | `<your-backend-host>.railway.app` *(or `cname.vercel-dns.com` if using Vercel UI)* | Routes `control.desksolutions.in` to the Control Center service |

* **Apex Domain Safety**: The root records (`@` / `desksolutions.in` and `www`) remain completely untouched on their existing nameservers/Vercel configuration.

---

## 8. Verification & Test Evidence

### Local Test Results
1. **Production Readiness Suite ([`test_control_production_readiness.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/test_control_production_readiness.js))**:
   * **26/26 Tests Passed (100%)**
   * Verified: Security response headers, 24h enrollment key generation, permanent Shop ID assignment, single-use key enforcement, multi-tenant isolation between Shop 1 and Shop 2, authenticated WebSocket handshake, telemetry persistence, HMAC-SHA256 signed remote command execution and ACK, and Co-Pilot intelligence queries.
2. **Multi-Shop Burn-In Fleet Test ([`burn_in_multi_shop.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/burn_in_multi_shop.js))**:
   * **35/35 Tests Passed (100%)**
   * Verified: Simultaneous connections, anti-replay nonce defenses, alert deduplication and resolution, server restart state persistence, and 100% offline-first ERP operational independence.

### Production Readiness Evidence
* **Implemented & Verified Locally**:
  * Server CORS and security headers.
  * Parameterized domain configuration (`control.desksolutions.in`).
  * Cryptographic signing & verification of remote commands.
  * Offline resilience and retry mechanisms.
* **Pending External Infrastructure Execution**:
  * DNS CNAME record propagation at domain registrar for `control.desksolutions.in`.
  * Deployment of container image or git repository to the persistent host (Railway/Render/Fly.io/VPS).

---

## 9. Exact Commands to Run

### 1. Start Control Center Locally
```powershell
$env:ELECTRON_RUN_AS_NODE="1"; npx electron cloud-server/server.js
```
* **Browser Dashboard URL**: `http://localhost:5000/`
* **WebSocket Endpoint**: `ws://localhost:5000/v1/telemetry`

### 2. Start Desktop ERP Client
```powershell
npm start
```

### 3. Run Automated Production Readiness Test Suite
```powershell
$env:ELECTRON_RUN_AS_NODE="1"; npx electron test_control_production_readiness.js
```

### 4. Run Multi-Shop Fleet Burn-In Suite
```powershell
$env:ELECTRON_RUN_AS_NODE="1"; npx electron burn_in_multi_shop.js
```

---

## 10. Security Considerations

1. **Zero Arbitrary Execution**: No `eval`, arbitrary shell execution, or remote JavaScript execution. Only whitelisted capabilities (`lock`, `restart`, `request_diagnostics`, `request_backup`, `check_updates`, `reconnect`) are permitted.
2. **Cryptographic Signatures**: Every command is signed with HMAC-SHA256 using the shop's private token, timestamped (5-minute TTL), and guarded with nonces against replay attacks.
3. **Permanent Shop ID Rule**: `1 Installation = 1 Permanent Shop ID`. Shop IDs are generated once upon valid enrollment and immutable thereafter.
4. **Audit Trail**: Every administrative action, enrollment event, and command dispatch is permanently recorded in `audit_logs`.
5. **Offline Data Sovereignty**: Local print shop customer data, invoices, and GST records remain stored in the local encrypted SQLite database on the shop computer and are never leaked to external unauthenticated sources.
