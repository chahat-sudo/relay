# Validation — 19 October 2026

## Backend API contracts follow-up

`npm test` passed all nine integration tests and `npm run build` passed after centralizing API path/method resolution. Unsupported methods now return HTTP405 with Allow rather than creating records or falling through to another handler. Unknown paths return HTTP404 before body parsing. Regression checks compare the workspace before/after rejected calls, exercise collection and item paths, and verify the reserved article-generation path. No database migration is required.

A local concurrency correctness check sent 20 simultaneous tracking requests: the primary received exactly its cap of three visits and the fallback received 17. Twelve simultaneous identical token-authenticated postbacks recorded one conversion and eleven duplicate acknowledgments. These isolated checks establish single-process correctness for the exercised cases; they are not throughput benchmarks or multi-process deployment verification.

Executed successfully:

- `npm run build`: TypeScript checking and production Vite build. The bundler reports dependency-level `use client` directive warnings from Lucide; this app is client-rendered and the build succeeds.
- `npm test`: seven passing integration suites over isolated local workspaces: routing/caps/fallback and conversion/reporting, validation and simulation, draft/publication/persistence/escaping, the AI adapter with a simulated HTTP provider, configurable crawler routing, disabled/unselected crawler handling, and additive backed-up migration.
- Mechanical design detector: one run over the interface sources; no findings.
- Browser: example campaign created; 70/30 simulator inspected without traffic writes; actual local tracking request redirected with click identity; zero-revenue conversion `local-smoke-test-001` recorded; example article draft saved; missing AI-provider state verified.
- Browser after fixes: mobile menu enters focus, excludes covered workspace, closes on Escape and returns focus to its trigger; Return opens the semantic daily-data table. Document overflow check at the actual narrow viewport: clientWidth=scrollWidth=600, with no page-level horizontal overflow.
- Visual captures: desktop 1265×712 and narrow 615×548. They are viewport captures, not full-page or 390px phone verification. Current screenshot files are under `.impeccable/review/`.
- Finish reviewer: **ship for its three scored fixes** (first-viewport campaign row, mobile-menu keyboard behavior, and keyboard-accessible daily values). This is a scoped verdict, not certification of every surface or production readiness.
- Final health request: HTTP200; one example campaign, two example destinations, one draft, one real local test click and one zero-revenue test conversion persisted.

Limits: no live AI provider/model was available; no external advertising platform integration, internet deployment, production traffic replay, throughput benchmark, or complete mobile/accessibility audit was performed. See README.md for implemented and deferred capabilities.

## Configurable crawler destination follow-up

The seven-suite test run and production build passed after adding optional crawler URLs. Tests use self-declared Google/Meta user agents against the local server; no identity-verification claim or real-platform reproduction is made. Tests cover exclusion from visitor metrics/cookies/cost/caps, HEAD behavior, simulation without writes, group selection, invalid configuration, pause behavior, old-client updates, persistence and backed-up idempotent v1 migration. The live workspace retained its campaign, destinations, draft and original test events; an original-state SQLite backup was created and crawler routing remains disabled.

Browser inspection confirmed the enable control reveals the URL input and Google/Meta checkboxes. A Google-claim simulator request follows normal visitor routing while the override is disabled. The captured narrow form had clientWidth=scrollWidth=304. Temporary edits were canceled. The follow-up design detector reported advisory gaps in the existing palette/type documentation; these do not establish new component regressions and were not treated as a request to rewrite the incumbent visual system.
