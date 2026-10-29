# Cloudflare deployment

The root `wrangler.jsonc` explicitly builds and deploys the Vite frontend as
Cloudflare static assets. Wrangler no longer attempts to modify Vite configuration
during a non-interactive deployment. Wrangler is pinned in `package-lock.json`.

From the repository root:

```sh
npm ci
npm run deploy:check
npm run deploy
```

In Cloudflare Workers Builds, keep the root directory at the repository root and
set the deploy command to `npm run deploy`. Leave the separate build command empty:
Wrangler runs `npm run build` through its `build.command` setting. The existing
`npx wrangler deploy` command also uses this configuration and the installed version.

Set the public `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as build
variables if the frontend uses those clients. Never use a `VITE_` prefix for
database passwords, the encryption key or server credentials.

## Backend requirement

This configuration deploys the frontend only. It does not deploy `server/index.ts`
or provide its API, redirects, postbacks or published articles. Vite's `/api` proxy
only runs in development. A successful deployment check verifies the build and
asset packaging; it does not establish a working production database or API.

Before using the hosted workspace, choose and implement a backend deployment:

- Host the Node server separately, add authentication for administration, and
  configure same-origin proxying to that authenticated backend; or
- Adapt the backend lifecycle, HTTP entry point, secrets and database connections
  to Cloudflare Workers and add authentication for administration.

Keep the original encryption key and database TLS validation in either option.
Do not remove the localhost restriction to expose the existing unauthenticated
administration server. Do not commit `.env` or `data/` to deploy the backend.

The separate `edge/wrangler.toml` deploys the optional signed tracking ingress.
It requires a running origin and its own secrets; the root frontend configuration
does not replace it. See `TRAFFIC-DETECTION.md` for that setup.
