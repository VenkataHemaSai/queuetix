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

## M5

Local proofs provision a fresh single-member replica set bound to loopback. The CLI accepts no application database URI or HTTP target. Service mode seeds a labeled lobby, drives the ordinary queue and booking services with an injected clock, and verifies persisted ownership before cleanup. HTTP mode starts the real Express app on an ephemeral port, signs fixture sessions with a fresh key and reads actual SSE frames and reconnect snapshots.

The admin control surface lives at `/operations/simulation` and requires a verified non-guest admin session for every action. The existing backend owns one worker thread and a separate MongoDB client. Its event, bot, seat, queue and booking models use the application schemas in dedicated `qt_sim_*` collections. Public discovery, ordinary analytics and payment reconciliation read their original collections. The worker can read the role of a verified account. Its booking runtime always creates mock orders.

Before starting the worker or its maintenance job, the server checks the database target. Local runs require a loopback proof database. The hosted path requires the production, non-preview Render service and its `tickets_prod` Atlas SRV database. An ordinary `tickets_dev` configuration leaves the simulation worker disabled. [Render runtime detection](https://render.com/docs/environment-variables#render)

A single `qt_sim_control` document holds the latest bounded progress, result and 90-second lease. An atomic conditional upsert admits one run. Progress, cancellation and finalization match the run identifier and check the lease against MongoDB time. A heartbeat renews ownership every ten seconds. A worker that detects its own lost lease asks local work to stop and lets it drain. Another worker can claim expired ownership for recovery. A former owner can repeat cleanup for its exact event and bot IDs in the dedicated collections if an in-flight write settled after recovery. The former owner cannot replace the recovered run state. The worker checks for stale leases on startup and every minute. Daily cleanup also runs on startup and the first awake tick after it is due, skipping the active run.

The driver emits `commandStarted` before its socket write. The worker spaces monitored commands and topology heartbeat starts by at least 22 ms, including control-plane account reads, transaction retries, commits, progress writes and cleanup. The synchronous wait is confined to the worker thread. Peak counts use a rolling one-second window. The budget applies per worker on the specified single-backend deployment. Connection handshakes, bulk document changes, Atlas internal work, and aggregate traffic from overlapping processes need separate accounting. [Measured workload and limits](load-test-report.md)
