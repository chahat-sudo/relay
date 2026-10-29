# Traffic detection and quality

Relay now includes an independent rules engine, browser collector, evidence inspector and offline model evaluator. Open **Traffic log → Traffic quality** in the local app.

Detection starts **off** for existing installations. Choose **Observe** under Detection settings to collect assessments without new blocking. An explicitly enabled campaign crawler destination now requires current provider-origin verification in every mode. Saved URLs and provider selections are preserved; user-agent claims alone never select that destination.

## What the engine establishes

- Google common and special crawler networks are checked against their respective official feeds. Forward-confirmed service-specific DNS is available as a fallback. Source revisions, check times, matches and examined coverage are retained.
- Google/Meta user-agent tokens are claims. Meta origin verification remains unknown unless an authoritative verifier is added. Cloudflare's generic verified-bot signal is recorded separately and does not independently identify a named provider.
- Local CIDR reputation rules, request rates, header inconsistencies and optional browser observations produce an ordinal heuristic score. The score is not a probability or proof of fraud. Verified beneficial crawlers are allowed by the heuristic enforcement policy.
- Browser and network evidence arrive independently. A later result appends an assessment without changing the historical delivery action, click cost or conversion attribution. Inspect a request to see its policy version, assessment history, observations and action history.

The live engine does not identify ad reviewers, reconstruct Adspect's proprietary model, or claim a measured production accuracy. Observation does not enforce risk-based restrictions. Explicitly enabled verified-crawler destinations still apply.

## Local browser-collection example

1. Start the app with `npm start`; start Vite separately with `npm run dev` if developing the interface.
2. In Traffic quality settings, select Observe, enable browser collection, and add the exact owned origin `http://127.0.0.1:4180`.
3. Add a destination pointing to `http://127.0.0.1:4180/example/landing` and include it in a campaign.
4. Open that campaign's tracking link. The destination receives an ordinary click ID and a `relay_request` identifier. The local sample page already includes the collector when that identifier is present.
5. Refresh Traffic quality and inspect the request. Browser collection should become complete or partial. The local client IP is loopback; it cannot prove Google or Meta origin.

For another landing page you own, approve its exact origin and add:

```html
<script defer src="https://YOUR-TRACKING-HOST/t/collector.js"></script>
```

Use your actual tracking host. The request identifier in the destination URL is not an authentication token. Collection credentials are short-lived HttpOnly cookies scoped to the request's collection path; they never enter destination URLs or JavaScript. HTTPS cross-site collection uses Secure/SameSite=None cookies. Browsers may block those cookies, so same-site integration is preferable where possible. Missing or blocked collection expires as unknown evidence; normal landing content still loads.

The version-1 collector observes automation exposure, language, timezone, platform availability, viewport, cookie capability and elapsed collection time. It does not read page content, cookie values, local storage, canvas or audio fingerprints. It has a strict named schema and a 32 KiB transport budget. Clients can forge browser observations; receiving a valid token does not authenticate their truth.

## Cloudflare ingress

The local administration service stays on `127.0.0.1:4180`. A separate authenticated tracking service starts on `127.0.0.1:4181` only when configured. Never expose the administration port through a tunnel.

Topology:

```text
Visitor → public tracking hostname / Worker
        → separate origin hostname / Cloudflare Tunnel
        → 127.0.0.1:4181
```

The Worker forwards only named tracking/collection routes. It overwrites incoming Relay assertion headers, signs the original client IP and optional Cloudflare metadata, and binds the assertion to the request method, exact path/query, selected header digest, body digest, audience, timestamp and nonce. The origin rejects invalid signatures and replays. Keys can be rotated with two simultaneous named origin keys. No visitor-supplied bot header is trusted.

Configure the following explicitly; this project does not create or purchase a domain, tunnel, account or subscription:

1. Choose a public tracking hostname and a separate Tunnel origin hostname on your Cloudflare zone. The origin hostname must not run the same Worker route, which would cause recursion.
2. Configure the Tunnel to reach **only** the tracking listener on `http://127.0.0.1:4181`. Do not forward port 4180, the filesystem, `/api/`, or the admin app.
3. Put these Node settings in the process environment or an ignored `.env` file: `RELAY_PUBLIC_ORIGIN` (exact HTTPS origin), `RELAY_EDGE_KEYS` (JSON mapping one or two key IDs to independently generated keys of at least 32 characters), and optionally `RELAY_TRACKING_PORT` (default 4181).
4. Build/deploy `edge/worker.ts` using `edge/wrangler.toml`. Set the Worker's `PUBLIC_ORIGIN` to the same public origin, `ORIGIN_URL` to the separate HTTPS origin hostname, and `RELAY_EDGE_KEY_ID` to a key ID accepted by Node. Store its matching key as the Worker secret `RELAY_EDGE_KEY`; never commit that secret.
5. Configure your own public hostname route for the Worker. Start Node using `npm run start:edge` when using `.env`, or `npm start` with exported environment variables.
6. Verify an actual external tracking request end to end. The inspector must show `cloudflare-signed` authority and the original external client IP. Check both IPv4 and IPv6 and test your actual Worker/Tunnel zone arrangement; a proxied subrequest's apparent IP can differ from the original client. Verify that public `/api/bootstrap` is inaccessible and a direct unsigned origin request is rejected.

The engine works without paid Cloudflare bot scores. If your plan exposes Bot Management fields, the Worker forwards them; absent fields remain null. The Worker handles Cloudflare Pseudo IPv4 by using the IPv6 companion only when the primary address is a Class E pseudo address. Test that setting on your zone rather than assuming it is active.

For rotation, add the new key ID/key at the origin first, switch the Worker's key ID/secret, and remove the old key after all old signed requests have expired. Assertions accept at most 60 seconds of clock skew; allow at least two minutes before removing an old key. Configure time synchronization on the origin host.

This repository contains and locally tests the ingress implementation. No live Cloudflare deployment has been verified yet.

## Modes, costs and retention

Off disables traffic-quality assessment storage, but enabled crawler destinations still verify origin. Observe records assessments without new blocking. Enforce requires an explicit operator declaration after reviewing evidence; it applies the selected action to high-risk requests: allow, throttle (429 with Retry-After), manual continuation, or deny (403). Manual continuation is accessible without JavaScript and does not verify a human. Repeated successful continuation does not create another click.

Do not enable enforcement solely because automated tests pass. Select an acceptable false-positive budget and evaluate independently labeled representative traffic first. The configuration gate records an operator choice, not a certification that production evaluation has occurred.

Raw observed requests, qualifying quality counts, excluded quality counts and unknowns are reported separately. Excluding a request from quality counts does not establish that the ad network refunded it. Configured CPC remains an estimate. Existing click and conversion records retain their identities and costs after a later assessment or detail-retention expiry.

Verified crawler redirects receive the configured URL unchanged, without visitor cookies, click IDs, browser collection, visitor-cap usage or click cost. Their routing-time proof is retained in the crawler log; observation/enforcement also retains a zero-cost traffic-quality record. The campaign route simulator does not establish origin proof, so even crawler claim profiles follow normal visitor rules.

Defaults are 30 days of detailed traffic evidence and 7 days for explicit raw-IP fields. The raw request path/query is retained as source evidence and may contain caller-supplied tracking identifiers. Verification hostnames, ranges and policy notes are retained for the detail lifetime; removing raw-IP fields does not make all evidence anonymous. Retention is configurable and runs once a minute while detection is active; Apply retention now performs it immediately. Expired collection is recorded explicitly. Verified crawler route evidence follows the detail retention period; historical user-agent-only crawler logs are preserved. Detailed traffic deletion does not delete the pre-existing financial click/conversion ledger.

Migration to database version 4 adds nullable origin evidence to crawler route records and creates `backup-before-verified-routing-*.sqlite` before changing an existing database. Historical rows retain null evidence and remain unverified. The earlier version-3 migration creates `backup-before-traffic-*.sqlite` before changing an existing database. Reopening does not repeat the migration. Preserve the whole data directory, including `.local-key`, with backups. Configuration changes are transactional, keep versioned before/after snapshots in `traffic_config_history`/`traffic_policies`, and do not create another revision when the same configuration is saved again. Restore a reviewed earlier complete configuration through the same config PUT endpoint; do not edit historical assessments.

## Admin and integration contracts

All `/api/traffic/...` routes are on the local administration listener. Existing write-origin and `X-Relay-Request` checks apply. Public collection routes do not expose those APIs.

| Method / path | Contract |
| --- | --- |
| GET `/api/traffic/status` | Settings, feed freshness/failures, ingress readiness and runtime model state |
| PUT `/api/traffic/config` | Validated partial setting changes; unsupported fields rejected |
| GET `/api/traffic/config/history` | Ten saved snapshots per page with an older-sequence cursor; load/review before restoring through config PUT |
| GET `/api/traffic/requests` | Paged requests; campaign, risk, identity, collection, reason and date filters |
| GET `/api/traffic/requests/:id` | Request evidence, immutable assessments, policy snapshot, observations, actions and labels |
| GET `/api/traffic/summary` | Counts and estimated raw CPC cost; date and campaign filters |
| POST `/api/traffic/intelligence/refresh` | Bounded refresh of fixed official feed sources |
| POST `/api/traffic/labels` | Independent legitimate/abusive label plus evidence provenance |
| POST `/api/traffic/simulate` | Synthetic assessment without visits, labels or origin-proof claims |
| POST `/api/traffic/maintenance` | Apply expiry and configured retention |
| POST `/api/traffic/model/evaluate` | Offline, time/session-separated model experiment; never activates inference |
| GET/HEAD `/r/:slug` | Existing tracking contract; HEAD has no visit/accounting effects |
| GET/HEAD `/t/collector.js` | Owned-page integration asset |
| POST/OPTIONS `/t/events/:requestId` | Exact approved origin and scoped cookie; validated observations; idempotent identical retries |
| POST `/t/challenge` | Expiring single-use continuation; identical completed retries return the existing destination |

`shared/traffic.ts` owns the named evidence/configuration types. `shared/public-routes.ts` owns public route/method interpretation for both Worker and Node. Request evidence preserves its authority and original path/query. Transport signing secrets, raw collection cookies and the ambient process environment are not persisted in traffic records.

Feed updates are single-flight per service, limited to 2 MiB and 20000 validated prefixes, and activated atomically. Freshness lasts six hours; stale revisions are not current proof. DNS is bounded by timeouts, concurrent work and a 60-second cache. Redirects never wait for a feed refresh or DNS fallback. If current proof is unavailable, that request follows the normal visitor route; background verification may establish proof for subsequent requests. A later assessment never rewrites the original destination, click or cost. Feed refresh also runs while traffic-quality detection is off if an active campaign has crawler routing enabled. Meta claims and generic Cloudflare verified-bot metadata cannot select a named crawler destination. Replay markers, request rate windows, policy caches and reports are bounded. Large-scale or multi-process deployment needs measurements beyond the local checks in the validation record.

## Offline model experiment

The live classifier stays rules-only. The evaluator trains a Bernoulli naive Bayes baseline on independently labeled data and compares it with the recorded rule decisions. It requires at least 200 examples, at least 30 examples per training class and 20 per holdout class. Related sessions cannot cross the chronological split; overlapping sessions are excluded. It reports confusion counts, precision/recall, Wilson intervals, Brier score, model parameters and a dataset digest. Capacity is limited to 20000 labeled requests per local experiment.

An eligible candidate needs a precision lower bound of at least 99%, a false-positive upper bound no greater than 1%, and improved recall without an increased false-positive rate relative to the recorded rules. These are review gates, not accuracy claims. The result is an uncalibrated model posterior; evaluation never installs a model or starts autonomous training. Missing conversions and our own block decisions are not valid ground-truth labels.

See [TRAFFIC-DETECTION-VALIDATION.md](TRAFFIC-DETECTION-VALIDATION.md) for executed checks and unverified production scope.
