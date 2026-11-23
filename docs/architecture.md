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

## M2 and M3

- M2 uses database passes, transactional holds and quotas, mock checkout, and signed tickets. Replacement preserves expiry. Reclaim and retirement use hold ownership and conditional transitions. Orders retain their exact hold and pass, and the verifier allows legitimate pending history while checking paid ownership.
- M3 freezes lobby count and seed on the same event row that joins update. It orders frozen users by SHA-256 of seed and user ID, writes idempotent numbering batches, and checks assignments before opening. Late joins and rejoins allocate a number in the membership transaction.
- The admission controller caps a batch by free passes and reclaimable stock. It advances the watermark with the admitted entries and inherited M2 passes in one transaction. An unpassed abandonment can recover its number by writing the same event row. A passed entry can explicitly rejoin once.
- Presence and recent admission counts live in process memory. Authenticated activity refreshes presence. The controller admits connected users, waits for protected users, and abandons timed-out users in order. Outbound SSE heartbeats never refresh presence. Restart protection gives waiters 45 seconds to reconnect without marking them connected.
- Authenticated queue and seat streams publish committed changes. A reconnect reads a fresh snapshot. The seat stream requires an active pass and closes when it expires or a successful payment consumes it. The displayed seat count uses persisted availability, while admission also counts reclaimable seats.
- Recovery finishes interrupted opening, catches up the scheduler and reconciles expired holds, passes and sold-out entries before readiness. At event start, participation closes immediately. Existing qualifying holds and pending settlements keep their M2 rights until a guarded event-ending transition can commit.

## M4

- The queue and hold routes apply bounded process-local limits. Client IP comes from Express and the configured `TRUST_PROXY_HOPS`. Limits reset on restart.
- Staff can redeem tickets for explicitly assigned events. The scanner verifies the existing HMAC payload and atomically records first use. Organizers see operations data for their own events. Administrators manage staff assignments and may inspect published events. Dashboard counts use recorded passes and live expiry deadlines.
- Mock is the default payment provider. Razorpay Test Mode uses stable receipts to map existing QueueTix orders to gateway orders. Checkout signatures and signed raw webhooks lead to captured-payment verification before the existing booking transaction runs. Refund intents commit with the booking decision and reconcile outside MongoDB transactions with a stable idempotency key.

M5 adds isolated, throttled proof runs. Hosted proxy behavior, streaming, cold-start timing and throughput require measurements in the configured environment.
