> Storage update: Supabase PostgreSQL cutover is complete. The original SQLite database and verified import snapshot are preserved. See [migration and verification details](SUPABASE-MIGRATION.md). Earlier SQLite validation below is historical.

# Relay — independent traffic & publishing

A locally runnable first version, written independently. No Klixsor bundles, binaries, migrations, templates or client contracts are used by this application.

## Run

Requires Node.js 24.14 or newer. From this folder:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4180**. It binds only to loopback and uses SQLite under `data/`. Stop the server with Ctrl+C. Keep the whole `data/` directory together when making an offline backup; it contains both the database and the local key used to encrypt the AI provider credential. Do not commit it.

For client development, run `npm start` and `npm run dev` in separate terminals. Vite serves port 5180 and proxies API requests to 4180. `npm run build` checks TypeScript and builds locally served assets, including fonts.

Cloudflare deployment uses the root Wrangler configuration for both frontend and
backend, with owner authentication. See [production setup](CLOUDFLARE-DEPLOYMENT.md)
for Worker secrets, database connectivity and deployment verification.

### Iframe landing-page example

Open <http://127.0.0.1:4180/example/frame> to see a branded outer page embedding a fictional Fieldnote landing page from `localhost`, a separate browser origin. Click **Explore the notebook**: the embedded page navigates while the outer address stays unchanged. **Open destination** opens the landing page directly for comparison.

The example does not record clicks or change campaign settings. Only its landing and notebook pages permit framing by the two local origins on this server's port; the workspace keeps its existing framing restriction. The destination is fixed, with no arbitrary URL input or external sites.

## Working workflows

- **Destinations:** offer or landing URLs, active/paused status and daily visit caps (UTC).
- **Campaigns:** ordered source/device rules, weighted destination allocations, fallback routing, cost per click, pause/resume and tracking links.
- **Traffic quality:** Traffic log → Traffic quality adds an independent detection engine, Google origin verification, network/request rules, browser observations, evidence histories, observation/enforcement modes and an offline model evaluator. Detection defaults off. Start with observation; see [setup and semantics](TRAFFIC-DETECTION.md) and [validation](TRAFFIC-DETECTION-VALIDATION.md).
- **Optional verified crawler URL:** an enabled campaign can route selected crawlers to a separate URL only with current provider-origin proof, in every detection mode. Google supports official ranges and confirmed DNS; Meta verification is unavailable, so Meta claims follow normal visitor rules. Routed crawlers have no visitor click, cookie, cap usage or cost. Historical user-agent-only log rows remain unverified; paused campaigns reject both paths.
- **Simulator:** explains the matching rule and eligible split without recording an event. Selection is probabilistic.
- **Tracking:** `/r/:alias` records a real visit, sets a local visitor cookie, selects an eligible destination and appends `click_id` and `campaign` to its URL. Source and external attribution values are preserved within documented field limits. HEAD checks do not count as visits.
- **Conversions:** record in the traffic log or use a campaign's token-authenticated `/postback` URL. Identical transaction retries are ignored; conflicting reuse returns 409. Monetary values use integer cents internally.
- **Reports:** actual clicks, distinct cookie visitors, conversions, revenue, cost and profit with UTC date ranges. Activity is paged; the conversion ledger shows the latest 100 outcomes.
- **Publishing:** write and edit drafts, preview their content, connect a campaign CTA and publish/unpublish on `/site`. Draft pages return 404. Article body text is escaped; `##` headings and paragraphs are supported, not arbitrary HTML.
- **AI drafts:** configure a local Ollama or another OpenAI-compatible chat-completions provider, enter its exact model ID and optionally a key. Generation sends topic/brief to that provider and saves a draft for review. Provider errors are shown; no generated article is fabricated when generation fails.

The empty workspace offers a two-destination example campaign. It creates configuration only, with no invented analytics. Any traffic or conversions from the example are real local test requests, not business results.

## Supabase client setup

Supabase client helpers are installed from the official `@supabase/supabase-client-react-router` registry block, with pinned `@supabase/supabase-js` and `@supabase/ssr` dependencies. This block adds clients; it does not require changing the existing React/Vite navigation.

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the ignored `.env` file, then restart Vite. `.env.example` documents these names without project-specific credentials. Vite exposes these two values to browser code; use a publishable key here. Database passwords and Supabase secret/service-role keys do not belong in `VITE_` variables.

Browser components can import `createClient` from `@/lib/supabase/client`. A request-scoped server helper is in `src/lib/supabase/server.ts`; a future server integration must load the same configuration and forward its returned `headers` with the response to persist auth cookies. It does not grant access to Relay administration endpoints or add an auth flow.

This setup does **not** move campaigns, clicks, conversions, crawler evidence or settings to Supabase. The PostgreSQL server adapter and importer are now implemented. Complete the [migration and cutover](SUPABASE-MIGRATION.md) to copy existing data and activate them. Successful connection checks do not establish database migration or production readiness.

## AI setup

In Settings, set a base URL such as `http://127.0.0.1:11434/v1` for an already-running Ollama instance and choose a model actually installed there. The app does not install Ollama or download a model. Hosted endpoints must use HTTPS. Keys are encrypted locally with AES-256-GCM and are never returned in API responses. No provider key or live model was available during implementation: the adapter was tested against a simulated HTTP provider, not a real model.

The adapter uses the chat-completions shape documented by [Ollama](https://docs.ollama.com/api/openai-compatibility). The local datastore uses [Node's SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html); it is experimental in the installed Node 24 runtime.

## Scope of this version

Crawler routing consumes the traffic engine's current Google network/DNS evidence. A user-agent claim or generic Cloudflare bot flag cannot establish a named provider. Missing, pending or expired proof follows normal visitor rules; later verification never rewrites a completed redirect or click cost. The simulator cannot establish origin proof. This does not identify every bot or ad reviewer. No real Google or Meta crawler request was used during testing; live official-feed retrieval was verified. Historical routed URLs and assessments retain their source evidence. See [verified-routing validation](VERIFIED-ROUTING-VALIDATION.md).

Database version 2 adds crawler configuration and a separate request table. Upgrading an existing workspace first creates `data/backup-before-crawler-*.sqlite` using SQLite's consistent snapshot operation, then applies the additive migration in a transaction. Opening an already upgraded workspace does not repeat the migration or backup. Keep the existing `.local-key` with any backup containing encrypted AI credentials.

Database version 3 adds traffic evidence, policy/configuration history, browser sessions and labels. Existing databases receive a consistent `backup-before-traffic-*.sqlite` before migration. Normal tracking, financial click records and the existing encryption key are preserved. The optional public tracking listener is separate from local administration.

Database version 4 adds nullable origin evidence to crawler-route records. An existing database receives a consistent `backup-before-verified-routing-*.sqlite` before the transactional migration; reopening does not repeat it. Saved campaign settings and historical rows are preserved, without treating old claims as verified identities.

This is a local, single-owner implementation. It is not an internet-ready multi-tenant deployment. There is no login or permission system because admin endpoints are restricted to loopback hosts. Writes require a custom request header and matching local browser origin. Do not expose it through a tunnel or change the binding without adding authentication and deployment controls.

Routing supports source and user-agent-derived device class. Traffic quality adds explainable heuristic risk scoring and optional authenticated Cloudflare signals; production accuracy is unmeasured. GeoIP datasets, ad-network cost sync, scheduled publishing, RSS ingestion, automatic domain/TLS provisioning, team roles and production-scale analytics are not implemented. Device classification is a heuristic. Weighted splits converge over many visits; destination caps count delivered visits, not conversions, and fallback obeys its own status/cap.

Reporting uses conversion event dates and click event dates independently. Visitor uniqueness is based on a cookie, not proof of a unique human. The first version uses USD and UTC; neither implies the user's billing currency or locale. Previously recorded click costs are retained when a campaign's configured CPC changes.

## Verification

`npm test` preserves the original nine integration workflows and adds traffic detection coverage at real local HTTP/storage boundaries. See [the traffic validation record](TRAFFIC-DETECTION-VALIDATION.md) for executed checks, local performance measurements, browser scope and unavailable production verification. Provider metadata and ML labels in deterministic tests are explicitly synthetic; no production traffic was replayed.

API collection creation uses POST; destination, campaign and article updates use PUT on their ID URL. Unsupported methods return 405 with an Allow header before request-body parsing or writes. Unknown API paths return 404. PATCH is not supported. Conversion listing uses GET and recording uses POST on `/api/conversions`.

Browser smoke testing also covers creating the example, inspecting its 70/30 simulator result, following a real local tracking link and recording a zero-revenue conversion labeled `local-smoke-test-001`. These example records remain in the local development workspace so the flow can be inspected.
