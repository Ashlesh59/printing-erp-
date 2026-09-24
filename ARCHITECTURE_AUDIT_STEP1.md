# DeskSolutions — Step 1: Architecture Audit & Safe Organization

**Project**: DeskSolutions / PrintShop Manager  
**Audit Date**: September 24, 2026  
**Auditor**: Antigravity Engineering (Pair Programming Assistant)  
**Status**: Step 1 Complete (Audit Only — Zero Destructive Changes)  

---

## Executive Summary

DeskSolutions is an offline-first desktop business software (ERP) for print shops, combined with a centralized founder fleet management platform (Control Center) and public web properties.

This audit confirms:
1. **Local Data Isolation**: Every shop's business data (customers, orders, inventory, pricing, payments, GST, print jobs) resides **100% locally** in that shop's SQLite database (`database.db`).
2. **Zero Cloud Business Data Leakage**: No shop customer, financial, production, or inventory data is transmitted to the cloud. The communication layer transmits **strictly operational telemetry** (heartbeat, CPU/RAM metrics, uptime, version, error logs, and signed command acknowledgments).
3. **Fleet Control Boundary**: The Control Center (`cloud-server/`) is strictly a fleet manager and Co-Pilot assistant; it does **not** act as a centralized ERP database.
4. **Architecture Stability**: The existing Electron ERP, local SQLite architecture, IPC security guards, and local LAN mobile ordering work offline without external network dependence.

---

## 1. High-Level Target Architecture

```text
DeskSolutions
│
├── desksolutions.in
│       └── Public Marketing Website (Independent Web App / Static Host)
│
├── control.desksolutions.in
│       └── Founder Control Center (Persistent Fleet Server: Express + WebSockets + Fleet SQLite)
│
└── Shop PCs
        ├── Shop 001 → Electron Desktop ERP → Local SQLite (100% Offline-First)
        ├── Shop 002 → Electron Desktop ERP → Local SQLite (100% Offline-First)
        └── Shop 003 → Electron Desktop ERP → Local SQLite (100% Offline-First)
```

---

## 2. Current Folder Structure

```text
Printing erp/
├── .env.example                               # Root environment configuration template
├── package.json                               # Desktop ERP Electron manifest & build config
├── package-lock.json
│
├── src/                                       # DESKTOP ERP APPLICATION CORE
│   ├── main/                                  # Electron Main Process
│   │   ├── main.js                            # App lifecycle, window management, guarded IPC handlers
│   │   ├── cloud-client.js                    # Fleet telemetry client (WebSocket + Heartbeat + HMAC Commands)
│   │   ├── cloud-sync.js                      # Optional incoming customer order poller (Supabase)
│   │   ├── server.js                          # Local LAN Wi-Fi Mobile Order Server (Port 3000)
│   │   ├── mobile-order.html                  # Local LAN ordering interface served to customer phones
│   │   ├── print-worker.html                  # Hidden background worker for document printing
│   │   ├── printer.js                         # Printing execution & unified PDF generator
│   │   ├── device-manager.js                  # Printer & scanner hardware detection
│   │   ├── document-engine.js                 # PDF page editing, rotation, stamp, watermark, split/merge
│   │   ├── document-validator.js              # PDF structural integrity & prepress validation
│   │   ├── doc-converter.js                   # Office & image conversion engine
│   │   ├── smart-scheduler.js                 # Production queue scheduling algorithms
│   │   ├── janitor.js                         # Temporary file & cache automated cleanup
│   │   ├── watcher.js                         # Watch-folder auto-importer
│   │   │
│   │   ├── database/                          # LOCAL SQLITE PERSISTENCE LAYER
│   │   │   ├── db.js                          # SQLite connection factory (WAL mode, pragma tuning)
│   │   │   ├── schema.js                      # Table definitions (orders, customers, inventory, etc.)
│   │   │   ├── models.js                      # Domain models (Order, Customer, Settings, User, Pricing)
│   │   │   ├── gst-model.js                   # GST invoicing & tax calculation models
│   │   │   ├── inventory-model.js             # Inventory, recipes, stock transfers, suppliers, POs
│   │   │   ├── production-model.js            # Print queue & machine workload models
│   │   │   ├── migrations.js                  # 21 automated versioned database migrations
│   │   │   ├── repositories/                  # Low-level query access objects
│   │   │   └── services/                      # Backup service & DB health checker
│   │   │
│   │   ├── events/                            # EVENT-DRIVEN ARCHITECTURE (EDA)
│   │   │   ├── EventBus.js                    # In-process asynchronous event bus
│   │   │   ├── EventMiddleware.js             # Validation, logging, performance middlewares
│   │   │   └── *.events.js                    # Domain subscribers (order, inventory, printer, etc.)
│   │   │
│   │   ├── security/                          # SECURITY & RBAC SUBSYSTEM
│   │   │   ├── ipc-guard.js                   # Role-Based Access Control (Admin, Operator, Public)
│   │   │   ├── session-manager.js             # User session & timeout management
│   │   │   ├── pin-security.js                # Argon2/PBKDF2 PIN hashing & salt management
│   │   │   ├── auth-throttle.js               # Brute-force rate limiting
│   │   │   └── license-service.js             # Offline Ed25519 digital cryptographic license verification
│   │   │
│   │   └── services/                          # HIGH-LEVEL BUSINESS LOGIC
│   │       ├── order-service.js               # Atomic transactional order placement & state machine
│   │       ├── pricing-engine.js              # Dynamic cost & quote calculations
│   │       ├── integrity-service.js           # Purchasing & inventory integrity verifier
│   │       ├── reconciliation-service.js      # Shift balance & cash drawer reconciliation
│   │       ├── printing/                      # Direct printer spooling drivers
│   │       └── purchasing/                    # Vendor ledger & purchasing workflow
│   │
│   ├── preload/                               # CONTEXT BRIDGE & IPC ISOLATION
│   │   ├── preload.js                         # Main window secure contextBridge (window.api)
│   │   └── print-worker-preload.js            # Print worker sandboxed contextBridge
│   │
│   └── renderer/                              # DESKTOP ERP USER INTERFACE
│       ├── index.html                         # Unified Desktop ERP Single-Page Dashboard
│       ├── css/                               # Module stylesheets (workspace, inventory, customer, etc.)
│       ├── js/                                # Renderer controllers (app.js, inventory.js, doc-workspace.js)
│       └── budget-tracker/                    # Embedded personal expense tracker mini-app
│
├── cloud-server/                              # FOUNDER CONTROL CENTER BACKEND
│   ├── server.js                              # Express REST API + WebSocket Telemetry Gateway (/v1/telemetry)
│   ├── package.json                           # Control Center server dependencies
│   ├── Dockerfile                             # Container spec for persistent cloud deployment (Port 5000)
│   ├── vercel.json                            # Vercel reverse proxy / headers routing spec
│   ├── .env.example                           # Server environment template
│   ├── cloud_control.db                       # Control Center SQLite fleet database
│   └── public/                                # CONTROL CENTER FOUNDER DASHBOARD
│       └── index.html                         # Responsive web UI (Overview, Shops, Alerts, Co-Pilot)
│
├── customer-portal/                           # EXPERIMENTAL ONLINE WEB UPLOAD PORTAL
│   ├── index.html                             # Customer-facing web upload form (Supabase)
│   └── vercel.json
│
├── scripts/                                   # OFFLINE UTILITIES
│   └── generate_license.js                    # Ed25519 license generator for founder
│
├── test_*.js                                  # TEST SUITES
│   ├── test_control_production_readiness.js   # 26-step automated test suite for Control Center
│   ├── test_runner_cloud.js                   # Cloud client connection & HMAC command test
│   ├── test_runner_persistence.js             # Offline local ERP persistence test
│   ├── burn_in_multi_shop.js                  # 36-step 24/7 multi-shop fleet burn-in test
│   └── test_phase1..6_*.js                    # Core ERP domain integration suites
│
└── (Scratch / Temporary Files)
    ├── check_db*.js, scratch.txt, etc.       # Development debug scripts to be safely archived
    └── server.log, renderer_error.log
```

---

## 3. Current Application Boundaries

| Domain | Runtime | Target Deployment | Purpose | Local State vs Remote State |
| :--- | :--- | :--- | :--- | :--- |
| **Desktop ERP** | Electron (Node + Chromium) | Windows PC (Shop Counter / Workstation) | Complete shop point-of-sale, job tracking, inventory, purchasing, printing, billing, and GST. | **100% Local**: All shop data stored in local SQLite. Operates without internet. |
| **Control Center** | Node.js (Express + `ws` + better-sqlite3) | `control.desksolutions.in` (Container / VPS) | Centralized fleet oversight for the founder. Enrolls shops, tracks heartbeats, dispatches signed diagnostic/maintenance commands, resolves alerts, powers Co-Pilot. | **Fleet Telemetry Only**: Stores shop metadata, heartbeat timestamps, hardware metrics, alerts, audit logs, and command states. No customer/order business data. |
| **Public Website** | Static / Jamstack | `desksolutions.in` | Public marketing, product feature showcases, contact information. | **Zero ERP Data**: Pure marketing site. |
| **Local Wi-Fi Mobile Order Server** | Embedded Express inside Desktop ERP | Shop Local Area Network (`192.168.x.x:3000`) | Allows in-shop customers to scan a QR code at the counter and upload documents directly from their phone over local Wi-Fi. | **100% Local**: Direct transfer from phone to local desktop ERP memory/disk. Never touches any cloud server. |

---

## 4. Current Data Flow

```text
[In-Shop Customer Phone]
        │ (Local Wi-Fi upload via QR code)
        ▼
[Local Mobile Server (src/main/server.js:3000)]
        │
        ▼
[OrderService (src/main/services/order-service.js)]
        │
        ▼
[Local Shop SQLite (database.db)] ◄───► [Desktop ERP UI (src/renderer)]
        │                                  (Operator POS, Billing, Print Queue)
        │
        │ (NO BUSINESS DATA TRANSMITTED)
        │ Only Hardware Metrics & System Status
        ▼
[CloudClient (src/main/cloud-client.js)]
        │
        │ WebSocket Telemetry (wss://control.desksolutions.in/v1/telemetry)
        │ - Heartbeat (uptime, RAM, CPU, version, dbStatus: 'healthy')
        │ - Error Reports (stack trace, errorType)
        │ - Diagnostics (OS platform, Node version)
        │ - Command Acknowledgments (commandId, status)
        ▼
[Founder Control Center (cloud-server/server.js)]
        │
        ▼
[Fleet SQLite Database (cloud_control.db)]
        │
        ▼
[Founder Dashboard & Co-Pilot (control.desksolutions.in)]
```

---

## 5. Current Local Database Location

The local Desktop ERP database is managed by [`src/main/database/db.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/db.js):

- **Production Windows Location**:  
  `%APPDATA%\printshopmanager\database\database.db`  
  (Resolved dynamically via `app.getPath('userData')/database/database.db`)
- **Non-Electron Test Execution Fallback**:  
  `Printing erp/database/database.db` or path provided in `process.env.TEST_DB_PATH`
- **Engine**: SQLite 3 via `better-sqlite3`
- **Storage Mode**: WAL (Write-Ahead Logging) mode, `synchronous = NORMAL`, `foreign_keys = ON`
- **Contained Tables**:
  - `customers`, `customer_notes`, `customer_documents`
  - `orders`, `order_items`, `order_status_history`, `payments`
  - `inventory_items`, `inventory_categories`, `inventory_transactions`, `inventory_reservations`
  - `suppliers`, `purchase_orders`, `purchase_order_items`, `goods_receipts`, `supplier_bills`, `supplier_payments`, `purchase_returns`
  - `gst_invoices`, `gst_invoice_items`, `gst_settings`
  - `print_jobs`, `print_profiles`, `printer_groups`, `printer_calibrations`, `print_audit_logs`
  - `users`, `activity_logs`, `event_history`, `settings`

---

## 6. Current Control Center Database Location

The Control Center fleet database is managed by [`cloud-server/server.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/server.js):

- **File Path**: `cloud-server/cloud_control.db` (configurable via `process.env.DB_PATH`)
- **Engine**: SQLite 3 via `better-sqlite3` in WAL mode
- **Contained Tables**:
  1. `shops`: Permanent Shop ID (`SHOP_XXXXXX`), name, registration timestamp, status (`active` / `revoked`), authentication token hash, enrollment metadata.
  2. `heartbeats`: Shop ID, application version, system uptime, last-seen timestamp, IP address, hostname, memory usage, CPU usage, local database health flag (`healthy`), system metrics JSON.
  3. `remote_commands`: Command ID, target Shop ID, command name, status (`pending`, `dispatched`, `success`, `rejected`), timestamp, expiration (TTL), nonce, HMAC-SHA256 signature, execution result JSON, acked timestamp.
  4. `enrollment_keys`: Enrollment key string (`DK-XXXX`), single-use flag (`used`), associated Shop ID, creation timestamp, expiration timestamp, revocation status (`revoked`).
  5. `alerts`: Alert ID, Shop ID, type (`SHOP_OFFLINE`, `APP_ERROR`, `UPDATE_FAILED`), severity (`info`, `warning`, `critical`), message, details JSON, status (`active`, `acknowledged`, `resolved`), resolved timestamp.
  6. `audit_logs`: Audit ID, Shop ID, action name, actor (`ADMIN`, `SYSTEM`, `CLIENT`), details, timestamp, client IP address.
  7. `diagnostics`: Diagnostics ID, Shop ID, metrics JSON, health status, timestamp.
  8. `errors`: Error ID, Shop ID, error type, error message, stack trace, timestamp, resolved flag.
  9. `updates`: Shop ID, installed version, available version, update status, download progress percentage, last check timestamp, error string.
  10. `pending_orders`: Vestigial dormant table declaration (see Section 7).

---

## 7. Cloud-Data Leakage Audit (CRITICAL)

An exhaustive code audit was conducted across every network egress point in the repository:

### Audit Results:
| Component | Audit Finding | Status |
| :--- | :--- | :--- |
| [`src/main/cloud-client.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/cloud-client.js) | Only transmits hardware telemetry (RAM, CPU, OS platform, uptime, version, db status: 'healthy'), error stack traces, diagnostics, and command ACKs. **Zero customer or financial data transmitted.** | ✅ **CLEAN** |
| [`src/main/server.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/server.js) | Local Express server strictly binds to local LAN (`0.0.0.0:3000`). Communicates only with in-shop phones over shop Wi-Fi. **No cloud egress.** | ✅ **CLEAN** |
| [`src/preload/preload.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/preload/preload.js) | Exposes `window.api` using Electron `contextBridge`. Invokes only local IPC handlers. | ✅ **CLEAN** |
| `src/renderer/js/*.js` | No `fetch()` or external HTTP calls in renderer JavaScript. All actions route through local IPC. | ✅ **CLEAN** |
| [`src/main/cloud-sync.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/cloud-sync.js) | Legacy/optional poller for web-submitted orders. It reads incoming orders *from* an external customer portal (Supabase) and writes them *down* into the local SQLite database. **It never uploads or syncs shop data up to the cloud.** | ✅ **CLEAN** |
| `cloud-server/server.js` (line 140) | Contains a dormant `CREATE TABLE IF NOT EXISTS pending_orders (...)` statement. **There are zero endpoints in `server.js` that insert, query, or expose this table.** It is an unused leftover from an early concept. | ⚠️ **Vestigial (Safe to remove in Step 2)** |

### Conclusion on Data Leakage:
**Zero accidental business data leakage was found.** All shop business data remains strictly local on each shop's computer.

---

## 8. Current Localhost Dependencies

1. **Local Wi-Fi Mobile Order Server**:
   - `src/main/server.js` binds to port `3000` (or `3000-3010`) on local IP (`192.168.x.x` / `127.0.0.1`).
   - This is **by design** for in-shop customer phone printing over local Wi-Fi.
2. **Control Center Server Defaults**:
   - `cloud-server/server.js` listens on port `5000` (`process.env.PORT || 5000`).
   - CORS configuration accepts `http://localhost:5000` and `http://127.0.0.1:5000` for development and testing.
3. **Test Suites**:
   - `test_control_production_readiness.js`, `test_runner_cloud.js`, and `burn_in_multi_shop.js` spin up or connect to `http://127.0.0.1:5000`, `5006`, or `5890`.

---

## 9. Files That Should Remain Untouched

These files are battle-tested and must **not** be modified, rewritten, or refactored:

1. **Local SQLite Engine & Models**:
   - [`src/main/database/db.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/db.js)
   - [`src/main/database/schema.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/schema.js)
   - [`src/main/database/models.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/models.js)
   - [`src/main/database/gst-model.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/gst-model.js)
   - [`src/main/database/inventory-model.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/inventory-model.js)
   - [`src/main/database/production-model.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/production-model.js)
   - [`src/main/database/migrations.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/migrations.js)
   - [`src/main/database/repositories/*`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/database/repositories/)
2. **Local Business Logic & Printing**:
   - [`src/main/services/order-service.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/services/order-service.js)
   - [`src/main/services/pricing-engine.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/services/pricing-engine.js)
   - [`src/main/printer.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/printer.js)
   - [`src/main/document-engine.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/document-engine.js)
   - [`src/main/document-validator.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/document-validator.js)
   - [`src/main/device-manager.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/device-manager.js)
   - [`src/main/smart-scheduler.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/smart-scheduler.js)
   - [`src/main/security/*`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/security/)
   - [`src/main/events/*`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/events/)
3. **Local Wi-Fi Ordering Engine**:
   - [`src/main/server.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/server.js)
   - [`src/main/mobile-order.html`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/main/mobile-order.html)
4. **Preload & Renderer UI**:
   - [`src/preload/preload.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/preload/preload.js)
   - [`src/preload/print-worker-preload.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/preload/print-worker-preload.js)
   - [`src/renderer/index.html`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/renderer/index.html)
   - [`src/renderer/css/*`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/renderer/css/)
   - [`src/renderer/js/*`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/src/renderer/js/)
5. **Existing Verification Test Suites**:
   - `test_phase1_security.js` through `test_phase6_hardening.js`
   - `test_control_production_readiness.js`
   - `burn_in_multi_shop.js`

---

## 10. Files That Will Eventually Need Modification

Only targeted configuration and deployment adjustments are needed in future steps:

1. [`cloud-server/server.js`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/server.js):
   - Safely remove dormant `pending_orders` table declaration (lines 140-151) to eliminate confusion.
   - Ensure `DB_PATH` properly defaults to a mounted volume in cloud environments (e.g. `/data/cloud_control.db` on Railway/Fly.io).
2. [`cloud-server/vercel.json`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/vercel.json):
   - Review route proxying if the Control Center frontend is served by Vercel while the backend WebSocket service runs on a persistent cloud host.
3. [`.env.example`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/.env.example) & [`cloud-server/.env.example`](file:///c:/Users/Ashlesh001/OneDrive/Desktop/Printing%20erp/cloud-server/.env.example):
   - Ensure documented production defaults point to `https://control.desksolutions.in` and `wss://control.desksolutions.in/v1/telemetry`.
4. **Root Housekeeping (Safe Archival Only)**:
   - Root-level one-off scripts (`check_db*.js`, `extract.js`, `scratch.*`, `scratch_*.html`, `workspace-new.html`) should eventually be moved into an `archive/` or `tools/` folder so the root folder remains clean and production-grade.

---

## 11. Recommended Final Folder Structure

To maintain maximum safety, the directory structure will retain current paths for the Desktop ERP and Control Center while organizing documentation and archiving one-off scripts:

```text
DeskSolutions/
├── apps/ (or current root structure preserved)
│   │
│   ├── desktop-erp/                   (= current src/)
│   │   ├── main/
│   │   ├── preload/
│   │   └── renderer/
│   │
│   ├── control-center/                (= current cloud-server/)
│   │   ├── public/                    (Founder Dashboard UI)
│   │   ├── server.js                  (API + WebSocket Telemetry Gateway)
│   │   ├── cloud_control.db           (Fleet DB)
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── website/                       (Public Website: desksolutions.in)
│
├── tests/                             (Consolidated test suites)
│   ├── test_control_production_readiness.js
│   ├── burn_in_multi_shop.js
│   └── test_phase*.js
│
└── archive/                           (Safe storage for one-off debug scripts)
```

> **Recommendation**: To avoid breaking relative paths, keep `src/` and `cloud-server/` in place at the root level during Step 2, and cleanly manage configuration without unnecessary path disruption.

---

## 12. Risks Before Proceeding & Mitigation Strategies

| Risk | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **Native Binary ABI Mismatch** (`better-sqlite3`) | `better-sqlite3` compiled for Electron (NODE_MODULE_VERSION 145) fails when run with system Node (NODE_MODULE_VERSION 137). | Control Center in production must run in Docker or on Node 20 with its own compiled `better-sqlite3`, while Desktop ERP uses Electron's prebuilt binaries. Tests involving Electron code should be run with `npx electron`. |
| **Hosting Misconception: Control Center on Pure Serverless** | Serverless platforms (like plain Vercel functions) terminate WebSocket connections and have ephemeral filesystems incompatible with SQLite WAL. | Deploy the Control Center backend (`cloud-server`) on a persistent host (Railway, Render, Fly.io, or VPS) with persistent disk storage, ensuring 24/7 WebSocket telemetry connectivity. The frontend UI can optionally be served via Vercel if proxied. |
| **Confusion Between Local Order Server and Control Center** | Operators or developers might mistake `src/main/server.js` (local Wi-Fi order server) for `cloud-server/server.js` (fleet control server). | Clear naming and strict boundary documentation established: `src/main/server.js` is the Local In-Shop Wi-Fi server; `cloud-server/server.js` is the Founder Fleet Control server. |
| **Accidental Cloud Migration of Shop Data** | If someone attempts to sync orders/customers to the cloud, shop privacy and offline capabilities are broken. | Architecture rule strictly codified: local SQLite remains 100% authoritative for business data. Control Center stores only fleet management data. |

---

## 13. Audit Checklist Summary

- [x] Verified local SQLite database path and persistence mechanics
- [x] Verified Control Center database path and persistence mechanics
- [x] Inspected all 18 specific files and directories requested
- [x] Audited all network egress points for accidental cloud data leakage (Confirmed: 0% business data leakage)
- [x] Tested Control Center production readiness test suite (26/26 passed)
- [x] Tested Multi-shop 24/7 burn-in test suite (36/36 passed)
- [x] Tested offline-first persistence test suite (Passed)
- [x] Verified HMAC-SHA256 remote command security and anti-replay defenses
- [x] Identified files to remain untouched vs files needing configuration updates
- [x] Documented architecture risks and mitigations
