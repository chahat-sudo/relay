# Relay on Cloudflare Workers

The root `wrangler.jsonc` deploys both the Vite assets and `edge/app-worker.ts`.
The public origin is `https://relay.chahat.workers.dev`. Change
`RELAY_PUBLIC_ORIGIN` in that configuration when changing the production domain.

The Worker protects the workspace and `/api` with HTTP Basic authentication.
The browser prompts for the owner login. Tracking, collection, token-authenticated
postbacks and published articles remain public. The asset fallback cannot handle
API requests: they always run through the backend.

One `RelayBackend` Durable Object owns the traffic runtime, crawler caches,
replay protection and in-memory rate windows. Application records remain in the
private Supabase `relay` schema. Durable Object storage holds the maintenance
alarm; it does not replace PostgreSQL. A 30-minute alarm refreshes intelligence
and runs configured retention. Hyperdrive query caching is disabled. Its origin
connection limit is five, and the application pool also permits at most five
connections, closing idle sockets after 30 seconds. Production capacity is unmeasured.

## Configure and deploy

1. The `HYPERDRIVE` binding is configured for this account's `relay-supabase`
   resource. It connects to the original Supabase database using the restricted
   `relay_cloudflare` login, which inherits `relay_backend` and has no superuser,
   database-creation, role-creation or RLS-bypass authority. The database password
   is held by Hyperdrive, rather than exposed to browser code or Worker secrets.
   Keep `DATABASE_URL` for the existing Node installation unchanged.
2. Run `npm run cloudflare:secrets`. This prepares the ignored
   `data/cloudflare-secrets.json` with the original encryption key encoded as
   `RELAY_WORKSPACE_KEY`, `RELAY_ADMIN_USER`, and a generated
   `RELAY_ADMIN_PASSWORD`. Existing login values are preserved, and changes to an
   existing file receive a backup. Inspect the login locally; never commit this file.
3. Run `npx wrangler login` if the Cloudflare CLI session has expired.
4. Upload the prepared secrets:

   ```sh
   npx wrangler secret bulk data/cloudflare-secrets.json
   ```

5. Run the deployment checks and deploy:

   ```sh
   npm run test:worker
   npm run deploy
   ```

For Cloudflare Workers Builds, use this repository's root directory, leave the
separate build command empty, and use `npm run deploy` as the deploy command.
Wrangler's `build.command` runs TypeScript checks and Vite. The existing
`npx wrangler deploy` command also works with the pinned Wrangler package.
Configure runtime secrets on the `relay` Worker, rather than only as build variables.
GitHub deployments do not upload ignored local files or secrets.

The direct Supabase endpoint and session pooler both require the project's private
CA. The CA is uploaded to Cloudflare as `relay-supabase-root`, and Hyperdrive uses
`verify-full` to verify its origin certificate and hostname. The internal Worker
socket uses Hyperdrive's binding transport; Internet database connections still
require verified TLS. See [Cloudflare's custom-CA configuration](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/).

Hyperdrive pools transactions, so it cannot retain a session-level `SET ROLE`.
The origin login inherits the restricted backend privileges directly. Existing
Node connections continue to use their original TLS and `SET ROLE` behavior.

## Verification

`npm run test:worker` builds the actual Worker and runs it in workerd through
Miniflare, with an embedded PostgreSQL engine exposed over local TCP. It checks
authentication, static assets, JSON APIs, origin checks, encrypted AI credentials,
draft generation, published articles, tracking, persistent rate windows, signed
client context, and verified crawler routing. Cloudflare metadata, crawler feeds
and the AI provider are simulated. This does not verify production Supabase TLS
or the Cloudflare account's deployment settings.

Live verification on 2026-10-30 confirmed owner authentication, the frontend,
JSON bootstrap and reports through Hyperdrive, published pages, and a tracking
HEAD check. Reports retained 2 campaigns, 2 destinations, 6 clicks and 1 conversion.
No synthetic production click or conversion was created. Runtime integration tests
cover writes against local PostgreSQL; no production configuration was changed
solely to test an API write.

After deployment, `/api/bootstrap` must require authentication and return JSON
after sign-in. `/api/summary?days=90` should show the migrated records. Use a HEAD
request to an existing tracking link for a check that creates no click. Confirm
the browser can create and save configuration before sending production traffic.

The legacy `edge/wrangler.toml` remains available for the separate Node-origin
tracking ingress. It is unnecessary for the integrated Worker deployment.
