import { randomUUID } from "node:crypto";
import { remainingTime, withTxn } from "../lib/db.js";
import { mongoDiagnostic } from "../lib/diagnostic.js";

const pending = {
  ok: false,
  mongo: null,
  txn: null,
  latencyMs: null,
  checkedAt: null,
};

export function createDbStatus() {
  let result = pending;
  return {
    read: () => result,
    store: (value) => {
      result = Object.freeze({ ...value });
    },
  };
}

export function dbUnavailable(clock, latencyMs) {
  return {
    ...pending,
    mongo: false,
    latencyMs,
    checkedAt: clock.now().toISOString(),
    code: "DB_SMOKE_CONNECTION_FAILED",
  };
}

async function ensureCollection(db, name, timeoutMS) {
  try {
    await db.createCollection(name, { timeoutMS });
  } catch (error) {
    if (error.code !== 48) throw error;
  }
}

export async function runDbSmoke({
  connection,
  clock,
  transaction = withTxn,
  reportFailure = () => {},
  mongoUri,
}) {
  const start = performance.now();
  const deadline = start + 10_000;
  const options = () => ({
    timeoutMS: Math.min(2000, remainingTime(deadline)),
  });
  const db = connection.db;
  const [smoke, first, second] = ["smoke", "smoke_a", "smoke_b"].map((name) =>
    db.collection(name),
  );
  const id = randomUUID();
  const filter = { _id: id };
  const document = { ...filter, probe: "startup" };
  const cleanup = new Set();
  let mongo = false;
  let txn = null;
  let code;
  let stage = "ping";
  try {
    await db.command({ ping: 1 }, options());
    stage = "write/read";
    cleanup.add(smoke);
    await smoke.insertOne(document, options());
    if (!(await smoke.findOne(filter, options())))
      throw new Error("Smoke document was missing after insert.");
    mongo = true;

    stage = "transaction";
    txn = false;
    // Create namespaces before the transaction so first boot does not depend on transactional DDL.
    for (const collection of [first, second]) {
      await ensureCollection(
        db,
        collection.collectionName,
        options().timeoutMS,
      );
      cleanup.add(collection);
    }
    await transaction(
      async ({ session }) => {
        await first.insertOne(document, { ...options(), session });
        await second.insertOne(document, { ...options(), session });
      },
      { connection, clock, timeoutMs: remainingTime(deadline) },
    );
    const firstRecord = await first.findOne(filter, options());
    const secondRecord = await second.findOne(filter, options());
    if (!firstRecord || !secondRecord)
      throw new Error("Committed smoke documents were missing on readback.");
    txn = true;
  } catch (error) {
    code =
      txn === false ? "DB_SMOKE_TRANSACTION_FAILED" : "DB_SMOKE_MONGO_FAILED";
    reportFailure({ stage, ...mongoDiagnostic(error, mongoUri) });
  } finally {
    const removals = await Promise.allSettled(
      [...cleanup].map(async (collection) =>
        collection.deleteOne(filter, { timeoutMS: 2000 }),
      ),
    );
    for (const removal of removals) {
      if (removal.status === "rejected") {
        code ??= "DB_SMOKE_CLEANUP_FAILED";
        reportFailure({
          stage: "cleanup",
          ...mongoDiagnostic(removal.reason, mongoUri),
        });
      }
    }
  }
  return {
    ok: mongo && txn === true && !code,
    mongo,
    txn,
    latencyMs: Math.round(performance.now() - start),
    checkedAt: clock.now().toISOString(),
    ...(code && { code }),
  };
}
