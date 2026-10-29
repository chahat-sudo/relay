# Verified crawler routing — 29 October 2026

Routing now consumes the intelligence owner's current identity evidence instead of reinterpreting a user-agent claim. Enabled campaign crawler destinations apply in off, observe and enforce modes. Only verified, selected provider identities can use them; Google supports official service-specific network ranges and forward-confirmed DNS. Meta remains unsupported for origin verification and follows visitor rules. Existing risk enforcement remains separate.

Unknown requests do not wait for remote work. They follow visitor rules while bounded background work refreshes ranges or DNS evidence for subsequent requests. Late evidence never rewrites a completed delivery or its financial ledger. Off-mode campaigns with crawler routing enabled also refresh intelligence. No crawler URL, campaign setting or live workspace data was changed during this implementation.

## Executed checks

- Checks ran on the available Node 24.14.1 runtime, which satisfies this subproject's `>=24.14.0` engine requirement. The parent REA `.nvmrc` specifies 24.18.0; that runtime was not available and was not installed. Validation under that exact parent pin remains unverified.
- `npm test`: 30 passing tests through isolated SQLite workspaces and actual local HTTP listeners. Google feeds, DNS, Cloudflare assertions and labels in these tests are simulated, not real provider-origin evidence.
- `npm run build`: TypeScript checking and the Vite production build passed. The existing Lucide `use client` warnings remain nonfatal.
- Coverage includes verified IPv4/IPv6/mapped addresses, service-specific feeds, spoofed and near-matching names, Meta claims from a Google IP, generic Cloudflare verified-bot metadata, enabled/disabled/unselected routes, all three detection modes, expiration, cold refresh without waiting, DNS cache expiry, HEAD without writes, simulations without proof, paused campaigns, visitor accounting, and immutable delivery after late verification.
- A forced traffic-record write failure rolls back the crawler log in the same transaction. Verified crawler redirects retain their exact configured destination without visitor cookies, click IDs, browser collection or cost. Existing cap, concurrency, continuation and conversion tests still pass.
- The additive version-4 migration was exercised against a version-3 database: consistent original-state backup, retained campaign settings and encryption key, historical crawler rows with null evidence, and idempotent reopen. Older version-1 and version-2 upgrade tests still pass.
- Restart and retention tests preserve the feed revisions cited by routing-time evidence, including revisions inside individual checks. New crawler evidence follows detail retention; legacy claim-only rows remain unchanged.
- Headless installed Chrome exercised the built app at desktop 1440×1000 and mobile 390×844 using an isolated temporary database. Campaign settings, Google-claim simulation using visitor rules, verified/legacy log labels and expandable origin evidence passed. Screenshots were inspected; no page-level horizontal overflow or page script errors were observed. This is Chrome-only verification of this change.

## Comparable local measurements

Each run started with zero historical clicks, completed one cold ordinary-browser redirect, then 200 warm redirects at concurrency 10. Client and server share one Node process with no children; the sampled process-family RSS therefore covers that process. Warm elapsed/CPU measurements exclude setup and the cold request. These workflows do not include crawler verification or external network work.

| Metric | Off before | Off after | Observe before | Observe after |
| --- | ---: | ---: | ---: | ---: |
| Cold redirect | 13.62 ms | 10.76 ms | 11.81 ms | 10.46 ms |
| Warm task elapsed | 563.65 ms | 598.50 ms | 655.14 ms | 667.91 ms |
| Warm p95 | 34.75 ms | 35.04 ms | 40.53 ms | 45.44 ms |
| Warm CPU | 657 ms | 578 ms | 750 ms | 734 ms |
| Sampled peak process-family RSS | 96,432,128 B | 95,719,424 B | 96,866,304 B | 96,813,056 B |

These are individual local runs with machine and scheduling variance, not a speedup or production capacity claim. RSS sampling can miss short peaks. Agent tokens, remote verification CPU/memory, Cloudflare, browser collection and production accuracy were not measured. Commands: `npm run benchmark:traffic -- off 0` and `npm run benchmark:traffic -- observe 0`.

## Unverified scope

No real Google/Meta request or live Cloudflare deployment was exercised for this change. No representative labeled production dataset or production load test was supplied. No PostgreSQL migration, multi-server state coordination, deployment or restart of the existing workspace was performed. The current application remains a single-owner, single-server SQLite implementation; crawler routing correctness does not establish broader production readiness.
