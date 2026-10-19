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

## Working workflows

- **Destinations:** offer or landing URLs, active/paused status and daily visit caps (UTC).
- **Campaigns:** ordered source/device rules, weighted destination allocations, fallback routing, cost per click, pause/resume and tracking links.
- **Optional crawler URL:** open a campaign's Crawler destination section, enable its separate route, enter an HTTP(S) URL and choose Google, Meta, or both. Matching self-declared user agents receive that URL before normal visitor rules. Existing campaigns default to disabled. Selected crawler requests have a separate Traffic log → Claimed crawlers view and do not create click IDs, visitor cookies, cost, conversions or destination-cap usage. Paused campaigns reject both paths. The simulator's Request profile selector previews each path without recording a request.
- **Simulator:** explains the matching rule and eligible split without recording an event. Selection is probabilistic.
- **Tracking:** `/r/:alias` records a real visit, sets a local visitor cookie, selects an eligible destination and appends `click_id` and `campaign` to its URL. Source and external attribution values are preserved within documented field limits. HEAD checks do not count as visits.
- **Conversions:** record in the traffic log or use a campaign's token-authenticated `/postback` URL. Identical transaction retries are ignored; conflicting reuse returns 409. Monetary values use integer cents internally.
- **Reports:** actual clicks, distinct cookie visitors, conversions, revenue, cost and profit with UTC date ranges. Activity is paged; the conversion ledger shows the latest 100 outcomes.
- **Publishing:** write and edit drafts, preview their content, connect a campaign CTA and publish/unpublish on `/site`. Draft pages return 404. Article body text is escaped; `##` headings and paragraphs are supported, not arbitrary HTML.
- **AI drafts:** configure a local Ollama or another OpenAI-compatible chat-completions provider, enter its exact model ID and optionally a key. Generation sends topic/brief to that provider and saves a draft for review. Provider errors are shown; no generated article is fabricated when generation fails.

The empty workspace offers a two-destination example campaign. It creates configuration only, with no invented analytics. Any traffic or conversions from the example are real local test requests, not business results.

## AI setup

In Settings, set a base URL such as `http://127.0.0.1:11434/v1` for an already-running Ollama instance and choose a model actually installed there. The app does not install Ollama or download a model. Hosted endpoints must use HTTPS. Keys are encrypted locally with AES-256-GCM and are never returned in API responses. No provider key or live model was available during implementation: the adapter was tested against a simulated HTTP provider, not a real model.

The adapter uses the chat-completions shape documented by [Ollama](https://docs.ollama.com/api/openai-compatibility). The local datastore uses [Node's SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html); it is experimental in the installed Node 24 runtime.

## Scope of this version

Crawler routing uses a bounded list of user-agent tokens, including Googlebot/AdsBot and facebookexternalhit/Facebot/Meta external-agent/fetcher tokens. This is a self-declared identity signal, not IP, DNS or cryptographic verification, and not a complete detector of advertising reviewers. A spoofed token can match; an unrecognized crawler or a review using an ordinary browser can follow normal visitor rules. [Google describes additional IP/DNS verification](https://developers.google.com/crawling/docs/crawlers-fetchers/overview-google-crawlers). No real Google or Meta request was used during testing. Logs retain the supplied user agent and the destination URL as routed, so later campaign edits do not reinterpret historical records.

Database version 2 adds crawler configuration and a separate request table. Upgrading an existing workspace first creates `data/backup-before-crawler-*.sqlite` using SQLite's consistent snapshot operation, then applies the additive migration in a transaction. Opening an already upgraded workspace does not repeat the migration or backup. Keep the existing `.local-key` with any backup containing encrypted AI credentials.

This is a local, single-owner implementation. It is not an internet-ready multi-tenant deployment. There is no login or permission system because admin endpoints are restricted to loopback hosts. Writes require a custom request header and matching local browser origin. Do not expose it through a tunnel or change the binding without adding authentication and deployment controls.

Rules currently support source and user-agent-derived device class. GeoIP, bot scoring, advanced fraud detection, ad-network cost sync, scheduled publishing, RSS ingestion, custom-domain/TLS management, team roles and production-scale analytics are not implemented. Device classification is a heuristic, not a verified browser identity. Weighted splits converge over many visits rather than guaranteeing a fixed ratio for small samples. Destination caps count visits, not conversions; fallback obeys its own status/cap.

Reporting uses conversion event dates and click event dates independently. Visitor uniqueness is based on a cookie, not proof of a unique human. The first version uses USD and UTC; neither implies the user's billing currency or locale. Previously recorded click costs are retained when a campaign's configured CPC changes.

## Verification

`npm test` runs nine integration tests over real local API/storage boundaries in isolated temporary workspaces: tracking and attribution, cap fallback, conversion idempotency, reporting, paused campaigns, simulation without writes, URL validation, CSRF header checks, draft/publish/unpublish and escaping, persistence, the simulated AI-provider adapter/key boundary, crawler routing/exclusion, disabled/unselected crawler behavior, backed-up idempotent migration, API method contracts, and simultaneous visits/postback retries. No production traffic was replayed and no performance benchmark was run.

API collection creation uses POST; destination, campaign and article updates use PUT on their ID URL. Unsupported methods return 405 with an Allow header before request-body parsing or writes. Unknown API paths return 404. PATCH is not supported. Conversion listing uses GET and recording uses POST on `/api/conversions`.

Browser smoke testing also covers creating the example, inspecting its 70/30 simulator result, following a real local tracking link and recording a zero-revenue conversion labeled `local-smoke-test-001`. These example records remain in the local development workspace so the flow can be inspected.
