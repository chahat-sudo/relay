# PostgreSQL migration and cutover

The server now uses PostgreSQL through a bounded connection pool. The original SQLite file is retained as migration input; it is never silently used as a runtime fallback. Browser Supabase keys do not authorize schema creation or database imports.

## Required access

Complete the Supabase integration connection to authorize project operations. The running Node server additionally needs the project's PostgreSQL direct or **session pooler** connection string, including its database password, as `DATABASE_URL` in the ignored `.env`. Obtain it from the Supabase Connect dialog; use the session pooler on port 5432 when direct IPv6 connectivity is unavailable. Do not paste passwords into chat or place them in `VITE_` variables. TLS certificate validation remains enabled; a custom certificate can be supplied through `RELAY_DATABASE_CA_FILE`.

## Cutover

1. Stop all Relay instances and any other writers to `data/relay.sqlite`.
2. Preserve the whole `data` directory, especially `.local-key`. Source/configuration backups from this change are under ignored `data/migration-backups`.
3. Set `DATABASE_URL` for the same project as `VITE_SUPABASE_URL`. Run `npm run db:migrate` with schema/role creation privileges.
4. Review the resulting manifest: every table must have matching row counts and digests, with `verified: true`. If verification fails, do not switch traffic. The original SQLite source remains intact.
5. Run `npm start`. Startup verifies that the local encryption key matches the imported workspace. Test campaigns, a new click, duplicate conversion submission, crawler evidence and reports before resuming public tracking.

The importer accepts recognized SQLite versions 1–4. It takes a consistent snapshot and copies `.local-key`, preserves IDs, raw JSON strings, timestamp strings, URLs, costs, sessions and label ordering, and imports into an empty private `relay` schema. Historical crawler claims remain unverified. Unknown tables/columns, foreign-key violations, changed sources or an occupied target fail instead of discarding or overwriting data. An identical rerun verifies the target; it does not replace rows. Inserts and verification share one PostgreSQL transaction. Identity sequences are advanced after import.

The migration creates the restricted `relay_backend` role. Runtime connections assume that role; it has no schema/role administration rights. RLS is enabled on application tables and private schema access is not granted to browser roles. Application SQL is parameterized. Routing, accounting, configuration changes, collection retries and continuation retries use a shared database transaction lock. Rate windows and edge replay markers still live in one process; this change alone does not establish a multi-server deployment.

## Validation scope

Tests run against embedded PostgreSQL (PGlite), including HTTP workflows and SQLite import fixtures. This verifies SQL and workflow behavior, not a live Supabase connection, session-pooler operation, certificate chain or production load. Existing SQLite benchmark results are historical; the updated benchmark labels its embedded PostgreSQL backend and excludes the remote database/network. Exact parent Node 24.18.0 validation remains unavailable; checks use installed Node 24.14.1.

Live cloud cutover completed on 29 October 2026 after PostgreSQL authentication and full TLS certificate verification succeeded. The previous `VERIFIED-ROUTING-VALIDATION.md` documents the SQLite-stage implementation, not the current database backend.

Executed on 29 October 2026: the 27 ported HTTP/workflow tests passed, the separate import test passed for all four SQLite versions (including identical reruns and changed-target rejection), and two connection-ownership/cleanup tests passed. The production build and typecheck passed. A separate import of the actual local workspace verified all 17 tables and successfully read its campaigns and encrypted-key configuration in isolated PostgreSQL. Its retained manifest is under ignored `data/migration-backups/verified-local-import-1793268969997/manifest.json`; this was not a cloud import.

Local ordinary-browser measurements used one cold request plus 200 warm requests at concurrency 10, with zero seeded clicks. Embedded PostgreSQL off mode measured 40.58 ms cold, 1888.66 ms warm elapsed, 2657 ms CPU and 607,617,024 bytes sampled peak process-family RSS. Observe measured 109.71 ms cold, 2866.05 ms warm elapsed, 3782 ms CPU and 609,824,768 bytes peak RSS. The earlier SQLite runs measured 10.76/10.46 ms cold, 598.50/667.91 ms warm elapsed, 578/734 ms CPU and 95,719,424/96,813,056 bytes peak RSS (off/observe). Backend and engine changed, so this is not a production PostgreSQL performance estimate or speedup claim. Client, HTTP server and embedded engine share one process with no children. RSS sampling can miss short peaks. Agent tokens, remote PostgreSQL CPU/memory, network costs and live Supabase throughput remain unmeasured.

## Completed Supabase cutover

The verified import into `vupshxsbzuhrrwoktppz` completed with matching counts and digests for all 17 application tables. Retained backup/verification manifest: `data/migration-backups/sqlite-to-supabase-1793273973700/manifest.json`. The original `data/relay.sqlite` and `.local-key` remain intact. The supplied Supabase CA was copied to ignored `data/certificates/supabase-root.crt` and configured through `RELAY_DATABASE_CA_FILE`; server and hostname verification remain enabled.

The actual Node server was started on loopback port 4180 and checked against Supabase. Bootstrap returned 2 campaigns and 1 article. The 90-day report returned 6 clicks and 1 conversion. The default shorter report window excludes older clicks as expected. An actual tracking HEAD request returned 200 without increasing the ledger count. Runtime queries used `relay_backend`; all 19 private-schema tables (17 application tables plus 2 metadata tables) have RLS enabled, and neither `anon` nor `authenticated` has schema usage. These checks read actual cloud data without adding synthetic financial events. Public Cloudflare ingress, multi-server state coordination and production load remain outside this validation.
