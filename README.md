# Relay — Kuwait delivery prototype

A cloud-hostable prototype for one warehouse, online Android drivers, multi-vendor orders, and complete-order delivery. Node.js 24 is required (built-in SQLite).

## Run

```sh
npm ci --cache /workspace/.npm-cache
npm test
npm start
```

Open the app and create the first administrator account. Create driver and warehouse users, register vendors, then create orders. Excel imports use one item per row; columns are `reference, recipient, phone, address, vendorCode, name, quantity`. Phone cells must be text (`+965` and eight digits). Validate the preview before confirming.

Operational data and proof images are stored in `data/app.db`; keep this on a persistent volume and back it up. Never commit it. A running cloud development workspace is not public production hosting. HTTPS is required for phone GPS and secure cookies. For HTTPS deployment set `NODE_ENV=production` and a securely supplied `SESSION_SECRET`. Production startup requires SESSION_SECRET and, for an empty database, SETUP_KEY: generate separate random values of at least 32 characters in the hosting settings. The initial administrator form requires SETUP_KEY; its value is never exposed by the setup endpoint. Keep the key in a password manager. For persistent storage, DATA_DIR accepts an absolute writable directory confirmed by the host; its default is data/ under the working directory.

## Current scope and limitations

Implemented: user roles, vendor address snapshots, itemized orders, Excel validation and confirmation, separate vendor pickup tasks and drivers, item verification and pickup proof per vendor, independent warehouse receipt, adding physically present warehouse items, complete-order dispatch verification, delivery photo/signature/name/GPS, Code 128 AWB labels, failed-delivery reasons, warehouse returns, rescheduling, and audit history.

### Trial workflow

1. As administrator, create operations, warehouse and driver accounts; register vendor locations.
2. Create an order containing items from two vendors (or import Excel). Each vendor gets its own pickup task.
3. Operations assigns pickup drivers on each task and a delivery driver separately.
4. Each pickup driver verifies every item and captures the vendor contact name, photo and GPS. Warehouse staff can receive one vendor’s items while awaiting another vendor.
5. Warehouse staff receive all items. Use “Add an item already at the warehouse” for physically present extras belonging to this order. This records receipt immediately; it does not create a future pickup. Existing uncollected items remain required.
6. Print the order’s AWB label. Its Code 128 barcode encodes the AWB number, not a public tracking link. Labels include recipient details and the complete item manifest.
7. The delivery driver checks every item before dispatch and captures recipient name, signature, photo and GPS at delivery.
8. For a failed attempt, record a reason. Warehouse staff must confirm physical return before operations can choose a new delivery date. Rescheduling clears the delivery assignment, so assign a driver again. Future-dated orders cannot dispatch early. Dates use Kuwait time.

Existing orders are migrated to stable vendor tasks on server startup. Previously completed aggregate pickups are marked historical; separate vendor proof is not invented. Historical pickup drivers use the prior order assignment where available.

This remains a prototype requiring a controlled production trial. Operations control, WhatsApp queueing/private tracking, email recovery, authentication throttles, durable local sessions and verified local SQLite backups are implemented; provider configuration, off-host recovery, live hosting validation and pagination remain outstanding. Camera, signature usability, barcode scanning/printing, offline drafts and GPS require validation on real Android devices over HTTPS. Proof validation checks file signatures but is not a full image decoder.

## Tests

`npm test` verifies complete-order dispatch rules and runs an isolated API workflow covering separate vendor pickups, role restrictions, warehouse consolidation, dispatch verification, delivery failure/return/rescheduling, delivery proof, barcode generation, and real Excel preview/import/duplicate rejection. `npm run format:check` checks formatting.

## Cloud hosting

See [the private trial deployment guide](docs/deployment.md) for `areyoutrip.in`, Docker hosting, persistent storage, protected first-account setup, HTTPS, and DNS connection requirements. Domain ownership alone does not supply application hosting. Deployment remains pending hosting-account access.

## Supabase

Optional remote storage is available using `DATABASE_BACKEND=supabase`. Follow [the Supabase setup guide](docs/supabase.md) before enabling it. Hostinger-injected Supabase variables alone leave the SQLite backend unchanged. Existing SQLite data is not automatically copied. The SQL schema and server-only key must be configured in the connected project before switching; local tests do not verify the live project.

ExcelJS currently declares uuid 8.x. A scoped npm override pins its dependency to CommonJS-compatible uuid 11.1.1 to address GHSA-w5hq-g745-h8pq / CVE-2026-41907. The Excel formatting round-trip test exercises ExcelJS's UUID generation; the workflow test also checks Excel import. Keep the override until an upstream ExcelJS release incorporates a patched version.

## Try the prototype and suggest changes

Open `/demo` on the deployed app for an isolated, fictional-data walkthrough. Use the role selector to try administrator, dispatcher, warehouse and driver views. Sample changes remain in the current browser tab's session storage; Reset sample orders clears them. The demo uses simulated GPS and a placeholder photo when no photo is selected. It supports order creation, separate vendor pickups, warehouse receipt/additions, full-manifest dispatch, delivery signature, failed attempts, returns/rescheduling, and barcode labels. Excel import is available only in the connected live app; the sample demo does not parse uploaded workbooks. No demo action writes to the operational database or sends notifications. Never enter real customer data into the demo.

The header's **Suggest an improvement** link opens a GitHub issue form with fields for the screen, current behavior, expected behavior and proposed change. Suggestions can also be sent in the development chat. Do not include customer details, passwords or keys in feedback.

`server.js` now starts the web listener independently from `application.js` initialization. Missing production secrets or database failures produce a setup-status screen and a JSON error code instead of intentionally terminating the server. It does not bypass account protection or silently change storage backends. `/health/live` checks the web listener; `/health/ready` returns 503 until the real application has initialized. The sample demo remains available while configuration is incomplete. Supabase requests have a 15-second timeout.

Run `npm run test:browser` after `npx playwright install chromium` to exercise the sample demo and configuration-failure screen. On this cloud machine, `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser` uses installed Chromium. The browser test does not establish live Hostinger connectivity.

## Workspace appearance and navigation

Use **Appearance** in the header to choose Light, Dark, or System. The preference is saved in that browser; System follows the device setting. Both themes also apply to dialogs, forms, the sample demo and setup screens. Printed AWB labels stay white for barcode readability.

The order board supports AWB/reference/recipient/vendor search, status filtering (including clickable summary cards), sorting, result counts and clear-filter empty states. Expand an order's **Manage workflow** section for assignment, pickup, warehouse and delivery actions. A progress strip and next-step hint summarize its stage. On phones, workspace navigation moves above the board. Successful actions and errors appear as accessible notifications. Order entry supports removing extra item rows and returns to the board after a successful save.

## Driver trips, fleet map and reports

Administrators and operations users now see **Fleet control** on the main order board and **Reports** in navigation. The fleet table shows each driver's open assigned orders, pre-dispatch deliveries, active pickup/delivery trips, pending pickup details, completed deliveries and last reported coordinates. A trip currently means one vendor pickup leg or one order's delivery leg. Counts are derived from order/task/trip records, not from sample dashboard totals. The dashboard polls every 15 seconds and preserves a focused form or open proof dialog while refreshing the fleet.

Drivers can open `/driver` on their Android browser, sign in with a driver account, then choose **Scan / claim AWB**. Scan Code 128/QR using the camera, upload a barcode image, or enter the AWB number. Review the order and explicitly claim an available pickup or delivery. Other drivers' assignments cannot be stolen. Delivery is claimable only after every item has been received at the warehouse. Pickup drivers use **Start pickup trip**, **Arrived at pickup**, and pickup proof; a failed pickup records a reason and leaves the task pending for a retry. Delivery drivers verify the complete manifest using **Start delivery trip**, can mark arrival, then capture delivery proof or a failure reason. All events appear in order history, fleet counts and reports. Concurrent claims/updates use storage revision checks.

**Location sharing:** the driver must allow GPS on HTTPS. Starting a trip requests foreground location sharing; it can also be enabled/stopped manually. GPS updates are limited to one successful send per 15 seconds. Sharing pauses when the page goes into the background or closes, and automatic sharing stops when all that driver's active legs finish. Browser/phone termination may prevent the final sharing-off request, so the dashboard always shows the last location timestamp, accuracy and stale status (after two minutes); it never invents positions for drivers who have not shared. A web page does not provide reliable locked-screen/background Android tracking. Use a native Android tracking service if that becomes a requirement. The sample demo uses clearly labeled simulated positions saved only in its browser tab.

The map uses locally served Leaflet and OpenStreetMap's public tile service, with attribution and a coordinate-table fallback when tiles cannot load. No Google Maps key is needed for this prototype. Report access is restricted to administrator/operations roles. Filter by driver, status and any event date in Kuwait time. Expand **View history** for items, pickup contacts/locations, trip events, receiver details, signature/photo capture flags and delivery GPS. **Open order & proof** links to the protected order proof view. Live **Export Excel** produces Orders, Order history, Pickups, Items and Trips sheets; timestamps in the workbook are labeled UTC. The isolated demo exports a CSV summary instead.

No new Supabase tables or SQL changes are required: trip/history fields remain inside existing order records, and latest location is stored on the driver account. Old in-transit orders get a clearly marked legacy delivery leg; unknown historical start times are not fabricated. Camera access and live GPS still require a real Android/HTTPS device trial. Automated coverage includes competing claims, cross-driver permissions, valid/invalid GPS, trip count changes, pickup/delivery proofs, Kuwait date boundaries, workbook exports, actual barcode-image decoding and dashboard polling. Browser tests stub third-party tile images; they do not establish live map-provider or Hostinger connectivity.

## Mawada daily import

See [the reference review and import contract](docs/fareye-reference.md). Mawada uploads now have a Kuwait-today selection and exclusion preview, saved delivery instructions/value/bell/card fields, and an auditable occasion review. The actual Mawada CMS export has not been supplied yet; mapping against its real layout remains unverified. Occasion suggestions currently use transparent text rules and are marked unconfirmed, not presented as AI model results.

Driver workload profiles and reviewable location signals: see [driver monitoring](docs/driver-monitoring.md). Open Fleet control → View driver to inspect shipments, pickups, trips and review notes.

## Operations control and reliability

Open **Operations control** for an actionable daily exception queue, named recovery plans and follow-ups, delivery/pickup commitments, area/vendor/window filters, bulk assignment previews, a delivery performance scorecard and reviewable WhatsApp updates. Drivers get a suggested next stop, navigation/call links and on-device proof drafts with explicit upload retry. New manually created orders support delivery dates, areas, windows and customer WhatsApp consent. Import mappings are saved per account; duplicate references require review and an explicit skip choice.

Read the [COO operating playbook](docs/operations-playbook.md) for the morning/during-day/close routine, responsibilities, exception rules and KPI definitions. Read [service configuration](docs/service-configuration.md) for WhatsApp Business, email recovery, persistent sessions and backup/restore setup. Customer updates use WhatsApp; recovery uses emailed single-use links through Resend. Provider APIs are stubbed in local tests; live acceptance/receipt still requires account configuration and consented trial contacts.

Production SQLite attempts a verified local backup on startup and every 24 hours, keeping seven copies by default. `npm run backup`, `npm run backup:verify -- FILE` and `npm run backup:restore -- FILE ABSOLUTE_EMPTY_DIRECTORY` provide operator tools. This does not create off-host copies or establish a complete disaster-recovery service. Supabase requires its provider backup workflow. Sessions/throttles persist in `DATA_DIR/runtime.db` and require a stable secret and persistent volume even with remote operational storage. One app instance is supported.

`npm test` includes operating-rule/API tests for revision-safe assignment, recovery plans, private tracking, concurrent send protection, one-time resets, session restart retention and a backup restore rehearsal. `npm run test:browser` now runs both the existing smoke check and a live isolated control/driver test, including offline proof persistence, reload and explicit successful upload retry.

## Driver chat

Operations and administrators with workflow access can open **Driver chat** in navigation, or **Chat with driver** on an order. Drivers use **Messages** or **Message operations**. Each order has a private thread for each assigned pickup/delivery driver; other drivers cannot read it. Messages show the sender and Kuwait time, with per-user unread indicators. Changes refresh every ten seconds while the app is open and visible. This is in-app text chat, not WhatsApp, phone push notifications or an emergency contact service.

The compose box retains unsent text while navigating in the current page, and a lost-response retry uses the same send identifier to avoid duplicate messages. Reloading/signing out discards unsent chat drafts. Saved history stays in the order record, using the existing storage backend without new tables or provider configuration. Reassignment or revoked access removes the former driver's ability to open/send messages; a replacement driver gets a separate thread. Operations can open a thread only while that driver remains assigned. History is retained if that same driver is reassigned later.

Conversations load the latest 100 messages with **Load earlier messages**. Each driver/order thread supports up to 1000 saved messages; the app refuses further sends at that limit rather than silently deleting history. Deleted or workflow-restricted driver accounts are unavailable. Warehouse accounts, fictional demo orders and the isolated demo do not participate. Chat text is excluded from general order/state responses and customer tracking. Existing order backups include saved chat history. Use a phone call for urgent instructions or when the driver is offline.

Chat coverage verifies cross-driver/role restrictions, reassignment, concurrent sends, duplicate retries, bounded history and independent unread counts. The two-user Chromium check covers replies, incoming-message polling, preserved composition, literal rendering of HTML-like text, lost responses and the mobile layout.
