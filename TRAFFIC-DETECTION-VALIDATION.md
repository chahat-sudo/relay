# Traffic detection validation — 27 October 2026

The implementation was exercised locally with isolated SQLite workspaces and real HTTP boundaries. Synthetic providers and synthetic labels are identified below; they do not establish real Google/Meta origin, production detection accuracy or Cloudflare deployment correctness.

## Executed checks

- TypeScript source checking and the production Vite build passed. The existing Lucide dependency emits `use client` directive warnings; the build succeeds.
- The Worker source also bundled successfully as a 5.41 kB browser-targeted ES module with the installed Rolldown 1.2.12. This is packaging verification, not a Cloudflare deployment test.
- The full test run passed 25 tests: the original nine workflows and sixteen new traffic checks, including transactional, idempotent configuration snapshots.
- New checks exercise signed ingress, tampered headers, replay and replay capacity, key rotation, timestamp/audience rejection, public/admin separation, IPv4/IPv6/mapped parsing, exact service-specific DNS matching, incomplete/failed verification, simulated crawler feeds, collection origin/cookie authentication, identical retries and conflicts, expiry, no-write simulation, backed-up migration, cost/attribution preservation, enforcement controls, accessible continuation, concurrent caps, retention, malformed/oversized inputs, durable-write failure and late feed completion during shutdown.
- Actual Chrome, Firefox and WebKit browser runs completed collection against the owned sample page. Each exercised the evidence inspector, independent label form, config save and insufficient-model-data gate. JavaScript-disabled and blocked-collector cases still received the normal landing page; pending collection expired. These runs used an isolated temporary database; labels were explicitly synthetic.
- A final browser confirmation also loaded a prior configuration into the form and verified that the running engine did not change until an explicit save.
- The existing local workspace was compared with its pre-migration backup: campaign, destination, click, conversion and article rows were equal. The updated backend and Vite responded successfully; local observation was then enabled with a retained prior-configuration snapshot. No enforcement declaration was made.
- Desktop 1440×1000 and mobile 390×844 captures were inspected. No page-level horizontal overflow or page script errors were observed. Wide data tables keep their existing horizontal scrolling behavior.
- The Impeccable detector reported six advisories and no warnings/errors for the new UI. No unrelated design-system repair was performed.
- Live HTTPS fetches of Google's official common and special crawler feeds parsed successfully: 317 common ranges and 272 special ranges at approximately 10:57 UTC. This establishes retrieval/schema compatibility, not that any request came from Google. DNS correctness tests use simulated resolver responses.

## Local performance

The comparable runs below each seeded 10000 synthetic historical clicks, completed one cold request, then 200 warm tracking requests at concurrency 10. Client and server share one Node process with no child processes; reported peak process-family RSS therefore covers that one process. The measurement excludes initial seeding from elapsed/CPU warm-run costs. It does not include Cloudflare, browser collection or an external network.

| Metric | Detection off | Observe |
| --- | ---: | ---: |
| Cold request | 12.82 ms | 15.04 ms |
| Warm task elapsed | 406.99 ms | 507.23 ms |
| Warm p50 request | 16.54 ms | 20.85 ms |
| Warm p95 request | 28.09 ms | 33.30 ms |
| Warm p99 request | 30.42 ms | 33.57 ms |
| Warm CPU time | 391 ms | 594 ms |
| Sampled peak process-family RSS | 94,797,824 bytes | 94,105,600 bytes |
| Logical database growth | 94,208 bytes | 475,136 bytes |

Observed p95 workflow overhead was approximately 5.21 ms. These short runs contain client scheduling and normal machine variance; they are not a server-only latency guarantee or a throughput capacity claim. RSS was sampled every 5 ms and can miss shorter peaks. Agent token usage and Cloudflare/browser CPU/memory costs were not measured.

The earlier pre-feature baseline was 676.55 ms elapsed, 41.53 ms p95, 703 ms CPU and 87,179,264 bytes sampled peak RSS for 200 requests. It ran alongside tests with an initially empty database and did not separate a cold request. It is not directly comparable to the paired measurements above and is not used to claim a speedup.

Repeat the local benchmark with `npm run benchmark:traffic -- off 10000` and `npm run benchmark:traffic -- observe 10000`. It creates/removes an isolated temporary workspace and never replays production traffic.

## Remaining production evidence

No public Cloudflare hostname, account route or live Tunnel/Worker deployment has been supplied and verified. Worker-to-origin compatibility was tested through a real local HTTP listener with simulated Cloudflare request metadata. Actual zone/subrequest behavior, public IPv4/IPv6 paths, cross-site HTTPS cookie behavior and production firewall rules remain unverified.

No representative independently labeled traffic corpus was supplied. The model evaluator's calculations were tested with synthetic examples; production precision, recall, false-positive rates, calibration and drift remain unknown. Runtime ML inference and self-training are not enabled. Controlled enforcement has local functional coverage, not the independent production accuracy evidence needed to approve a canary.
