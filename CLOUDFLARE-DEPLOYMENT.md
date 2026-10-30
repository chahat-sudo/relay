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
and runs configured retention. The database pool is bounded to five connections
with idle connections closed after 30 seconds. Production capacity is unmeasured.

## Configure and deploy

1. In Supabase **Connect → Session pooler**, copy the connection string on port
   **5432**. Its user is `postgres.PROJECT_REF`, rather than the direct endpoint's
   `postgres`. Add it to the ignored `.env` as `RELAY_WORKER_DATABASE_URL`.
   Keep `DATABASE_URL` for the existing Node installation unchanged.
2. Run `npm run cloudflare:secrets`. This prepares the ignored
   `data/cloudflare-secrets.json` with `DATABASE_URL`, the original encryption key
   encoded as `RELAY_WORKSPACE_KEY`, `RELAY_ADMIN_USER`, and a generated
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

The direct Supabase endpoint failed certificate validation in local workerd with
`UnknownIssuer`, including when supplied the downloaded Supabase CA. Workers does
not use the Node server's custom CA file. Certificate validation has not been
disabled. The session pooler connection still needs verification for this project
before the deployment can be considered live and working.

## Verification

`npm run test:worker` builds the actual Worker and runs it in workerd through
Miniflare, with an embedded PostgreSQL engine exposed over local TCP. It checks
authentication, static assets, JSON APIs, origin checks, encrypted AI credentials,
draft generation, published articles, tracking, persistent rate windows, signed
client context, and verified crawler routing. Cloudflare metadata, crawler feeds
and the AI provider are simulated. This does not verify production Supabase TLS
or the Cloudflare account's deployment settings.

After deployment, `/api/bootstrap` must require authentication and return JSON
after sign-in. `/api/summary?days=90` should show the migrated records. Use a HEAD
request to an existing tracking link for a check that creates no click. Confirm
the browser can create and save configuration before sending production traffic.

The legacy `edge/wrangler.toml` remains available for the separate Node-origin
tracking ingress. It is unnecessary for the integrated Worker deployment.
