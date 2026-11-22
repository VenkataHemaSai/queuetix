# QueueTix architecture

The consolidated brief’s §§1–18 describe the product. §19 resolves earlier ambiguity, §20 takes precedence over both, and §20.14 amends conflicting rules in §20. §21 governs frontend design and evidence within those constraints. §21.17 supersedes the older M0 kickoff.

## M0

Use JavaScript and npm workspaces on Node 20+. Vercel Hobby serves React, Vite, and Tailwind. One Render Free Express process connects through Mongoose to Atlas Free. MongoDB is the durable authority. Process memory is disposable. Redis and production Docker are outside the architecture.

The Express app is injectable and separate from startup. Startup validates configuration, connects to MongoDB, and runs one bounded probe. The probe pings, writes and reads a uniquely identified record, commits inserts across two collections, reads them outside the transaction, and cleans up only its records. Public GET requests return the cached outcome and check time. A cold restart runs a fresh probe. Render's liveness endpoint remains independent of database readiness.

The transaction helper retries transient transactions and retries an uncertain commit on its original session and transaction. Both share a bounded retry budget. Each attempt captures the injected clock once. After-commit callbacks run only on confirmed commit. Future business operations with unresolved commit results reconcile using persisted state and idempotency keys.

The browser checks liveness, database readiness, confirmed transaction, and Authorization CORS preflight. It timestamps each SSE arrival and checks the cadence across ten ticks. §21 supplies the semantic palette, typography, focus, and responsive rules. Hosted results and Atlas support require evidence from the configured environment. A failed Atlas transaction blocks M0 acceptance.

## M1

Google Identity Services supplies an ID token that Express verifies for QueueTix's configured client ID. Demo sessions use rate-limited guest attendee accounts. Both receive one-hour QueueTix bearer tokens. Protected requests load the current account from MongoDB before authorizing a role. The browser keeps its session in tab-scoped storage.

Organizers edit their own drafts and publish using a MongoDB transaction. Publishing writes the scheduled event and the generated seats together. A shared layout generator keeps labels, aisle columns and indexes consistent with the SVG preview. Public event routes omit drafts, simulations and all inventory state. Only the read-only layout and configured prices appear in the preview.

## Later milestones

- M2 introduces passes through a shared service, transactional holds and quotas, mock checkout, and tickets. Replace preserves expiry. Reclaim and retirement use hold ownership and conditional transitions. §§20.14.3–5 require scoped request fingerprints and strict seat validation, exact hold/pass references, safe late payment and later-pass handling, and a verifier that checks paid ownership while allowing legitimate pending history.
- M3 adds restart-safe seeded opening, transactional numbering, strict admission order, one rejoin per event, approximate position, and authorized SSE. §20.14.6 sets 15-second client pings, a 30-second presence window, and 45-second disconnect grace. Outbound heartbeats keep the transport open.
- M4 adds recovery, rate limits, scanner and admin tools. M5 adds isolated, throttled proof runs and truthful coverage claims. Recheck actual free-tier limits at deployment.

No design question blocks local M0. Production URLs, Atlas transaction support, proxy streaming and cold-start latency are deployment acceptance evidence.
