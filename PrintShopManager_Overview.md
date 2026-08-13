# Exhaustive Overview: PrintShopManager

This document provides a highly granular, complete technical breakdown of the **PrintShopManager** project. This is designed to serve as an absolute source of truth for an AI or developer tasked with understanding the complete scope of the application.

## 1. Core Architecture
PrintShopManager is a robust Electron.js application that does not rely on frontend frameworks like React or Vue. 
- **Frontend (Renderer):** Vanilla HTML, CSS, JavaScript (DOM manipulation).
- **Backend (Main):** Node.js.
- **Database:** SQLite (`better-sqlite3`) running locally, with Write-Ahead Logging (WAL) and automatic corruption recovery.
- **Inter-Process Communication (IPC):** A massive `contextBridge` (`src/preload/preload.js`) exposes over 100 specific backend functions to the `window.api` frontend object.

---

## 2. Exhaustive Database Schema Breakdown (`schema.js`)
The local SQLite database acts as a full Enterprise Resource Planning (ERP) backend. It tracks the following entities:

### Customer & Order Management
*   **`customers`**: name, phone (unique), email, tag, address, gstin, state, preferences.
*   **`customer_notes` & `customer_documents`**: Tracks communication and uploaded files (linked to `customers.id`).
*   **`orders`**: The unified invoice header (customer_id, total_price, status).
*   **`order_items`**: The discrete files/print configurations (print_type, paper_size, sides, pages, copies, extras_json).

### Production & Workflow (Smart Print Queue)
*   **`production_jobs`**: Represents physical printing tasks. Tracks assigned printer, operator, estimated duration, scheduled times, priority (Waiting/Normal/High), and status.
*   **`workflow_steps`**: A configurable Kanban-style workflow engine (e.g., "Order Created" -> "Designer Approval" -> "Inventory Reserve" -> "Printing" -> "Completed").
*   **`print_audit_logs` & `print_jobs`**: Enterprise audit trails tracking which file was printed to which hardware printer, who initiated it, and the exact print profile snapshot used.

### Inventory Management Module (Enterprise Level)
*   **`inventory_categories` & `inventory_locations`**: Where items are stored (e.g., "Main Warehouse", "Front Desk") and their category.
*   **`suppliers`**: Contacts for reordering stock, tracking outstanding balances.
*   **`inventory_items`**: Tracks SKU, barcode, minimum stock, maximum stock, reorder levels, purchase price, selling price, GSM, finish.
*   **`purchase_orders` & `purchase_order_items`**: Tracks restock orders sent to suppliers.
*   **`stock_transactions` & `inventory_history`**: Every single movement of stock (purchase, return, waste, damage, manual_in) is logged.
*   **`inventory_alerts` & `inventory_reservations`**: Triggers UI alerts when stock hits the `low_stock_threshold_percent`. Reservations tie pending orders to physical stock.

### Finance, Tax & Products
*   **`gst_invoices` & `gst_invoice_items`**: India-specific tax compliance, calculating CGST, SGST, IGST, and HSN/SAC codes.
*   **`products` & `print_profiles`**: Enterprise definitions for sellable items and the specific physical margins, scaling, and duplex configurations for the printer hardware.
*   **`recipes`**: Bill of Materials (BOM) linking a product to multiple inventory components.

### System & Security
*   **`users`**: Role-based access control (Admin, Manager, Operator) using SHA-256 hashed 4-digit PINs.
*   **`devices`**: Tracks which physical Windows computers have the software installed.
*   **`database_events`**: Audit log of database backups and operations.
*   **`settings` & `license`**: Core shop configuration, pricing defaults, and software activation keys.

---

## 3. The Backend Services (`src/main/`)

### Embedded Mobile Kiosk Server (`server.js`)
*   Uses `express` and `multer`.
*   Automatically scans network interfaces to find the machine's local IPv4 address.
*   Spins up an HTTP server on port 3000 (retries up to 3010 if occupied).
*   Generates a QR Code (`qrcode` library). When customers on the same Wi-Fi scan it, they see `mobile-order.html`.
*   Accepts PDF/JPG/PNG uploads (up to 100MB), creates a `Pending` order in the DB, and emits a `new-mobile-order` event to the desktop UI.
*   **Cloud Fallback:** If the owner configures a Supabase backend + Vercel frontend in settings, the QR code overrides the local IP and points to the Vercel portal URL instead.

### Document Engine & Doc Studio (`document-engine.js`, `doc-converter.js`)
Exposed to the UI for heavy document manipulation before printing. Capabilities include:
*   Rotating, deleting, reordering, and duplicating PDF pages.
*   Splitting, merging, and extracting pages from PDFs.
*   Inserting blanks, adding watermarks, page numbers, and stamps.
*   Scaling pages and cropping.
*   Converting Office documents (likely using external tools or LibreOffice bindings).

---

## 4. The Frontend IPC Bridge (`preload.js`)
The frontend never touches `require('fs')` or `better-sqlite3` directly. It communicates exclusively via `window.api`. There are over 100 methods exposed, grouped into:
1.  **Customer/Order API:** `searchCustomers`, `createOrder`, `getRecentOrders`.
2.  **Production API:** `productionGetJobs`, `productionAssignPrinter`, `productionRecommendPrinter`.
3.  **Inventory API:** `getInvItems`, `adjustInvStock`, `receiveInvPurchaseOrder`, `getInvAlerts`.
4.  **Doc Studio API:** `docRotatePages`, `docCropPages`, `docSaveProject`.
5.  **Security/System API:** `verifyPin`, `backupDatabase`, `restoreBackup`, `isDatabaseCorrupted`.
6.  **Cloud/GST API:** `updateCloudSettings`, `createGstInvoice`.

---

## 5. UI/UX Exhaustive Breakdown (`index.html` & `css/`)

The application acts as a Single Page Application (SPA), dynamically showing/hiding massive `<div>` sections.

### The 4 Primary UI States
1.  **License Activation (`#license-screen`):** Initial check against the `license` DB table.
2.  **Role Selection (`#role-selection-screen`):** An animated, Apple-inspired entry screen (using `.glow-orb`) where users pick:
    *   *Customer Mode:* Activates `#customer-kiosk-container` (shows the local server QR code).
    *   *Shop Mode:* Activates `#main-app` (the primary ERP dashboard).
    *   *Admin Mode:* Activates `#admin-container` (requires PIN).
3.  **Smart Setup Wizard (`#setup-wizard-screen`):** An 11-step process setting up everything from business details, detecting physical printers, configuring paper sizes, setting pricing, to scheduling automated SQLite WAL backups.
4.  **Main App / Shop Mode (`#main-app`):** The core application.

### The Shop Dashboard Views (Inside `#main-app`)
*   **`dashboard`**: Shows live stats, pending orders list, and low inventory alerts.
*   **`workspace`**: The "Create Order" area. Allows uploading files, quoting prices based on `pricing` DB table, and submitting to the queue.
*   **`incoming`**: Polls or listens to `server.js` for mobile orders. Staff can approve/reject them here.
*   **`history` & `customers`**: Data tables for historical CRM and billing lookup.
*   **`production`**: The "Print Queue". Shows jobs, allows assigning to specific printers via `device-manager.js`, and tracks print status.
*   **`inventory`**: A massive sub-module with tabs for items, categories, suppliers, and purchase orders. Shows red warning badges in the sidebar when stock is low.
*   **`doc-studio`**: An interactive canvas interface (likely utilizing the included `fabric.js` and `cropperjs` dependencies in `package.json`) to visually crop, rotate, and manipulate uploaded documents before they hit the print spooler.

## Summary
PrintShopManager is a highly complex, natively integrated system. It handles networking (Express), file system watching (Chokidar), native printer spooling, SQLite enterprise databases, document manipulation (PDF-Lib), and a massive vanilla JS frontend state machine. It is designed to be the absolute center of operations for a physical print shop.
