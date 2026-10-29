# Independent traffic platform

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the user: React and TypeScript for the interface; a Node.js TypeScript API; Supabase PostgreSQL for durable server-side storage, with a verified import from the original SQLite database. Local administration stays on loopback. Vite builds the client. AI generation uses a configurable OpenAI-compatible chat-completions endpoint and user-supplied credentials.

## Product Purpose

Build the user's own system for traffic management, traffic distribution, campaign tracking and AI publishing. It must be an independent implementation with original source and interface. Running or reusing Klixsor application code is outside the requested product.

## Capabilities and Constraints

Confirmed scope:

- Core campaign tracker, click tracking, conversion postbacks and reports.
- Traffic management and traffic distribution.
- AI publishing and site/content management.
- Optional per-campaign crawler destination URL gated by current provider-origin verification in every detection mode. Google supports official crawler feeds and forward-confirmed DNS. Meta verification is unavailable and Meta claims follow visitor routes. The simulator cannot establish origin proof; historical user-agent-only logs remain unverified.
- A locally runnable working application, carried forward from the user's request to run the system locally.

Proposed implementation scope, subject to refinement:

- Campaigns referencing traffic sources, landing pages and offers.
- Ordered routing rules and weighted destination distribution.
- Destination caps, availability controls and fallback routing.
- Persistent click identities and conversion attribution.
- Reports for clicks, conversions, cost, revenue and distribution outcomes.
- AI-generated article drafts, editing/review and deliberate publication to locally served sites.

Open decisions:

- Brand/product name and visual direction.
- Deployment beyond the local development instance.
- AI provider and user-supplied provider credentials.
- Team roles, external advertising integrations, domain provisioning and production scale requirements.

## Evidence on Hand

The sibling investigation/klixsor folder contains reference research. It is evidence about another product, not this application's source, UI assets, schema or API contract. No vendor bundles, binary code or migrations are to be imported into this application.

No real traffic dataset, customer claims or operating benchmarks have been supplied. Any example records must be clearly labeled and kept distinguishable from real collected events.

## Product Principles

- Independently implement behavior; do not copy the reference product's code or interface.
- Make routing decisions, delivery outcomes and attribution inspectable.
- Keep configured rules and genuinely observed traffic distinguishable.
- Make AI drafts editable before publication.
- Keep the local installation usable without depending on the reference demo.
