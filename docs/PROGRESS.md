# QueueTix progress

## Current milestone

M0 foundation is implemented and verified locally. Hosted acceptance awaits account setup and live results.

## Done

- Created the npm workspaces, React diagnostics page, Express health API, and test and build tooling.
- Added a bounded startup MongoDB probe, cached database readiness and a transaction helper.
- Recorded specification precedence and the M0–M5 boundaries in [architecture](architecture.md).
- Wrote the [deployment and acceptance runbook](deploy-m0.md).

## Decisions made

- A single startup probe keeps anonymous status reads out of the database. The process caches its completed result and closes the M0 probe connection.
- Commit uncertainty retries the same commit. When the outcome remains unknown, the caller must reconcile durable state before retrying. After-commit effects wait for confirmation.
- The browser measures tick arrival gaps to catch buffering. The checks distinguish an absent database result from a failed transaction.
- Render uses its supplied port. In production the allowlist contains the stable Vercel origin and M0 uses no auth or operator secrets.

## Open questions

- The actual Atlas cluster, production URLs, and deployed timings are pending the account owner.

## Known issues and bugs

- The full npm audit reports moderate advisories in Jest's development dependency tree. The isolated Render production dependency install and the Vercel client install each reported zero vulnerabilities.
- Hosted acceptance is pending. A failed Atlas transaction blocks the milestone and requires the sanitized error from the Render logs.

## How to run locally

Use Node 20.19+ in the 20.x line, or Node 22.12+ in the 22.x or newer supported lines. Local verification used Node 22.14.0.

Use the repository root in PowerShell to prepare the workspace environment files.

```powershell
npm ci
Copy-Item server/.env.example server/.env
Copy-Item client/.env.example client/.env
```

Set the server URI to an authorized Atlas `tickets_dev` database or a local replica set. The example uses a local replica set named `rs0`. If MongoDB Community and `mongosh` are installed and port 27017 is free, start the replica set from the repository root.

```powershell
New-Item -ItemType Directory -Force .cache/mongo-data | Out-Null
mongod --dbpath .cache/mongo-data --port 27017 --bind_ip 127.0.0.1 --replSet rs0
```

Initialize the replica set once in a second terminal.

```powershell
mongosh --host 127.0.0.1 --port 27017 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

Run `npm run dev` from the root and open `http://localhost:5173/smoke`. With the example settings, Vite uses port 5173 and Express uses port 3000.

## How to run tests

Run these commands from the root. The tests provision a MongoDB replica set and download its pinned binary if needed.

```powershell
npm test
npm run lint
npm run format:check
npm run build
```

## Local verification on 21 November 2026

### Tests and build

- PASS — `npm test` ran 15 tests across 3 suites. Covered stable health and error responses, environment and CORS validation, the fake clock, real database commit/readback and cleanup, 100 anonymous reads with zero MongoDB commands, retry and commit uncertainty, and ten real-time SSE ticks.
- PASS — `npm run lint`, `npm run format:check` and `npm run build`.
- PASS — the Render production-only install and server build from repository root, and the Vercel workspace install and client build from `client`, ran in isolated Windows copies. Provider build execution is pending.

### Browser and screenshots

- PASS — Chromium 157 with the production-built Vite client, a local Express process, and MongoMemoryReplSet. All five checks passed. The startup probe took 104 ms. Nine consecutive gaps were 2.00–2.02 seconds and ticks appeared before the stream closed.
- PASS — the browser sent an Authorization preflight from the configured origin. A second browser origin was blocked and its smoke page showed four failures and the transaction as NOT CHECKED.
- PASS — no horizontal overflow at 320, 375, 768, 1024 and 1440 px. Keyboard focus and the Run checks action worked with reduced motion. Local screenshots are in `.cache/qa/`, including `smoke-pass-375.png`, `smoke-pass-1440.png`, `smoke-running-1440.png` and `smoke-denied-375.png`.

## Deployed URLs

- GitHub repository — pending.
- Render API — pending.
- Vercel production `/smoke` — pending.

## Hosted acceptance

| Check                                                             | Result  |
| ----------------------------------------------------------------- | ------- |
| Vercel reaches Render and passes Authorization preflight          | NOT RUN |
| Completed Atlas startup probe verifies write/read and transaction | NOT RUN |
| Render streams ten ticks separately through its proxy             | NOT RUN |
| First request after 20 minutes idle succeeds within 90 seconds    | NOT RUN |
| Render rejects a disallowed browser origin                        | NOT RUN |
| Mobile and desktop layouts on the deployed URL                    | NOT RUN |

## Outstanding M2 and M3 amendments

- M2 §20.14.3 — scope idempotency keys, persist canonical fingerprints, reject changed payloads and invalid seat IDs, and test duplicate-key races. Regressions `T-IDEMP-1`, `T-IDEMP-2`, `T-HOLD-INPUT-1`.
- M2 §20.14.4 — store exact order hold/pass references, exclude the order's hold from the superseding-hold check, handle later unused passes, and preserve single paid ownership. Regressions `T-PAY-CURRENT-1`, `T-PAY-OLDPASS-1`, `T-PAY-DOUBLE-1`.
- M2 §20.14.5 — allow valid pending order history and verify unique paid ownership, matching tickets and sold seats. Regressions `T-VERIFY-PENDING-1`, `T-VERIFY-PAID-1`.
- M3 §20.14.6 — implement 15-second client pings, a 30-second presence cutoff, strict order and 45-second grace. Confirm abandonment on the backend and include entries 1–14 in the disconnect fixture. Regressions `T-PRES-1`, `T-PRES-2`, `T-DC-1`.

## Exact next step

The account owner starts at GitHub step 1 in the [M0 deployment runbook](deploy-m0.md), then records the listed deployment checks. Stop and capture the exact sanitized failure if Atlas cannot complete the transaction. M1 requires the explicit instruction `start M1`.
